# BSV Browser

A mobile browser that brings identity, micropayments, and BSV-powered websites to iOS and Android. Built with React Native + Expo, it runs a WebView-based substrate that lets web apps communicate with an on-device BSV wallet.

**Key capabilities:**

- Self-custodial BSV wallet (BIP-39 mnemonic) with local SQLite storage
- Web2/Web3 dual mode -- browse normally or with wallet identity and payments
- CWI (Computing With Integrity) provider for web apps (BRC-100 compliant)
- Permission-gated access for web apps requesting wallet operations
- Peer-to-peer payments via MessageBox with identity resolution
- Local Payments -- BLE (Bluetooth Low Energy) peer-to-peer transfers between nearby phones
- Legacy Bridge for sending/receiving via traditional P2PKH addresses
- Trust and identity management (BRC-68 certifiers)
- Shamir's Secret Sharing backup -- split your key into printable QR shares
- Database import/export for full wallet backup and migration
- Multi-network support (mainnet, testnet, teratest)
- Background transaction monitoring via ARC SSE (Server-Sent Events)
- Deep linking for `http` / `https` URLs
- 10 languages supported

## Table of Contents

- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Available Scripts](#available-scripts)
- [Project Structure](#project-structure)
- [Architecture](#architecture)
- [Environment Variables](#environment-variables)
- [Code Style](#code-style)
- [Contributing](#contributing)
- [Building for Devices](#building-for-devices)
- [Native Rebuild Requirements](#native-rebuild-requirements)
- [Publishing Your Own Version](#publishing-your-own-version)
- [Supported Languages](#supported-languages)
- [License](#license)

## Prerequisites

| Tool               | Notes                                                     |
| ------------------ | --------------------------------------------------------- |
| **Node.js**        | LTS recommended (the project has no `engines` constraint) |
| **npm**            | Ships with Node                                           |
| **Expo CLI**       | Installed automatically via `npx expo`                    |
| **EAS CLI**        | `npm i -g eas-cli` -- needed for device builds            |
| **Xcode**          | Required for iOS simulator / device builds (macOS only)   |
| **Android Studio** | Required for Android emulator / device builds             |
| **Watchman**       | Recommended on macOS (`brew install watchman`)            |

## Getting Started

```bash
# 1. Clone the repo
git clone https://github.com/bsv-blockchain/bsv-browser.git
cd bsv-browser

# 2. Install dependencies
npm install

# 3. (Optional) Create a .env.local for API keys -- see "Environment Variables" below
#    The app works without one; defaults are defined in context/config.tsx

# 4. Start the dev server
npm start                    # opens Expo dev-client menu
```

On first launch the app starts in **Web2 mode** -- a normal browser with no wallet. To enable Web3 features:

1. Open the menu and tap **Create New Wallet** or **Import Existing Wallet**
2. If creating: the app generates a 12-word BIP-39 mnemonic -- back it up securely
3. If importing: paste an existing mnemonic phrase, a 64-character hex private key, or scan Shamir backup shares via QR code

Once a wallet is active the app switches to **Web3 mode** and BSV-enabled web apps will work inside the browser.

> **Note:** The app uses a **development build** (Expo dev-client), not Expo Go.
> You must create a dev build first -- see [Building for Devices](#building-for-devices).

## Available Scripts

| Script                 | Description                                             |
| ---------------------- | ------------------------------------------------------- |
| `npm start`            | Start the Expo dev server (`expo start --dev-client`)   |
| `npm run android`      | Start on a connected Android device / emulator          |
| `npm run ios`          | Start on a connected iOS device / simulator             |
| `npm run web`          | Start the web version                                   |
| `npm run lint`         | Run ESLint                                              |
| `npm run lint:fix`     | Run ESLint with auto-fix                                |
| `npm run format`       | Format all files with Prettier                          |
| `npm run format:check` | Check formatting without writing                        |
| `npm run fix`          | Run `format` then `lint:fix`                            |
| `npm run clean`        | Delete generated caches and build artifacts             |
| `npm run version`      | Bump version in package.json + app.json, commit and tag |

### Device / Store Builds

| Script                                 | Description                          |
| -------------------------------------- | ------------------------------------ |
| `npm run android-dev-build`            | Local EAS dev-client build (Android) |
| `npm run android-apk`                  | Local EAS preview APK build          |
| `npm run android-build-for-play-store` | Local EAS production AAB build       |
| `npm run ios-dev-build`                | Local EAS dev-client build (iOS)     |
| `npm run ios-build-for-app-store`      | Local EAS production build (iOS)     |

## Project Structure

```
bsv-browser/
├── app/                    # Expo Router screens (file-based routing)
│   ├── _layout.tsx         #   Root layout -- context providers + Stack navigator
│   ├── index.tsx           #   Home / browser screen
│   ├── auth/               #   Mnemonic & recovery-share auth flows
│   ├── payments.tsx        #   Peer-to-peer payments (send/receive via MessageBox)
│   ├── local-payments.tsx  #   Local Payments (BLE P2P transfer between nearby phones)
│   ├── legacy-payments.tsx #   Legacy Bridge (P2PKH receive addresses + send to address)
│   ├── transactions.tsx    #   Transaction history
│   ├── settings.tsx        #   Settings screen
│   ├── trust.tsx           #   Trust management
│   └── wallet-config.tsx   #   Network / wallet config picker
├── components/
│   ├── browser/            #   Address bar, tabs, bookmarks, history, permissions
│   ├── onboarding/         #   Default-browser prompt, Web3 benefits modal
│   ├── ui/                 #   Shared UI primitives (Sheet, GroupedList, ErrorBoundary, etc.)
│   └── wallet/             #   Balance, amount input, authorization modals
├── context/                # React context providers
│   ├── config.tsx          #   Default configuration constants
│   ├── i18n/               #   Translations (10 languages)
│   ├── theme/              #   Theme tokens and context
│   ├── WalletContext.tsx   #   Wallet initialization, permissions, SSE monitor
│   ├── UserContext.tsx     #   User / auth state
│   ├── BrowserModeContext.tsx # Web2/Web3 mode toggle (auto-switches on auth)
│   ├── ExchangeRateContext.tsx # BSV/fiat exchange rates
│   └── ...                 #   Sheets, local storage
├── hooks/                  # Custom React hooks (deep linking, history, permissions, etc.)
├── stores/                 # MobX stores (bookmarks, tabs)
├── storage/                # SQLite-backed wallet storage adapter
│   ├── schema/             #   Table creation SQL
│   └── methods/            #   Query builders for actions & outputs
├── wallet/                 # Wallet integration layer
├── shared/                 # Shared constants and types (search engines, default bookmarks)
├── utils/                  # Helpers -- crypto, permissions, logging, webview injection
│   ├── ble/                #   BLE local payments -- chunking, peripheral, central, pending queue
│   ├── webview/            #   Injected polyfills, message router, CWI provider, download handler
│   ├── backupShares.ts     #   Shamir Secret Sharing for printable key recovery
│   ├── mnemonicWallet.ts   #   BIP-39/32 mnemonic key derivation
│   ├── importDatabases.ts  #   Import wallet database from file
│   └── exportDatabases.ts  #   Export wallet database for backup
├── types/                  # Global TypeScript declarations
├── scripts/                # Shell / Node helper scripts (configure, version)
├── credentials/            # Signing keystores (Android)
├── docs/                   # GitHub Pages marketing site + design docs (LOCAL_PAYMENTS.md, NOWAB_IMPLEMENTATION.md)
├── funding-app/            # Standalone Vite app for funding (builds into docs/)
└── assets/                 # App icons, splash screens, favicons
```

## Architecture

The app boots through `index.js`, which installs `react-native-quick-crypto` as a global `crypto` polyfill before any BSV SDK code runs. Expo Router then takes over.

The root layout (`app/_layout.tsx`) nests context providers in this order:

```
GestureHandlerRootView
  └─ ErrorBoundary
       └─ LanguageProvider (i18n)
            └─ LocalStorageProvider
                 └─ UserContextProvider
                      └─ ExchangeRateContextProvider
                           └─ WalletContextProvider
                                └─ BrowserModeProvider
                                     └─ ThemeProvider
```

**State management** uses MobX for browser-level state (tabs, bookmarks) and React Context for wallet, user, and UI state.

**Wallet** is fully self-custodial. Keys are derived from a BIP-39 mnemonic at path `m/0'/0'` (hardened). The mnemonic is stored in `expo-secure-store`. The wallet is built using `@bsv/wallet-toolbox-mobile`'s `SimpleWalletManager`.

**Wallet storage** is backed by `expo-sqlite` with a schema defined in `storage/schema/createTables.ts`. See `storage/README.md` for detailed documentation.

**CWI Provider** (`utils/webview/cwiProvider.ts`) exposes `window.CWI` to web apps inside the browser. This implements the BRC-100 wallet interface, including `createAction`, `signAction`, `listActions`, `getPublicKey`, `encrypt`/`decrypt`, `createSignature`/`verifySignature`, `acquireCertificate`/`listCertificates`, and identity discovery methods. All operations go through a permission system with user-facing approval modals.

**WebView communication** happens via injected polyfills (`utils/webview/`) that bridge web-app wallet requests to the native wallet layer through a message router. Custom user-agent spoofing and media polyfills ensure compatibility with sites that use bot detection or advanced media APIs.

**Background monitoring** -- a `Monitor` instance subscribes to ARC SSE (Server-Sent Events) for real-time transaction status updates. Missed events are fetched when the app returns from the background.

**Web2/Web3 dual mode** -- the app starts in Web2 mode (a plain browser). Creating or importing a wallet automatically switches to Web3 mode, enabling the CWI provider, payments, and identity features. Users can toggle modes manually.

**Metro** is configured with crypto polyfills (`react-native-quick-crypto`, `stream-browserify`, `buffer`) and special COOP/COEP headers for SharedArrayBuffer support (required by `expo-sqlite` on web).

## Environment Variables

Create a `.env.local` file in the project root. The app reads `EXPO_PUBLIC_*` variables at build time.

| Variable                             | Purpose                                  | Default                              |
| ------------------------------------ | ---------------------------------------- | ------------------------------------ |
| `EXPO_PUBLIC_DEFAULT_WAB_URL`        | Reserved for future WAB support          | `noWAB` (self-custodial, hardcoded)  |
| `EXPO_PUBLIC_DEFAULT_STORAGE_URL`    | Reserved for future remote storage       | `local` (local-only, hardcoded)      |
| `EXPO_PUBLIC_DEFAULT_MESSAGEBOX_URL` | MessageBox service URL                   | `https://messagebox.babbage.systems` |
| `EXPO_PUBLIC_DEFAULT_CHAIN`          | Network: `main`, `test`, or `teratest`   | `main`                               |
| `EXPO_PUBLIC_DEFAULT_HOMEPAGE`       | Default browser homepage URL             | --                                   |
| `EXPO_PUBLIC_ADMIN_ORIGINATOR`       | Admin originator identifier              | `admin.com`                          |
| `EXPO_PUBLIC_ARC_URL`                | ARC transaction processor URL (mainnet)  | --                                   |
| `EXPO_PUBLIC_CHAINTRACKS_URL`        | Chaintracks block explorer URL (mainnet) | --                                   |
| `EXPO_PUBLIC_WOC_API_KEY`            | WhatsOnChain API key                     | --                                   |
| `EXPO_PUBLIC_TAAL_API_KEY`           | TAAL API key                             | --                                   |

Testnet variants use `_TEST_` infix (e.g. `EXPO_PUBLIC_TEST_ARC_URL`). Teratest uses `_TERATEST_` infix.

Production values are set in `eas.json` under the `production` build profile and override `.env.local`.

## Code Style

The project uses **ESLint** (v9, flat config) with `eslint-config-expo` and **Prettier** for formatting.

Key Prettier rules (`.prettierrc`):

- No semicolons
- Single quotes
- No trailing commas
- 120-character line width
- 2-space indentation
- LF line endings

Run `npm run fix` before committing to auto-format and auto-fix lint issues.

## Contributing

Contributions are welcome. Here's how to get started:

1. **Fork** the repository and create a feature branch from `master`.
2. **Install** dependencies with `npm install`.
3. **Make your changes.** Follow the existing code style -- run `npm run fix` before committing.
4. **Test on-device.** Create a dev build (`npm run ios-dev-build` or `npm run android-dev-build`) and verify your changes work on a real device or emulator.
5. **Open a pull request** against `master` with a clear description of what you changed and why.

### Commit style

Keep commit messages short and imperative, lowercase, and focused on the change:

```
add new permission modal for camera access
fix balance display rounding on transactions screen
refactor tab store to use async initialization
```

### Where to look

| Area                     | Key files                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| Adding a new screen      | `app/` -- add a new `.tsx` file; Expo Router picks it up automatically                              |
| Modifying browser chrome | `components/browser/`                                                                               |
| Wallet logic             | `context/WalletContext.tsx`, `utils/simpleWalletBuilder.ts`, `storage/`                             |
| Auth / mnemonic          | `app/auth/mnemonic.tsx`, `utils/mnemonicWallet.ts`                                                  |
| CWI provider             | `utils/webview/cwiProvider.ts`                                                                      |
| WebView bridge           | `utils/webview/messageRouter.ts`, `utils/webview/injectedPolyfills.ts`                              |
| Permissions              | `utils/permissionsManager.ts`, `hooks/usePermissions.ts`                                            |
| Payments                 | `app/payments.tsx` (P2P), `app/local-payments.tsx` (BLE), `app/legacy-payments.tsx` (Legacy Bridge) |
| Backup / recovery        | `utils/backupShares.ts`, `app/auth/scan-shares.tsx`                                                 |
| DB import/export         | `utils/importDatabases.ts`, `utils/exportDatabases.ts`                                              |
| Translations             | `context/i18n/translations.tsx` -- add your language code to the table                              |
| Theming                  | `context/theme/tokens.ts`, `context/theme/ThemeContext.tsx`                                         |
| State (tabs/bookmarks)   | `stores/TabStore.tsx`, `stores/BookmarkStore.tsx`                                                   |

## Building for Devices

The app uses **EAS Build** to create native binaries locally. You need the EAS CLI installed (`npm i -g eas-cli`).

### iOS (macOS only)

```bash
# Create a development build
npm run ios-dev-build

# The build produces a .tar.gz archive. Double-click it to extract the .app,
# then drag the .app onto the iOS Simulator window to install it.

# Start the dev server and connect
npm run ios
```

### Android

```bash
# Create a development build
npm run android-dev-build

# The APK will be output locally -- install it via adb
adb install build-*.apk

# Start the dev server and connect
npm run android
```

### Production builds

```bash
npm run ios-build-for-app-store
npm run android-build-for-play-store
```

## Native Rebuild Requirements

Some features use native libraries that require a full native rebuild (not just a Metro restart). After adding or updating these dependencies, run:

```bash
# iOS
npx expo prebuild --platform ios --clean
npx expo run:ios --device

# Android
npx expo prebuild --platform android --clean
npx expo run:android --device
```

The `--clean` flag regenerates the native projects from scratch, ensuring all native modules, `patch-package` patches, and `app.json` plugin configs are picked up.

**Features requiring native rebuilds:**

| Feature              | Native Dependencies                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Local Payments (BLE) | `munim-bluetooth`, `react-native-ble-plx`, `react-native-nitro-modules`, `@react-native-community/netinfo` |
| Wallet storage       | `expo-sqlite`                                                                                              |
| Secure key storage   | `expo-secure-store`                                                                                        |
| Crypto polyfill      | `react-native-quick-crypto`                                                                                |

**When is a rebuild needed?**

- After `npm install` adds a package with native code
- After modifying files in `patches/` (applied via `patch-package` postinstall)
- After changing `app.json` plugin configurations (e.g. BLE permissions, Expo plugins)

**When is a rebuild NOT needed?**

- Changes to JS/TS source files only -- Metro hot-reload is sufficient
- Changes to translations, styles, or React component logic

See [`docs/LOCAL_PAYMENTS.md`](docs/LOCAL_PAYMENTS.md) for detailed documentation on the BLE local payments architecture.

## Publishing Your Own Version

If you want to fork this project and release your own version on the Apple App Store and Google Play Store, you need to create your own Expo project, generate signing credentials, and replace the identifiers in the config files.

### 1. Create an Expo account and project

1. Sign up at [expo.dev](https://expo.dev).
2. Create a new project in the Expo dashboard. This gives you an **EAS project ID** and an **owner** slug.

### 2. Replace identifiers in `app.json`

Open `app.json` and change the following fields to match your own project:

| Field                       | Current value                            | What to change it to                                         |
| --------------------------- | ---------------------------------------- | ------------------------------------------------------------ |
| `expo.name`                 | `"BSV Browser"`                          | Your app's display name                                      |
| `expo.slug`                 | `"bsv-browser"`                          | Your Expo project slug (must match the dashboard)            |
| `expo.scheme`               | `"bsv-browser"`                          | Your app's URI scheme for deep links                         |
| `expo.owner`                | `"bsvb"`                                 | Your Expo account username or organization slug              |
| `expo.extra.eas.projectId`  | `"435e9e20-dd2a-4be5-8684-af5809f913bb"` | Your EAS project ID from the Expo dashboard                  |
| `expo.android.package`      | `"org.bsvassociation.browser"`           | Your Android application ID (e.g. `com.yourcompany.browser`) |
| `expo.ios.bundleIdentifier` | `"org.bsvassociation.browser"`           | Your iOS bundle identifier (e.g. `com.yourcompany.browser`)  |

The Android package and iOS bundle identifier must be unique across the Play Store and App Store respectively. Once published, they cannot be changed.

### 3. Set up iOS credentials

EAS can manage iOS credentials for you. Run:

```bash
eas credentials -p ios
```

This will walk you through:

- **Apple Developer account** -- you need a paid [Apple Developer Program](https://developer.apple.com/programs/) membership ($99/year).
- **Distribution certificate** -- EAS will create one or let you upload an existing `.p12`.
- **Provisioning profile** -- EAS generates this automatically, tied to your bundle identifier.

For App Store submissions, EAS handles code signing automatically during `eas build --profile production`. You do not need to manually manage certificates unless you prefer to.

### 4. Set up Android credentials

For Android you need a **keystore** to sign your APK/AAB. EAS can generate one for you:

```bash
eas credentials -p android
```

This will either:

- **Generate a new keystore** -- EAS creates and securely stores it for you, or
- **Let you upload an existing keystore** -- if you already have a `.jks` or `.keystore` file.

The repository includes a `credentials/android/keystore.jks` for the official BSV Browser build. **Do not use this keystore for your own release.** Generate your own and keep it safe -- if you lose your upload keystore, you cannot update your app on the Play Store.

To upload to the Play Store you also need a [Google Play Developer account](https://play.google.com/console/) ($25 one-time fee) and must create your app listing in the Play Console before your first submission.

### 5. Update production environment variables

Edit the `production` env block in `eas.json` to point to your own infrastructure:

```jsonc
// eas.json → build → production → env
{
  "EXPO_PUBLIC_DEFAULT_MESSAGEBOX_URL": "https://your-messagebox.example.com",
  "EXPO_PUBLIC_DEFAULT_CHAIN": "main",
  "EXPO_PUBLIC_ADMIN_ORIGINATOR": "yourdomain.com",
  "EXPO_PUBLIC_DEFAULT_HOMEPAGE": "https://your-homepage.example.com"
}
```

### 6. Build and submit

```bash
# iOS -- builds an IPA and submits to App Store Connect
eas build --profile production --platform ios
eas submit -p ios

# Android -- builds an AAB and submits to Google Play
eas build --profile production --platform android
eas submit -p android
```

The `eas submit` commands will prompt you for your App Store Connect / Google Play credentials on first use. You can also run builds locally with the `--local` flag (which is what the npm scripts in this repo do).

### Summary of files you need to touch

| File        | Fields to change                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------- |
| `app.json`  | `name`, `slug`, `scheme`, `owner`, `extra.eas.projectId`, `android.package`, `ios.bundleIdentifier` |
| `eas.json`  | `production.env.*` values (messagebox URL, chain, homepage, etc.)                                   |
| Credentials | Run `eas credentials` for both platforms -- do **not** reuse the included keystore                  |

## Supported Languages

The app is localised into the following languages using `react-i18next`:

| Code | Language             |
| ---- | -------------------- |
| `en` | English              |
| `zh` | Chinese (Simplified) |
| `hi` | Hindi                |
| `es` | Spanish              |
| `fr` | French               |
| `ar` | Arabic               |
| `pt` | Portuguese           |
| `bn` | Bengali              |
| `ru` | Russian              |
| `id` | Indonesian           |

Translations live in `context/i18n/translations.tsx`. The device locale is detected automatically via `expo-localization` and falls back to English.

To add a new language, add a new key to the translations object and include it in the language table above.

## License

The code in this repository is licensed under the [Open BSV License v4](LICENSE.txt). Software and derivatives may only be used on the BSV blockchain and its test networks.
