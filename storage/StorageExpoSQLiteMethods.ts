/**
 * CRUD methods for StorageExpoSQLite
 * This file contains insert, update, find, and filter methods for all wallet tables
 */

import { StorageExpoSQLite, TrxToken } from './StorageExpoSQLite'

// Table type definitions (based on @bsv/wallet-toolbox schema)
export interface TableUser {
  userId?: number
  created_at?: Date | string
  updated_at?: Date | string
  identityKey: string
  activeStorage?: string
}

export interface TableProvenTx {
  provenTxId?: number
  created_at?: Date | string
  updated_at?: Date | string
  txid: string
  height: number
  idx: number
  merklePath: number[] | Uint8Array
  rawTx: number[] | Uint8Array
  blockHash: string
  merkleRoot: string
}

export interface TableProvenTxReq {
  provenTxReqId?: number
  created_at?: Date | string
  updated_at?: Date | string
  txid: string
  status: string
  attempts?: number
  notified?: number
  history?: string
  rawTx?: number[] | Uint8Array | null
  batch?: string
  provenTxId?: number | null
}

export interface TableCertificate {
  certificateId?: number
  created_at?: Date | string
  updated_at?: Date | string
  userId: number
  type: string
  subject: string
  serialNumber: string
  certifier: string
  revocationOutpoint: string
  signature: string
  isDeleted?: boolean | number
}

export interface TableCertificateField {
  certificateId: number
  userId: number
  created_at?: Date | string
  updated_at?: Date | string
  fieldName: string
  fieldValue: string
  masterKey: string
}

export interface TableOutputBasket {
  basketId?: number
  created_at?: Date | string
  updated_at?: Date | string
  userId: number
  name: string
  isDeleted?: boolean | number
}

export interface TableTransaction {
  transactionId?: number
  created_at?: Date | string
  updated_at?: Date | string
  userId: number
  status: string
  reference: string
  satoshis?: number
  description?: string
  rawTx?: number[] | Uint8Array | null
  inputBEEF?: number[] | Uint8Array | null
  isOutgoing?: boolean | number
  version?: number
  lockTime?: number
  provenTxId?: number | null
  truncatedExternalInputs?: string
}

export interface TableCommission {
  commissionId?: number
  created_at?: Date | string
  updated_at?: Date | string
  userId: number
  transactionId: number
  satoshis: number
  isRedeemed?: boolean | number
  keyOffset?: string
  lockingScript?: string
}

export interface TableOutput {
  outputId?: number
  created_at?: Date | string
  updated_at?: Date | string
  userId: number
  transactionId: number
  vout: number
  satoshis: number
  basketId: number
  spendable?: boolean | number
  change?: boolean | number
  outpoint: string
  spentBy?: string | null
  providedBy: string
  purpose?: string
  derivationPrefix?: string
  derivationSuffix?: string
  paymailHandle?: string
  senderIdentityKey?: string
  lockingScript?: number[] | Uint8Array | null
  customInstructions?: string
}

export interface TableOutputTag {
  outputTagId?: number
  created_at?: Date | string
  updated_at?: Date | string
  userId: number
  tag: string
  isDeleted?: boolean | number
}

export interface TableOutputTagMap {
  outputTagId: number
  outputId: number
  created_at?: Date | string
  updated_at?: Date | string
  isDeleted?: boolean | number
}

export interface TableTxLabel {
  txLabelId?: number
  created_at?: Date | string
  updated_at?: Date | string
  userId: number
  label: string
  isDeleted?: boolean | number
}

export interface TableTxLabelMap {
  txLabelId: number
  transactionId: number
  created_at?: Date | string
  updated_at?: Date | string
  isDeleted?: boolean | number
}

export interface TableMonitorEvent {
  id?: number
  created_at?: Date | string
  updated_at?: Date | string
  event: string
  details?: string
}

export interface TableSyncState {
  syncStateId?: number
  created_at?: Date | string
  updated_at?: Date | string
  userId: number
  storageIdentityKey: string
  storageName: string
  status: string
  refNum: string
  init?: string
  when?: string
  error?: string
}

// Find arguments interfaces
export interface FindArgs<T> {
  partial: Partial<T>
  since?: Date
  limit?: number
  offset?: number
  orderDescending?: boolean
  trx?: TrxToken
}

