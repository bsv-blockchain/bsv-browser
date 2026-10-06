# HTTP 402 Payment Handler

## Overview

BSV Browser natively handles HTTP 402 (Payment Required) responses. When a server returns a 402, the browser automatically negotiates a BSV micropayment and retries the request — the user sees the paid content without manual intervention.

This implements the payment flow described in BRC-29, using `x-bsv-*` HTTP headers to exchange payment parameters between client and server.

## How It Works

### 1. Initial Request

The user navigates to a URL in the WebView. The server responds with HTTP 402 and two headers:

```
HTTP/1.1 402 Payment Required
x-bsv-sats: 100
x-bsv-server: 03a1b2c3...  (server identity key)
```

### 2. Detection

The 402 is detected through the **`onHttpError` callback**: React Native WebView fires it for a non-2xx response to a page load. Headers are not available through this path.

A 402 returned to a page's own `fetch()` or `XMLHttpRequest` is left to the page; the browser does not pay it. (An injected fetch wrapper once meant to do this never ran, since Hermes cannot serialize it, and was removed. The app no longer accepts `PAYMENT_REQUIRED` messages from pages, which let any page name the URL, amount and payee of a payment charged to another site.)

Since WebView native navigations don't expose response headers, the payment handler **re-fetches the URL** itself when headers are empty, to read the `x-bsv-sats` and `x-bsv-server` values directly.

### 3. Payment Construction

`BsvPaymentHandler.handle402()` runs the following steps:

1. **Read payment parameters** — extract `x-bsv-sats` (amount) and `x-bsv-server` (server identity key) from headers, or probe the URL if headers were unavailable.
2. **Derive a payment key** — call `wallet.getPublicKey()` with BRC-29 protocol ID `[2, '3241645161d8']`, a random `derivationPrefix` and `derivationSuffix`, and the server's identity key as counterparty.
3. **Build and broadcast the transaction** — call `wallet.createAction()` with a P2PKH output locked to the derived key's hash and `acceptDelayedBroadcast: false`. The `customInstructions` field carries the derivation parameters so the server can derive the matching private key. Undelayed mode posts to Arcade (or failover broadcasters) before the call returns; Arcade's immediate `RECEIVED` / `202` is treated as broadcast success (later SSE `SEEN_ON_NETWORK` is not required for the paid retry).
4. **Retry the request** — re-fetch the original URL with five payment headers:

```
x-bsv-sender:  <client identity key>
x-bsv-beef:    <base64-encoded BEEF transaction>
x-bsv-prefix:  <derivation prefix>
x-bsv-suffix:  <derivation suffix>
x-bsv-vout:    <output index>
```

5. **Display content** — if the server returns 200, the HTML is injected into the WebView via `document.write()` and cached for 30 minutes.

### 4. Server-Side Validation

The server receives the payment headers, decodes the BEEF, and calls `wallet.internalizeAction()` with the `paymentRemittance` (prefix, suffix, sender key). If internalization succeeds, the server serves the protected content.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  WebView (page navigation)                              │
│                                                         │
│  GET /articles/slug ──────────────────► Server          │
│                              ◄──────── 402 + headers    │
│                                                         │
│  onHttpError                                            │
│       │                                                 │
│       ▼                                                 │
│  React Native (index.tsx onHttpError)                   │
│       │                                                 │
│       ▼                                                 │
│  BsvPaymentHandler.handle402()                          │
│       │                                                 │
│       ├── probe fetch (if headers missing)              │
│       ├── wallet.getPublicKey()   (derive payment key)  │
│       ├── wallet.createAction()   (build tx)            │
│       ├── fetch(url, paymentHeaders)  (retry)           │
│       │                                                 │
│       ▼                                                 │
│  injectJavaScript(document.write(html))                 │
└─────────────────────────────────────────────────────────┘
```

## Files

| File | Role |
|------|------|
| `utils/webview/bsvPaymentHandler.ts` | Core 402 handler — probe, payment construction, retry, caching |
| `utils/webview/errorPages.ts` | Static fallback HTML for 402, 403, 404, 500 |
| `app/index.tsx` | Wires handler into `onHttpError`, initializes handler with wallet |

## Error Handling

- If payment construction fails (insufficient funds, wallet error, network issue), the 402 error page is shown.
- If the server rejects the payment on retry, the 402 error page is shown.
- All failures are caught silently — no unhandled rejections reach the global error boundary.

## Caching

Paid content is cached in-memory by URL for 30 minutes. Subsequent navigations to the same URL within that window serve the cached HTML without a new payment.

## Server Requirements

A compatible server must:

1. Return HTTP 402 with `x-bsv-sats` and `x-bsv-server` headers on protected routes.
2. Accept payment via `x-bsv-sender`, `x-bsv-beef`, `x-bsv-prefix`, `x-bsv-suffix`, and `x-bsv-vout` headers.
3. Validate the BEEF transaction and internalize the payment.
4. Return the content with HTTP 200 on successful payment.
5. Expose `x-bsv-sats` and `x-bsv-server` via CORS `Access-Control-Expose-Headers` if the server is on a different origin.

See the `demos/article` project for a reference Express server implementation.
