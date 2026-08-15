# Wallet Backup Blob-Log Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Go HTTP service that stores append-only, opaque encrypted blobs for wallet backup and recovery, authenticated by BRC-103/104, structurally incapable of reading what it stores.

**Architecture:** A small chi service in the house style of `go-uhrp-storage-server`. Clients authenticate with `go-bsv-middleware`; the authenticated identity key *is* the account address, and no request anywhere carries a client-supplied identity. Blobs are AES-GCM ciphertext the server never decrypts, stored in Postgres `bytea` behind a `BlobStore` interface, organised as `(pseudonym, deviceId, generation, seq)` with two generations retained and no idle expiry.

**Tech Stack:** Go 1.26.3, chi v5, `github.com/bsv-blockchain/go-sdk`, `github.com/bsv-blockchain/go-bsv-middleware`, Postgres (`lib/pq`), `log/slog`, `database/sql`, testify, Docker.

## Global Constraints

- Module path `github.com/bsv-blockchain/go-wallet-backup-server`, Go **1.26.3**, no `toolchain` line.
- **The account address is `ShouldGetAuthenticatedIdentity(ctx).ToDERHex()` and nothing else.** No request body, query parameter, path segment, or header may supply an identity. This is not a style preference — `go-wallet-toolbox` has a live cross-tenant auth bypass from exactly this mistake.
- The server **must never be able to decrypt a blob**. No decrypt call, no server key in any encryption protocol, no plaintext parsing of blob bytes.
- Auth middleware mounts at the **origin root**, never under a subtree. The TS client posts its handshake to `${origin}/.well-known/auth` on an exact-path match.
- **Do not construct the payment middleware.** `NewPayment` without `WithRequestPriceCalculator` silently charges 100 sat/request, and its path dereferences `CompletedProtoWallet.InternalizeAction`, which returns `(nil, nil)`.
- **No streaming is possible behind the auth middleware** — its `ResponseWriterWrapper` buffers to sign responses and implements neither `http.Flusher` nor `http.Hijacker`. Every request and response is fully buffered, so `http.MaxBytesReader` and a hard **1 MiB** blob cap are mandatory, not defensive.
- Error envelope: `{"status":"error","code":"ERR_SCREAMING_SNAKE","description":"Human sentence."}`. Success: `{"status":"success", ...}`. Slices normalised to `[]`, never `null`.
- `SERVER_PRIVATE_KEY` is 64-char hex from env with **no dev default**; fail fast at startup if unset.

---

## File Structure

| File | Responsibility |
|---|---|
| `cmd/server/main.go` | Composition root: config, logger, wallet, store, server, graceful shutdown |
| `internal/config/config.go` | `Config` struct + `Load()` from `os.Getenv` |
| `internal/logger/logger.go` | `Configure(level, format) *slog.Logger` |
| `internal/wallet/wallet.go` | Server identity from hex key |
| `internal/server/server.go` | chi router, middleware chain, route groups |
| `internal/server/middlewares/identity.go` | `RequireIdentityKey`, `GetIdentityKey` |
| `internal/server/responses/responses.go` | `WriteJSON` / `WriteError` envelope |
| `internal/server/handlers/append.go` | `POST /v1/log/{deviceId}` |
| `internal/server/handlers/read.go` | `GET` index, blob, manifest |
| `internal/server/handlers/prune.go` | `DELETE /v1/generation/{deviceId}/{generation}` |
| `internal/server/handlers/health.go` | `GET /health` |
| `internal/blobstore/blobstore.go` | `BlobStore` interface + `BlobKey` |
| `internal/blobstore/postgres.go` | Postgres implementation |
| `internal/store/migrations.go` | Idempotent `CREATE TABLE IF NOT EXISTS` list |
| `test-client/` | Node + `@bsv/sdk` AuthFetch interop tests |

---

### Task 1: Scaffold, config, logger, health endpoint

**Files:**
- Create: `go.mod`, `cmd/server/main.go`, `internal/config/config.go`, `internal/logger/logger.go`, `internal/server/server.go`, `internal/server/responses/responses.go`, `internal/server/handlers/health.go`
- Test: `internal/config/config_test.go`, `internal/server/handlers/health_test.go`

**Interfaces:**
- Consumes: nothing
- Produces: `config.Config{Port, ServerPrivateKey, DatabaseURL, LogLevel, LogFormat, MaxBlobBytes}`, `config.Load() (*Config, error)`, `logger.Configure(level, format string) *slog.Logger`, `responses.WriteJSON(w, status int, payload any)`, `responses.WriteError(w, status int, code, description string)`, `server.New(...) *http.Server`.

- [ ] **Step 1: Write the failing config test**

```go
package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoadRequiresServerPrivateKey(t *testing.T) {
	t.Setenv("SERVER_PRIVATE_KEY", "")
	_, err := Load()
	require.Error(t, err)
	require.Contains(t, err.Error(), "SERVER_PRIVATE_KEY")
}

func TestLoadRejectsMalformedKey(t *testing.T) {
	t.Setenv("SERVER_PRIVATE_KEY", "nothex")
	_, err := Load()
	require.Error(t, err)
}

func TestLoadDefaults(t *testing.T) {
	t.Setenv("SERVER_PRIVATE_KEY", "0000000000000000000000000000000000000000000000000000000000000001")
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, 8080, cfg.Port)
	require.Equal(t, int64(1<<20), cfg.MaxBlobBytes)
}
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `go test ./internal/config/ -v`
Expected: FAIL — package does not compile, `Load` undefined.

- [ ] **Step 3: Implement config**

```go
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	Port             int
	ServerPrivateKey string
	DatabaseURL      string
	LogLevel         string
	LogFormat        string
	MaxBlobBytes     int64
}

