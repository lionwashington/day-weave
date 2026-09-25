import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planDistill, pendingDistill } from '../src/capture/distill-plan.js'
import { acknowledgeCaptureSnapshot } from '../src/capture/snapshot.js'
import { serializeWithFrontmatter, parseFrontmatter } from '../src/knowledge-store/markdown.js'

describe('Codex distill progress isolation', () => {
  it('ignores legacy Claude cursor; bounded snapshots survive continuation and are idempotent', () => {
    const root = mkdtempSync(join(tmpdir(), 'distill-plan-'))
    try {
      const raw = join(root, 'raw'); mkdirSync(raw)
      const put = (file: string, extra = {}) => writeFileSync(join(raw, file), serializeWithFrontmatter({
        id: file, source: 'codex', distilled: false,
        metadata: { codex_session_id: 'synthetic', rollout_end_offset: 100 }, ...extra,
      }, '## User\n\nsynthetic fact'))
      put('legacy.md', { source: 'claude-code', session_id: 'synthetic', last_parsed_offset: 1 })
      put('first.md')
      put('future.md', { metadata: { codex_session_id: 'synthetic', rollout_end_offset: 200 } })
      put('other.md', { metadata: { codex_session_id: 'other', rollout_end_offset: 100 } })
      const plan = planDistill(raw, 'synthetic', 100, join(root, 'job'))
      expect(plan.count).toBe(1); expect(plan.deferred).toBe(1)
      const file = join(root, 'job/plan.json')
      expect(pendingDistill(file).complete).toBe(false)
      const p = join(raw, 'first.md')
      writeFileSync(p, readFileSync(p, 'utf8').trimEnd() + '\n\n## Assistant\n\ncontinuation')
      expect(acknowledgeCaptureSnapshot(plan.jobs[0], ['synthetic']).complete).toBe(false)
      expect(pendingDistill(file).complete).toBe(true)
      expect(acknowledgeCaptureSnapshot(plan.jobs[0], ['synthetic']).status).toBe('unchanged')
      expect(parseFrontmatter(readFileSync(p, 'utf8')).data.distilled).toBe(false)
      const next = planDistill(raw, 'synthetic', 100, join(root, 'next'))
      expect(next.count).toBe(1)
      expect(acknowledgeCaptureSnapshot(next.jobs[0], ['synthetic']).complete).toBe(true)
      expect(planDistill(raw, 'synthetic', 100, join(root, 'again')).count).toBe(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it('fails closed on missing capture boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'distill-plan-'))
    try {
      writeFileSync(join(root, 'bad.md'), serializeWithFrontmatter({source:'codex', metadata:{codex_session_id:'synthetic'}}, 'x'))
      expect(() => planDistill(root, 'synthetic', 100, join(root, 'job'))).toThrow('boundary')
    } finally { rmSync(root, { recursive:true, force:true }) }
  })
})
