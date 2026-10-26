#!/usr/bin/env node
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, rmdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const [name, channel, cwd, workshop, port, recover = '0'] = process.argv.slice(2)
if (!name || !/^[a-z0-9_-]+$/.test(channel) || !cwd || !workshop || !/^\d+$/.test(port)) throw new Error('invalid new-session arguments')
const root = join(process.env.KA_STATE_DIR, 'codex-app-servers')
mkdirSync(root, { recursive: true, mode: 0o700 })
const file = join(root, `${channel}.session.json`)
const journal = join(root, `${channel}.session-switch.json`)
const lock = join(root, `${channel}.session-switch.lock`)
const write = (path, value) => {
  writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(path + '.tmp', path)
}
async function api(action, threadId) {
  const response = await fetch(`http://127.0.0.1:${port}/api/runtimes/codex/${channel}/session-switch`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, thread_id: threadId, cwd }), signal: AbortSignal.timeout(15000),
  })
  const body = await response.json()
  if (!response.ok || !body.ok) throw new Error(body.error || 'session switch API unavailable')
  return body.result
}
function command(verb) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [workshop, verb, name, '--skip-daemon'], { stdio: ['ignore', 'pipe', 'pipe'] })
    // Never print pane captures or private workspace contents in this controller.
    child.stdout.resume(); child.stderr.resume()
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`${verb} timed out`)) }, 180000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${verb} failed (${code})`)) })
  })
}
async function ready(expected) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const status = await api('status')
    const binding = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
    if (status.held && status.alive && binding.threadId && !binding.fresh && status.threadId === binding.threadId && (!expected || expected === binding.threadId)) return binding.threadId
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('new session registration did not become ready')
}
// A controller crash leaves a journal and held Channel queue. Recovery is
// explicit, never silently discard the journal or release to an unknown thread.
if (existsSync(lock) && recover === '1') {
  const pid = Number(readFileSync(join(lock, 'pid'), 'utf8'))
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid controller lock; manual inspection required')
  let alive = true
  try { process.kill(pid, 0) } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error }
  if (alive) throw new Error('session switch controller still running')
  unlinkSync(join(lock, 'pid')); rmdirSync(lock)
}
mkdirSync(lock, { mode: 0o700 })
writeFileSync(join(lock, 'pid'), String(process.pid), { mode: 0o600 })
let transaction
let acquired = false
try {
  if (recover === '1') {
    const candidate = JSON.parse(readFileSync(journal, 'utf8'))
    if (candidate.cwd !== cwd || candidate.channel !== channel || (candidate.previous !== null && (!candidate.previous?.threadId || candidate.previous.cwd !== cwd))) throw new Error('invalid recovery journal')
    transaction = candidate
    if (['complete', 'rolled-back'].includes(transaction.phase)) {
      console.log(JSON.stringify({ ok: true, mate: name, already_finished: true }))
      transaction.phase = 'complete'
    }
    if (transaction.phase === 'releasing') {
      await api('release', transaction.threadId)
      write(journal, { ...transaction, phase: 'complete' }); transaction.phase = 'complete'
      console.log(JSON.stringify({ ok: true, mate: name, recovered_release: true }))
      process.exitCode = 0
    }
  } else {
    if (existsSync(journal)) {
      const prior = JSON.parse(readFileSync(journal, 'utf8'))
      if (!['complete', 'rolled-back'].includes(prior.phase)) throw new Error('unfinished switch; use --recover')
    }
    const old = await api('status')
    if (old.threadId && old.cwd !== cwd) throw new Error('channel workspace mismatch')
    if (old.held) throw new Error('unfinished channel hold; use --recover')
    if (!old.threadId && existsSync(file)) throw new Error('bound mate is offline; start it before rotating to preserve rollback')
    transaction = { schema_version: 1, channel, cwd, phase: 'preparing', previous: old.threadId ? { schema_version: 1, cwd, threadId: old.threadId, fresh: false } : null }
    write(journal, transaction)
    await api(old.threadId ? 'begin' : 'begin-new', old.threadId)
    acquired = true
  }
  if (transaction.phase !== 'complete') {
    if (recover === '1' && transaction.previous) throw new Error('explicit rollback requested')
    write(file, { schema_version: 1, cwd, fresh: true, previousThreadId: transaction.previous?.threadId })
    transaction.phase = 'switching'; write(journal, transaction)
    if (transaction.previous || recover === '1') await command('stop')
    await command('start')
    const threadId = await ready()
    if (threadId === transaction.previous?.threadId) throw new Error('new session reused old thread')
    transaction.phase = 'releasing'; transaction.threadId = threadId; write(journal, transaction)
    await api('release', threadId)
    write(journal, { ...transaction, phase: 'complete', threadId }); transaction.phase = 'complete'
    console.log(JSON.stringify({ ok: true, mate: name, switched: true, restore: 'mate-bound', threadId }))
  }
} catch (error) {
  if (!transaction) throw error
  if (transaction.phase === 'releasing') {
    console.error('Release acknowledgement uncertain. Use --recover to reconcile; do not roll back a possibly active new thread.')
    process.exitCode = 1
  } else {
    try {
      const status = await api('status')
      if (!status.held) {
        if (transaction.phase === 'preparing' && !acquired) {
          transaction.phase = 'rolled-back'; write(journal, transaction)
          throw new Error('not-acquired')
        }
        throw new Error('hold missing; manual inspection required')
      }
      if (!transaction.previous) throw new Error('first session failed; held messages retained for --recover')
      write(file, transaction.previous)
      await command('stop'); await command('start')
      await ready(transaction.previous.threadId)
      await api('release', transaction.previous.threadId)
      transaction.phase = 'rolled-back'; write(journal, transaction)
      console.log(JSON.stringify({ ok: recover === '1', mate: name, rolled_back: true }))
    } catch (rollbackError) {
      if (rollbackError.message !== 'not-acquired') {
        transaction.phase = 'recovery-required'; write(journal, transaction)
        console.error('Recovery required: old thread and queued messages retained. Do not start a second switch.')
        process.exitCode = 1
      }
    }
    if (recover !== '1') { console.error(error.message); process.exitCode = 1 }
  }
} finally { unlinkSync(join(lock, 'pid')); rmdirSync(lock) }
