# Storage Layer Architecture Analysis
## Session: StorageExpoSQLite Rewrite Analysis
## Date: 2026-02-24

## Summary
Comprehensive analysis of the @bsv/wallet-toolbox-mobile storage class hierarchy to determine exactly what StorageExpoSQLite must implement to properly extend StorageProvider.

## Package Structure
- Only `@bsv/wallet-toolbox-mobile` is present in node_modules (no `@bsv/wallet-toolbox`)
- StorageKnex does NOT exist in wallet-toolbox-mobile (it's server-only, not shipped)
- The mobile package exports from `index.mobile.js`: WalletStorageManager, StorageProvider, StorageSyncReader, tables, entities, StorageMobile

## Class Hierarchy
```
StorageReader (abstract)
  └─ StorageReaderWriter (abstract)
       └─ StorageProvider (abstract)
            └─ StorageIdb (concrete - IndexedDB)
            └─ StorageExpoSQLite (concrete - what we need to build)
```

## File Locations
- StorageReader.d.ts: node_modules/@bsv/wallet-toolbox-mobile/out/src/storage/StorageReader.d.ts
- StorageReaderWriter.d.ts: node_modules/@bsv/wallet-toolbox-mobile/out/src/storage/StorageReaderWriter.d.ts
- StorageProvider.d.ts: node_modules/@bsv/wallet-toolbox-mobile/out/src/storage/StorageProvider.d.ts
- StorageIdb.d.ts: node_modules/@bsv/wallet-toolbox-mobile/out/src/storage/StorageIdb.d.ts
- Current StorageExpoSQLite: storage/StorageExpoSQLite.ts (NOT extending StorageProvider - standalone class)
- Current StorageExpoSQLiteImpl: storage/StorageExpoSQLiteImpl.ts (prototype extension pattern - wrong approach)

## Current Problem
The current `StorageExpoSQLite` does NOT extend `StorageProvider`. It is a completely standalone class. This means:
1. It misses all the complex business logic in StorageProvider (createAction, processAction, internalizeAction, etc.)
2. It misses StorageReaderWriter convenience methods (findOrInsert*, setActive, tagOutput)
3. It misses StorageReader utility methods (validateEntityDate, getSyncChunk, findUserByIdentityKey)
4. The `WalletStorageManager` cannot use it properly as a storage backend

## CORRECT APPROACH
StorageExpoSQLite MUST extend StorageProvider:
```typescript
import { StorageProvider, StorageProviderOptions } from '@bsv/wallet-toolbox-mobile'
export class StorageExpoSQLite extends StorageProvider {
  constructor(options: StorageProviderOptions) { super(options) }
  // ... implement only the abstract methods listed below
}
```

---

## METHODS ALREADY PROVIDED (DO NOT REIMPLEMENT)

### From StorageReader (inherited for free)
- `isAvailable(): boolean` - checks if `_settings` is set
- `makeAvailable(): Promise<TableSettings>` - calls readSettings() and caches result
- `getSettings(): TableSettings` - returns cached settings
- `isStorageProvider(): boolean` - returns false (overridden by StorageProvider)
- `findUserByIdentityKey(key: string)` - calls findUsers({ partial: { identityKey: key } })
- `getSyncChunk(args)` - calls getSyncChunk module
- `validateEntityDate(date)` - converts dates per dbtype (SQLite -> ISO string)
- `validateOptionalEntityDate(date, useNowAsDefault?)`
- `validateDate(date)` - ensures Date object
- `validateOptionalDate(date)`
- `validateDateForWhere(date)` - converts for WHERE clauses

### From StorageReaderWriter (inherited for free)
- `setActive(auth, newActiveStorageIdentityKey)` - calls updateUser
- `findCertificateById(id, trx?)`
- `findCommissionById(id, trx?)`
- `findOutputById(id, trx?, noScript?)`
- `findOutputBasketById(id, trx?)`
- `findProvenTxById(id, trx?)`
- `findProvenTxReqById(id, trx?)`
- `findSyncStateById(id, trx?)`
- `findTransactionById(id, trx?, noRawTx?)` - NOTE: StorageExpoSQLiteImpl reimplements this incorrectly
- `findTxLabelById(id, trx?)`
- `findOutputTagById(id, trx?)`
- `findUserById(id, trx?)` - NOTE: StorageExpoSQLiteImpl reimplements this incorrectly
- `findOrInsertUser(identityKey, trx?)` - full implementation with default basket creation
- `findOrInsertTransaction(newTx, trx?)`
- `findOrInsertOutputBasket(userId, name, trx?)`
- `findOrInsertTxLabel(userId, label, trx?)`
- `findOrInsertTxLabelMap(transactionId, txLabelId, trx?)`
- `findOrInsertOutputTag(userId, tag, trx?)`
- `findOrInsertOutputTagMap(outputId, outputTagId, trx?)`
- `findOrInsertSyncStateAuth(auth, storageIdentityKey, storageName)`
- `findOrInsertProvenTxReq(newReq, trx?)`
- `findOrInsertProvenTx(newProven, trx?)`
- `tagOutput(partial, tag, trx?)`

### From StorageProvider (inherited for free)
- `isStorageProvider(): boolean` - returns true
- `setServices(v)` / `getServices()`
- `abortAction(auth, args)`
- `internalizeAction(auth, args)` - delegates to internalizeAction module
- `getReqsAndBeefToShareWithWorld(txids, knownTxids, trx?)`
- `mergeReqToBeefToShareExternally(req, mergeToBeef, knownTxids, trx?)`
- `getProvenOrReq(txid, newReq?, trx?)`
- `updateTransactionsStatus(transactionIds, status, trx?)`
- `updateTransactionStatus(status, transactionId?, userId?, reference?, trx?)`
- `createAction(auth, args)` - delegates to createAction module
- `processAction(auth, args)` - delegates to processAction module
- `attemptToPostReqsToNetwork(reqs, trx?, logger?)`
- `listCertificates(auth, args)` - delegates to listCertificates module
- `verifyKnownValidTransaction(txid, trx?)`
- `getValidBeefForKnownTxid(txid, mergeToBeef?, trustSelf?, knownTxids?, trx?, requiredLevels?)`
- `getValidBeefForTxid(txid, mergeToBeef?, trustSelf?, knownTxids?, trx?, requiredLevels?, chainTracker?, skipInvalidProofs?)`
- `getBeefForTransaction(txid, options)`
- `findMonitorEventById(id, trx?)`
- `relinquishCertificate(auth, args)`
- `relinquishOutput(auth, args)`
- `processSyncChunk(args, chunk)` - NOTE: abstract in StorageReaderWriter but IMPLEMENTED in StorageProvider
- `updateProvenTxReqWithNewProvenTx(args)`
- `confirmSpendableOutputs()`
- `updateProvenTxReqDynamics(id, update, trx?)`
- `extendOutput(o, includeBasket?, includeTags?, trx?)`
- `validateOutputScript(o, trx?)`

---

## ABSTRACT METHODS THAT MUST BE IMPLEMENTED

### From StorageReader (abstract)
1. `destroy(): Promise<void>`
2. `transaction<T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken): Promise<T>`
3. `readSettings(trx?: TrxToken): Promise<TableSettings>`
4. `findCertificateFields(args: FindCertificateFieldsArgs): Promise<TableCertificateField[]>`
5. `findCertificates(args: FindCertificatesArgs): Promise<TableCertificateX[]>`
6. `findCommissions(args: FindCommissionsArgs): Promise<TableCommission[]>`
7. `findMonitorEvents(args: FindMonitorEventsArgs): Promise<TableMonitorEvent[]>`
8. `findOutputBaskets(args: FindOutputBasketsArgs): Promise<TableOutputBasket[]>`
9. `findOutputs(args: FindOutputsArgs): Promise<TableOutput[]>`
10. `findOutputTags(args: FindOutputTagsArgs): Promise<TableOutputTag[]>`
11. `findSyncStates(args: FindSyncStatesArgs): Promise<TableSyncState[]>`
12. `findTransactions(args: FindTransactionsArgs): Promise<TableTransaction[]>`
13. `findTxLabels(args: FindTxLabelsArgs): Promise<TableTxLabel[]>`
14. `findUsers(args: FindUsersArgs): Promise<TableUser[]>`
15. `countCertificateFields(args): Promise<number>`
16. `countCertificates(args): Promise<number>`
17. `countCommissions(args): Promise<number>`
18. `countMonitorEvents(args): Promise<number>`
19. `countOutputBaskets(args): Promise<number>`
20. `countOutputs(args): Promise<number>`
21. `countOutputTags(args): Promise<number>`
22. `countSyncStates(args): Promise<number>`
23. `countTransactions(args): Promise<number>`
24. `countTxLabels(args): Promise<number>`
25. `countUsers(args): Promise<number>`
26. `getProvenTxsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTx[]>`
27. `getProvenTxReqsForUser(args: FindForUserSincePagedArgs): Promise<TableProvenTxReq[]>`
28. `getTxLabelMapsForUser(args: FindForUserSincePagedArgs): Promise<TableTxLabelMap[]>`
29. `getOutputTagMapsForUser(args: FindForUserSincePagedArgs): Promise<TableOutputTagMap[]>`

### From StorageReaderWriter (abstract - in addition to above)
30. `dropAllData(): Promise<void>`
31. `migrate(storageName: string, storageIdentityKey: string): Promise<string>`
32. `findOutputTagMaps(args: FindOutputTagMapsArgs): Promise<TableOutputTagMap[]>`
33. `findProvenTxReqs(args: FindProvenTxReqsArgs): Promise<TableProvenTxReq[]>`
34. `findProvenTxs(args: FindProvenTxsArgs): Promise<TableProvenTx[]>`
35. `findTxLabelMaps(args: FindTxLabelMapsArgs): Promise<TableTxLabelMap[]>`
36. `countOutputTagMaps(args): Promise<number>`
37. `countProvenTxReqs(args): Promise<number>`
38. `countProvenTxs(args): Promise<number>`
39. `countTxLabelMaps(args): Promise<number>`
40. `insertCertificate(certificate: TableCertificate, trx?): Promise<number>`
41. `insertCertificateField(certificateField, trx?): Promise<void>`
42. `insertCommission(commission, trx?): Promise<number>`
43. `insertMonitorEvent(event, trx?): Promise<number>`
44. `insertOutput(output, trx?): Promise<number>`
45. `insertOutputBasket(basket, trx?): Promise<number>`
46. `insertOutputTag(tag, trx?): Promise<number>`
47. `insertOutputTagMap(tagMap, trx?): Promise<void>`
48. `insertProvenTx(tx, trx?): Promise<number>`
49. `insertProvenTxReq(tx, trx?): Promise<number>`
50. `insertSyncState(syncState, trx?): Promise<number>`
51. `insertTransaction(tx, trx?): Promise<number>`
52. `insertTxLabel(label, trx?): Promise<number>`
53. `insertTxLabelMap(labelMap, trx?): Promise<void>`
54. `insertUser(user, trx?): Promise<number>`
55. `updateCertificate(id, update, trx?): Promise<number>`
56. `updateCertificateField(certificateId, fieldName, update, trx?): Promise<number>`
57. `updateCommission(id, update, trx?): Promise<number>`
58. `updateMonitorEvent(id, update, trx?): Promise<number>`
59. `updateOutput(id, update, trx?): Promise<number>`
60. `updateOutputBasket(id, update, trx?): Promise<number>`
61. `updateOutputTag(id, update, trx?): Promise<number>`
62. `updateOutputTagMap(outputId, tagId, update, trx?): Promise<number>`
63. `updateProvenTx(id, update, trx?): Promise<number>`
64. `updateProvenTxReq(id: number | number[], update, trx?): Promise<number>`
65. `updateSyncState(id, update, trx?): Promise<number>`
66. `updateTransaction(id: number | number[], update, trx?): Promise<number>`
67. `updateTxLabel(id, update, trx?): Promise<number>`
68. `updateTxLabelMap(transactionId, txLabelId, update, trx?): Promise<number>`
69. `updateUser(id, update, trx?): Promise<number>`
70. `processSyncChunk(args, chunk)` - abstract in StorageReaderWriter but StorageProvider implements it (so NOT needed if extending StorageProvider correctly)

### From StorageProvider (abstract - in addition to all above)
71. `reviewStatus(args: { agedLimit: Date; trx?: TrxToken }): Promise<{ log: string }>`
72. `purgeData(params: PurgeParams, trx?): Promise<PurgeResults>`
73. `allocateChangeInput(userId, basketId, targetSatoshis, exactSatoshis, excludeSending, transactionId): Promise<TableOutput | undefined>`
74. `getProvenOrRawTx(txid, trx?): Promise<ProvenOrRawTx>`
75. `getRawTxOfKnownValidTransaction(txid?, offset?, length?, trx?): Promise<number[] | undefined>`
76. `getLabelsForTransactionId(transactionId?, trx?): Promise<TableTxLabel[]>`
77. `getTagsForOutputId(outputId, trx?): Promise<TableOutputTag[]>`
78. `listActions(auth, args): Promise<ListActionsResult>`
79. `listOutputs(auth, args): Promise<ListOutputsResult>`
80. `countChangeInputs(userId, basketId, excludeSending): Promise<number>`
81. `findCertificatesAuth(auth, args): Promise<TableCertificateX[]>`
82. `findOutputBasketsAuth(auth, args): Promise<TableOutputBasket[]>`
83. `findOutputsAuth(auth, args): Promise<TableOutput[]>`
84. `insertCertificateAuth(auth, certificate): Promise<number>`
85. `adminStats(adminIdentityKey): Promise<AdminStatsResult>`

## GRAND TOTAL: 85 abstract methods to implement

---

## Constructor Signature

```typescript
import { StorageProvider, StorageProviderOptions } from '@bsv/wallet-toolbox-mobile'

export interface StorageExpoSQLiteOptions extends StorageProviderOptions {
  // StorageProviderOptions requires:
  //   chain: 'main' | 'test'
  //   feeModel: StorageFeeModel  // { model: 'sat/kb', value: 1 }
  //   commissionSatoshis: number // 0 to disable
  //   commissionPubKeyHex?: string // required if commissionSatoshis > 0
  databaseName?: string // optional, defaults to 'wallet-toolbox-{chain}net.db'
}

export class StorageExpoSQLite extends StorageProvider {
  constructor(options: StorageExpoSQLiteOptions) {
    super(options)
    this.dbName = options.databaseName || `wallet-toolbox-${options.chain}net.db`
  }
}
```

Use `StorageProvider.createStorageBaseOptions(chain)` as a helper to build the required options:
```typescript
const opts = StorageProvider.createStorageBaseOptions('main')
// Returns: { chain: 'main', feeModel: { model: 'sat/kb', value: 1 }, commissionSatoshis: 0, commissionPubKeyHex: undefined }
const storage = new StorageExpoSQLite({ ...opts, databaseName: 'my-wallet.db' })
```

---

## Key Implementation Notes

### DBType must be 'SQLite'
The settings record MUST have `dbtype: 'SQLite'`. The base class `validateEntityDate` and
`validateDateForWhere` methods switch on this to convert dates to ISO strings for SQLite.

### Date Handling
All dates stored in SQLite as ISO strings. `validateEntityDate` handles this automatically
once `dbtype: 'SQLite'` is set in settings.

### processSyncChunk
This is abstract in StorageReaderWriter but StorageProvider provides the concrete implementation.
StorageExpoSQLite does NOT need to implement this - StorageProvider handles it.

### listActions / listOutputs
StorageIdb uses dedicated `listActionsIdb` and `listOutputsIdb` helper modules for the complex
query logic. The StorageExpoSQLite equivalent should implement similar SQL query logic with
proper filtering, paging, label/tag joins, etc.

### allocateChangeInput
Critical for wallet funding. Must do an atomic read-then-update within a transaction to
prevent double-spending. See StorageIdb.js lines 292-341 for the algorithm.

### getProvenTxsForUser / getProvenTxReqsForUser / getTxLabelMapsForUser / getOutputTagMapsForUser
These are for sync. StorageIdb implements them via their filter* methods with userId filtering.
StorageExpoSQLite should use SQL JOINs to filter by userId efficiently.

### validateEntity pattern
StorageIdb.validateEntity (lines 2185-2210):
- Converts all date fields to Date objects
- Converts Uint8Array to number[]
- Converts null to undefined
The base StorageReader already provides validateEntityDate/validateDate helpers.
The StorageIdb adds validateEntity/validateEntities/validatePartialForUpdate as public methods
(not abstract - but expected by internal code via the Entity classes).

### transaction() method
IMPORTANT: The current StorageExpoSQLite.transaction() uses SQLite's `BEGIN TRANSACTION` / `COMMIT` / `ROLLBACK`
directly. This is correct, but it needs to handle NESTED transactions (when a trx is passed in,
reuse it rather than starting a new one). See how StorageIdb handles this (lines 1124-1140):
it just runs scope(trx) if trx is already provided.

---

## What the Current Implementation Has vs Needs

### Already Implemented (can be kept/adapted):
- initDB / verifyDB / migrate pattern
- insertUser, insertProvenTx, insertProvenTxReq, insertCertificate, insertCertificateField
- insertOutputBasket, insertTransaction, insertCommission, insertOutput
- insertOutputTag, insertOutputTagMap, insertTxLabel, insertTxLabelMap, insertMonitorEvent, insertSyncState
- updateUser, updateProvenTx, updateProvenTxReq, updateTransaction, updateOutput
- findUsers, findProvenTxs, findTransactions, findOutputs (basic versions)
- countUsers, countTransactions, countOutputs (basic versions)
- dropAllData
- transaction (but needs nested transaction fix)
- listOutputs, listActions, listCertificates (basic non-compliant versions)

### Missing / Wrong:
- Does NOT extend StorageProvider (critical - the whole class needs to be restructured)
- Missing: findCertificateFields, findCertificates, findCommissions, findMonitorEvents
- Missing: findOutputBaskets, findOutputTags, findSyncStates, findTxLabels
- Missing: findOutputTagMaps, findProvenTxReqs (used findProvenTxs for reqs - wrong)
- Missing: findTxLabelMaps
- Missing: all count* methods except countUsers/countTransactions/countOutputs
- Missing: getProvenTxsForUser, getProvenTxReqsForUser, getTxLabelMapsForUser, getOutputTagMapsForUser
- Missing: updateCertificate, updateCertificateField, updateCommission, updateMonitorEvent
- Missing: updateOutputBasket, updateOutputTag, updateOutputTagMap, updateSyncState
- Missing: updateTxLabel, updateTxLabelMap
- Missing: getProvenOrRawTx, getRawTxOfKnownValidTransaction
- Missing: getLabelsForTransactionId, getTagsForOutputId
- Missing: allocateChangeInput, countChangeInputs
- Missing: findCertificatesAuth, findOutputBasketsAuth, findOutputsAuth, insertCertificateAuth
- Missing: reviewStatus, purgeData
- Missing: adminStats
- Missing: validateEntity / validateEntities / validatePartialForUpdate public helpers
- findOrInsert* methods duplicated in StorageExpoSQLiteImpl (these are FREE from StorageReaderWriter)
- findUserById / findTransactionById / findOutputById duplicated (FREE from StorageReaderWriter)
- The prototype-patching pattern in StorageExpoSQLiteImpl.ts must be eliminated

---

## Recommended Rewrite Approach

1. Create new `StorageExpoSQLite.ts` that extends `StorageProvider`
2. Use `StorageProvider.createStorageBaseOptions(chain)` for constructor options
3. Set `dbtype: 'SQLite'` in the settings record during `migrate()`
4. Implement all 85 abstract methods
5. Remove StorageExpoSQLiteImpl.ts entirely (prototype patching is anti-pattern)
6. Keep the SQL schema in `schema/createTables.ts`
7. For listActions/listOutputs, create dedicated helper modules similar to listActionsIdb/listOutputsIdb
8. DELETE the reimplementations of: findUserById, findTransactionById, findOutputById,
   findOrInsertUser, findOrInsertTransaction, findOrInsertOutputBasket, findOrInsertTxLabel,
   findOrInsertOutputTag (all inherited from StorageReaderWriter for free)
