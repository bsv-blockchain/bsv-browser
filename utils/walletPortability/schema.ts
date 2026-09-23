import { PublicKey } from '@bsv/sdk'

export const ARCHIVE_TABLES = ['provenTxs', 'provenTxReqs', 'outputBaskets', 'transactions', 'commissions', 'outputs', 'outputTags', 'outputTagMaps', 'txLabels', 'txLabelMaps', 'certificates', 'certificateFields', 'syncStates'] as const
export type ArchiveTable = typeof ARCHIVE_TABLES[number]
export type ArchiveChain = 'main' | 'test' | 'ttn'
export type ArchiveRow = Record<string, any>
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024 - 1
export class PortabilityError extends Error {
  constructor(readonly code: string, detail?: string) {
    const messages: Record<string, string> = {
      invalid: 'This is not a complete, valid BRC-38/39 wallet data file.',
      identity: 'The wallet identity or network does not match this file.',
      password: 'The file could not be unlocked. Check the passphrase and that the file is intact.',
      resources: 'This archive requests unsupported encryption resources.',
      size: 'This archive exceeds the supported 2 GiB file size.',
      unsupported: 'This file uses an unsupported wallet archive version or encryption method.',
      cancelled: 'Stopped safely. Your original file and completed recovery copies remain available.',
      storage: 'The complete wallet copy could not be saved or verified.',
      busy: 'Another wallet data operation is running.'
    }
    super((messages[code] ?? messages.storage) + (detail ? ` Check: ${detail}.` : ''))
    this.name = 'PortabilityError'
  }
}
export const binaries: Record<string, string[]> = {
  provenTxs: ['rawTx', 'merklePath'], provenTxReqs: ['rawTx', 'inputBEEF'],
  transactions: ['rawTx', 'inputBEEF'], commissions: ['lockingScript'], outputs: ['lockingScript']
}
export const jsonFields: Record<string, string[]> = {
  provenTxReqs: ['history', 'notify'], syncStates: ['syncMap', 'errorLocal', 'errorOther']
}
export const booleans = new Set(['isDeleted', 'isOutgoing', 'isRedeemed', 'spendable', 'change', 'notified', 'init'])
export const archiveStores: Record<ArchiveTable, string> = {
  provenTxs: 'proven_txs', provenTxReqs: 'proven_tx_reqs', outputBaskets: 'output_baskets',
  transactions: 'transactions', commissions: 'commissions', outputs: 'outputs', outputTags: 'output_tags',
  outputTagMaps: 'output_tags_map', txLabels: 'tx_labels', txLabelMaps: 'tx_labels_map',
  certificates: 'certificates', certificateFields: 'certificate_fields', syncStates: 'sync_states'
}
export function canonicalArchiveJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new PortabilityError('invalid')
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalArchiveJson).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalArchiveJson((value as ArchiveRow)[key])}`).join(',')}}`
}
export function checkArchiveSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new PortabilityError('invalid')
  if (size > MAX_ARCHIVE_BYTES) throw new PortabilityError('size')
}
export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PortabilityError('cancelled')
}
export function validateDate(value: unknown): void {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value) throw new PortabilityError('invalid', 'timestamp')
}
export function validateJson(value: unknown, depth = 0): void {
  if (value == null || depth > 64 || (typeof value === 'number' && !Number.isFinite(value))) throw new PortabilityError('invalid', 'JSON values')
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i)
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(++i)
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw new PortabilityError('invalid', 'Unicode')
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new PortabilityError('invalid', 'Unicode')
    }
  } else if (Array.isArray(value)) value.forEach(child => validateJson(child, depth + 1))
  else if (typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new PortabilityError('invalid')
    for (const [key, child] of Object.entries(value)) { validateJson(key, depth + 1); validateJson(child, depth + 1) }
  } else if (!['number', 'boolean'].includes(typeof value)) throw new PortabilityError('invalid')
}

export const required: Record<(typeof ARCHIVE_TABLES)[number], string[]> = {
      provenTxs: [
        'provenTxId',
        'txid',
        'rawTx',
        'merklePath',
        'height',
        'index',
        'blockHash',
        'merkleRoot',
      ],
      provenTxReqs: [
        'provenTxReqId',
        'txid',
        'status',
        'attempts',
        'notified',
        'history',
        'notify',
        'rawTx',
      ],
      outputBaskets: [
        'basketId',
        'userId',
        'name',
        'numberOfDesiredUTXOs',
        'minimumDesiredUTXOValue',
        'isDeleted',
      ],
      transactions: [
        'transactionId',
        'userId',
        'status',
        'reference',
        'isOutgoing',
        'satoshis',
        'description',
      ],
      commissions: [
        'commissionId',
        'userId',
        'transactionId',
        'satoshis',
        'keyOffset',
        'isRedeemed',
        'lockingScript',
      ],
      outputs: [
        'outputId',
        'userId',
        'transactionId',
        'vout',
        'satoshis',
        'spendable',
        'change',
        'providedBy',
        'purpose',
        'type',
      ],
      outputTags: ['outputTagId', 'userId', 'tag', 'isDeleted'],
      outputTagMaps: ['outputId', 'outputTagId', 'isDeleted'],
      txLabels: ['txLabelId', 'userId', 'label', 'isDeleted'],
      txLabelMaps: ['transactionId', 'txLabelId', 'isDeleted'],
      certificates: [
        'certificateId',
        'userId',
        'type',
        'serialNumber',
        'certifier',
        'subject',
        'revocationOutpoint',
        'signature',
        'isDeleted',
      ],
      certificateFields: ['certificateId', 'userId', 'fieldName', 'fieldValue', 'masterKey'],
      syncStates: [
        'syncStateId',
        'userId',
        'storageIdentityKey',
        'storageName',
        'status',
        'init',
        'refNum',
        'syncMap',
      ],
    };
