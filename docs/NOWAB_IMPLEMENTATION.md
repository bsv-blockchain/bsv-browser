# noWAB (Self-Custodial) Wallet Implementation

## Overview

The noWAB feature provides a fully self-custodial wallet option that doesn't require any backend authentication services. Users maintain complete control using a BIP39 mnemonic seed phrase.

## Implementation Status

### ✅ Phase 1: Core Infrastructure (COMPLETED)

1. **Configuration Option Added**
   - [components/WalletConfigPicker.tsx](../components/WalletConfigPicker.tsx)
   - "Self-Custodial Wallet" option with `wabUrl: 'noWAB'` and `storageUrl: 'local'`
   - Prominent display as first option with primary color styling
   - Skips WAB verification for noWAB configs

2. **Mnemonic Wallet Utilities**
   - [utils/mnemonicWallet.ts](../utils/mnemonicWallet.ts)
   - Generate new mnemonic wallets
   - Recover from existing mnemonic
   - Validate mnemonic phrases
   - Uses @bsv/sdk `Mnemonic` and `HD` classes
   - Derives primary key at BIP32 path `m/0'/0'`

3. **Simple Wallet Builder**
   - [utils/simpleWalletBuilder.ts](../utils/simpleWalletBuilder.ts)
   - Creates wallet from primary key + privileged key manager
   - Compatible with `SimpleWalletManager` API
   - Supports local storage only (no remote storage)

4. **Context Integration**
   - [context/WalletContext.tsx](../context/WalletContext.tsx)
   - Added `SimpleWalletManager` import
   - Added `isNoWABMode` flag
   - Ready for noWAB wallet management

### 🚧 Phase 2: Authentication Flow (IN PROGRESS)

The following components need to be created or modified:

#### 1. Mnemonic Setup Screen

**File to create:** `app/auth/mnemonic-setup.tsx`

**Purpose:** Handle new wallet creation and mnemonic recovery

**Features:**
- Generate new 12-word mnemonic
- Display mnemonic for backup
- Confirm user has backed up mnemonic
- Or allow paste of existing mnemonic
- Validate mnemonic format

**Flow:**
```
User selects "Self-Custodial Wallet"
  ↓
Generate/Import Mnemonic Screen
  ↓
Backup Confirmation Screen
  ↓
Create Privileged Key Manager
  ↓
Initialize SimpleWalletManager
  ↓
Wallet Ready
```

#### 2. WalletContext Updates

**File to modify:** `context/WalletContext.tsx`

**Required Changes:**

```typescript
// Add state for storing encrypted mnemonic
const [encryptedMnemonic, setEncryptedMnemonic] = useState<string | null>(null)

// Modified auth initialization
useEffect(() => {
  if (isNoWABMode) {
    // Initialize SimpleWalletManager
    initializeSimpleWallet()
  } else {
    // Existing WAB initialization
    initializeWABWallet()
  }
}, [isNoWABMode, selectedNetwork])

async function initializeSimpleWallet() {
  const walletBuilder = createSimpleWalletBuilder({
    chain: selectedNetwork,
    useLocalStorage: true
  })

  const simpleManager = new SimpleWalletManager(
    adminOriginator,
    walletBuilder,
    // Optional: pass snapshot if resuming
  )

  // Provide primary key (from mnemonic)
  if (encryptedMnemonic) {
    const mnemonic = decryptMnemonic(encryptedMnemonic)
    const { primaryKey, identityKey } = recoverMnemonicWallet(mnemonic)
    await simpleManager.providePrimaryKey(primaryKey)
  }

  // Provide privileged key manager
  const privilegedKeyManager = new PrivilegedKeyManager(/* ... */)
  await simpleManager.providePrivilegedKeyManager(privilegedKeyManager)

  // Set up permissions
  // ... similar to existing buildWallet logic
}
```

#### 3. Snapshot Management

**Changes needed:**
- WAB mode: Store presentation key backup + password
- noWAB mode: Store encrypted mnemonic + SimpleWalletManager snapshot

**Storage strategy:**
```typescript
interface NoWABSnapshot {
  type: 'noWAB'
  encryptedMnemonic: string // Encrypted with device key
  walletSnapshot: number[] // SimpleWalletManager.saveSnapshot()
  network: 'main' | 'test'
}

interface WABSnapshot {
  type: 'WAB'
  snap: number[] // Existing presentation key backup
  wabUrl: string
  method: string
}

type WalletSnapshot = NoWABSnapshot | WABSnapshot
```

### 🔮 Phase 3: UI Components (TODO)

#### Components to Create:

1. **MnemonicGenerateScreen** (`components/MnemonicGenerateScreen.tsx`)
   - Display newly generated mnemonic
   - Copy to clipboard button
   - Warning about backup importance
   - Continue button (disabled until confirmed)

2. **MnemonicConfirmScreen** (`components/MnemonicConfirmScreen.tsx`)
   - Ask user to confirm random words from mnemonic
   - Ensures user has backed up properly

3. **MnemonicRecoverScreen** (`components/MnemonicRecoverScreen.tsx`)
   - Text input for mnemonic
   - Word suggestions (BIP39 word list)
   - Validation feedback
   - Support for 12, 15, 18, 21, or 24 words

