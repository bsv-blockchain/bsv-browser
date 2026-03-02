# WalletClient Architecture Research
## Session: WalletClient Communication Substrate Deep Dive
## Date: 2026-03-02

## Summary
Complete analysis of how `WalletClient` from `@bsv/sdk` works, what it connects to,
all available communication substrates, and the `WalletInterface` it expects on the
provider side. This determines what we need to implement for a browser extension
wallet provider.

---

## The Core Abstraction: WalletInterface

Everything revolves around `WalletInterface` defined in:
`node_modules/@bsv/sdk/src/wallet/Wallet.interfaces.ts`

`WalletClient` IS a `WalletInterface`. Every substrate IS a `WalletInterface`.
The wallet backend IS a `WalletInterface`. The interface has 28 methods:

### Transaction Methods
1. `createAction(args, originator?)` - create a BSV transaction
2. `signAction(args, originator?)` - sign a partially-built transaction
3. `abortAction(args, originator?)` - abort a pending transaction
4. `internalizeAction(args, originator?)` - import an external transaction

### Output/UTXO Methods
5. `listActions(args, originator?)` - list transaction history
6. `listOutputs(args, originator?)` - list UTXOs
7. `relinquishOutput(args, originator?)` - remove output from basket

### Cryptographic Methods (BRC-42 / BRC-43)
8. `getPublicKey(args, originator?)` - derive public key
9. `revealCounterpartyKeyLinkage(args, originator?)` - BRC-42 key linkage
10. `revealSpecificKeyLinkage(args, originator?)` - BRC-42 key linkage
11. `encrypt(args, originator?)` - AES-GCM encryption
12. `decrypt(args, originator?)` - AES-GCM decryption
13. `createHmac(args, originator?)` - HMAC-SHA256 (BRC-56)
14. `verifyHmac(args, originator?)` - HMAC-SHA256 verification
15. `createSignature(args, originator?)` - ECDSA signature
16. `verifySignature(args, originator?)` - ECDSA verification

### Certificate Methods (BRC-64/65)
17. `acquireCertificate(args, originator?)` - acquire identity cert
18. `listCertificates(args, originator?)` - list stored certs
19. `proveCertificate(args, originator?)` - prove cert fields to verifier
20. `relinquishCertificate(args, originator?)` - delete cert

### Discovery Methods
21. `discoverByIdentityKey(args, originator?)` - find identity by key
22. `discoverByAttributes(args, originator?)` - find identity by attributes

### Status/Info Methods
23. `isAuthenticated(args, originator?)` - check auth state
24. `waitForAuthentication(args, originator?)` - block until authed
25. `getHeight(args, originator?)` - BSV chain height
26. `getHeaderForHeight(args, originator?)` - block header
27. `getNetwork(args, originator?)` - mainnet | testnet
28. `getVersion(args, originator?)` - wallet version string