func Load() (*Config, error) {
	key := os.Getenv("SERVER_PRIVATE_KEY")
	if key == "" {
		return nil, errors.New("SERVER_PRIVATE_KEY is not defined in environment variables")
	}
	if len(key) != 64 {
		return nil, fmt.Errorf("SERVER_PRIVATE_KEY must be 64 hex characters, got %d", len(key))
	}
	for _, c := range key {
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')) {
			return nil, errors.New("SERVER_PRIVATE_KEY must be hexadecimal")
		}
	}
	return &Config{
		Port:             getEnvInt("PORT", 8080),
		ServerPrivateKey: key,
		DatabaseURL:      getEnvDefault("DATABASE_URL", "postgres://localhost:5432/wallet_backup?sslmode=disable"),
		LogLevel:         getEnvDefault("LOG_LEVEL", "info"),
		LogFormat:        getEnvDefault("LOG_FORMAT", "json"),
		MaxBlobBytes:     int64(getEnvInt("MAX_BLOB_BYTES", 1<<20)),
	}, nil
}

func getEnvDefault(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func getEnvInt(k string, d int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}
```

- [ ] **Step 4: Run the config test**

Run: `go test ./internal/config/ -v`
Expected: PASS

- [ ] **Step 5: Implement logger and responses**

```go
// internal/logger/logger.go
package logger

import (
	"log/slog"
	"os"
	"strings"
)

func Configure(level, format string) *slog.Logger {
	var l slog.Level
	switch strings.ToLower(level) {
	case "debug":
		l = slog.LevelDebug
	case "warn":
		l = slog.LevelWarn
	case "error":
		l = slog.LevelError
	default:
		l = slog.LevelInfo
	}
	opts := &slog.HandlerOptions{Level: l}
	var h slog.Handler = slog.NewJSONHandler(os.Stdout, opts)
	if strings.ToLower(format) == "text" {
		h = slog.NewTextHandler(os.Stdout, opts)
	}
	lg := slog.New(h)
	slog.SetDefault(lg)
	return lg
}
```

```go
// internal/server/responses/responses.go
package responses

import (
	"encoding/json"
	"net/http"
)

type ErrorBody struct {
	Status      string `json:"status"`
	Code        string `json:"code"`
	Description string `json:"description"`
}

func WriteJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func WriteError(w http.ResponseWriter, status int, code, description string) {
	WriteJSON(w, status, ErrorBody{Status: "error", Code: code, Description: description})
}
```

- [ ] **Step 6: Write the health handler test**

```go
package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

type fakePinger struct{ err error }

func (f fakePinger) Ping() error { return f.err }

func TestHealthOK(t *testing.T) {
	rec := httptest.NewRecorder()
	Health(fakePinger{}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"status":"ok"`)
}

func TestHealthDegraded(t *testing.T) {
	rec := httptest.NewRecorder()
	Health(fakePinger{err: http.ErrServerClosed}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/health", nil))
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
}
```

- [ ] **Step 7: Implement the health handler**

```go
package handlers

import (
	"net/http"

	"github.com/bsv-blockchain/go-wallet-backup-server/internal/server/responses"
)

type Pinger interface{ Ping() error }

func Health(p Pinger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := p.Ping(); err != nil {
			responses.WriteJSON(w, http.StatusServiceUnavailable,
				map[string]any{"status": "degraded", "details": map[string]any{"database": err.Error()}})
			return
		}
		responses.WriteJSON(w, http.StatusOK,
			map[string]any{"status": "ok", "details": map[string]any{"database": "ok"}})
	})
}
```

- [ ] **Step 8: Run the handler tests**

Run: `go test ./internal/server/... -v`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add go.mod go.sum cmd internal
git commit -m "feat: scaffold service with config, logger, responses and health"
```

---

### Task 2: Server identity and BRC-103/104 auth

**Files:**
- Create: `internal/wallet/wallet.go`, `internal/server/middlewares/identity.go`
- Modify: `internal/server/server.go`
- Test: `internal/server/middlewares/identity_test.go`

**Interfaces:**
- Consumes: `config.Config` from Task 1
- Produces: `wallet.NewServerIdentity(hexKey string) (sdkwallet.Interface, error)`, `middlewares.RequireIdentityKey(next http.Handler) http.Handler`, `middlewares.GetIdentityKey(ctx context.Context) *ec.PublicKey`, and a router with the auth boundary in place.

- [ ] **Step 1: Add dependencies**

```bash
go get github.com/bsv-blockchain/go-sdk@v1.2.23
go get github.com/bsv-blockchain/go-bsv-middleware@v0.13.5
go get github.com/go-chi/chi/v5
go get github.com/stretchr/testify
```

- [ ] **Step 2: Implement the server identity**

```go
package wallet

import (
	"fmt"

	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"
	sdkwallet "github.com/bsv-blockchain/go-sdk/wallet"
)

// NewServerIdentity builds a key-only wallet for BRC-103/104 auth. It has no storage and
// no chain access — deliberately, since this service never transacts.
func NewServerIdentity(hexKey string) (sdkwallet.Interface, error) {
	priv, err := ec.PrivateKeyFromHex(hexKey)
	if err != nil {
		return nil, fmt.Errorf("parse server key: %w", err)
	}
	w, err := sdkwallet.NewCompletedProtoWallet(priv)
	if err != nil {
		return nil, fmt.Errorf("build server wallet: %w", err)
	}
	return w, nil
}
```

- [ ] **Step 3: Write the identity middleware test**

```go
package middlewares

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRequireIdentityKeyRejectsUnauthenticated(t *testing.T) {
	called := false
	h := RequireIdentityKey(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))

	rec := httptest.NewRecorder()
	// No auth middleware ran, so no identity is in the context.
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/manifest", nil))

	require.False(t, called, "handler must not run without an authenticated identity")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
	require.Contains(t, rec.Body.String(), "ERR_AUTH_REQUIRED")
}
```

- [ ] **Step 4: Run it**

Run: `go test ./internal/server/middlewares/ -v`
Expected: FAIL — `RequireIdentityKey` undefined.

- [ ] **Step 5: Implement the identity middleware**

The re-stash under a local typed key is what makes handlers unit-testable; the library's
own context key is unexported, so without it handler tests can only ever assert 401.

```go
package middlewares

import (
	"context"
	"net/http"

	"github.com/bsv-blockchain/go-bsv-middleware/pkg/middleware"
	ec "github.com/bsv-blockchain/go-sdk/primitives/ec"

	"github.com/bsv-blockchain/go-wallet-backup-server/internal/server/responses"
)

type ctxKey struct{}

var identityContextKey = ctxKey{}

func RequireIdentityKey(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key, err := middleware.ShouldGetAuthenticatedIdentity(r.Context())
		if err != nil || key == nil || middleware.IsUnknownIdentity(key) {
			responses.WriteError(w, http.StatusUnauthorized, "ERR_AUTH_REQUIRED", "Authentication required.")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), identityContextKey, key)))
	})
}

