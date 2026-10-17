#!/usr/bin/env node

const [endpoint, cwd, explicitThreadId = '', mode = 'select'] = process.argv.slice(2)
// Runtime .thread files record the selected session; they are not resume pins.
const requestedThreadId = explicitThreadId
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
  if (requestedThreadId) {
    try {
      const checked = await request('thread/read', { threadId: requestedThreadId, includeTurns: false }, resumeTimeoutMs)
      if (checked.thread.cwd !== cwd) throw new Error('requested thread belongs to another workspace')
    } catch (error) {
      // A cold App Server may only read loaded threads. Resume only this exact
      // unloaded ID; missing IDs and all other errors remain failures.
      const rpc = error.rpcError
      if (rpc?.code !== -32600 || rpc.message !== `thread not loaded: ${requestedThreadId}`) throw error
    }
    const resumed = await request('thread/resume', { threadId: requestedThreadId, ...(model ? { model } : {}) }, resumeTimeoutMs)
    thread = resumed.thread
  }
  if (!thread && mode === 'wait') {
    const deadline = Date.now() + 15_000
    while (!thread && Date.now() < deadline) {
      thread = notifiedThread ?? await listLatest()
      if (!thread) await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!thread) throw new Error(`timed out waiting for the TUI to create a thread in ${cwd}`)
  } else if (!thread) {
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