Note: All methods have an OPTIONAL `originator` parameter (the requesting app's domain name).
This is the second parameter — it is not part of `args`.

---

## WalletClient Constructor

```typescript
new WalletClient(
  substrate: 'auto' | 'Cicada' | 'XDM' | 'window.CWI' | 'json-api' | 'react-native' | 'secure-json-api' | WalletInterface,
  originator?: string  // The app's domain name, e.g. 'myapp.com'
)
```

### Named Substrate Strings
- `'auto'` - tries all substrates, picks first that works
- `'Cicada'` - binary wire protocol over HTTP to localhost:3301
- `'XDM'` - cross-document messaging (iframe postMessage to parent)
- `'window.CWI'` - direct `window.CWI` object injection
- `'json-api'` - JSON over HTTP to localhost:3321
- `'react-native'` - ReactNativeWebView postMessage
- `'secure-json-api'` - JSON over HTTPS to localhost:2121

### Direct WalletInterface
You can pass any object that implements `WalletInterface` directly.
This is how embedded wallets work (no transport needed).

---

## Auto-Discovery Order (in `connectToSubstrate()`)

When `substrate === 'auto'`, WalletClient tries these in parallel, picks first success:
1. `WindowCWISubstrate` - checks `window.CWI`
2. `WalletWireTransceiver(HTTPWalletWire)` - binary HTTP to localhost:3301 (Cicada)
3. `HTTPWalletJSON` at `https://localhost:2121` (secure JSON)
4. `HTTPWalletJSON` at `http://localhost:3321` (plain JSON)
5. `ReactNativeWebView` - checks `window.ReactNativeWebView`
6. (fallback) `XDMSubstrate` - `window.parent.postMessage` with timeout

Detection is done by calling `getVersion({})` on each and checking for `{ version: string }`.

---

## Five Communication Substrates

### 1. window.CWI (Most Relevant for Browser Extension)

**File:** `substrates/window.CWI.ts`
**Class:** `WindowCWISubstrate`
**How it works:**
- Reads `window.CWI` at construction time
- All method calls delegate directly to `window.CWI.methodName(args, originator)`
- Completely synchronous delegation - no message passing
- This is the **browser extension injection pattern**

**What must be provided by the extension:**
```typescript
// The extension content script injects this onto the page's window:
window.CWI = {
  createAction: async (args, originator) => { ... },
  signAction: async (args, originator) => { ... },
  // ... all 28 WalletInterface methods
}
```

**Detection:** `typeof window.CWI === 'object'`

**Security note:** The `isTrusted` flag is NOT checked here (unlike XDM).
The injected object is trusted by definition since it comes from the extension.

---

### 2. XDM (Cross-Document Messaging / iframes)

**File:** `substrates/XDM.ts`
**Class:** `XDMSubstrate`
**How it works:**
- Sends messages to `window.parent` via `postMessage`
- Message format (outbound from app to wallet frame):
  ```javascript
  {
    type: 'CWI',
    isInvocation: true,
    id: '<random-base64-12-bytes>',
    call: '<methodName>',  // e.g. 'createAction'
    args: { ... }
  }
  ```
- Listens for response:
  ```javascript
  {
    type: 'CWI',
    isInvocation: false,  // NOT present / false = response
    id: '<same-id>',
    status: 'success' | 'error',
    result: { ... },      // on success
    description: '...',   // on error
    code: number          // on error
  }
  ```
- **IMPORTANT:** Only trusts messages with `e.isTrusted === true`

**Use case:** App is loaded inside a wallet-controlled iframe.
The wallet owns the parent frame and listens for postMessage calls.

---

### 3. ReactNativeWebView (React Native)

**File:** `substrates/ReactNativeWebView.ts`
**Class:** `ReactNativeWebView`
**How it works:**
- Same message format as XDM but JSON-stringified
- Sends via `window.ReactNativeWebView.postMessage(JSON.stringify(msg))`
- Receives via `window.addEventListener('message', ...)` with `JSON.parse(e.data)`
- The `isTrusted` check is **NOT** present (unlike XDM)

---

### 4. HTTPWalletWire / WalletWireTransceiver (Cicada binary protocol)

**Files:** `substrates/HTTPWalletWire.ts`, `substrates/WalletWireTransceiver.ts`
**How it works:**
- `WalletWireTransceiver` is the `WalletInterface` adapter
- `HTTPWalletWire` is the actual transport (implements `WalletWire` interface)
- `WalletWire` interface: `{ transmitToWallet(message: number[]): Promise<number[]> }`
- Binary protocol: each call is serialized to a `number[]` (byte array)
- Sends POST to `http://localhost:3301/<callName>` with binary body
- Returns binary response

**Binary wire protocol:**
- Byte 0: call code (1-28, see WalletWireCalls enum)
- Byte 1: originator string byte length
- Bytes 2..N: originator string UTF-8
- Bytes N+1..: call-specific binary payload

**Server-side handler:** `WalletWireProcessor`
- Implements `WalletWire` interface on the wallet side
- Receives binary message, decodes it, calls `this.wallet.methodName(args, originator)`
- Re-encodes the response to binary
- Used when building a local Cicada-compatible wallet server

---

### 5. HTTPWalletJSON (JSON over HTTP)

**File:** `substrates/HTTPWalletJSON.ts`
**Class:** `HTTPWalletJSON`
**How it works:**
- Posts JSON to `http://localhost:3321/<callName>` (default)
- Content-Type: `application/json`
- Request body: `JSON.stringify(args)` (just the args, no originator in body)
- Originator in header: `Origin` and `Originator` headers
- Response: JSON-parsed directly as the return value
- Error handling: checks `res.ok`, parses known error codes (5=WERR_REVIEW_ACTIONS, 6=WERR_INVALID_PARAMETER, 7=WERR_INSUFFICIENT_FUNDS)

---

## WalletWireProcessor (Server/Provider Side)

**File:** `substrates/WalletWireProcessor.ts`
**Purpose:** The server-side handler for the binary Cicada wire protocol.
This wraps any `WalletInterface` and exposes it over the binary wire.

```typescript
const processor = new WalletWireProcessor(myWalletImplementation)
// processor.transmitToWallet(binaryMessage) -> decoded, dispatched, re-encoded response
```

This is what a local wallet daemon implements to accept Cicada binary connections.

---

## The window.CWI Pattern for Browser Extensions

This is the most relevant pattern for building a Brave/Chrome extension wallet.

### How MetaMask-style injection works (and BSV equivalent):

**Content Script (injected by extension into every page):**
```javascript
// The content script injects a script tag that runs in page context
// OR uses executeScript to inject the provider

window.CWI = {
  // Implements all 28 WalletInterface methods
  // Each method sends a message to the extension background script
  // and awaits the response

  async createAction(args, originator) {
    return await sendToBackground('createAction', args, originator)
  },

  async getVersion(args, originator) {
    return { version: 'bsv-wallet-1.0.0' }
  },

  // ... all other methods
}
```

**Message flow:**
```
Web App
  └─ new WalletClient('window.CWI')
  └─ wallet.createAction(args)
       └─ WindowCWISubstrate.createAction(args)
            └─ window.CWI.createAction(args, originator)
                 └─ [content script bridge]
                      └─ chrome.runtime.sendMessage(...)
                           └─ [background script / service worker]
                                └─ WalletInterface.createAction(args)
```

---

## The XDM Pattern (Alternative for Extensions)

The extension could instead open a wallet popup/iframe and communicate via postMessage.

**App-side:** Uses `XDMSubstrate` which calls `window.parent.postMessage`
**Extension popup:** Listens for `message` events from child iframes

Message must have `e.isTrusted === true` to be accepted by XDMSubstrate listener.

---

## Key WalletWireCalls Enum (28 calls, codes 1-28)

```
1=createAction, 2=signAction, 3=abortAction, 4=listActions,
5=internalizeAction, 6=listOutputs, 7=relinquishOutput, 8=getPublicKey,
9=revealCounterpartyKeyLinkage, 10=revealSpecificKeyLinkage,
11=encrypt, 12=decrypt, 13=createHmac, 14=verifyHmac,
15=createSignature, 16=verifySignature, 17=acquireCertificate,
18=listCertificates, 19=proveCertificate, 20=relinquishCertificate,
21=discoverByIdentityKey, 22=discoverByAttributes,
23=isAuthenticated, 24=waitForAuthentication,
25=getHeight, 26=getHeaderForHeight, 27=getNetwork, 28=getVersion
```

---

## Implementation Strategy for Browser Extension Provider

### Option A: window.CWI injection (recommended, simplest)

The extension content script injects `window.CWI` implementing all 28 methods.
WalletClient with `'auto'` or `'window.CWI'` picks it up automatically.

**Provider object shape:**
```typescript
interface CWIProvider {
  // All 28 methods of WalletInterface
  // Each method signature: (args: T, originator?: string) => Promise<R>
}
```

**Bridge pattern:**
- Content script creates `window.CWI` object
- Methods forward calls to background via `chrome.runtime.sendMessage`
- Background has the actual `WalletInterface` implementation (Wallet class)
- Background sends response back

### Option B: JSON HTTP server at localhost:3321

Extension could run a local HTTP server and respond to JSON requests.
WalletClient `'json-api'` substrate connects to `http://localhost:3321`.

Not typical for browser extensions (needs native app companion).

### Option C: XDM via popup iframe

Extension opens a wallet UI in an iframe; app communicates via postMessage.
More complex UX but allows rich wallet UI without leaving the page.

---

## Files Referenced

- `/node_modules/@bsv/sdk/src/wallet/WalletClient.ts` - Main client class
- `/node_modules/@bsv/sdk/src/wallet/Wallet.interfaces.ts` - WalletInterface + all types
- `/node_modules/@bsv/sdk/src/wallet/substrates/window.CWI.ts` - CWI injection substrate
- `/node_modules/@bsv/sdk/src/wallet/substrates/XDM.ts` - Cross-document messaging
- `/node_modules/@bsv/sdk/src/wallet/substrates/ReactNativeWebView.ts` - React Native
- `/node_modules/@bsv/sdk/src/wallet/substrates/HTTPWalletWire.ts` - Binary HTTP transport
- `/node_modules/@bsv/sdk/src/wallet/substrates/HTTPWalletJSON.ts` - JSON HTTP transport
- `/node_modules/@bsv/sdk/src/wallet/substrates/WalletWire.ts` - Wire interface
- `/node_modules/@bsv/sdk/src/wallet/substrates/WalletWireProcessor.ts` - Server-side handler
- `/node_modules/@bsv/sdk/src/wallet/substrates/WalletWireTransceiver.ts` - Client-side binary
- `/node_modules/@bsv/sdk/src/wallet/substrates/WalletWireCalls.ts` - Call codes 1-28

---

## BRC Alignment

- **BRC-100**: The `WalletInterface` with all 28 methods IS the BRC-100 spec
- **BRC-42**: Key derivation used by `getPublicKey`, `encrypt`, `decrypt`, `createHmac` etc.
- **BRC-43**: Security levels (0=open, 1=silent, 2=interactive) in `protocolID[0]`
- **BRC-56**: HMAC operations (createHmac, verifyHmac)
- **BRC-62**: BEEF format used in `createAction` (tx field), `listOutputs`, `internalizeAction`
- **BRC-64/65**: Certificate structure in `acquireCertificate`, `listCertificates`
