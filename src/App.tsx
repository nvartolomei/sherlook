import { useState, useEffect, type SyntheticEvent } from 'react'
import { computeInterdiff, parseDiffFiles } from './interdiff'

const LABEL_INITIAL = 'initial'
const LABEL_FORCE = 'force'
const LABEL_TIP = 'tip'

const LABEL_TOOLTIPS: Record<string, string> = {
  [LABEL_INITIAL]: 'First known commit on this PR',
  [LABEL_FORCE]: 'Result of a force push',
  [LABEL_TIP]: 'Current PR head (contains extra commits after previous timeline entry)',
}

interface ForcePushEvent {
  createdAt: string
  actor: { login: string } | null
  beforeCommit: { oid: string; abbreviatedOid: string } | null
  afterCommit: { oid: string; abbreviatedOid: string } | null
}

interface BaseRef {
  oid: string
  abbreviatedOid: string
  date?: string
}

interface PrData {
  createdAt: string
  author: { login: string } | null
  baseRefName: string
  baseRef: BaseRef | null
  headRef: BaseRef | null
  events: ForcePushEvent[]
}

const PR_URL_RE = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/

function parsePrUrl(url: string) {
  const m = url.match(PR_URL_RE)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) }
}

async function fetchTimeline(
  token: string,
  owner: string,
  repo: string,
  number: number,
): Promise<PrData> {
  const query = `{
    repository(owner: "${owner}", name: "${repo}") {
      pullRequest(number: ${number}) {
        createdAt
        author { login }
        baseRefName
        baseRefOid
        headRefOid
        commits(last: 1) { nodes { commit { committedDate } } }
        timelineItems(itemTypes: HEAD_REF_FORCE_PUSHED_EVENT, first: 50) {
          nodes {
            ... on HeadRefForcePushedEvent {
              createdAt
              actor { login }
              beforeCommit { oid abbreviatedOid }
              afterCommit { oid abbreviatedOid }
            }
          }
        }
      }
    }
  }`

  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  })

  if (!res.ok) {
    throw new Error(`GitHub API error: ${res.status} ${res.statusText}`)
  }

  const json = await res.json()

  if (json.errors) {
    throw new Error(json.errors.map((e: { message: string }) => e.message).join(', '))
  }

  const pr = json.data.repository.pullRequest
  return {
    createdAt: pr.createdAt,
    author: pr.author,
    baseRefName: pr.baseRefName,
    baseRef: pr.baseRefOid ? { oid: pr.baseRefOid, abbreviatedOid: pr.baseRefOid.slice(0, 7) } : null,
    headRef: pr.headRefOid ? { oid: pr.headRefOid, abbreviatedOid: pr.headRefOid.slice(0, 7), date: pr.commits?.nodes?.[0]?.commit?.committedDate } : null,
    events: pr.timelineItems.nodes,
  }
}

const DIFF_CACHE = 'sherlook-diff-v1'

async function fetchDiff(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`

  const cache = await caches.open(DIFF_CACHE)
  const cached = await cache.match(url)
  if (cached) return cached.text()

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.diff',
    },
  })

  if (!res.ok) {
    throw new Error(`GitHub compare error: ${res.status} ${res.statusText}`)
  }

  // Cache the response (clone since body can only be consumed once)
  await cache.put(url, res.clone())

  return res.text()
}


interface TimelineRow {
  commit: string
  oid: string
  date: string
  author: string
  label: string
}

function buildTimeline(pr: PrData): TimelineRow[] {
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
      label: LABEL_TIP,
    })
  }

  return rows
}

interface BaseOption {
  oid: string
  label: string
}

function getBaseOptions(pr: PrData, timeline: TimelineRow[], selectedOid: string): BaseOption[] {
  const idx = timeline.findIndex((r) => r.oid === selectedOid)
  if (idx < 0) return []

  const options: BaseOption[] = []

  // PR base branch is always an option
  if (pr.baseRef) {
    options.push({
      oid: pr.baseRef.oid,
      label: `${pr.baseRefName} (${pr.baseRef.abbreviatedOid})`,
    })
  }

  // All previous commits in the timeline
  for (let i = 0; i < idx; i++) {
    options.push({
      oid: timeline[i].oid,
      label: `#${i} ${timeline[i].commit}`,
    })
  }

  return options
}

function defaultBase(pr: PrData, timeline: TimelineRow[], selectedOid: string): string {
  const idx = timeline.findIndex((r) => r.oid === selectedOid)
  if (idx > 0) return timeline[idx - 1].oid
  if (pr.baseRef) return pr.baseRef.oid
  return ''
}

