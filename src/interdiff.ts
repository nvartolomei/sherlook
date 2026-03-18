import { structuredPatch } from 'diff'

export interface DiffFile {
  path: string
  chunks: string
  added: number
  removed: number
}

export function parseDiffFiles(raw: string): DiffFile[] {
  const files: DiffFile[] = []
  const parts = raw.split(/^(?=diff --(git|interdiff) )/m)
  for (const part of parts) {
    if (!part.match(/^diff --(git|interdiff) /)) continue
    const m = part.match(/^diff --(git|interdiff) a\/.+ b\/(.+)/)
    let added = 0, removed = 0
    for (const line of part.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++ ')) added++
      else if (line.startsWith('-') && !line.startsWith('--- ')) removed++
    }
    files.push({ path: m ? m[2] : '?', chunks: part, added, removed })
  }
  return files
}

export function stripPatchMeta(patch: string): string {
  return patch
    .split('\n')
    .filter((line) =>
      !line.startsWith('diff --git ') &&
      !line.startsWith('index ') &&
      !line.startsWith('--- ') &&
      !line.startsWith('+++ ') &&
      !line.startsWith('new file mode ') &&
      !line.startsWith('deleted file mode ') &&
      !line.startsWith('old mode ') &&
      !line.startsWith('new mode ') &&
      !line.startsWith('similarity index ') &&
      !line.startsWith('rename from ') &&
      !line.startsWith('rename to ')
    )
    .join('\n')
}

interface Hunk {
  header: string
  lines: string[]
}

function parseHunks(stripped: string): Hunk[] {
  const hunks: Hunk[] = []
  let header = ''
  let lines: string[] = []

  for (const line of stripped.split('\n')) {
    if (line.startsWith('@@')) {
      if (header) hunks.push({ header, lines })
      header = line
      lines = []
    } else if (header) {
      lines.push(line)
    }
  }
  if (header) hunks.push({ header, lines })
  return hunks
}

// Post-patch content: context + additions (what the file looks like after patch)
function getNewContent(hunk: Hunk): string {
  return hunk.lines.filter(l => !l.startsWith('-')).map(l => l.substring(1)).join('\n')
}

// Base content: context + removals (what the file looked like before patch)
function getOldContent(hunk: Hunk): string {
  return hunk.lines.filter(l => !l.startsWith('+')).map(l => l.substring(1)).join('\n')
}

function getOldRange(hunk: Hunk): [number, number] {
  const m = hunk.header.match(/@@ -(\d+)(?:,(\d+))?/)
  if (!m) return [0, 0]
  const start = parseInt(m[1])
  return [start, start + parseInt(m[2] ?? '1')]
}

function getOldStart(hunk: Hunk): number {
  const m = hunk.header.match(/@@ -(\d+)/)
  return m ? parseInt(m[1]) : 0
}

function getNewStart(hunk: Hunk): number {
  const m = hunk.header.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
  return m ? parseInt(m[1]) : 0
}

function rangesOverlap(a: [number, number], b: [number, number]): boolean {
  // Both [0,0] means both are new-file additions — treat as overlapping
  if (a[0] === 0 && a[1] === 0 && b[0] === 0 && b[1] === 0) return true
  return a[0] < b[1] && b[0] < a[1]
}

// Diff two source-level contents and emit unified diff hunks with adjusted line numbers
function emitDiff(
  oldContent: string,
  newContent: string,
  oldStartLine: number,
  newStartLine: number,
  result: string[],
): void {
  if (oldContent === newContent) return
  const oldStr = oldContent ? oldContent + '\n' : ''
  const newStr = newContent ? newContent + '\n' : ''
  const patch = structuredPatch('', '', oldStr, newStr, '', '', { context: 3 })
  for (const hunk of patch.hunks) {
    const oldStart = hunk.oldStart + oldStartLine - 1
    const newStart = hunk.newStart + newStartLine - 1
    result.push(`@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) {
      result.push(line)
    }
  }
}

export function computeInterdiff(patchA: string, patchB: string): string {
  const filesA = new Map(parseDiffFiles(patchA).map((f) => [f.path, f.chunks]))
  const filesB = new Map(parseDiffFiles(patchB).map((f) => [f.path, f.chunks]))

  const allPaths = [...new Set([...filesA.keys(), ...filesB.keys()])].sort()

  const result: string[] = []

  for (const path of allPaths) {
    const a = stripPatchMeta(filesA.get(path) || '')
    const b = stripPatchMeta(filesB.get(path) || '')
    if (a === b) continue

    const hunksA = parseHunks(a)
    const hunksB = parseHunks(b)

    // Match hunks by base-side range overlap
    const usedB = new Set<number>()
    const pairs: { a: Hunk | null, b: Hunk | null }[] = []

    for (const ha of hunksA) {
      const idx = hunksB.findIndex((hb, i) =>
        !usedB.has(i) && rangesOverlap(getOldRange(ha), getOldRange(hb))
      )
      if (idx >= 0) {
        usedB.add(idx)
        pairs.push({ a: ha, b: hunksB[idx] })
      } else {
        pairs.push({ a: ha, b: null })
      }
    }
    for (let i = 0; i < hunksB.length; i++) {
      if (!usedB.has(i)) pairs.push({ a: null, b: hunksB[i] })
    }

    // Sort by base position
    pairs.sort((x, y) => {
      const px = getOldStart(x.a ?? x.b!)
      const py = getOldStart(y.a ?? y.b!)
      return px - py
    })

    const fileResult: string[] = []

    for (const { a: ha, b: hb } of pairs) {
      if (ha && hb) {
        // Matched: diff the two post-patch contents (source-level)
        emitDiff(getNewContent(ha), getNewContent(hb), getNewStart(ha), getNewStart(hb), fileResult)
      } else if (ha) {
        // Only in patchA: resultA has post-patch, resultB has base
        emitDiff(getNewContent(ha), getOldContent(ha), getNewStart(ha), getOldStart(ha), fileResult)
      } else {
        // Only in patchB: resultA has base, resultB has post-patch
        emitDiff(getOldContent(hb!), getNewContent(hb!), getOldStart(hb!), getNewStart(hb!), fileResult)
      }
    }

    if (fileResult.length > 0) {
      result.push(`diff --interdiff a/${path} b/${path}`)
      result.push(...fileResult)
    }
  }

  return result.join('\n')
}
