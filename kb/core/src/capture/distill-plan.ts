import { mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { parseFrontmatter } from '../knowledge-store/markdown.js'
import { atomicUpdateText, textHash } from './atomic-update.js'
import { createCaptureSnapshot, type CaptureSnapshot } from './snapshot.js'

/** Codex progress is a set of acknowledged immutable turn snapshots, not a
 * Claude reader byte cursor. Persist the fixed set once; later captures belong
 * to the next run. Never infer acknowledgement from a model's stats output. */
export function planDistill(rawDir: string, session: string, upper: number, dir: string) {
  if (!Number.isSafeInteger(upper) || upper < 0 || !session) throw new Error('invalid boundary')
  rawDir = realpathSync(rawDir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  dir = realpathSync(dir)
  const jobs: string[] = []
  let deferred = 0
  for (const file of readdirSync(rawDir).filter(f => f.endsWith('.md')).sort()) {
    const { data } = parseFrontmatter(readFileSync(join(rawDir, file), 'utf8'))
    const metadata = data.metadata as Record<string, unknown> | undefined
    if (data.source !== 'codex' || metadata?.codex_session_id !== session || data.distilled === true) continue
    const end = metadata?.rollout_end_offset
    if (typeof end !== 'number' || !Number.isSafeInteger(end) || end < 0) throw new Error('missing Codex capture boundary')
    if (end > upper) { deferred++; continue }
    const job = join(dir, `${jobs.length}.json`)
    createCaptureSnapshot(rawDir, file, job)
    jobs.push(job)
  }
  const plan = { schema: 1, session, upper, jobs, deferred }
  atomicUpdateText(join(dir, 'plan.json'), old => {
    if (old !== null) throw new Error('plan already exists')
    return JSON.stringify(plan) + '\n'
  })
  return { ...plan, count: jobs.length }
}

export function pendingDistill(planFile: string) {
  const plan = JSON.parse(readFileSync(planFile, 'utf8'))
  if (plan.schema !== 1 || !Array.isArray(plan.jobs)) throw new Error('invalid plan')
  const pending: string[] = []
  for (const job of plan.jobs) {
    const s = JSON.parse(readFileSync(job, 'utf8')) as CaptureSnapshot
    if (s.schema !== 1 || textHash(s.body) !== s.hash) throw new Error('invalid snapshot')
    const { data, content } = parseFrontmatter(readFileSync(join(s.rawDir, s.file), 'utf8'))
    const body = content.trim()
    const count = s.body.split(/^## (?:User|Assistant)$/m).length - 1
    const acknowledged = data.source === 'codex' && data.id === s.id &&
      (body === s.body || body.startsWith(s.body + '\n\n## ')) &&
      typeof data.distilled_content_hash === 'string' &&
      Number(data.distilled_message_count ?? 0) >= count
    if (!acknowledged) pending.push(job)
  }
  return { total: plan.jobs.length, pending, complete: pending.length === 0 }
}
