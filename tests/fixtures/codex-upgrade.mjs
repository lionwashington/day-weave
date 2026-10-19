#!/usr/bin/env node
// Synthetic executable for real-tmux upgrade E2E. No model/API/network access
// except a loopback App Server with initialize-only WebSocket responses.
import {appendFileSync, renameSync, symlinkSync} from 'node:fs'
import {createInterface} from 'node:readline'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
const root = process.env.UPGRADE_FIXTURE_ROOT
const version = fileURLToPath(import.meta.url).includes('release-new') ? '1.2.4' : '1.2.3'
const scenario = process.env.UPGRADE_FIXTURE_SCENARIO
const args = process.argv.slice(2)
const record = (kind, more = {}) => appendFileSync(join(root, 'journal.jsonl'), JSON.stringify({kind, version, pid: process.pid, cwd: process.cwd(), args,
  upgradePermissionLeaked: process.env.KA_CODEX_UPGRADE_ON_RESTART !== undefined, ...more}) + '\n')
if (args.includes('--version')) {console.log('codex-cli ' + version); process.exit(0)}
if (args.includes('app-server') && args.includes('--stdio')) {
  createInterface({input: process.stdin}).on('line', line => {
    const m = JSON.parse(line)
    if (!m.id) return
    const result = m.method === 'hooks/list' ? {data: [{cwd: process.cwd(), hooks: [], errors: []}]} : {userAgent: 'synthetic/' + version}
    console.log(JSON.stringify({id: m.id, result}))
  })
} else if (args.includes('app-server')) {
  record('server')
  const endpoint = new URL(args[args.indexOf('--listen') + 1])
  const http = createServer()
  http.on('upgrade', (req, socket) => {
    socket.on('error', () => {})
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    let pending = Buffer.alloc(0)
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 2) {
        let length = pending[1] & 127, offset = 2
        if (length === 126) {if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4}
        if (length === 127) {socket.destroy(); return}
        const masked = pending[1] & 128, opcode = pending[0] & 15
        if (pending.length < offset + (masked ? 4 : 0) + length) return
        const mask = masked ? pending.subarray(offset, offset + 4) : null; offset += masked ? 4 : 0
        const body = Buffer.from(pending.subarray(offset, offset + length)); pending = pending.subarray(offset + length)
        if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
        if (opcode === 8) {socket.end(Buffer.from([0x88, 0])); return}
        if (opcode !== 1) continue
        const m = JSON.parse(body)
        if (m.method !== 'initialize') continue
        const payload = Buffer.from(JSON.stringify({id: m.id, result: {userAgent: 'synthetic/' + version}}))
        socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
      }
    })
  })
  http.listen(Number(endpoint.port), '127.0.0.1')
} else {
  record('tui')
  const dialog = version === '1.2.3' || scenario === 'repeated-prompt'
  let selected = scenario === 'last-selected' ? 3 : ['skip-selected', 'selection-refuses'].includes(scenario) ? 2 : 1
  const render = () => {
    // Real TUIs render explicit CRLF after switching the PTY to raw mode;
    // console.log's bare LF cannot be assumed to reset the cursor column.
    process.stdout.write('\x1b[2J\x1b[H' + [
      `✨ Update available! ${version} → ${version === '1.2.3' ? '1.2.4' : '1.2.5'}`,
      `${selected === 1 ? '› ' : '  '}1. Update now (runs \`synthetic built-in updater\`)`,
      `${selected === 2 ? '› ' : '  '}2. Skip`,
      `${selected === 3 ? '› ' : '  '}3. Skip until next version`,
    ].join('\r\n') + '\r\n')
  }
  if (dialog) render()
  if (scenario === 'stale-success') console.log('🎉 Update ran successfully! Please restart Codex.')
  if (!dialog) console.log('Ask Codex\n? for shortcuts')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', data => {
    record('keys', {keys: String(data)})
    if (!dialog) return
    if (String(data).includes('\x1b[A')) {
      if (scenario !== 'selection-refuses') selected = Math.max(1, selected - String(data).split('\x1b[A').length + 1)
      render(); return
    }
    if (!/[\r\n]/.test(String(data)) || selected !== 1) return
    if (scenario === 'update-error') {console.log('Error: synthetic-private failure'); return}
    if (scenario === 'timeout') {console.log('Updating Codex via built-in installer...'); return}
    if (scenario !== 'no-version-change') {
      symlinkSync(join(root, scenario === 'broken-install' ? 'broken-release' : 'release-new.mjs'), join(root, 'bin/codex.tmp'))
      renameSync(join(root, 'bin/codex.tmp'), join(root, 'bin/codex'))
    }
    console.log('🎉 Update ran successfully! Please restart Codex.')
    if (scenario === 'success-exit') process.exit(0)
  })
}
