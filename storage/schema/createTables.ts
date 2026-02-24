import type { SQLiteDatabase } from 'expo-sqlite'

/**
 * SQL statements to create all wallet storage tables
 * Schema aligned with @bsv/wallet-toolbox-mobile Table type definitions
 */
export async function createTables(db: SQLiteDatabase): Promise<void> {
  // Users table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS users (
      userId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      identityKey TEXT NOT NULL UNIQUE,
      activeStorage TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_identityKey ON users(identityKey);
  `)

  // Proven transactions table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS proven_txs (
      provenTxId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      txid TEXT NOT NULL UNIQUE,
      height INTEGER NOT NULL,
      "index" INTEGER NOT NULL,
      merklePath BLOB NOT NULL,
      rawTx BLOB NOT NULL,
      blockHash TEXT NOT NULL,
      merkleRoot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_proven_txs_txid ON proven_txs(txid);
  `)

  // Proven transaction requests table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS proven_tx_reqs (
      provenTxReqId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      txid TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      notified INTEGER NOT NULL DEFAULT 0,
      history TEXT,
      notify TEXT,
      rawTx BLOB,
      inputBEEF BLOB,
      batch TEXT,
      provenTxId INTEGER,
      FOREIGN KEY (provenTxId) REFERENCES proven_txs(provenTxId)
    );
    CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_txid ON proven_tx_reqs(txid);
    CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_status ON proven_tx_reqs(status);
    CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_batch ON proven_tx_reqs(batch);
    CREATE INDEX IF NOT EXISTS idx_proven_tx_reqs_provenTxId ON proven_tx_reqs(provenTxId);
  `)

  // Certificates table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS certificates (
      certificateId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      type TEXT NOT NULL,
      subject TEXT NOT NULL,
      serialNumber TEXT NOT NULL,
      certifier TEXT NOT NULL,
      verifier TEXT,
      revocationOutpoint TEXT NOT NULL,
      signature TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_certificates_userId ON certificates(userId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_certificates_unique ON certificates(userId, type, certifier, serialNumber);
  `)

  // Certificate fields table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS certificate_fields (
      certificateId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      fieldName TEXT NOT NULL,
      fieldValue TEXT NOT NULL,
      masterKey TEXT NOT NULL,
      PRIMARY KEY (certificateId, fieldName),
      FOREIGN KEY (certificateId) REFERENCES certificates(certificateId),
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_certificate_fields_userId ON certificate_fields(userId);
    CREATE INDEX IF NOT EXISTS idx_certificate_fields_certificateId ON certificate_fields(certificateId);
  `)

  // Output baskets table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS output_baskets (
      basketId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      name TEXT NOT NULL,
      numberOfDesiredUTXOs INTEGER NOT NULL DEFAULT 144,
      minimumDesiredUTXOValue INTEGER NOT NULL DEFAULT 32,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_output_baskets_userId ON output_baskets(userId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_output_baskets_name_userId ON output_baskets(name, userId);
  `)

  // Transactions table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS transactions (
      transactionId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      status TEXT NOT NULL,
      reference TEXT NOT NULL UNIQUE,
      isOutgoing INTEGER NOT NULL DEFAULT 0,
      satoshis INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      version INTEGER,
      lockTime INTEGER,
      txid TEXT,
      inputBEEF BLOB,
      rawTx BLOB,
      provenTxId INTEGER,
      FOREIGN KEY (userId) REFERENCES users(userId),
      FOREIGN KEY (provenTxId) REFERENCES proven_txs(provenTxId)
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_userId ON transactions(userId);
    CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
    CREATE INDEX IF NOT EXISTS idx_transactions_provenTxId ON transactions(provenTxId);
    CREATE INDEX IF NOT EXISTS idx_transactions_txid ON transactions(txid);
  `)

  // Commissions table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS commissions (
      commissionId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      transactionId INTEGER NOT NULL UNIQUE,
      satoshis INTEGER NOT NULL,
      keyOffset TEXT,
      isRedeemed INTEGER NOT NULL DEFAULT 0,
      lockingScript BLOB,
      FOREIGN KEY (userId) REFERENCES users(userId),
      FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
    );
    CREATE INDEX IF NOT EXISTS idx_commissions_userId ON commissions(userId);
    CREATE INDEX IF NOT EXISTS idx_commissions_transactionId ON commissions(transactionId);
  `)

  // Outputs table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS outputs (
      outputId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      transactionId INTEGER NOT NULL,
      basketId INTEGER,
      spendable INTEGER NOT NULL DEFAULT 1,
      change INTEGER NOT NULL DEFAULT 0,
      outputDescription TEXT,
      vout INTEGER NOT NULL,
      satoshis INTEGER NOT NULL,
      providedBy TEXT NOT NULL,
      purpose TEXT,
      type TEXT,
      txid TEXT,
      senderIdentityKey TEXT,
      derivationPrefix TEXT,
      derivationSuffix TEXT,
      customInstructions TEXT,
      spentBy INTEGER,
      sequenceNumber INTEGER,
      spendingDescription TEXT,
      scriptLength INTEGER,
      scriptOffset INTEGER,
      lockingScript BLOB,
      FOREIGN KEY (userId) REFERENCES users(userId),
      FOREIGN KEY (transactionId) REFERENCES transactions(transactionId),
      FOREIGN KEY (basketId) REFERENCES output_baskets(basketId)
    );
    CREATE INDEX IF NOT EXISTS idx_outputs_userId ON outputs(userId);
    CREATE INDEX IF NOT EXISTS idx_outputs_transactionId ON outputs(transactionId);
    CREATE INDEX IF NOT EXISTS idx_outputs_basketId ON outputs(basketId);
    CREATE INDEX IF NOT EXISTS idx_outputs_spentBy ON outputs(spentBy);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outputs_unique ON outputs(transactionId, vout, userId);
  `)

  // Output tags table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS output_tags (
      outputTagId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      tag TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_output_tags_userId ON output_tags(userId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_output_tags_tag_userId ON output_tags(tag, userId);
  `)

  // Output tags map table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS output_tags_map (
      outputTagId INTEGER NOT NULL,
      outputId INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (outputTagId, outputId),
      FOREIGN KEY (outputTagId) REFERENCES output_tags(outputTagId),
      FOREIGN KEY (outputId) REFERENCES outputs(outputId)
    );
    CREATE INDEX IF NOT EXISTS idx_output_tags_map_outputTagId ON output_tags_map(outputTagId);
    CREATE INDEX IF NOT EXISTS idx_output_tags_map_outputId ON output_tags_map(outputId);
  `)

  // Transaction labels table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS tx_labels (
      txLabelId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      label TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_labels_userId ON tx_labels(userId);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_labels_label_userId ON tx_labels(label, userId);
  `)

  // Transaction labels map table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS tx_labels_map (
      txLabelId INTEGER NOT NULL,
      transactionId INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      isDeleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (txLabelId, transactionId),
      FOREIGN KEY (txLabelId) REFERENCES tx_labels(txLabelId),
      FOREIGN KEY (transactionId) REFERENCES transactions(transactionId)
    );
    CREATE INDEX IF NOT EXISTS idx_tx_labels_map_txLabelId ON tx_labels_map(txLabelId);
    CREATE INDEX IF NOT EXISTS idx_tx_labels_map_transactionId ON tx_labels_map(transactionId);
  `)

  // Monitor events table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS monitor_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      event TEXT NOT NULL,
      details TEXT
    );
  `)

  // Sync states table
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS sync_states (
      syncStateId INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      userId INTEGER NOT NULL,
      storageIdentityKey TEXT NOT NULL,
      storageName TEXT NOT NULL,
      status TEXT NOT NULL,
      init INTEGER NOT NULL DEFAULT 0,
      refNum TEXT NOT NULL UNIQUE,
      syncMap TEXT,
      "when" TEXT,
      satoshis INTEGER,
      errorLocal TEXT,
      errorOther TEXT,
      FOREIGN KEY (userId) REFERENCES users(userId)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_states_userId ON sync_states(userId);
    CREATE INDEX IF NOT EXISTS idx_sync_states_status ON sync_states(status);
    CREATE INDEX IF NOT EXISTS idx_sync_states_refNum ON sync_states(refNum);
  `)

  // Settings table (singleton)
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS settings (
      storageIdentityKey TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      storageName TEXT NOT NULL,
      chain TEXT NOT NULL,
      dbtype TEXT NOT NULL,
      maxOutputScript INTEGER NOT NULL
    );
  `)
}
