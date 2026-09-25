import { PrivateKey, Transaction, LockingScript, Utils } from '@bsv/sdk';
import { createSyncMap, type BRC38WalletData } from '@bsv/wallet-toolbox-mobile';

/** Public, unfunded test data. Never used to construct an operational wallet. */
export function portabilityFixture(): BRC38WalletData {
  const identity = new PrivateKey(42).toPublicKey().toString();
  const date = '2026-01-02T03:04:05.006Z';
  const time = { created_at: date, updated_at: date };
  const owned = { ...time, userId: 1 };
  const tx = new Transaction(
    1,
    [],
    [{ satoshis: 1, lockingScript: LockingScript.fromASM('OP_TRUE') }],
    0
  );
  const txid = tx.id('hex'),
    rawTx = Utils.toBase64(tx.toBinary());
  return {
    brc: 38,
    title: 'User Wallet Data Format',
    formatVersion: 1,
    exportedAt: date,
    sourceStorage: {
      ...time,
      storageIdentityKey: '1'.repeat(64),
      storageName: 'Unfunded portability fixture',
      chain: 'test',
      dbtype: 'SQLite',
      maxOutputScript: 10000,
    },
    user: { ...owned, identityKey: identity, activeStorage: '1'.repeat(64) },
    tables: {
      provenTxs: [
        {
          ...time,
          provenTxId: 1,
          txid,
          height: 1,
          index: 0,
          merklePath: 'AQID',
          rawTx,
          blockHash: '2'.repeat(64),
          merkleRoot: txid,
        },
      ],
      provenTxReqs: [
        {
          ...time,
          provenTxReqId: 1,
          provenTxId: 1,
          txid,
          status: 'completed',
          attempts: 1,
          notified: true,
          history: { notes: [] },
          notify: { transactionIds: [1] },
          rawTx,
          inputBEEF: 'BAUG',
        },
      ],
      outputBaskets: [
        {
          ...owned,
          basketId: 1,
          name: 'default',
          numberOfDesiredUTXOs: 144,
          minimumDesiredUTXOValue: 32,
          isDeleted: false,
        },
      ],
      transactions: [
        {
          ...owned,
          transactionId: 1,
          provenTxId: 1,
          txid,
          status: 'completed',
          reference: 'Zml4dHVyZQ==',
          isOutgoing: false,
          satoshis: 1,
          description: 'Fixture\u0000preserve the suffix 🧾',
          version: 1,
          lockTime: 0,
          rawTx,
          inputBEEF: 'BAUG',
        },
      ],
      commissions: [
        {
          ...owned,
          commissionId: 1,
          transactionId: 1,
          satoshis: 0,
          keyOffset: 'fixture',
          isRedeemed: false,
          lockingScript: 'UQ==',
        },
      ],
      outputs: [
        {
          ...owned,
          outputId: 1,
          transactionId: 1,
          basketId: 1,
          txid,
          vout: 0,
          satoshis: 1,
          spendable: false,
          change: false,
          outputDescription: 'Unfunded fixture',
          providedBy: 'you',
          purpose: 'fixture',
          type: 'custom',
          lockingScript: 'UQ==',
          derivationPrefix: 'AQ==',
          derivationSuffix: 'Ag==',
        },
      ],
      outputTags: [{ ...owned, outputTagId: 1, tag: 'deleted-fixture', isDeleted: true }],
      outputTagMaps: [{ ...time, outputId: 1, outputTagId: 1, isDeleted: true }],
      txLabels: [{ ...owned, txLabelId: 1, label: 'deleted-fixture', isDeleted: true }],
      txLabelMaps: [{ ...time, transactionId: 1, txLabelId: 1, isDeleted: true }],
      certificates: [
        {
          ...owned,
          certificateId: 1,
          type: 'AQ==',
          serialNumber: 'Ag==',
          certifier: identity,
          subject: identity,
          verifier: identity,
          revocationOutpoint: `${txid}.0`,
          signature: '0102',
          isDeleted: true,
        },
      ],
      certificateFields: [
        {
          ...owned,
          certificateId: 1,
          fieldName: 'fixture',
          fieldValue: 'encrypted-fixture',
          masterKey: 'AQID',
        },
      ],
      syncStates: [
        {
          ...owned,
          syncStateId: 1,
          storageIdentityKey: '3'.repeat(64),
          storageName: 'Fixture peer',
          status: 'success',
          init: true,
          refNum: 'fixture',
          syncMap: JSON.parse(JSON.stringify(createSyncMap())),
          when: date,
          satoshis: 0,
        },
      ],
    },
  };
}
