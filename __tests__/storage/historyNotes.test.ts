import { NOTE_VALUE_MAX, scrubHistoryJson, scrubNoteValues } from '@/storage/methods/historyNotes'

describe('scrubNoteValues', () => {
  it('truncates a megabyte of broadcast hex to the cap', () => {
    // The real shape: a provider note carrying the whole Extended Format payload.
    const note = { when: '2026-08-19T00:00:00Z', what: 'ArcadePostEF', rawTx: 'ab'.repeat(500_000) }
    const out = scrubNoteValues(note)
    expect(out.rawTx.length).toBe(NOTE_VALUE_MAX)
    expect(out.rawTx.endsWith('…')).toBe(true)
    expect(out.what).toBe('ArcadePostEF')
    expect(out.when).toBe('2026-08-19T00:00:00Z')
  })

  it('leaves short values untouched and does not mutate the input', () => {
    const note = { what: 'wocPostRawTx', httpStatus: 200 }
    const out = scrubNoteValues(note)
    expect(out).toEqual(note)
    expect(out).not.toBe(note)
  })

  it('scrubs nested objects and arrays', () => {
    const out = scrubNoteValues({
      what: 'x',
      nested: { hex: 'c'.repeat(9999) },
      list: ['d'.repeat(9999), 'short']
    })
    expect((out.nested as any).hex.length).toBe(NOTE_VALUE_MAX)
    expect((out.list as any)[0].length).toBe(NOTE_VALUE_MAX)
    expect((out.list as any)[1]).toBe('short')
  })

  it('keeps a string exactly at the cap intact', () => {
    const exact = 'e'.repeat(NOTE_VALUE_MAX)
    expect(scrubNoteValues({ v: exact }).v).toBe(exact)
  })

  it('preserves non-string values, including null', () => {
    const out = scrubNoteValues({ what: 'x', code: 429, ok: false, when: null })
    expect(out).toEqual({ what: 'x', code: 429, ok: false, when: null })
  })
})

describe('scrubHistoryJson', () => {
  it('scrubs the values inside stored history JSON', () => {
    const history = JSON.stringify({
      notes: [{ what: 'ArcadePostEF', rawTx: 'ab'.repeat(500_000) }]
    })
    expect(history.length).toBeGreaterThan(1_000_000)

    const out = scrubHistoryJson(history) as string
    expect(out.length).toBeLessThan(600)
    const parsed = JSON.parse(out)
    expect(parsed.notes[0].what).toBe('ArcadePostEF')
    expect(parsed.notes[0].rawTx.length).toBe(NOTE_VALUE_MAX)
  })

  it('passes short history through byte-identically', () => {
    const history = JSON.stringify({ notes: [{ what: 'ok' }] })
    expect(scrubHistoryJson(history)).toBe(history)
  })

  it('truncates unparseable history rather than letting it through', () => {
    // Malformed history is already a bug; letting a megabyte past because it
    // failed to parse would defeat the purpose of the cap.
    const junk = 'f'.repeat(900_000)
    const out = scrubHistoryJson(junk) as string
    expect(out.length).toBe(NOTE_VALUE_MAX)
  })

  it('leaves undefined alone so an update that omits history stays an omission', () => {
    // sqlUpdate skips undefined values; turning one into a string here would
    // write a column the caller never asked to touch.
    expect(scrubHistoryJson(undefined)).toBeUndefined()
  })

  it('handles an already-parsed object', () => {
    const out = scrubHistoryJson({ notes: [{ hex: 'a'.repeat(9999) }] }) as any
    expect(out.notes[0].hex.length).toBe(NOTE_VALUE_MAX)
  })
})