/**
 * Add CRUD methods to StorageExpoSQLite class
 */
declare module './StorageExpoSQLite' {
  interface StorageExpoSQLite {
    // ==================== INSERT METHODS ====================
    insertUser(user: TableUser, trx?: TrxToken): Promise<number>
    insertProvenTx(tx: TableProvenTx, trx?: TrxToken): Promise<number>
    insertProvenTxReq(req: TableProvenTxReq, trx?: TrxToken): Promise<number>
    insertCertificate(cert: TableCertificate, trx?: TrxToken): Promise<number>
    insertCertificateField(field: TableCertificateField, trx?: TrxToken): Promise<void>
    insertOutputBasket(basket: TableOutputBasket, trx?: TrxToken): Promise<number>
    insertTransaction(tx: TableTransaction, trx?: TrxToken): Promise<number>
    insertCommission(commission: TableCommission, trx?: TrxToken): Promise<number>
    insertOutput(output: TableOutput, trx?: TrxToken): Promise<number>
    insertOutputTag(tag: TableOutputTag, trx?: TrxToken): Promise<number>
    insertOutputTagMap(tagMap: TableOutputTagMap, trx?: TrxToken): Promise<void>
    insertTxLabel(label: TableTxLabel, trx?: TrxToken): Promise<number>
    insertTxLabelMap(labelMap: TableTxLabelMap, trx?: TrxToken): Promise<void>
    insertMonitorEvent(event: TableMonitorEvent, trx?: TrxToken): Promise<number>
    insertSyncState(syncState: TableSyncState, trx?: TrxToken): Promise<number>

    // ==================== UPDATE METHODS ====================
    updateUser(id: number, update: Partial<TableUser>, trx?: TrxToken): Promise<number>
    updateProvenTx(id: number, update: Partial<TableProvenTx>, trx?: TrxToken): Promise<number>
    updateProvenTxReq(id: number | number[], update: Partial<TableProvenTxReq>, trx?: TrxToken): Promise<number>
    updateCertificate(id: number, update: Partial<TableCertificate>, trx?: TrxToken): Promise<number>
    updateCertificateField(
      certificateId: number,
      fieldName: string,
      update: Partial<TableCertificateField>,
      trx?: TrxToken
    ): Promise<number>
    updateOutputBasket(id: number, update: Partial<TableOutputBasket>, trx?: TrxToken): Promise<number>
    updateTransaction(id: number | number[], update: Partial<TableTransaction>, trx?: TrxToken): Promise<number>
    updateCommission(id: number, update: Partial<TableCommission>, trx?: TrxToken): Promise<number>
    updateOutput(id: number, update: Partial<TableOutput>, trx?: TrxToken): Promise<number>
    updateOutputTag(id: number, update: Partial<TableOutputTag>, trx?: TrxToken): Promise<number>
    updateOutputTagMap(
      outputId: number,
      tagId: number,
      update: Partial<TableOutputTagMap>,
      trx?: TrxToken
    ): Promise<number>
    updateTxLabel(id: number, update: Partial<TableTxLabel>, trx?: TrxToken): Promise<number>
    updateTxLabelMap(
      transactionId: number,
      txLabelId: number,
      update: Partial<TableTxLabelMap>,
      trx?: TrxToken
    ): Promise<number>
    updateMonitorEvent(id: number, update: Partial<TableMonitorEvent>, trx?: TrxToken): Promise<number>
    updateSyncState(id: number, update: Partial<TableSyncState>, trx?: TrxToken): Promise<number>