4. **MnemonicBackupPrompt** (`components/MnemonicBackupPrompt.tsx`)
   - Modal showing importance of backup
   - "I understand" checkbox
   - "Show me my mnemonic" button

### 📋 Implementation Checklist

- [x] Add noWAB configuration option
- [x] Create mnemonic utilities
- [x] Create simple wallet builder
- [x] Import SimpleWalletManager
- [x] Add isNoWABMode flag
- [ ] Create mnemonic setup screen
- [ ] Update WalletContext for noWAB initialization
- [ ] Implement mnemonic encryption/storage
- [ ] Create mnemonic UI components
- [ ] Update snapshot management for noWAB
- [ ] Skip phone/OTP/password screens for noWAB
- [ ] Add mnemonic recovery flow
- [ ] Test wallet creation
- [ ] Test wallet recovery
- [ ] Test transactions in noWAB mode
- [ ] Add mnemonic backup reminders

## Technical Details

### Mnemonic Generation

```typescript
import { generateMnemonicWallet } from '@/utils/mnemonicWallet'

const { mnemonic, primaryKey, identityKey } = generateMnemonicWallet()

// Display mnemonic to user for backup
console.log('Backup these 12 words:', mnemonic)

// Use primaryKey to initialize wallet
await simpleManager.providePrimaryKey(primaryKey)
```

### Mnemonic Recovery

```typescript
import { recoverMnemonicWallet, validateMnemonic } from '@/utils/mnemonicWallet'

const userMnemonic = "word1 word2 word3..." // From user input

if (!validateMnemonic(userMnemonic)) {
  alert('Invalid mnemonic phrase')
  return
}

const { primaryKey, identityKey } = recoverMnemonicWallet(userMnemonic)
await simpleManager.providePrimaryKey(primaryKey)
```

### Key Derivation

The implementation uses standard BIP39/BIP32:

1. **Mnemonic → Seed**: BIP39 spec
2. **Seed → HD Key**: BIP32 spec
3. **HD Key → Primary Key**: Derivation path `m/0'/0'` (hardened)

This ensures compatibility with other BIP39/BIP32 wallets.

### Security Considerations

1. **Mnemonic Storage**
   - MUST be encrypted at rest
   - Use device secure storage (expo-secure-store)
   - Consider biometric protection

2. **Mnemonic Display**
   - Show only once during creation
   - Screenshot prevention (if possible)
   - Clear warnings about backup

3. **Recovery**
   - Require full mnemonic for recovery
   - No partial recovery
   - Validate before accepting

## User Experience

### New Wallet Flow (noWAB)

1. User selects "Self-Custodial Wallet"
2. App generates 12-word mnemonic
3. User shown mnemonic with backup instructions
4. User confirms backup (word verification)
5. Wallet created and ready

**Time:** ~2 minutes (including backup)

### Existing Wallet Recovery (noWAB)

1. User selects "Self-Custodial Wallet"
2. User chooses "Recover from mnemonic"
3. User enters 12-word mnemonic
4. App validates and recovers wallet
5. Wallet ready

**Time:** ~30 seconds

### Comparison with WAB Mode

| Feature | WAB Mode | noWAB Mode |
|---------|----------|------------|
| Phone number | Required | Not needed |
| OTP verification | Required | Not needed |
| Password | Required | Not needed |
| Backend service | Required | Not needed |
| Account recovery | Phone + OTP | Mnemonic only |
| Setup time | ~5 minutes | ~2 minutes |
| Privacy | Medium | Maximum |
| Control | Shared | Complete |

## Future Enhancements

1. **Multi-device Sync**
   - Optional encrypted cloud backup of mnemonic
   - QR code transfer between devices

2. **Advanced Features**
   - Custom derivation paths
   - Multiple accounts from one mnemonic
   - Passphrase protection (BIP39)

3. **Security**
   - Hardware wallet integration
   - Shamir's Secret Sharing for mnemonic backup
   - Time-locked recovery options

## Testing

### Manual Test Cases

1. **New Wallet Creation**
   - [ ] Generate mnemonic
   - [ ] Display mnemonic
   - [ ] Confirm backup
   - [ ] Create wallet
   - [ ] Make transaction

2. **Wallet Recovery**
   - [ ] Enter mnemonic
   - [ ] Validate mnemonic
   - [ ] Recover wallet
   - [ ] Access previous transactions

3. **Error Handling**
   - [ ] Invalid mnemonic
   - [ ] Incomplete mnemonic
   - [ ] Wrong word count
   - [ ] Network errors

## References

- [BIP39 Specification](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)
- [BIP32 Specification](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki)
- [@bsv/sdk Documentation](https://docs.bsvblockchain.org/sdk/)
- SimpleWalletManager: `@bsv/wallet-toolbox-mobile/out/src/SimpleWalletManager`

## Notes

- The noWAB implementation provides a true self-custodial experience
- Users have complete control but also complete responsibility
- Losing the mnemonic means losing access to funds permanently
- This is the recommended option for maximum privacy and sovereignty
