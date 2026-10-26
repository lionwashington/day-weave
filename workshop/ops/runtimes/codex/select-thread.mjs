#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
const [endpoint, cwd, explicitThreadId = '', mode = 'select'] = process.argv.slice(2)
// Runtime .thread files record the selected session; they are not resume pins.
const sessionFile = process.env.KA_CODEX_SESSION_FILE
const session = mode === 'select' && sessionFile && existsSync(sessionFile) ? JSON.parse(readFileSync(sessionFile, 'utf8')) : null
if (session && (session.schema_version !== 1 || session.cwd !== cwd || (!session.fresh && !session.threadId))) throw new Error('invalid mate session binding')
const requestedThreadId = session ? (session.fresh ? '' : session.threadId) : explicitThreadId
if (!endpoint || !cwd) throw new Error('usage: select-thread.mjs <endpoint> <cwd> [thread-id]')
if (!['select', 'wait'].includes(mode)) throw new Error(`invalid selection mode: ${mode}`)

const websocket = new WebSocket(endpoint)
let nextId = 1
const pending = new Map()
let notifiedThread
const model = process.env.KA_CODEX_MODEL || undefined
const resumeTimeoutMs = Number(process.env.KA_CODEX_THREAD_RESUME_TIMEOUT_MS ?? 600_000)

function request(method, params, timeoutMs = 15_000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, timeoutMs)
    pending.set(id, { method, resolve, reject, timer })
    websocket.send(JSON.stringify({ method, id, params }))
  })
}

await new Promise((resolve, reject) => {
  websocket.addEventListener('open', resolve, { once: true })
  websocket.addEventListener('error', () => reject(new Error(`cannot connect to ${endpoint}`)), { once: true })
})

websocket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  if (message.method === 'thread/started' && message.params?.thread?.cwd === cwd) {
    notifiedThread = message.params.thread
  }
  if (message.id === undefined || (!('result' in message) && !('error' in message))) return
  const item = pending.get(message.id)
  if (!item) return
  clearTimeout(item.timer)
  pending.delete(message.id)
  if (message.error) item.reject(Object.assign(new Error(`${item.method}: ${message.error.message ?? JSON.stringify(message.error)}`), { rpcError: message.error }))
  else item.resolve(message.result)
})

try {
  await request('initialize', {
    clientInfo: { name: 'ka_workshop', title: 'KA Workshop', version: '0.1.0' },
    capabilities: null,
  })
  websocket.send(JSON.stringify({ method: 'initialized', params: {} }))

  const listLatest = async () => {
    const listed = await request('thread/list', {
      cwd,
      limit: 1,
      sortKey: 'recency_at',
      sortDirection: 'desc',
    })
    const latest = listed.data?.[0]
    if (latest && latest.cwd !== cwd) throw new Error('latest thread belongs to another workspace')
    return latest
  }

  let thread
  let fresh = false
  if (session?.fresh) {
    fresh = true
  } else if (requestedThreadId) {
    try {
      const checked = await request('thread/read', { threadId: requestedThreadId, includeTurns: false }, resumeTimeoutMs)
      if (checked.thread.cwd !== cwd) throw new Error('requested thread belongs to another workspace')
    } catch (error) {
      // A cold App Server may only read loaded threads. Resume only this exact
      // unloaded ID; missing IDs and all other errors remain failures.
      const rpc = error.rpcError
      if (rpc?.code !== -32600 || rpc.message !== `thread not loaded: ${requestedThreadId}`) throw error
    }
    try {
      const resumed = await request('thread/resume', { threadId: requestedThreadId, ...(model ? { model } : {}) }, resumeTimeoutMs)
      thread = resumed.thread
    } catch (error) {
      // An empty TUI thread has no rollout until its first turn. Only an
      // explicitly recorded empty binding may be recreated, and only on the
      // server's precise missing-rollout response; never on a network error.
      if (session?.unpersisted && error.rpcError?.code === -32600 && /^no rollout found for thread id /.test(error.rpcError.message)) fresh = true
      else throw error
    }
  }
  if (!thread && mode === 'wait') {
    const deadline = Date.now() + 15_000
    while (!thread && Date.now() < deadline) {
      // A sibling mate can share cwd, but cannot share this server's loaded set.
      thread = notifiedThread
      if (!thread) {
        const loaded = await request('thread/loaded/list', {})
        if (loaded.data?.length === 1) {
          const result = await request('thread/read', { threadId: loaded.data[0], includeTurns: false })
          if (result.thread?.cwd === cwd) thread = result.thread
        }
      }
      if (!thread) await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!thread) throw new Error(`timed out waiting for the TUI to create a thread in ${cwd}`)
  } else if (!thread && !fresh) {
    const latest = await listLatest()
    if (!latest) {
      fresh = true
    } else {
      const resumed = await request('thread/resume', { threadId: latest.id, ...(model ? { model } : {}) }, resumeTimeoutMs)
      thread = resumed.thread
    }
  }
  if (thread && thread.cwd !== cwd) throw new Error('resumed thread belongs to another workspace')
  if (fresh) process.stdout.write(`${JSON.stringify({ id: '', path: null, cwd, fresh: true })}\n`)
  else process.stdout.write(`${JSON.stringify({ id: thread.id, path: thread.path ?? null, cwd: thread.cwd, fresh: false })}\n`)
} finally {
  websocket.close()
}