// GetIdentityKey returns the authenticated caller's key, or nil.
// This is the ONLY source of an account address in this service.
func GetIdentityKey(ctx context.Context) *ec.PublicKey {
	k, _ := ctx.Value(identityContextKey).(*ec.PublicKey)
	return k
}

// WithIdentityKey injects an identity for tests.
func WithIdentityKey(ctx context.Context, k *ec.PublicKey) context.Context {
	return context.WithValue(ctx, identityContextKey, k)
}
```

- [ ] **Step 6: Run the test**

Run: `go test ./internal/server/middlewares/ -v`
Expected: PASS

- [ ] **Step 7: Wire the router**

Mounting is the part that silently breaks. The auth middleware intercepts
`POST /.well-known/auth` on an exact path compare and never calls `next`, and the TS client
always posts the handshake to the origin root. Mounting under `/api` would 401 everything.

```go
package server

import (
	"fmt"
	"net/http"
	"time"

	"github.com/bsv-blockchain/go-bsv-middleware/pkg/middleware"
	"github.com/bsv-blockchain/go-sdk/auth"
	sdkwallet "github.com/bsv-blockchain/go-sdk/wallet"
	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"log/slog"

	"github.com/bsv-blockchain/go-wallet-backup-server/internal/blobstore"
	"github.com/bsv-blockchain/go-wallet-backup-server/internal/server/handlers"
	"github.com/bsv-blockchain/go-wallet-backup-server/internal/server/middlewares"
)

type Deps struct {
	Wallet       sdkwallet.Interface
	Store        blobstore.BlobStore
	Pinger       handlers.Pinger
	Logger       *slog.Logger
	MaxBlobBytes int64
	Port         int
}

func New(d Deps) *http.Server {
	r := chi.NewRouter()
	r.Use(chimw.RequestID, chimw.Logger, chimw.Recoverer)
	r.Use(corsMiddleware)
	r.Use(maxBody(d.MaxBlobBytes))

	r.Method(http.MethodGet, "/health", handlers.Health(d.Pinger))

	// Single SessionManager instance shared by both mounts. Replace with a shared
	// implementation before running more than one replica: sessions are in-process, so
	// a handshake on replica A followed by a request on replica B returns
	// 401 session-not-found.
	sessions := auth.NewSessionManager()
	authMW := middleware.NewAuth(d.Wallet,
		middleware.WithAuthDisallowUnauthenticated(),
		middleware.WithAuthSessionManager(sessions),
		middleware.WithAuthLogger(d.Logger),
	)

	// Handled inside the middleware; the wrapped handler is never reached.
	r.Handle("/.well-known/auth", authMW.HTTPHandler(http.NotFoundHandler()))

	r.Group(func(r chi.Router) {
		r.Use(authMW.HTTPHandler)
		r.Use(middlewares.RequireIdentityKey)

		r.Get("/v1/manifest", handlers.Manifest(d.Store))
		r.Post("/v1/log/{deviceId}", handlers.Append(d.Store, d.MaxBlobBytes))
		r.Get("/v1/log/{deviceId}", handlers.Index(d.Store))
		r.Get("/v1/log/{deviceId}/{seq}", handlers.Blob(d.Store))
		r.Delete("/v1/generation/{deviceId}/{generation}", handlers.PruneGeneration(d.Store))
	})

	return &http.Server{
		Addr:              fmt.Sprintf(":%d", d.Port),
		Handler:           r,
		ReadHeaderTimeout: 10 * time.Second,
	}
}

func maxBody(n int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, n+4096) // blob cap plus envelope slack
			next.ServeHTTP(w, r)
		})
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
		// AuthFetch reads x-bsv-auth-* off the response; without this they are hidden.
		w.Header().Set("Access-Control-Expose-Headers", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		next.ServeHTTP(w, r)
	})
}
```

- [ ] **Step 8: Commit**

```bash
git add internal cmd go.mod go.sum
git commit -m "feat: BRC-103/104 auth boundary with identity-only account addressing"
```

---

### Task 3: Blob store, schema and migrations

**Files:**
- Create: `internal/blobstore/blobstore.go`, `internal/blobstore/postgres.go`, `internal/store/migrations.go`
- Test: `internal/blobstore/postgres_test.go`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces:

```go
type BlobKey struct {
	Pseudonym  string // 66-char compressed hex, from auth only
	DeviceID   string
	Generation int
	Seq        int
}

