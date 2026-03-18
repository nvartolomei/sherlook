import { describe, it, expect } from 'vitest'
import { computeInterdiff } from './interdiff'

// Helper: build a minimal git diff for a single file
function makePatch(path: string, hunks: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `index abc1234..def5678 100644`,
    `--- a/${path}`,
    `+++ b/${path}`,
    hunks,
  ].join('\n') + '\n'
}

// Extract only the meaningful lines (skip diff --interdiff and @@ headers)
function contentLines(result: string): string[] {
  return result.split('\n').filter(l =>
    l.startsWith('+') || l.startsWith('-') || l.startsWith(' ')
  )
}

describe('computeInterdiff', () => {
  it('new hunk in patchB shows additions', () => {
    // patchA has a hunk at base 10, patchB adds a second hunk at base 20
    const patchA = makePatch('file.cc', [
      '@@ -10,3 +10,4 @@',
      ' line_a',
      '+old_addition',
      ' line_b',
    ].join('\n'))

    const patchB = makePatch('file.cc', [
      '@@ -10,3 +10,4 @@',
      ' line_a',
      '+old_addition',
      ' line_b',
      '@@ -20,4 +21,7 @@',
      ' before_context',
      '+    if (empty()) {',
      '+        throw std::runtime_error("empty");',
      '+    }',
      ' after_context',
    ].join('\n'))

    const result = computeInterdiff(patchA, patchB)
    const lines = contentLines(result)

    // The new additions should show as +
    expect(lines).toContain('+    if (empty()) {')
    expect(lines).toContain('+        throw std::runtime_error("empty");')
    expect(lines).toContain('+    }')
    // Context around the new hunk should be context
    expect(lines).toContain(' before_context')
    expect(lines).toContain(' after_context')
  })

  it('identical patches produce no output', () => {
    const patch = makePatch('file.cc', [
      '@@ -10,3 +10,4 @@',
      ' context',
      '+added',
      ' context',
    ].join('\n'))

    const result = computeInterdiff(patch, patch)
    expect(result).toBe('')
  })

  it('additions in old patch show as removals when absent from new', () => {
    // patchA adds lines; patchB does not touch this file
    const patchA = makePatch('file.cc', [
      '@@ -10,2 +10,4 @@',
      ' context',
      '+old_line_1',
      '+old_line_2',
      ' context',
    ].join('\n'))

    const result = computeInterdiff(patchA, '')
    const lines = contentLines(result)

    expect(lines).toContain('-old_line_1')
    expect(lines).toContain('-old_line_2')
  })

  it('removals in old patch show as additions when absent from new', () => {
    // patchA removes a line; patchB does not touch this file
    const patchA = makePatch('file.cc', [
      '@@ -10,3 +10,2 @@',
      ' context',
      '-removed_line',
      ' context',
    ].join('\n'))

    const result = computeInterdiff(patchA, '')
    const lines = contentLines(result)

    expect(lines).toContain('+removed_line')
  })

  it('modified addition: old version removed, new version added', () => {
    const patchA = makePatch('file.cc', [
      '@@ -10,2 +10,3 @@',
      ' context_before',
      '+    throw std::runtime_error("empty manifest");',
      ' context_after',
    ].join('\n'))

    const patchB = makePatch('file.cc', [
      '@@ -10,2 +10,4 @@',
      ' context_before',
      '+    throw std::runtime_error(',
      '+      "can\'t make manifest metadata for empty manifest");',
      ' context_after',
    ].join('\n'))

    const result = computeInterdiff(patchA, patchB)
    const lines = contentLines(result)

    expect(lines).toContain('-    throw std::runtime_error("empty manifest");')
    expect(lines).toContain('+    throw std::runtime_error(')
    expect(lines).toContain('+      "can\'t make manifest metadata for empty manifest");')
    expect(lines).toContain(' context_before')
    expect(lines).toContain(' context_after')
  })

  it('unchanged additions between patches are context in interdiff', () => {
    const patchA = makePatch('file.cc', [
      '@@ -10,2 +10,4 @@',
      ' context',
      '+common_addition',
      '+only_in_a',
      ' context',
    ].join('\n'))

    const patchB = makePatch('file.cc', [
      '@@ -10,2 +10,4 @@',
      ' context',
      '+common_addition',
      '+only_in_b',
      ' context',
    ].join('\n'))

    const result = computeInterdiff(patchA, patchB)
    const lines = contentLines(result)

    expect(lines).toContain(' common_addition')
    expect(lines).toContain('-only_in_a')
    expect(lines).toContain('+only_in_b')
  })

  it('moved line within same hunk', () => {
    const patchA = makePatch('file.cc', [
      '@@ -10,5 +10,6 @@',
      ' void foo() {',
      '+    LOG("hello");',
      '     do_stuff_a();',
      '     do_stuff_b();',
      '     do_stuff_c();',
      ' }',
    ].join('\n'))

    const patchB = makePatch('file.cc', [
      '@@ -10,5 +10,6 @@',
      ' void foo() {',
      '     do_stuff_a();',
      '     do_stuff_b();',
      '     do_stuff_c();',
      '+    LOG("hello");',
      ' }',
    ].join('\n'))

    const result = computeInterdiff(patchA, patchB)
    const lines = contentLines(result)

    // The move should be visible as - at old position and + at new position
    expect(lines).toContain('-    LOG("hello");')
    expect(lines).toContain('+    LOG("hello");')
  })

  it('moved hunk across file regions (non-overlapping base ranges)', () => {
    // patchA adds block at base ~10, patchB adds same block at base ~50
    const patchA = makePatch('file.cc', [
      '@@ -10,2 +10,5 @@',
      ' aaa',
      '+    LOG("hello");',
      '+    LOG("world");',
      '+    LOG("!");',
      ' bbb',
    ].join('\n'))

    const patchB = makePatch('file.cc', [
      '@@ -50,2 +50,5 @@',
      ' ccc',
      '+    LOG("hello");',
      '+    LOG("world");',
      '+    LOG("!");',
      ' ddd',
    ].join('\n'))

    const result = computeInterdiff(patchA, patchB)
    const lines = contentLines(result)

    // Old position: additions show as removals
    const dels = lines.filter(l => l.startsWith('-'))
    expect(dels).toContain('-    LOG("hello");')

    // New position: additions show as additions
    const adds = lines.filter(l => l.startsWith('+'))
    expect(adds).toContain('+    LOG("hello");')
  })

  it('new file only in patchB', () => {
    const patchA = makePatch('old.cc', [
      '@@ -1,2 +1,3 @@',
      ' x',
      '+y',
      ' z',
    ].join('\n'))

    const patchB =
      makePatch('old.cc', [
        '@@ -1,2 +1,3 @@',
        ' x',
        '+y',
        ' z',
      ].join('\n')) +
      makePatch('new.cc', [
        '@@ -0,0 +1,2 @@',
        '+line1',
        '+line2',
      ].join('\n'))

    const result = computeInterdiff(patchA, patchB)
    const lines = result.split('\n')

    // old.cc is identical → not in output
    expect(lines.some(l => l.includes('old.cc'))).toBe(false)
    // new.cc additions show up
    expect(lines).toContain('diff --interdiff a/new.cc b/new.cc')
    expect(lines).toContain('+line1')
    expect(lines).toContain('+line2')
  })

  it('generates @@ headers with correct line numbers', () => {
    // patchB adds lines at base line 50 → new line 50
    const patchB = makePatch('file.cc', [
      '@@ -50,2 +50,4 @@',
      ' ctx',
      '+new1',
      '+new2',
      ' ctx',
    ].join('\n'))

    const result = computeInterdiff('', patchB)
    const headers = result.split('\n').filter(l => l.startsWith('@@'))

    // Should reference line 50, not line 1
    expect(headers.length).toBeGreaterThan(0)
    expect(headers[0]).toMatch(/@@ -50,\d+ \+50,\d+ @@/)
  })

  it('new file in both patches shows only the delta', () => {
    // Both patches add the same new file with a one-line difference
    const patchA = [
      'diff --git a/newfile.txt b/newfile.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/newfile.txt',
      '@@ -0,0 +1,3 @@',
      '+aaa',
      '+bbb',
      '+ccc',
    ].join('\n')

    const patchB = [
      'diff --git a/newfile.txt b/newfile.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/newfile.txt',
      '@@ -0,0 +1,3 @@',
      '+aaa',
      '+BBB',
      '+ccc',
    ].join('\n')

    const result = computeInterdiff(patchA, patchB)

    expect(result).toBe(
      'diff --interdiff a/newfile.txt b/newfile.txt\n' +
      '@@ -1,3 +1,3 @@\n' +
      ' aaa\n' +
      '-bbb\n' +
      '+BBB\n' +
      ' ccc'
    )
  })
})
