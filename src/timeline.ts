export const LABEL_INITIAL = 'initial'
export const LABEL_FORCE = 'force'
export const LABEL_COMMIT = 'commit(s)'

export const LABEL_TOOLTIPS: Record<string, string> = {
  [LABEL_INITIAL]: 'First known commit on this PR',
  [LABEL_FORCE]: 'Result of a force push',
  [LABEL_COMMIT]: 'Commits pushed between force pushes',
}

export interface ForcePushEvent {
  createdAt: string
  actor: { login: string } | null
  beforeCommit: { oid: string; abbreviatedOid: string } | null
  afterCommit: { oid: string; abbreviatedOid: string } | null
}

export interface BaseRef {
  oid: string
  abbreviatedOid: string
  date?: string
}

export interface PrData {
  title: string
  createdAt: string
  author: { login: string } | null
  baseRefName: string
  baseRef: BaseRef | null
  headRef: BaseRef | null
  events: ForcePushEvent[]
}

export interface TimelineRow {
  commit: string
  oid: string
  date: string
  author: string
  label: string
}

export function formatDate(iso: string) {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16)
}

export function buildTimeline(pr: PrData): TimelineRow[] {
  const rows: TimelineRow[] = []

  // Row 1: first known commit (beforeCommit of first force push, or current head)
  const initial = pr.events[0]?.beforeCommit ?? pr.headRef
  if (!initial) throw new Error('PR has no head ref and no force push history')
  rows.push({
    commit: initial.abbreviatedOid,
    oid: initial.oid,
    date: formatDate(pr.createdAt),
    author: pr.author?.login ?? 'unknown',
    label: LABEL_INITIAL,
  })

  // Remaining rows: each force push's afterCommit
  for (const ev of pr.events) {
    // If beforeCommit doesn't match previous row, commits were pushed in between
    const prevOid = rows[rows.length - 1].oid
    if (ev.beforeCommit && ev.beforeCommit.oid !== prevOid) {
      rows.push({
        commit: ev.beforeCommit.abbreviatedOid,
        oid: ev.beforeCommit.oid,
        date: formatDate(ev.createdAt),
        author: '',
        label: LABEL_COMMIT,
      })
    }
    rows.push({
      commit: ev.afterCommit?.abbreviatedOid ?? '?',
      oid: ev.afterCommit?.oid ?? '',
      date: formatDate(ev.createdAt),
      author: ev.actor?.login ?? 'unknown',
      label: LABEL_FORCE,
    })
  }

  const lastOid = rows[rows.length - 1].oid
  if (pr.headRef && pr.headRef.oid !== lastOid) {
    rows.push({
      commit: pr.headRef.abbreviatedOid,
      oid: pr.headRef.oid,
      date: pr.headRef.date ? formatDate(pr.headRef.date) : '',
      author: '',
      label: LABEL_COMMIT,
    })
  }

  return rows
}