    // ==================== FIND METHODS ====================
    findUsers(args: FindArgs<TableUser>): Promise<TableUser[]>
    findProvenTxs(args: FindArgs<TableProvenTx>): Promise<TableProvenTx[]>
    findProvenTxReqs(args: FindArgs<TableProvenTxReq>): Promise<TableProvenTxReq[]>
    findCertificates(args: FindArgs<TableCertificate>): Promise<TableCertificate[]>
    findCertificateFields(args: FindArgs<TableCertificateField>): Promise<TableCertificateField[]>
    findOutputBaskets(args: FindArgs<TableOutputBasket>): Promise<TableOutputBasket[]>
    findTransactions(args: FindArgs<TableTransaction>): Promise<TableTransaction[]>
    findCommissions(args: FindArgs<TableCommission>): Promise<TableCommission[]>
    findOutputs(args: FindArgs<TableOutput>): Promise<TableOutput[]>
    findOutputTags(args: FindArgs<TableOutputTag>): Promise<TableOutputTag[]>
    findOutputTagMaps(args: FindArgs<TableOutputTagMap>): Promise<TableOutputTagMap[]>
    findTxLabels(args: FindArgs<TableTxLabel>): Promise<TableTxLabel[]>
    findTxLabelMaps(args: FindArgs<TableTxLabelMap>): Promise<TableTxLabelMap[]>
    findMonitorEvents(args: FindArgs<TableMonitorEvent>): Promise<TableMonitorEvent[]>
    findSyncStates(args: FindArgs<TableSyncState>): Promise<TableSyncState[]>

    // ==================== FIND BY ID METHODS ====================
    findUserById(id: number, trx?: TrxToken): Promise<TableUser | undefined>
    findProvenTxById(id: number, trx?: TrxToken): Promise<TableProvenTx | undefined>
    findProvenTxReqById(id: number, trx?: TrxToken): Promise<TableProvenTxReq | undefined>
    findCertificateById(id: number, trx?: TrxToken): Promise<TableCertificate | undefined>
    findOutputBasketById(id: number, trx?: TrxToken): Promise<TableOutputBasket | undefined>
    findTransactionById(id: number, trx?: TrxToken): Promise<TableTransaction | undefined>
    findCommissionById(id: number, trx?: TrxToken): Promise<TableCommission | undefined>
    findOutputById(id: number, trx?: TrxToken): Promise<TableOutput | undefined>
    findOutputTagById(id: number, trx?: TrxToken): Promise<TableOutputTag | undefined>
    findTxLabelById(id: number, trx?: TrxToken): Promise<TableTxLabel | undefined>
    findMonitorEventById(id: number, trx?: TrxToken): Promise<TableMonitorEvent | undefined>
    findSyncStateById(id: number, trx?: TrxToken): Promise<TableSyncState | undefined>

    // ==================== COUNT METHODS ====================
    countUsers(args: FindArgs<TableUser>): Promise<number>
    countProvenTxs(args: FindArgs<TableProvenTx>): Promise<number>
    countProvenTxReqs(args: FindArgs<TableProvenTxReq>): Promise<number>
    countCertificates(args: FindArgs<TableCertificate>): Promise<number>
    countOutputBaskets(args: FindArgs<TableOutputBasket>): Promise<number>
    countTransactions(args: FindArgs<TableTransaction>): Promise<number>
    countCommissions(args: FindArgs<TableCommission>): Promise<number>
    countOutputs(args: FindArgs<TableOutput>): Promise<number>
    countOutputTags(args: FindArgs<TableOutputTag>): Promise<number>
    countOutputTagMaps(args: FindArgs<TableOutputTagMap>): Promise<number>
    countTxLabels(args: FindArgs<TableTxLabel>): Promise<number>
    countTxLabelMaps(args: FindArgs<TableTxLabelMap>): Promise<number>
    countMonitorEvents(args: FindArgs<TableMonitorEvent>): Promise<number>
    countSyncStates(args: FindArgs<TableSyncState>): Promise<number>

    // ==================== FIND OR INSERT METHODS ====================
    findOrInsertUser(identityKey: string, trx?: TrxToken): Promise<{ user: TableUser; isNew: boolean }>
    findOrInsertTransaction(
      newTx: TableTransaction,
      trx?: TrxToken
    ): Promise<{ tx: TableTransaction; isNew: boolean }>
    findOrInsertOutputBasket(userId: number, name: string, trx?: TrxToken): Promise<TableOutputBasket>
    findOrInsertTxLabel(userId: number, label: string, trx?: TrxToken): Promise<TableTxLabel>
    findOrInsertOutputTag(userId: number, tag: string, trx?: TrxToken): Promise<TableOutputTag>
  }
}

export type {
  StorageExpoSQLite,
  TrxToken
}
