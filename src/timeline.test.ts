import { describe, it, expect } from 'vitest'
import { buildTimeline, type PrData } from './timeline'

function mkPr(overrides: Partial<PrData> = {}): PrData {
  return {
    title: 'test',
    createdAt: '2025-01-01T00:00:00Z',
    author: { login: 'alice' },
    baseRefName: 'main',
    baseRef: { oid: 'base000', abbreviatedOid: 'base000' },
    headRef: { oid: 'head000', abbreviatedOid: 'head000', date: '2025-01-05T00:00:00Z' },
    events: [],
    ...overrides,
  }
}

function mkEvent(
  before: string,
  after: string,
  actor = 'bob',
  date = '2025-01-02T00:00:00Z',
) {
  return {
    createdAt: date,
    actor: { login: actor },
    beforeCommit: { oid: before, abbreviatedOid: before.slice(0, 7) },
    afterCommit: { oid: after, abbreviatedOid: after.slice(0, 7) },
  }
}

describe('buildTimeline', () => {
  it('PR with no force pushes — just initial row', () => {
    expect(buildTimeline(mkPr())).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'alice', label: 'initial' },
    ])
  })

  it('single force push — initial + force', () => {
    expect(buildTimeline(mkPr({
      headRef: { oid: 'aaa222', abbreviatedOid: 'aaa222' },
      events: [mkEvent('head000', 'aaa222')],
    }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'alice', label: 'initial' },
      { commit: 'aaa222', oid: 'aaa222', date: '2025-01-02 00:00', author: 'bob', label: 'force' },
    ])
  })

  it('force push with intermediate commits — inserts commit(s) row', () => {
    expect(buildTimeline(mkPr({
      headRef: { oid: 'aaa333', abbreviatedOid: 'aaa333' },
      events: [
        mkEvent('head000', 'aaa222', 'bob', '2025-01-02T00:00:00Z'),
        mkEvent('aaa299', 'aaa333', 'bob', '2025-01-03T00:00:00Z'),
      ],
    }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'alice', label: 'initial' },
      { commit: 'aaa222', oid: 'aaa222', date: '2025-01-02 00:00', author: 'bob', label: 'force' },
      { commit: 'aaa299', oid: 'aaa299', date: '2025-01-03 00:00', author: '', label: 'commit(s)' },
      { commit: 'aaa333', oid: 'aaa333', date: '2025-01-03 00:00', author: 'bob', label: 'force' },
    ])
  })

  it('trailing commits after last force push', () => {
    expect(buildTimeline(mkPr({
      headRef: { oid: 'zzz999', abbreviatedOid: 'zzz999', date: '2025-01-10T00:00:00Z' },
      events: [mkEvent('head000', 'aaa222')],
    }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'alice', label: 'initial' },
      { commit: 'aaa222', oid: 'aaa222', date: '2025-01-02 00:00', author: 'bob', label: 'force' },
      { commit: 'zzz999', oid: 'zzz999', date: '2025-01-10 00:00', author: '', label: 'commit(s)' },
    ])
  })

  it('no trailing commit row when head matches last force push', () => {
    expect(buildTimeline(mkPr({
      headRef: { oid: 'aaa222', abbreviatedOid: 'aaa222' },
      events: [mkEvent('head000', 'aaa222')],
    }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'alice', label: 'initial' },
      { commit: 'aaa222', oid: 'aaa222', date: '2025-01-02 00:00', author: 'bob', label: 'force' },
    ])
  })

  it('multiple force pushes in sequence', () => {
    expect(buildTimeline(mkPr({
      headRef: { oid: 'ccc444', abbreviatedOid: 'ccc444' },
      events: [
        mkEvent('head000', 'aaa111', 'alice', '2025-01-02T00:00:00Z'),
        mkEvent('aaa111', 'bbb222', 'bob', '2025-01-03T00:00:00Z'),
        mkEvent('bbb222', 'ccc444', 'carol', '2025-01-04T00:00:00Z'),
      ],
    }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'alice', label: 'initial' },
      { commit: 'aaa111', oid: 'aaa111', date: '2025-01-02 00:00', author: 'alice', label: 'force' },
      { commit: 'bbb222', oid: 'bbb222', date: '2025-01-03 00:00', author: 'bob', label: 'force' },
      { commit: 'ccc444', oid: 'ccc444', date: '2025-01-04 00:00', author: 'carol', label: 'force' },
    ])
  })

  it('force push with null afterCommit', () => {
    expect(buildTimeline(mkPr({
      headRef: { oid: 'head000', abbreviatedOid: 'head000' },
      events: [{
        createdAt: '2025-01-02T00:00:00Z',
        actor: { login: 'bob' },
        beforeCommit: { oid: 'head000', abbreviatedOid: 'head000' },
        afterCommit: null,
      }],
    }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'alice', label: 'initial' },
      { commit: '?', oid: '', date: '2025-01-02 00:00', author: 'bob', label: 'force' },
      { commit: 'head000', oid: 'head000', date: '', author: '', label: 'commit(s)' },
    ])
  })

  it('null author on PR', () => {
    expect(buildTimeline(mkPr({ author: null }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'unknown', label: 'initial' },
    ])
  })

  it('null actor on force push event', () => {
    expect(buildTimeline(mkPr({
      headRef: { oid: 'aaa222', abbreviatedOid: 'aaa222' },
      events: [{
        createdAt: '2025-01-02T00:00:00Z',
        actor: null,
        beforeCommit: { oid: 'head000', abbreviatedOid: 'head000' },
        afterCommit: { oid: 'aaa222', abbreviatedOid: 'aaa222' },
      }],
    }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'alice', label: 'initial' },
      { commit: 'aaa222', oid: 'aaa222', date: '2025-01-02 00:00', author: 'unknown', label: 'force' },
    ])
  })

  it('throws when no headRef and no events', () => {
    expect(() => buildTimeline(mkPr({ headRef: null, events: [] })))
      .toThrow('PR has no head ref and no force push history')
  })

  it('no headRef but has events — uses first beforeCommit as initial', () => {
    expect(buildTimeline(mkPr({
      headRef: null,
      events: [mkEvent('head000', 'aaa222')],
    }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'alice', label: 'initial' },
      { commit: 'aaa222', oid: 'aaa222', date: '2025-01-02 00:00', author: 'bob', label: 'force' },
    ])
  })

  it('dates are formatted correctly', () => {
    expect(buildTimeline(mkPr({ createdAt: '2025-06-15T14:30:45Z' }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-06-15 14:30', author: 'alice', label: 'initial' },
    ])
  })

  it('headRef with no date — trailing commit has empty date', () => {
    expect(buildTimeline(mkPr({
      headRef: { oid: 'zzz999', abbreviatedOid: 'zzz999' },
      events: [mkEvent('head000', 'aaa222')],
    }))).toEqual([
      { commit: 'head000', oid: 'head000', date: '2025-01-01 00:00', author: 'alice', label: 'initial' },
      { commit: 'aaa222', oid: 'aaa222', date: '2025-01-02 00:00', author: 'bob', label: 'force' },
      { commit: 'zzz999', oid: 'zzz999', date: '', author: '', label: 'commit(s)' },
    ])
  })
})
