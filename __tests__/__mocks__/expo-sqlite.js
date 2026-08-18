// expo-sqlite ships untransformed ESM and is a native module, so it cannot load
// under jest. Tests that exercise StorageExpoSQLite inject their own database
// handle (see __tests__/walletBalanceSql.test.ts, which injects one backed by
// node:sqlite) — nothing should ever reach these.
const native = () => {
  throw new Error('expo-sqlite is native: inject a database handle in tests')
}
module.exports = {
  openDatabaseAsync: native,
  openDatabaseSync: native,
  deleteDatabaseAsync: native
}
