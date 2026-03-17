import { useState, useEffect, FormEvent } from 'react'
import { diffLines } from 'diff'

interface ForcePushEvent {
  createdAt: string
  actor: { login: string } | null
  beforeCommit: { oid: string; abbreviatedOid: string } | null
  afterCommit: { oid: string; abbreviatedOid: string } | null
}

interface BaseRef {
  oid: string
  abbreviatedOid: string
}

interface PrData {
  createdAt: string
  author: { login: string } | null
  baseRefName: string
  baseRef: BaseRef | null
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
        baseRef { target { ... on Commit { oid abbreviatedOid } } }
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
  const baseTarget = pr.baseRef?.target
  return {
    createdAt: pr.createdAt,
    author: pr.author,
    baseRefName: pr.baseRefName,
    baseRef: baseTarget ? { oid: baseTarget.oid, abbreviatedOid: baseTarget.abbreviatedOid } : null,
    events: pr.timelineItems.nodes,
  }
}

async function fetchDiff(
  token: string,
  owner: string,
  repo: string,
  base: string,
  head: string,
): Promise<string> {
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/compare/${base}...${head}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.diff',
      },
    },
  )

  if (!res.ok) {
    throw new Error(`GitHub compare error: ${res.status} ${res.statusText}`)
  }

  return res.text()
}

interface DiffFile {
  path: string
  chunks: string
  added: number
  removed: number
}

function parseDiffFiles(raw: string): DiffFile[] {
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

function computeInterdiff(patchA: string, patchB: string): string {
  const filesA = new Map(parseDiffFiles(patchA).map((f) => [f.path, f.chunks]))
  const filesB = new Map(parseDiffFiles(patchB).map((f) => [f.path, f.chunks]))

  const allPaths = [...new Set([...filesA.keys(), ...filesB.keys()])].sort()

  const result: string[] = []

  for (const path of allPaths) {
    const a = filesA.get(path) || ''
    const b = filesB.get(path) || ''
    if (a === b) continue

    result.push(`diff --interdiff a/${path} b/${path}`)

    const changes = diffLines(a, b)
    for (const change of changes) {
      const prefix = change.added ? '+' : change.removed ? '-' : ' '
      const text = change.value.endsWith('\n') ? change.value.slice(0, -1) : change.value
      for (const line of text.split('\n')) {
        result.push(prefix + line)
      }
    }
  }

  return result.join('\n')
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

  if (pr.events.length === 0) return rows

  // Row 1: the initial commit (beforeCommit of the first force push)
  const first = pr.events[0]
  rows.push({
    commit: first.beforeCommit?.abbreviatedOid ?? '?',
    oid: first.beforeCommit?.oid ?? '',
    date: formatDate(pr.createdAt),
    author: pr.author?.login ?? 'unknown',
    label: 'initial',
  })

  // Rows 2+: each force push's afterCommit
  for (const ev of pr.events) {
    rows.push({
      commit: ev.afterCommit?.abbreviatedOid ?? '?',
      oid: ev.afterCommit?.oid ?? '',
      date: formatDate(ev.createdAt),
      author: ev.actor?.login ?? 'unknown',
      label: 'force',
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
      label: `#${i + 1} ${timeline[i].commit}`,
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

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (prUrl) {
      params.set('pull', prUrl)
    } else {
      params.delete('pull')
    }
    if (selectedOid) {
      params.set('commit', selectedOid)
    } else {
      params.delete('commit')
    }
    if (baseOid) {
      params.set('base', baseOid)
    } else {
      params.delete('base')
    }
    const qs = params.toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(null, '', url)
  }, [prUrl, selectedOid, baseOid])

  async function doFetch(url: string) {
    setError('')
    setPrData(null)

    if (!token.trim()) {
      setError('GitHub token is required.')
      return
    }

    const parsed = parsePrUrl(url)
    if (!parsed) {
      setError('Invalid PR URL. Expected: https://github.com/owner/repo/pull/123')
      return
    }

    setLoading(true)
    try {
      const data = await fetchTimeline(token.trim(), parsed.owner, parsed.repo, parsed.number)
      setPrData(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    doFetch(prUrl)
  }

  useEffect(() => {
    if (prUrl && token) doFetch(prUrl)
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
    <>
      <h1><img src="/git.svg" alt="git" className="logo" /> sherlook</h1>

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
          <a
            href="https://github.com/settings/personal-access-tokens/new"
            target="_blank"
            rel="noreferrer"
          >
            create token
          </a>
          <div className="helper">
            Create a fine-grained token: Settings &rarr; Developer settings &rarr; Fine-grained
            tokens &rarr; Generate. Set "Public Repositories (read-only)" under Repository access.
            No extra permissions needed.
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

      {error && <div className="error">{error}</div>}

      {loading && <div>Loading...</div>}

      {!loading && prData && timeline.length === 0 && (
        <div>No force pushes found on this PR.</div>
      )}

      {!loading && timeline.length > 0 && (
        <div className="section">
          <h2>## timeline</h2>
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
                  <td className="dim label">{row.label}</td>
                  <td className="dim">{i + 1}</td>
                  <td className="commit">{row.commit}</td>
                  <td>{row.date}</td>
                  <td>{row.author}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedOid && (() => {
        const isInterdiff = prData?.baseRef && baseOid !== prData.baseRef.oid
        return (
        <div className="section">
          <h2 className="diff-heading">
            ## {isInterdiff ? 'interdiff' : 'diff'}{' '}
            <span className="base-selector">
              <select value={baseOid} onChange={(e) => setBaseOid(e.target.value)}>
                {baseOptions.map((opt) => (
                  <option key={opt.oid} value={opt.oid}>{opt.label}</option>
                ))}
              </select>
              {' '}&rarr; {selectedOid.slice(0, 7)}
            </span>
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
                <pre className="diff">
                  {visibleDiff.split('\n').map((line, i) => {
                    let cls = ''
                    if (line.startsWith('diff --interdiff') || line.startsWith('diff --git')) cls = 'diff-file'
                    else if (line.startsWith('+++ ') || line.startsWith('--- ')) cls = 'diff-file'
                    else if (line.startsWith('@@')) cls = 'diff-hunk'
                    else if (line.startsWith('+')) cls = 'diff-add'
                    else if (line.startsWith('-')) cls = 'diff-del'
                    return <div key={i} className={cls}>{line}</div>
                  })}
                </pre>
              </>
            )
          })()}
          {!diffLoading && !diffError && !diff && selectedOid && baseOid && (
            <div className="dim">No diff.</div>
          )}
        </div>
        )
      })()}
    </>
  )
}

export default App
