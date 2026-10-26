#!/usr/bin/env node
// Real Codex + tmux + Channel, isolated homes/socket/ports and a loopback model.
// No account credentials, production services, or paid model calls.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { CodexRuntimeManager } from '../../channels/core/src/codex/runtime-manager.ts'
import { createHttpApp } from '../../channels/core/src/http.ts'
import { runtimeTargetOf } from '../../channels/core/src/targets.ts'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'workshop-rotation-e2e-'))
const runtime = join(root, 'runtime'), home = join(root, 'home'), cwd = join(root, 'shared')
mkdirSync(home); mkdirSync(cwd)
const socket = `rotation-test-${process.pid}`
const wrapper = join(root, 'tmux')
writeFileSync(wrapper, `#!/bin/sh\nexec tmux -L '${socket}' "$@"\n`, { mode: 0o755 })
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(root, 'codex'), TERM: 'xterm-256color', LANG: 'C.UTF-8',
  KA_HOME: runtime, KA_STATE_DIR: join(runtime, 'state'), KA_CONFIG_DIR: join(runtime, 'config'),
  KA_CONFIG: join(runtime, 'config/config.yaml'), OPS_CONFIG: join(runtime, 'config/workshop.yaml'), TMUX_BIN: wrapper }
mkdirSync(env.CODEX_HOME)
let requests = 0
const model = createServer((req, res) => {
  req.resume()
  if (req.method !== 'POST') { res.end(JSON.stringify({ data: [] })); return }
  requests++
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  const id = `synthetic-${requests}`
  const item = { id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ISOLATED_OK' }] }
  for (const event of [
    { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  res.end()
})
await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
const platform = { name: 'telegram', resolveReplyTarget: v => v, isSelf: () => true, startInbound() {},
  send: async () => null, fetchAttachment: async () => '', instructions: () => '', replyToolDescription: '' }
const manager = new CodexRuntimeManager(platform, { platform: 'telegram', bindingsPath: join(root, 'channel/bindings.json'), externalChatId: 'synthetic' })
const channel = createHttpApp(platform, manager).listen(0, '127.0.0.1')
await new Promise(resolve => channel.once('listening', resolve))
const cli = join(runtime, 'workshop/ops/workshop.sh')
async function command(...args) {
  const child = spawn('bash', [cli, ...args, '--skip-daemon'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b)
  const code = await new Promise(resolve => child.once('exit', resolve))
  assert.equal(code, 0, output.slice(-5000)); return output
}
async function wait(check, ms = 30000) {
  const until = Date.now() + ms
  while (!await check()) { assert.ok(Date.now() < until, 'isolated condition timed out'); await new Promise(r => setTimeout(r, 100)) }
}
const state = name => manager.sessionSwitch(name, 'status')
const turn = name => runtimeTargetOf(name).deliver({ content: 'Synthetic isolated fixture. Say OK.', meta: { chat_id: 'synthetic', source: 'telegram' } })
try {
  assert.equal(spawnSync('bash', [join(repo, 'install.sh'), '--only', 'ka'], { env, encoding: 'utf8' }).status, 0)
  writeFileSync(env.KA_CONFIG, `channel_kind: telegram\nchannels:\n  telegram:\n    port: ${channel.address().port}\n`)
  writeFileSync(env.OPS_CONFIG, `session: fixture\nruntime: codex\nmates:\n  - name: alpha\n    cwd: ${cwd}\n  - name: beta\n    cwd: ${cwd}\n`)
  writeFileSync(join(env.CODEX_HOME, 'config.toml'), `model="probe"\nmodel_provider="probe"\n[tui]\nscreen_reader_detection_done=true\n[model_providers.probe]\nname="probe"\nbase_url="http://127.0.0.1:${model.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`)
  await command('start', 'alpha'); await wait(async () => (await state('alpha')).alive)
  await turn('alpha')
  const original = (await state('alpha')).threadId
  // Let the registrar promote the now-persisted first turn.
  await wait(async () => !(manager.targets.get('alpha').registration.allowUnpersistedThread))
  const before = requests
  await command('new-session', 'beta')
  const beta = (await state('beta')).threadId
  assert.notEqual(beta, original)
  assert.equal((await state('alpha')).threadId, original)
  assert.equal(requests, before, 'switch must not call model')
  console.log(JSON.stringify({ scenario: 'same-cwd-switch', passed: true, noModelCall: true, siblingUnchanged: true }))
  // Empty sessions have no rollout: restart must create only an empty replacement,
  // never resume alpha merely because it is the latest same-cwd persisted thread.
  await command('stop', 'beta'); await command('start', 'beta')
  await wait(async () => (await state('beta')).alive)
  assert.notEqual((await state('beta')).threadId, original)
  await turn('beta')
  await wait(async () => !(manager.targets.get('beta').registration.allowUnpersistedThread))
  const persisted = (await state('beta')).threadId
  await command('stop', 'beta'); await command('start', 'beta')
  await wait(async () => (await state('beta')).alive)
  assert.equal((await state('beta')).threadId, persisted)
  assert.equal((await state('alpha')).threadId, original)
  const binding = JSON.parse(readFileSync(join(env.KA_STATE_DIR, 'codex-app-servers/beta.session.json')))
  assert.equal(binding.threadId, persisted)
  console.log(JSON.stringify({ scenario: 'empty-and-persisted-restart', passed: true, sameCwdIsolated: true }))
} finally {
  for (const name of ['alpha', 'beta']) {
    // Async: the stop helper calls the HTTP server hosted in this process.
    await command('stop', name)
  }
  spawnSync(wrapper, ['kill-server'], { env })
  await manager.stop()
  channel.closeAllConnections(); await new Promise(resolve => channel.close(resolve))
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
