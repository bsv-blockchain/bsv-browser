# Self-Custodial Wallet Implementation

## Overview

BSV Browser uses a fully self-custodial wallet. Users maintain complete control of their funds using a BIP-39 mnemonic seed phrase. All key material is stored locally on the device -- there is no backend authentication service.

> **Note:** An earlier version of the app supported WAB (Wallet Authentication Base) for server-assisted authentication. WAB has been removed. The codebase contains TODO comments about re-adding WAB support in a future version if needed.

## Architecture

### Key Derivation

The implementation uses standard BIP-39 / BIP-32:

1. **Mnemonic -> Seed**: BIP-39 spec (12-word mnemonic)
2. **Seed -> HD Key**: BIP-32 spec
3. **HD Key -> Primary Key**: Derivation path `m/0'/0'` (hardened)

This ensures compatibility with other BIP-39/BIP-32 wallets.

### Wallet Construction

The wallet is built using `SimpleWalletManager` from `@bsv/wallet-toolbox-mobile`:

1. A primary key is derived from the mnemonic (or provided directly as a hex private key)
2. A `PrivilegedKeyManager` is created from the same key
3. `SimpleWalletManager` is initialized with local SQLite storage (`StorageExpoSQLite`)
4. A `WalletPermissionsManager` is attached for web-app permission gating
5. A `Monitor` subscribes to ARC SSE for real-time transaction status updates

### Storage

- **Mnemonic / key**: Encrypted and stored in `expo-secure-store` (hardware-backed on supported devices)
- **Wallet data**: SQLite database via `expo-sqlite` (see `storage/README.md`)
- **Preferences**: `@react-native-async-storage/async-storage`

## Authentication Flow

### New Wallet Creation

```
User taps "Create New Wallet"
  -> App generates 12-word BIP-39 mnemonic
  -> Mnemonic displayed with backup options:
       - Save as file (share sheet)
       - Copy to clipboard
       - Print Recovery Shares (Shamir's Secret Sharing)
  -> User confirms they saved the phrase
  -> Wallet built from mnemonic and ready
```

**File:** `app/auth/mnemonic.tsx` (mode: `generate`)

### Import Existing Wallet

```
User taps "Import Existing Wallet"
  -> Text input for:
       - 12-24 word mnemonic phrase, OR
       - 64-character hex private key
  -> Validation and wallet build
```

**File:** `app/auth/mnemonic.tsx` (mode: `import`)

### Recover from Backup Shares

```
User taps "Scan Backup Shares"
  -> Camera opens for QR scanning
  -> User scans 2 of 3 Shamir shares
  -> Private key reconstructed
  -> Wallet built from recovered key
```

**File:** `app/auth/scan-shares.tsx`

## Key Files

| File                           | Purpose                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| `app/auth/mnemonic.tsx`        | Wallet create/import screen (mnemonic or hex key)             |
| `app/auth/scan-shares.tsx`     | QR camera scanner for backup share recovery                   |
| `utils/mnemonicWallet.ts`      | BIP-39/32 mnemonic generation, recovery, validation           |
| `utils/simpleWalletBuilder.ts` | Wallet construction from primary key                          |
| `utils/backupShares.ts`        | Shamir's Secret Sharing -- split key into printable QR shares |
| `context/WalletContext.tsx`    | Wallet lifecycle, permissions, SSE monitor                    |
| `context/config.tsx`           | Default configuration (`DEFAULT_WAB_URL = 'noWAB'`)           |
| `storage/StorageExpoSQLite.ts` | SQLite wallet storage adapter                                 |

## Backup Options

### Mnemonic Phrase

The 12-word mnemonic can be:

- **Saved as a file** via the OS share sheet
- **Copied to clipboard** for pasting elsewhere

### Shamir's Secret Sharing (Recovery Shares)

The primary key (derived from the mnemonic at `m/0'/0'`) is split into **2-of-3 shares** using `PrivateKey.toBackupShares()`. Each share is printed as a page with:

- A QR code encoding the share data
- A QR code encoding the identity key
- Written recovery instructions

Users print 3 pages and store them in separate locations. Any 2 of the 3 can reconstruct the private key.

**File:** `utils/backupShares.ts`

### Database Export

The entire wallet SQLite database can be exported as a timestamped `.db` file and later imported on another device or after a reinstall.

**Files:** `utils/exportDatabases.ts`, `utils/importDatabases.ts`

## Security Considerations

1. **Mnemonic storage** -- encrypted at rest in `expo-secure-store`, which uses Keychain (iOS) or EncryptedSharedPreferences (Android)
2. **No remote storage** -- all wallet data is local. No keys or wallet state are sent to any server.
3. **Permission system** -- web apps must request and receive user approval before accessing wallet operations (spending, certificates, identity, etc.)
4. **Key loss** -- losing both the mnemonic and all backup shares means permanent loss of funds. The app warns users about this during wallet creation.

## API Reference

### `generateMnemonicWallet()`

```typescript
import { generateMnemonicWallet } from '@/utils/mnemonicWallet'

const { mnemonic, primaryKey, identityKey } = generateMnemonicWallet()
```

### `recoverMnemonicWallet(mnemonic)`

```typescript
import { recoverMnemonicWallet, validateMnemonic } from '@/utils/mnemonicWallet'

if (!validateMnemonic(userMnemonic)) {
  // Invalid mnemonic
  return
}

const { primaryKey, identityKey } = recoverMnemonicWallet(userMnemonic)
```

### `generateBackupShares(primaryKey)`

```typescript
import { generateBackupShares } from '@/utils/backupShares'

const shares = generateBackupShares(primaryKey) // Returns 3 share strings
```

### `recoverKeyFromShares(shares)`

```typescript
import { recoverKeyFromShares } from '@/utils/backupShares'

const privateKey = recoverKeyFromShares([share1, share2]) // Any 2 of 3
```

## References

- [BIP-39 Specification](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)
- [BIP-32 Specification](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki)
- [@bsv/sdk Documentation](https://docs.bsvblockchain.org/sdk/)
- `SimpleWalletManager`: `@bsv/wallet-toolbox-mobile`