type Entry struct {
	Seq        int       `json:"seq"`
	Sha256     string    `json:"sha256"`
	PrevSha256 string    `json:"prevSha256"`
	Size       int       `json:"size"`
	CreatedAt  time.Time `json:"createdAt"`
}

type DeviceSummary struct {
	DeviceID   string    `json:"deviceId"`
	Generation int       `json:"generation"`
	HeadSeq    int       `json:"headSeq"`
	HeadSha256 string    `json:"headSha256"`
	TotalBytes int64     `json:"totalBytes"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type BlobStore interface {
	Append(ctx context.Context, k BlobKey, prevSha256 string, data []byte) (sha string, err error)
	Get(ctx context.Context, k BlobKey) ([]byte, error)
	Index(ctx context.Context, pseudonym, deviceID string, generation, from, limit int) ([]Entry, error)
	Manifest(ctx context.Context, pseudonym string) ([]DeviceSummary, error)
	DeleteGeneration(ctx context.Context, pseudonym, deviceID string, generation int) (int64, error)
	Ping() error
}

var (
	ErrSeqConflict = errors.New("sequence conflict")
	ErrNotFound    = errors.New("not found")
)
```

- [ ] **Step 1: Write the schema**

```go
package store

var Migrations = []string{
	`CREATE TABLE IF NOT EXISTS blob_log (
		pseudonym    TEXT        NOT NULL,
		device_id    TEXT        NOT NULL,
		generation   INTEGER     NOT NULL,
		seq          INTEGER     NOT NULL,
		sha256       TEXT        NOT NULL,
		prev_sha256  TEXT,
		ciphertext   BYTEA       NOT NULL,
		created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
		PRIMARY KEY (pseudonym, device_id, generation, seq)
	)`,
	`CREATE INDEX IF NOT EXISTS blob_log_head
		ON blob_log (pseudonym, device_id, generation, seq DESC)`,
}

func Migrate(db *sql.DB) error {
	for i, m := range Migrations {
		if _, err := db.Exec(m); err != nil {
			return fmt.Errorf("migration %d: %w", i, err)
		}
	}
	return nil
}
```

- [ ] **Step 2: Write the failing store test**

```go
func TestAppendEnforcesContiguousSeq(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	k := BlobKey{Pseudonym: "02aa", DeviceID: "d1", Generation: 1, Seq: 1}

	_, err := s.Append(ctx, k, "", []byte("one"))
	require.NoError(t, err)

	// Re-appending the same seq must conflict, not overwrite. Overwriting would let a
	// bug or a racing device silently destroy a backup entry.
	_, err = s.Append(ctx, k, "", []byte("different"))
	require.ErrorIs(t, err, ErrSeqConflict)

	// Skipping a sequence number must be refused, or restore would hit a silent hole.
	k.Seq = 3
	_, err = s.Append(ctx, k, "", []byte("three"))
	require.ErrorIs(t, err, ErrSeqConflict)
}

func TestAppendReturnsSha256(t *testing.T) {
	s := newTestStore(t)
	sha, err := s.Append(context.Background(),
		BlobKey{Pseudonym: "02aa", DeviceID: "d1", Generation: 1, Seq: 1}, "", []byte("hello"))
	require.NoError(t, err)
	sum := sha256.Sum256([]byte("hello"))
	require.Equal(t, hex.EncodeToString(sum[:]), sha)
}

func TestGetIsScopedToPseudonym(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	_, err := s.Append(ctx, BlobKey{Pseudonym: "02aa", DeviceID: "d1", Generation: 1, Seq: 1}, "", []byte("secret"))
	require.NoError(t, err)

	// A different pseudonym must not see it, even with every other field identical.
	_, err = s.Get(ctx, BlobKey{Pseudonym: "02bb", DeviceID: "d1", Generation: 1, Seq: 1})
	require.ErrorIs(t, err, ErrNotFound)
}
```

- [ ] **Step 3: Run it**

Run: `go test ./internal/blobstore/ -v`
Expected: FAIL — package does not compile.

- [ ] **Step 4: Implement the Postgres store**

The append is a single transaction that reads the current head and inserts only if the
new sequence is exactly head+1.

```go
func (s *PostgresStore) Append(ctx context.Context, k BlobKey, prev string, data []byte) (string, error) {
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()

	var head sql.NullInt64
	if err := tx.QueryRowContext(ctx,
		`SELECT MAX(seq) FROM blob_log WHERE pseudonym=$1 AND device_id=$2 AND generation=$3`,
		k.Pseudonym, k.DeviceID, k.Generation).Scan(&head); err != nil {
		return "", err
	}

	expected := 1
	if head.Valid {
		expected = int(head.Int64) + 1
	}
	if k.Seq != expected {
		return "", fmt.Errorf("%w: expected seq %d, got %d", ErrSeqConflict, expected, k.Seq)
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO blob_log (pseudonym, device_id, generation, seq, sha256, prev_sha256, ciphertext)
		 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		k.Pseudonym, k.DeviceID, k.Generation, k.Seq, sha, nullable(prev), data); err != nil {
		return "", err
	}
	return sha, tx.Commit()
}
```

Implement `Get`, `Index`, `Manifest`, `DeleteGeneration` and `Ping` in the same file. Every
query's `WHERE` clause must include `pseudonym=$1`.

- [ ] **Step 5: Run the tests**

Run: `go test ./internal/blobstore/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/blobstore internal/store
git commit -m "feat: postgres blob store with contiguous-seq append and pseudonym scoping"
```

---

### Task 4: Append handler

**Files:**
- Create: `internal/server/handlers/append.go`
- Test: `internal/server/handlers/append_test.go`

**Interfaces:**
- Consumes: `blobstore.BlobStore`, `middlewares.GetIdentityKey`, `middlewares.WithIdentityKey`
- Produces: `handlers.Append(store blobstore.BlobStore, maxBytes int64) http.HandlerFunc`

- [ ] **Step 1: Write the failing tests**

```go
func TestAppendRejectsNonOctetStream(t *testing.T) {
	rec, req := newAuthedRequest(t, http.MethodPost, "/v1/log/"+validDevice+"?seq=1&generation=1", []byte("x"))
	req.Header.Set("Content-Type", "application/json")
	route(t, fakeStore{}).ServeHTTP(rec, req)
	require.Equal(t, http.StatusUnsupportedMediaType, rec.Code)
}

func TestAppendRejectsOversizeBlob(t *testing.T) {
	rec, req := newAuthedRequest(t, http.MethodPost, "/v1/log/"+validDevice+"?seq=1&generation=1",
		make([]byte, (1<<20)+1))
	req.Header.Set("Content-Type", "application/octet-stream")
	route(t, fakeStore{}).ServeHTTP(rec, req)
	require.Equal(t, http.StatusRequestEntityTooLarge, rec.Code)
	require.Contains(t, rec.Body.String(), "ERR_BLOB_TOO_LARGE")
}

func TestAppendRejectsMalformedDeviceID(t *testing.T) {
	rec, req := newAuthedRequest(t, http.MethodPost, "/v1/log/NOT-HEX?seq=1&generation=1", []byte("x"))
	req.Header.Set("Content-Type", "application/octet-stream")
	route(t, fakeStore{}).ServeHTTP(rec, req)
	require.Equal(t, http.StatusBadRequest, rec.Code)
	require.Contains(t, rec.Body.String(), "ERR_INVALID_DEVICE_ID")
}

func TestAppendUsesAuthenticatedIdentityAsPseudonym(t *testing.T) {
	// The security property of the whole service: the row key comes from auth, and a
	// client cannot influence it. There is no identity parameter to try to spoof, so
	// this asserts the handler reads from the context and nowhere else.
	var captured blobstore.BlobKey
	store := fakeStore{onAppend: func(k blobstore.BlobKey) { captured = k }}

	rec, req := newAuthedRequestAs(t, testPubKeyHex, http.MethodPost,
		"/v1/log/"+validDevice+"?seq=1&generation=1", []byte("blob"))
	req.Header.Set("Content-Type", "application/octet-stream")
	route(t, store).ServeHTTP(rec, req)

	require.Equal(t, http.StatusCreated, rec.Code)
	require.Equal(t, testPubKeyHex, captured.Pseudonym)
}

func TestAppendReturnsSeqConflictAs409(t *testing.T) {
	store := fakeStore{err: blobstore.ErrSeqConflict}
	rec, req := newAuthedRequest(t, http.MethodPost, "/v1/log/"+validDevice+"?seq=5&generation=1", []byte("x"))
	req.Header.Set("Content-Type", "application/octet-stream")
	route(t, store).ServeHTTP(rec, req)
	require.Equal(t, http.StatusConflict, rec.Code)
	require.Contains(t, rec.Body.String(), "ERR_SEQ_CONFLICT")
}
```

- [ ] **Step 2: Run them**

Run: `go test ./internal/server/handlers/ -run TestAppend -v`
Expected: FAIL — `Append` undefined.

- [ ] **Step 3: Implement the handler**

```go
package handlers

import (
	"errors"
	"io"
	"net/http"
	"regexp"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/bsv-blockchain/go-wallet-backup-server/internal/blobstore"
	"github.com/bsv-blockchain/go-wallet-backup-server/internal/server/middlewares"
	"github.com/bsv-blockchain/go-wallet-backup-server/internal/server/responses"
)

var deviceIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

func Append(store blobstore.BlobStore, maxBytes int64) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key := middlewares.GetIdentityKey(r.Context())
		if key == nil {
			responses.WriteError(w, http.StatusUnauthorized, "ERR_AUTH_REQUIRED", "Authentication required.")
			return
		}

		if r.Header.Get("Content-Type") != "application/octet-stream" {
			responses.WriteError(w, http.StatusUnsupportedMediaType, "ERR_UNSUPPORTED_MEDIA_TYPE",
				"Body must be application/octet-stream.")
			return
		}

		deviceID := chi.URLParam(r, "deviceId")
		if !deviceIDPattern.MatchString(deviceID) {
			responses.WriteError(w, http.StatusBadRequest, "ERR_INVALID_DEVICE_ID",
				"Device id must be 32 lowercase hex characters.")
			return
		}

		seq, err1 := strconv.Atoi(r.URL.Query().Get("seq"))
		generation, err2 := strconv.Atoi(r.URL.Query().Get("generation"))
		if err1 != nil || err2 != nil || seq < 1 || generation < 1 {
			responses.WriteError(w, http.StatusBadRequest, "ERR_INVALID_PARAMS",
				"seq and generation must be positive integers.")
			return
		}

		// Bounded read. No streaming is possible behind the auth middleware, so this is
		// fully buffered by design and the cap is what keeps it safe.
		data, err := io.ReadAll(io.LimitReader(r.Body, maxBytes+1))
		if err != nil {
			responses.WriteError(w, http.StatusRequestEntityTooLarge, "ERR_BLOB_TOO_LARGE",
				"Blob exceeds the maximum size.")
			return
		}
		if int64(len(data)) > maxBytes {
			responses.WriteError(w, http.StatusRequestEntityTooLarge, "ERR_BLOB_TOO_LARGE",
				"Blob exceeds the maximum size.")
			return
		}

		// The account address comes from auth and only from auth.
		k := blobstore.BlobKey{
			Pseudonym:  key.ToDERHex(),
			DeviceID:   deviceID,
			Generation: generation,
			Seq:        seq,
		}

		sha, err := store.Append(r.Context(), k, r.URL.Query().Get("prevSha256"), data)
		switch {
		case errors.Is(err, blobstore.ErrSeqConflict):
			responses.WriteError(w, http.StatusConflict, "ERR_SEQ_CONFLICT", err.Error())
		case err != nil:
			responses.WriteError(w, http.StatusInternalServerError, "ERR_INTERNAL", "Could not store the blob.")
		default:
			responses.WriteJSON(w, http.StatusCreated,
				map[string]any{"status": "success", "seq": seq, "sha256": sha})
		}
	}
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/server/handlers/ -run TestAppend -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/server/handlers
git commit -m "feat: append handler with size cap and auth-derived addressing"
```

---

### Task 5: Read handlers — manifest, index, blob

**Files:**
- Create: `internal/server/handlers/read.go`
- Test: `internal/server/handlers/read_test.go`

**Interfaces:**
- Consumes: `blobstore.BlobStore`
- Produces: `handlers.Manifest(store)`, `handlers.Index(store)`, `handlers.Blob(store)` — all `http.HandlerFunc`

- [ ] **Step 1: Write the failing tests**

```go
func TestManifestReturnsEmptyArrayNotNull(t *testing.T) {
	rec, req := newAuthedRequest(t, http.MethodGet, "/v1/manifest", nil)
	route(t, fakeStore{devices: nil}).ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), `"devices":[]`)
	require.NotContains(t, rec.Body.String(), "null")
}

func TestBlobReturnsRawOctetStream(t *testing.T) {
	payload := []byte{0x00, 0xff, 0x10}
	rec, req := newAuthedRequest(t, http.MethodGet, "/v1/log/"+validDevice+"/1?generation=1", nil)
	route(t, fakeStore{blob: payload}).ServeHTTP(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "application/octet-stream", rec.Header().Get("Content-Type"))
	require.Equal(t, payload, rec.Body.Bytes())
}

func TestBlobNotFound(t *testing.T) {
	rec, req := newAuthedRequest(t, http.MethodGet, "/v1/log/"+validDevice+"/99?generation=1", nil)
	route(t, fakeStore{err: blobstore.ErrNotFound}).ServeHTTP(rec, req)
	require.Equal(t, http.StatusNotFound, rec.Code)
	require.Contains(t, rec.Body.String(), "ERR_BLOB_NOT_FOUND")
}
```

- [ ] **Step 2: Run them**

Run: `go test ./internal/server/handlers/ -run 'TestManifest|TestBlob' -v`
Expected: FAIL

- [ ] **Step 3: Implement the read handlers**

Each reads the pseudonym from `middlewares.GetIdentityKey` and passes it to the store.
`Blob` writes raw bytes with `Content-Type: application/octet-stream`; the others use
`responses.WriteJSON`. Normalise nil slices to `[]T{}` before encoding.

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/server/handlers/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/server/handlers
git commit -m "feat: manifest, index and blob read handlers"
```

---

### Task 6: Generation pruning and retention

**Files:**
- Create: `internal/server/handlers/prune.go`
- Test: `internal/server/handlers/prune_test.go`, `internal/blobstore/retention_test.go`

**Interfaces:**
- Consumes: `blobstore.BlobStore.DeleteGeneration`
- Produces: `handlers.PruneGeneration(store) http.HandlerFunc`

Retention is **keep the current and previous generation**. Two, so a failed compaction
never leaves a user with zero backups. There is no idle expiry: a pseudonym untouched for
years belongs to exactly the user this service exists for.

- [ ] **Step 1: Write the failing retention tests**

```go
func TestDeleteGenerationRefusesTheTwoNewest(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	for gen := 1; gen <= 3; gen++ {
		_, err := s.Append(ctx, BlobKey{Pseudonym: "02aa", DeviceID: "d1", Generation: gen, Seq: 1}, "", []byte("x"))
		require.NoError(t, err)
	}

	// Generations 3 (current) and 2 (previous) must survive.
	_, err := s.DeleteGeneration(ctx, "02aa", "d1", 3)
	require.Error(t, err)
	_, err = s.DeleteGeneration(ctx, "02aa", "d1", 2)
	require.Error(t, err)

	// Generation 1 is now redundant and may go.
	n, err := s.DeleteGeneration(ctx, "02aa", "d1", 1)
	require.NoError(t, err)
	require.Equal(t, int64(1), n)
}

func TestDeleteGenerationIsScopedToPseudonym(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	for gen := 1; gen <= 3; gen++ {
		_, err := s.Append(ctx, BlobKey{Pseudonym: "02aa", DeviceID: "d1", Generation: gen, Seq: 1}, "", []byte("x"))
		require.NoError(t, err)
	}
	n, err := s.DeleteGeneration(ctx, "02bb", "d1", 1)
	require.NoError(t, err)
	require.Equal(t, int64(0), n, "must not delete another pseudonym's data")
}
```

- [ ] **Step 2: Run them**

Run: `go test ./internal/blobstore/ -run TestDeleteGeneration -v`
Expected: FAIL

- [ ] **Step 3: Implement the guard in DeleteGeneration**

```go
func (s *PostgresStore) DeleteGeneration(ctx context.Context, pseudonym, deviceID string, generation int) (int64, error) {
	var newest sql.NullInt64
	if err := s.db.QueryRowContext(ctx,
		`SELECT MAX(generation) FROM blob_log WHERE pseudonym=$1 AND device_id=$2`,
		pseudonym, deviceID).Scan(&newest); err != nil {
		return 0, err
	}
	// Keep the current and previous generation so a failed compaction never leaves the
	// user with nothing to restore from.
	if newest.Valid && generation > int(newest.Int64)-2 {
		return 0, fmt.Errorf("refusing to delete generation %d: within the two retained generations", generation)
	}
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM blob_log WHERE pseudonym=$1 AND device_id=$2 AND generation=$3`,
		pseudonym, deviceID, generation)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}
```

- [ ] **Step 4: Run the tests**

Run: `go test ./internal/blobstore/ -v`
Expected: PASS

- [ ] **Step 5: Implement the handler and test it**

`PruneGeneration` maps the retention error to `409 ERR_RETENTION_GUARD` and success to
`204`.

- [ ] **Step 6: Commit**

```bash
git add internal
git commit -m "feat: generation pruning with a two-generation retention floor"
```

---

### Task 7: Cross-tenant security suite

**Files:**
- Create: `internal/server/security_test.go`

**Interfaces:**
- Consumes: the full router from Task 2 and all handlers
- Produces: proof that identity A cannot reach identity B's data on **every** route.

This exists because `go-wallet-toolbox` shipped precisely this bug. A table-driven test
over every route is the guard.

- [ ] **Step 1: Write the failing test**

```go
func TestNoRouteLeaksAcrossIdentities(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()

	alice := "02" + strings.Repeat("aa", 32)
	bob := "02" + strings.Repeat("bb", 32)
	device := strings.Repeat("a", 32)

	_, err := store.Append(ctx, blobstore.BlobKey{
		Pseudonym: alice, DeviceID: device, Generation: 1, Seq: 1,
	}, "", []byte("alice-secret"))
	require.NoError(t, err)

	routes := []struct {
		name, method, path string
	}{
		{"manifest", http.MethodGet, "/v1/manifest"},
		{"index", http.MethodGet, "/v1/log/" + device + "?generation=1"},
		{"blob", http.MethodGet, "/v1/log/" + device + "/1?generation=1"},
		{"prune", http.MethodDelete, "/v1/generation/" + device + "/1"},
	}

	for _, rt := range routes {
		t.Run(rt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := authedAs(t, bob, rt.method, rt.path, nil)
			routerFor(store).ServeHTTP(rec, req)

			require.NotContains(t, rec.Body.String(), "alice-secret",
				"%s leaked another identity's blob content", rt.name)
			require.NotEqual(t, http.StatusOK, rec.Code,
				"%s returned another identity's data", rt.name)
		})
	}
}

func TestAppendCannotWriteIntoAnotherIdentitysLog(t *testing.T) {
	store := newTestStore(t)
	alice := "02" + strings.Repeat("aa", 32)
	bob := "02" + strings.Repeat("bb", 32)
	device := strings.Repeat("a", 32)

	rec := httptest.NewRecorder()
	req := authedAs(t, bob, http.MethodPost, "/v1/log/"+device+"?seq=1&generation=1", []byte("bob-wrote-this"))
	req.Header.Set("Content-Type", "application/octet-stream")
	routerFor(store).ServeHTTP(rec, req)

	// Bob's write lands under Bob's pseudonym, never Alice's.
	_, err := store.Get(context.Background(), blobstore.BlobKey{
		Pseudonym: alice, DeviceID: device, Generation: 1, Seq: 1,
	})
	require.ErrorIs(t, err, blobstore.ErrNotFound)
}
```

- [ ] **Step 2: Run it**

Run: `go test ./internal/server/ -run 'TestNoRouteLeaks|TestAppendCannot' -v`
Expected: PASS if the handlers were implemented correctly. **If any subtest fails, that is
a real cross-tenant vulnerability — fix the handler, never the test.**

- [ ] **Step 3: Commit**

```bash
git add internal/server/security_test.go
git commit -m "test: prove no route leaks across authenticated identities"
```

---

### Task 8: TypeScript interop test

**Files:**
- Create: `test-client/package.json`, `test-client/backup.test.ts`, `docker-compose.test.yml`

**Interfaces:**
- Consumes: the running server
- Produces: proof that the real `@bsv/sdk` `AuthFetch` client can complete the handshake and round-trip a blob. Unit tests cannot prove this — they never exercise BRC-103/104 framing.

`go-bsv-middleware` already ships a dockerized Node client driving the Go middleware; copy
that harness shape.

- [ ] **Step 1: Write the interop test**

```ts
import { AuthFetch, CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import { randomBytes } from 'crypto'

const BASE = process.env.SERVER_URL ?? 'http://localhost:8080'

function clientFor (priv = PrivateKey.fromRandom()): { fetch: AuthFetch, key: string } {
  const wallet = new CompletedProtoWallet(priv)
  return { fetch: new AuthFetch(wallet), key: priv.toPublicKey().toString() }
}

describe('backup log interop', () => {
  it('round-trips a blob as raw binary', async () => {
    const { fetch } = clientFor()
    const device = randomBytes(16).toString('hex')
    const blob = randomBytes(4096)

    const put = await fetch.fetch(`${BASE}/v1/log/${device}?seq=1&generation=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: blob,
    })
    expect(put.status).toBe(201)

    const got = await fetch.fetch(`${BASE}/v1/log/${device}/1?generation=1`, { method: 'GET' })
    expect(got.status).toBe(200)
    expect(Buffer.from(await got.arrayBuffer())).toEqual(blob)
  })

  it('rejects a second write to the same sequence', async () => {
    const { fetch } = clientFor()
    const device = randomBytes(16).toString('hex')
    const url = `${BASE}/v1/log/${device}?seq=1&generation=1`
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' } }

    expect((await fetch.fetch(url, { ...opts, body: randomBytes(16) })).status).toBe(201)
    expect((await fetch.fetch(url, { ...opts, body: randomBytes(16) })).status).toBe(409)
  })

  it('does not expose one identity\'s blob to another', async () => {
    const alice = clientFor()
    const bob = clientFor()
    const device = randomBytes(16).toString('hex')

    await alice.fetch.fetch(`${BASE}/v1/log/${device}?seq=1&generation=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from('alice-secret'),
    })

    // Same device id, different authenticated identity: must not resolve.
    const res = await bob.fetch.fetch(`${BASE}/v1/log/${device}/1?generation=1`, { method: 'GET' })
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run against a live server**

```bash
docker compose -f docker-compose.test.yml up -d
SERVER_URL=http://localhost:8080 npm --prefix test-client test
```

Expected: all three pass. A failure in the first test most often means the auth middleware
was mounted under a subtree rather than the origin root, so the handshake never reached it.

- [ ] **Step 3: Commit**

```bash
git add test-client docker-compose.test.yml
git commit -m "test: TypeScript AuthFetch interop against the live server"
```

---

### Task 9: Ops — Docker, CI, graceful shutdown

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `.github/workflows/go.yml`, `.github/workflows/docker-publish.yml`
- Modify: `cmd/server/main.go`

**Interfaces:**
- Consumes: everything above
- Produces: a deployable image and CI.

- [ ] **Step 1: Add graceful shutdown to main**

```go
srv := server.New(deps)
go func() {
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("server failed", "error", err)
		os.Exit(1)
	}
}()

stop := make(chan os.Signal, 1)
signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
<-stop

ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
defer cancel()
if err := srv.Shutdown(ctx); err != nil {
	logger.Error("graceful shutdown failed", "error", err)
}
```

- [ ] **Step 2: Write the multi-stage Dockerfile**

Alpine multi-stage, matching house style. Static build, non-root user, `HEALTHCHECK`
hitting `/health`.

- [ ] **Step 3: Add the CI workflow**

```yaml
name: go
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
          POSTGRES_DB: wallet_backup_test
        options: >-
          --health-cmd pg_isready --health-interval 10s
          --health-timeout 5s --health-retries 5
        ports: ['5432:5432']
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.26.3' }
      - run: go test ./... -race -cover
      - uses: golangci/golangci-lint-action@v6
```

Neither reference service has a Go test/lint workflow. Adding one closes a documented gap
rather than breaking convention.

- [ ] **Step 4: Write .env.example**

```
PORT=8080
SERVER_PRIVATE_KEY=
DATABASE_URL=postgres://postgres:postgres@localhost:5432/wallet_backup?sslmode=disable
LOG_LEVEL=info
LOG_FORMAT=json
MAX_BLOB_BYTES=1048576
```

`SERVER_PRIVATE_KEY` is deliberately blank — there is no dev default, and startup fails
without it.

- [ ] **Step 5: Verify the whole suite with race detection**

```bash
go test ./... -race -cover
golangci-lint run
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml .env.example .github
git commit -m "chore: docker image, CI workflow and graceful shutdown"
```

---

## Deferred: paid access

The service ships **free**. If it later charges, the intended route is
[go-402-pay](https://github.com/bsv-blockchain/go-402-pay) (BRC-121) rather than the
BRC-105 middleware bundled with `go-bsv-middleware`, combined with a
[BRC-228](https://bsv.brc.dev/payments/0228) ephemeral `senderIdentityKey`.

This is additive — `pay402.PaymentMiddleware` wraps routes with a `CalculatePrice` hook —
so nothing in this plan needs to anticipate it. Two constraints if it happens:

- Payment must not re-link the pseudonym to the user's real identity. BRC-228 removes the
  identity key from the *remittance*, but its own spec states inputs and change are signed
  by the real wallet and that it is "not graph-private". The residual leak is chain-graph
  correlation of the funding UTXOs.
- The pseudonymous client wallet **cannot pay**: `CompletedProtoWallet.createAction`
  throws `not implemented`. Only the user's real wallet can fund a transaction, so a
  bridge between the paying identity and the authenticating pseudonym is required, and
  that bridge is where linkage leaks.

Resolve the privacy analysis before implementing.

---

## Acceptance

- `go test ./... -race -cover` green; `golangci-lint run` clean
- Cross-tenant suite proves no route leaks across identities
- TypeScript `AuthFetch` interop round-trips a blob as raw binary
- Blobs over 1 MiB rejected with `413` before allocation
- No decrypt call, and no server key in any encryption protocol, anywhere in the tree
- No route reads an identity from a request body, query, path, or header
- Startup fails fast without `SERVER_PRIVATE_KEY`
- `/health` reports database reachability