export const checkRequiredRow = (row: Record<string, unknown>, fields: string[], table: string) => {
      for (const field of [...fields, 'created_at', 'updated_at'])
        if (row[field] === undefined)
          throw new PortabilityError('invalid', `${table}.${field} required`);
      for (const [field, value] of Object.entries(row)) {
        if (
          [
            'userId',
            'transactionId',
            'provenTxId',
            'provenTxReqId',
            'basketId',
            'outputId',
            'outputTagId',
            'txLabelId',
            'certificateId',
            'commissionId',
            'syncStateId',
          ].includes(field) &&
          (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
        )
          throw new PortabilityError('invalid', `${table}.${field} identifier`);
        if (
          [
            'isDeleted',
            'isOutgoing',
            'isRedeemed',
            'spendable',
            'change',
            'notified',
            'init',
          ].includes(field) &&
          typeof value !== 'boolean'
        )
          throw new PortabilityError('invalid', `${table}.${field} boolean`);
      }
      for (const field of fields) {
        if (
          [
            'height',
            'index',
            'attempts',
            'numberOfDesiredUTXOs',
            'minimumDesiredUTXOValue',
            'satoshis',
            'vout',
            'maxOutputScript',
          ].includes(field)
        ) {
          if (!Number.isSafeInteger(row[field]))
            throw new PortabilityError('invalid', `${table}.${field} integer`);
        } else if (
          !field.endsWith('Id') &&
          ![
            'isDeleted',
            'isOutgoing',
            'isRedeemed',
            'spendable',
            'change',
            'notified',
            'init',
            'history',
            'notify',
            'syncMap',
          ].includes(field)
        ) {
          if (typeof row[field] !== 'string')
            throw new PortabilityError('invalid', `${table}.${field} text`);
        }
      }
    };

export function validateRow(table: ArchiveTable | 'user' | 'sourceStorage', value: unknown): ArchiveRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PortabilityError('invalid', table)
  const row = value as ArchiveRow
  validateJson(row)
  // Older IDB exports retain this optional extension as its database bit.
  // Keep the original representation in the immutable archive; native working
  // storage exposes the corresponding boolean through the current Toolbox API.
  if (table === 'provenTxReqs' && row.wasBroadcast !== undefined && typeof row.wasBroadcast !== 'boolean' && row.wasBroadcast !== 0 && row.wasBroadcast !== 1) throw new PortabilityError('invalid', 'provenTxReqs.wasBroadcast')
  const fields = table === 'user' ? ['userId', 'identityKey', 'activeStorage'] : table === 'sourceStorage' ? ['storageIdentityKey', 'storageName', 'chain', 'dbtype', 'maxOutputScript'] : required[table]
  checkRequiredRow(row, fields, table)
  validateDate(row.created_at); validateDate(row.updated_at)
  if (table === 'syncStates' && row.when !== undefined) validateDate(row.when)
  for (const field of binaries[table] ?? []) if (row[field] !== undefined) {
    const bytes = row[field]
    if (typeof bytes !== 'string' || bytes.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes)) throw new PortabilityError('invalid', `${table}.${field}`)
  }
  for (const field of jsonFields[table] ?? []) if (row[field] !== undefined && (!row[field] || typeof row[field] !== 'object' || Array.isArray(row[field]))) throw new PortabilityError('invalid', `${table}.${field}`)
  if (table === 'user') {
    const identity = row.identityKey
    if (!/^(02|03)[a-f0-9]{64}$/i.test(identity) || PublicKey.fromString(identity).toString() !== identity.toLowerCase()) throw new PortabilityError('identity')
  }
  if (table === 'sourceStorage' && !['main', 'test', 'ttn'].includes(row.chain)) throw new PortabilityError('unsupported', 'network')
  return row
}
export function rowKey(table: ArchiveTable, row: ArchiveRow): string {
  const keys = table === 'outputTagMaps' ? ['outputId', 'outputTagId'] : table === 'txLabelMaps' ? ['transactionId', 'txLabelId'] : table === 'certificateFields' ? ['certificateId', 'fieldName'] : [required[table][0]]
  return JSON.stringify(keys.map(key => row[key]))
}
export interface ArchiveSummary {
  identityKey: string; chain: ArchiveChain; exportedAt: string; sourceName: string; sourceIdentity: string
  counts: Record<ArchiveTable, number>; totalRecords: number; pendingTransactions: number
}
