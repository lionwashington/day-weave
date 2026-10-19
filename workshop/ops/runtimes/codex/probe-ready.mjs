#!/usr/bin/env node
// A bounded, read-only protocol handshake. No thread, turn, or model request.
const [endpoint, expectedVersion = '', budget = '1000'] = process.argv.slice(2)
let url
try { url = new URL(endpoint) } catch {}
const timeoutMs = Number(budget)
if (!url || url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port ||
    url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (expectedVersion && !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(expectedVersion)) ||
    !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
  console.log(JSON.stringify({ ok: false, reason: 'invalid_probe_input' }))
  process.exit(2)
}
const result = await new Promise(resolve => {
  const ws = new WebSocket(url)
  let done = false
  const finish = result => {
    if (done) return
    done = true
    clearTimeout(timer)
    try { ws.close() } catch {}
    resolve(result)
  }
  const timer = setTimeout(() => finish({ ok: false, reason: 'protocol_timeout' }), timeoutMs)
  ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {
    clientInfo: { name: 'ka_startup_probe', version: '0.1.0' }, capabilities: null,
  } })))
  ws.addEventListener('error', () => finish({ ok: false, reason: 'transport_unavailable' }))
  ws.addEventListener('close', () => finish({ ok: false, reason: 'transport_closed' }))
  ws.addEventListener('message', event => {
    let message
    try { message = JSON.parse(String(event.data)) } catch {
      return finish({ ok: false, reason: 'invalid_protocol_response' })
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return finish({ ok: false, reason: 'invalid_protocol_response' })
    }
    if (message.id !== 1) return
    if (message.error) return finish({ ok: false, reason: 'initialize_rejected' })
    const userAgent = message.result?.userAgent
    const version = typeof userAgent === 'string'
      ? userAgent.match(/^[^/\s]+\/(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\s|$)/)?.[1] : undefined
    if (!version) return finish({ ok: false, reason: 'server_version_missing' })
    if (expectedVersion && version !== expectedVersion) return finish({ ok: false, reason: 'version_mismatch', version, expected_version: expectedVersion })
    ws.send(JSON.stringify({ method: 'initialized', params: {} }))
    finish({ ok: true, version })
  })
})
// Do not let an unresponsive peer extend the budget through a close handshake.
process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(result.ok ? 0 : 1))
