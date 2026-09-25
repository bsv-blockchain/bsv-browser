import { JSONParser, TokenType } from '@streamparser/json'
import { ARCHIVE_TABLES, canonicalArchiveJson, PortabilityError, rowKey, validateDate, validateRow, type ArchiveTable } from './schema'

export type ArchiveEvent =
  | { kind: 'metadata'; key: string; json: string }
  | { kind: 'table'; table: ArchiveTable }
  | { kind: 'row'; table: ArchiveTable; ordinal: number; rowKey: string; json: string }

/** Bounded row streaming. Deleting each emitted row is essential: selecting a
 * parent path makes keepStack:false alone retain its children until EOF. */
export class ArchiveStreamParser {
  private readonly parser = new JSONParser({ paths: ['$.*', '$.tables.*', '$.tables.*.*'], keepStack: false, stringBufferSize: 65536, numberBufferSize: 64 })
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly containers: Array<{ object: boolean; keyExpected: boolean; keys: Set<string> }> = []
  private readonly metadata = new Set<string>()
  private readonly tables = new Set<string>()
  private readonly counts = new Map<string, number>()
  private pending: ArchiveEvent[] = []
  private bytes = 0
  private rowStart?: number
  private lastTokenOffset = 0
  private sawRoot = false

  constructor() {
    this.parser.onToken = ({ token, value, offset }) => {
      this.lastTokenOffset = offset
      if (!this.sawRoot) {
        if (token !== TokenType.LEFT_BRACE) throw new PortabilityError('invalid', 'archive object')
        this.sawRoot = true
      }
      const parent = this.containers[this.containers.length - 1]
      if (token === TokenType.STRING && parent?.object && parent.keyExpected) {
        const key = String(value)
        if (parent.keys.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new PortabilityError('invalid', 'duplicate or unsafe JSON key')
        parent.keys.add(key); parent.keyExpected = false
      }
      if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
        if (this.containers.length >= 64) throw new PortabilityError('invalid', 'JSON nesting')
        // A record or metadata value at this depth cannot grow without a bound.
        if (this.containers.length === 3) this.rowStart = offset
        this.containers.push({ object: token === TokenType.LEFT_BRACE, keyExpected: true, keys: new Set() })
      } else if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
        if (this.containers.length === 4) this.rowStart = undefined
        this.containers.pop()
      } else if (token === TokenType.COMMA && parent?.object) parent.keyExpected = true
    }
    this.parser.onValue = ({ key, value, parent, stack }) => {
      if (stack.length === 3 && stack[1].key === 'tables') {
        const table = String(stack[2].key) as ArchiveTable
        if (!ARCHIVE_TABLES.includes(table) || !Array.isArray(parent) || key !== (this.counts.get(table) ?? 0)) throw new PortabilityError('invalid', 'record order')
        const row = validateRow(table, value)
        this.pending.push({ kind: 'row', table, ordinal: Number(key), rowKey: rowKey(table, row), json: canonicalArchiveJson(row) })
        this.counts.set(table, Number(key) + 1)
        delete parent[Number(key)]
      } else if (stack.length === 2 && stack[1].key === 'tables') {
        const table = String(key) as ArchiveTable
        if (!ARCHIVE_TABLES.includes(table) || !Array.isArray(value) || this.tables.has(table)) throw new PortabilityError('invalid', 'table array')
        this.tables.add(table)
        this.pending.push({ kind: 'table', table })
        if (parent && !Array.isArray(parent)) delete parent[table]
      } else if (stack.length === 1) {
        const name = String(key)
        if (!['brc', 'title', 'formatVersion', 'exportedAt', 'sourceStorage', 'user', 'tables'].includes(name) || this.metadata.has(name)) throw new PortabilityError('invalid', 'archive header')
        this.metadata.add(name)
        if ((name === 'brc' && value !== 38) || (name === 'title' && value !== 'User Wallet Data Format') || (name === 'formatVersion' && value !== 1)) throw new PortabilityError('unsupported')
        if (name === 'exportedAt') validateDate(value)
        if (name === 'user' || name === 'sourceStorage') validateRow(name, value)
        if (name === 'tables') {
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PortabilityError('invalid', 'tables')
        } else this.pending.push({ kind: 'metadata', key: name, json: canonicalArchiveJson(value) })
        if (parent && !Array.isArray(parent)) delete parent[name]
      }
    }
  }

  write(bytes: Uint8Array): ArchiveEvent[] {
    this.bytes += bytes.length
    // Limit one uncompleted string/record independently of whole archive size.
    if (this.bytes - (this.rowStart ?? this.lastTokenOffset) > 64 * 1024 * 1024) throw new PortabilityError('resources', 'individual record exceeds 64 MiB')
    try { this.decoder.decode(bytes, { stream: true }); this.parser.write(bytes) }
    catch (error) { if (error instanceof PortabilityError) throw error; throw new PortabilityError('invalid') }
    return this.takeEvents()
  }

  end(): ArchiveEvent[] {
    try { this.decoder.decode(); if (!this.parser.isEnded) this.parser.end() }
    catch (error) { if (error instanceof PortabilityError) throw error; throw new PortabilityError('invalid') }
    if (!this.sawRoot || this.containers.length || this.metadata.size !== 7 || this.tables.size !== ARCHIVE_TABLES.length) throw new PortabilityError('invalid', 'missing archive categories')
    return this.takeEvents()
  }

  private takeEvents(): ArchiveEvent[] { const events = this.pending; this.pending = []; return events }
}