function formatDate(iso: string) {
  return new Date(iso).toISOString().replace('T', ' ').slice(0, 16)
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer" className="ext-link">[{children}]</a>
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('gh_token') || '')
  const [prUrl, setPrUrl] = useState(() => {
    return new URLSearchParams(window.location.search).get('pull') || ''
  })
  const [selectedOid, setSelectedOid] = useState(() => {
    return new URLSearchParams(window.location.search).get('commit') || ''
  })
  const [baseOid, setBaseOid] = useState(() => {
    return new URLSearchParams(window.location.search).get('base') || ''
  })
  const [prData, setPrData] = useState<PrData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [diff, setDiff] = useState('')
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState('')
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem('gh_token', token)
  }, [token])

  function syncUrl(overrides: Record<string, string> = {}) {
    const state = { pull: prUrl, commit: selectedOid, base: baseOid, ...overrides }
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(state)) {
      if (v) params.set(k, v)
    }
    const qs = params.toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    if (url !== window.location.pathname + (window.location.search || '')) {
      window.history.pushState(null, '', url)
    }
  }

  useEffect(() => {
    syncUrl()
  }, [selectedOid, baseOid]) // eslint-disable-line react-hooks/exhaustive-deps

  async function doFetch(url: string) {
    setError('')
    setPrData(null)
    setSelectedOid('')
    setBaseOid('')

    if (!token.trim()) return

    const parsed = parsePrUrl(url)
    if (!parsed) {
      setError('Invalid PR URL. Expected: https://github.com/owner/repo/pull/123')
      return
    }

    setLoading(true)
    try {
      const data = await fetchTimeline(token.trim(), parsed.owner, parsed.repo, parsed.number)
      document.title = `+- ${parsed.owner}/${parsed.repo}#${parsed.number} — sherlook`
      setPrData(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(e: SyntheticEvent) {
    e.preventDefault()
    syncUrl({ pull: prUrl })
    doFetch(prUrl)
  }

  useEffect(() => {
    if (prUrl && token) doFetch(prUrl)

    function handlePopState() {
      const params = new URLSearchParams(window.location.search)
      const pull = params.get('pull') || ''
      const commit = params.get('commit') || ''
      const base = params.get('base') || ''
      setPrUrl(pull)
      setSelectedOid(commit)
      setBaseOid(base)
      if (pull && token) doFetch(pull)
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch diff when base and selected commit are set
  useEffect(() => {
    if (!baseOid || !selectedOid || !token || !prUrl || !prData) {
      setDiff('')
      return
    }
    const parsed = parsePrUrl(prUrl)
    if (!parsed) return

    const isInterdiff = prData.baseRef && baseOid !== prData.baseRef.oid
    const targetOid = prData.baseRef?.oid

    let cancelled = false
    setDiffLoading(true)
    setDiffError('')
    setDiff('')

    const work = isInterdiff && targetOid
      ? Promise.all([
          fetchDiff(token.trim(), parsed.owner, parsed.repo, targetOid, baseOid),
          fetchDiff(token.trim(), parsed.owner, parsed.repo, targetOid, selectedOid),
        ]).then(([diffA, diffB]) => computeInterdiff(diffA, diffB))
      : fetchDiff(token.trim(), parsed.owner, parsed.repo, baseOid, selectedOid)

    work
      .then((text) => {
        if (!cancelled) { setDiff(text); setSelectedFile(null) }
      })
      .catch((err) => {
        if (!cancelled) setDiffError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false)
      })

    return () => { cancelled = true }
  }, [baseOid, selectedOid, token, prUrl, prData])

  const timeline = prData ? buildTimeline(prData) : []
  const baseOptions = prData && selectedOid ? getBaseOptions(prData, timeline, selectedOid) : []

  // Set default base if commit is selected but base is missing or invalid
  useEffect(() => {
    if (!prData || !selectedOid) return
    const validOids = baseOptions.map((o) => o.oid)
    if (!baseOid || !validOids.includes(baseOid)) {
      setBaseOid(defaultBase(prData, timeline, selectedOid))
    }
  }, [selectedOid, prData]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="app">
      <h1>
        <a href="/"><img src="/git.svg" alt="git" className="logo" /> sherlook</a>
        <ExtLink href="https://github.com/nvartolomei/sherlook">source</ExtLink>
      </h1>
      <p className="description">
        Someone force-pushed a PR and now the diff is 10,000 lines of rebased noise?
        Sherlook diffs the diffs to show only what actually changed between force pushes.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="section">
          <label>
            GitHub token:{' '}
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              size={40}
              placeholder="ghp_..."
            />
          </label>
          {' '}
          <ExtLink href="https://github.com/settings/personal-access-tokens/new">create token</ExtLink>
          <div className="helper">
            Create a fine-grained token: Settings &rarr; Developer settings &rarr; Fine-grained
            tokens &rarr; Generate. Set "Public Repositories (<strong>read-only</strong>)" under Repository access.
            No extra permissions needed. Your token stays in localStorage and is only sent to the GitHub API.
          </div>
        </div>

        <div className="section">
          <label>
            PR URL:{' '}
            <input
              type="text"
              value={prUrl}
              onChange={(e) => setPrUrl(e.target.value)}
              size={50}
              placeholder="https://github.com/owner/repo/pull/123"
            />
          </label>
          {' '}
          <button type="submit">Fetch</button>
        </div>
      </form>

      {(loading || timeline.length > 0 || (prUrl && !token.trim()) || error) && (
        <div className="section">
          <h2>## timeline</h2>
          {!token.trim() && prUrl && (
            <div className="error">Configure a GitHub token to load this PR.</div>
          )}
          {error && <div className="error">{error}</div>}
          {loading && <div className="dim">Loading...</div>}
          {!loading && timeline.length > 0 && (
          <table className="timeline">
            <thead>
              <tr>
                <th></th>
                <th>#</th>
                <th>commit</th>
                <th>date</th>
                <th>author</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((row, i) => (
                <tr
                  key={i}
                  className={`clickable ${row.oid === selectedOid ? 'selected' : ''}`}
                  onClick={() => {
                    setSelectedOid(row.oid)
                    if (row.oid !== selectedOid) {
                      setBaseOid(defaultBase(prData!, timeline, row.oid))
                    }
                  }}
                >
                  <td className="dim label" title={LABEL_TOOLTIPS[row.label]}>{row.label}</td>
                  <td className="dim">{row.label === LABEL_TIP ? '∞' : i}</td>
                  <td className="commit">{row.commit}</td>
                  <td>{row.date}</td>
                  <td>{row.author}</td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </div>
      )}

      {!loading && selectedOid && prData && baseOptions.length > 0 && (() => {
        const isInterdiff = prData?.baseRef && baseOid !== prData.baseRef.oid
        return (
        <div className="section">
          <h2 className="diff-heading">
            ## {isInterdiff ? 'interdiff' : 'diff'}
            {baseOptions.length > 0 && (
              <span className="base-selector">
                <select value={baseOid} onChange={(e) => setBaseOid(e.target.value)}>
                  {baseOptions.map((opt) => (
                    <option key={opt.oid} value={opt.oid}>{opt.label}</option>
                  ))}
                </select>
                {' '}&rarr; {selectedOid.slice(0, 7)}
              </span>
            )}
          </h2>
          {diffLoading && <div className="dim">Loading diff...</div>}
          {diffError && <div className="error">{diffError}</div>}
          {!diffLoading && !diffError && diff && (() => {
            const files = parseDiffFiles(diff)
            const visibleDiff = selectedFile
              ? files.find((f) => f.path === selectedFile)?.chunks ?? ''
              : diff
            return (
              <>
                <div className="file-picker">
                  <div
                    className={`file-entry ${selectedFile === null ? 'file-selected' : ''}`}
                    onClick={() => setSelectedFile(null)}
                  >
                    all files ({files.length})
                  </div>
                  {files.map((f) => (
                    <div
                      key={f.path}
                      className={`file-entry ${selectedFile === f.path ? 'file-selected' : ''}`}
                      onClick={() => setSelectedFile(f.path)}
                    >
                      {f.path}
                      {' '}
                      <span className="file-stat file-stat-add">+{f.added}</span>
                      <span className="file-stat file-stat-del">-{f.removed}</span>
                    </div>
                  ))}
                </div>
                <div className="diff">
                  <div className="diff-inner">
                    {visibleDiff.split('\n').map((line, i) => {
                      let cls = ''
                      if (line.startsWith('diff --interdiff') || line.startsWith('diff --git')) cls = 'diff-file'
                      else if (line.startsWith('+++ ') || line.startsWith('--- ')) cls = 'diff-file'
                      else if (line.startsWith('@@')) cls = 'diff-hunk'
                      else if (line.startsWith('+')) cls = 'diff-add'
                      else if (line.startsWith('-')) cls = 'diff-del'
                      return <div key={i} className={cls}>{line}</div>
                    })}
                  </div>
                </div>
              </>
            )
          })()}
          {!diffLoading && !diffError && !diff && baseOid && (
            <div className="dim">Empty diff.</div>
          )}
        </div>
        )
      })()}
      <footer className="footer">
        Git Logo by <ExtLink href="https://twitter.com/jasonlong">Jason Long</ExtLink>,{' '}
        <ExtLink href="https://creativecommons.org/licenses/by/3.0/">CC BY 3.0</ExtLink>
      </footer>
    </div>
  )
}

export default App
