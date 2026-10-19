#!/usr/bin/env node
// Opt-in full-launcher regression with an isolated Codex home, tmux socket and
// loopback mock model. No real credentials, business threads or production Channel.
// Tests registrar stdio, remote resume, hook states and real keyboard handling.
// Requires Linux, Codex >=0.163.0, Node >=22, Python, tmux and stty.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverHookTrustOverride } from '../../workshop/ops/runtimes/codex/hook-trust-overrides.mjs'
import { parseUpdatePrompt, parseUpdateNotice } from '../../workshop/ops/runtimes/codex/upgrade-on-restart.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))

for (const command of ['codex', 'tmux', 'stty']) {
  if (spawnSync(command, ['--version'], { stdio: 'ignore' }).error) throw new Error(`required test executable missing: ${command}`)
}
const root = mkdtempSync(join(tmpdir(), 'ka-codex-remote-startup-'))
const isolatedHome = join(root, 'home')
mkdirSync(isolatedHome)
const env = { PATH: process.env.PATH, HOME: isolatedHome, CODEX_HOME: root,
  XDG_CONFIG_HOME: join(isolatedHome, '.config'), TERM: 'xterm-256color', LANG: 'C.UTF-8' }
const runtime = join(root, 'runtime')
Object.assign(env, { KA_HOME: runtime, KA_STATE_DIR: join(runtime, 'state'),
  KA_CONFIG_DIR: join(runtime, 'config'), KA_CONFIG: join(runtime, 'config/config.yaml'),
  OPS_CONFIG: join(runtime, 'config/workshop.yaml') })
assert.equal(spawnSync('bash', [join(repo, 'install.sh'), '--only', 'ka'], { env, encoding: 'utf8' }).status, 0)
writeFileSync(env.KA_CONFIG, 'channel_kind: telegram\nchannels:\n  telegram:\n    port: 1\n')
const delay = ms => new Promise(done => setTimeout(done, ms))
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`
let modelRequests = 0
const modelServer = createHttpServer((request, response) => {
  request.resume()
  if (request.method !== 'POST' || !new URL(request.url, 'http://127.0.0.1').pathname.endsWith('/responses')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [] }))
    return
  }
  modelRequests += 1
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const responseId = `fixture_response_${modelRequests}`
  const item = { id: `fixture_message_${modelRequests}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `ISOLATED_PROBE_OK_${modelRequests}` }] }
  for (const event of [
    { type: 'response.created', response: { id: responseId, status: 'in_progress', output: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: responseId, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.end()
})
await new Promise(done => modelServer.listen(0, '127.0.0.1', done))
const config = `model="probe"\nmodel_provider="probe"\n[features]\nhooks=true\n[tui]\nscreen_reader_detection_done=true\n[model_providers.probe]\nname="probe"\nbase_url="http://127.0.0.1:${modelServer.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\n`
writeFileSync(join(root, 'config.toml'), config)

async function runScenario(name, hookState = 'absent', fresh = false) {
  const cwd = fresh ? join(root, 'fresh-work') : join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  writeFileSync(join(root, 'config.toml'), config)
  writeFileSync(env.OPS_CONFIG, `session: fixture\nruntime: codex\nmates:\n  - name: isolated-tty\n    cwd: ${cwd}\n`)
  // Hook evidence is synthetic and confined to this temporary Codex home.
  const hookFile = join(root, 'hooks.json')
  const marker = join(root, `hook-${name}.txt`)
  const writeHook = value => writeFileSync(hookFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command',
    command: `${shellQuote(process.execPath)} -e ${shellQuote(`require('fs').appendFileSync(${JSON.stringify(marker)},${JSON.stringify(value + '\n')})`)}` }] }] } }))
  if (hookState === 'absent') rmSync(hookFile, { force: true })
  else writeHook('initial')
  const args = []
  const listener = createTcpServer()
  await new Promise(done => listener.listen(0, '127.0.0.1', done))
  const endpoint = `ws://127.0.0.1:${listener.address().port}`
  await new Promise(done => listener.close(done))
  const sidecar = spawn('codex', [...args, '--dangerously-bypass-hook-trust', 'app-server', '--listen', endpoint], {
    cwd, env, stdio: ['ignore', 'ignore', 'pipe'],
  })
  sidecar.stderr.resume()
  const socket = `ka-isolated-startup-${process.pid}-${name}`
  const tmux = (...argv) => spawnSync('tmux', ['-L', socket, ...argv], { env, encoding: 'utf8', timeout: 5000 })
  const capture = () => tmux('capture-pane', '-p', '-t', 'fixture:0').stdout || ''
  let ws
  const pending = new Map()
  let nextId = 0
  let completed = false
  let failure
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ws = new WebSocket(endpoint)
        await new Promise((done, reject) => { ws.onopen = done; ws.onerror = reject })
        break
      } catch { await delay(100) }
    }
    assert.equal(ws?.readyState, WebSocket.OPEN, 'isolated sidecar did not listen')
    ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.method === 'turn/completed') completed = true
      const call = pending.get(message.id)
      if (!call) return
      pending.delete(message.id)
      clearTimeout(call.timer)
      message.error ? call.reject(new Error('isolated RPC request failed')) : call.done(message.result)
    }
    const rpc = (method, params) => new Promise((done, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`isolated RPC timed out: ${method}`)) }, 10_000)
      pending.set(id, { done, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
    await rpc('initialize', { clientInfo: { name: 'ka_isolated_tui_regression', version: '1' }, capabilities: { experimentalApi: true } })
    ws.send(JSON.stringify({ method: 'initialized', params: {} }))
    if (hookState !== 'absent') {
      const hooks = await rpc('hooks/list', { cwds: [cwd] })
      const hook = hooks.data?.[0]?.hooks?.[0]
      assert.equal(hooks.data?.[0]?.hooks?.length, 1)
      assert.equal(hook.trustStatus, 'untrusted')
      if (['trusted', 'modified'].includes(hookState)) {
        writeFileSync(join(root, 'config.toml'), config + `\n[hooks.state]\n${JSON.stringify(hook.key)}={trusted_hash=${JSON.stringify(hook.currentHash)}}\n`)
        if (hookState === 'modified') writeHook('modified')
      }
      const overlay = await discoverHookTrustOverride(cwd, [], {
        spawnProcess(command, args, options) { return spawn(command, args, { ...options, env }) },
      })
      assert.equal(Boolean(overlay), hookState !== 'trusted', 'fixture hook trust state was not established')
    }
    let thread
    if (!fresh) {
      thread = await rpc('thread/start', { cwd, model: 'probe', modelProvider: 'probe' })
      await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'Isolated regression fixture. Reply OK.', text_elements: [] }] })
      for (let attempt = 0; attempt < 100 && !completed; attempt++) await delay(100)
      assert.ok(completed, 'local mock model turn did not persist')
    }
    {
      ws.close()
      const stopped = new Promise(done => sidecar.once('exit', done))
      sidecar.kill('SIGTERM')
      await stopped
    }
    // Keep the isolated pane available on error, so a crashed TUI cannot be
    // mistaken for successful unattended startup merely because no menu remains.
    const originalConfig = readFileSync(join(root, 'config.toml'), 'utf8')
    const originalHook = existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : undefined
    const launcher = join(runtime, 'workshop/ops/runtimes/codex/bin/start-pane.sh')
    const actualLauncher = ['env', 'KA_CHANNEL=isolated-tty', 'KA_CHANNEL_KIND=telegram', 'KA_CHANNEL_PORT=1', 'KA_CODEX_KEEP_APP_SERVER_ON_TUI_EXIT=0', 'SHELL=/bin/bash', launcher, 'isolated-tty', cwd, ...(fresh ? [] : ['resume', thread.thread.id])]
    const trace = process.env.KA_TEST_STRACE ? [process.env.KA_TEST_STRACE, '-f', '-tt', '-yy', '-e', 'trace=ioctl,execve', '-o', `${process.env.KA_TEST_TRACE_PREFIX}-${name}.log`] : []
    const command = 'exec ' + [...trace, ...actualLauncher].map(shellQuote).join(' ')
    const created = tmux('new-session', '-d', '-s', 'fixture', '-x', '110', '-y', '35', '-c', cwd, command)
    assert.equal(created.status, 0, 'isolated tmux pane failed')
    tmux('set-option', '-g', 'remain-on-exit', 'on')
    // Startup draft briefly paints a composer before asynchronous hook review.
    // Do not treat that transient placeholder as completed TUI initialization.
    await delay(10000)
    let screen = ''
    for (let attempt = 0; attempt < 300; attempt++) {
      screen = capture()
      if (screen.includes('Hooks need review') || (screen.includes('Ask Codex to do anything') && (fresh || screen.includes('ISOLATED_PROBE_OK')))) break
      await delay(100)
    }
    const tty = tmux('display-message', '-p', '-t', 'fixture:0', '#{pane_tty}').stdout.trim()
    const terminalMode = spawnSync('stty', ['-F', tty, '-a'], { encoding: 'utf8' }).stdout || ''
    const raw = terminalMode.includes('-icanon') && terminalMode.includes('-echo ') && terminalMode.includes('-icrnl')
    const hookPrompt = screen.includes('Hooks need review')
    const ready = screen.includes('Ask Codex to do anything') && (fresh || screen.includes('ISOLATED_PROBE_OK'))
    assert.ok(raw, `isolated TUI did not retain raw keyboard mode: ${screen}`)
    assert.equal(hookPrompt, false)
    let arrowEditing = false
    let enterStatus = false
    const tmuxWrapper = join(root, `tmux-${name}`)
    writeFileSync(tmuxWrapper, `#!/bin/sh\nexec tmux -L '${socket}' "$@"\n`, { mode: 0o755 })
    const confirmed = spawnSync('bash', ['-c', 'source "$KA_HOME/shared/ops/common.sh"; source "$KA_RUNTIMES_DIR/codex/post-launch.sh"; runtime::post_launch fixture:0 isolated-tty'], {
      env: { ...env, TMUX_BIN: tmuxWrapper, KA_WORKSHOP_START_TIMEOUT: '15' }, encoding: 'utf8', timeout: 25000,
    })
    assert.equal(confirmed.status, 0, 'actual post-launch readiness failed: ' + confirmed.stderr)
    {
      assert.ok(ready, 'launcher did not reach a live composer')
      tmux('send-keys', '-t', 'fixture:0', '-l', 'KA_AB')
      tmux('send-keys', '-t', 'fixture:0', 'Left')
      tmux('send-keys', '-t', 'fixture:0', '-l', 'C')
      await delay(300)
      arrowEditing = capture().includes('KA_ACB')
      tmux('send-keys', '-t', 'fixture:0', 'End', 'C-u')
      tmux('send-keys', '-t', 'fixture:0', '-l', '/status')
      await delay(300)
      tmux('send-keys', '-t', 'fixture:0', 'Enter')
      await delay(700)
      enterStatus = /Session:/u.test(capture())
      assert.ok(arrowEditing, 'left arrow was not interpreted as an editing key')
      assert.ok(enterStatus, 'Enter did not execute local /status')
    }
    tmux('send-keys', '-t', 'fixture:0', 'Escape')
    const beforeRequests = modelRequests
    const beforeHook = existsSync(marker) ? readFileSync(marker, 'utf8').length : 0
    tmux('send-keys', '-t', 'fixture:0', '-l', 'Synthetic local model regression.')
    // Do not merge Enter into Codex's rapid-input/paste detection burst.
    await delay(500)
    tmux('send-keys', '-t', 'fixture:0', 'Enter')
    for (let i = 0; i < 150; i++) {
      const hookRan = hookState === 'absent' || (existsSync(marker) && readFileSync(marker, 'utf8').length > beforeHook)
      if (modelRequests > beforeRequests && capture().includes(`ISOLATED_PROBE_OK_${modelRequests}`) && hookRan) break
      await delay(100)
    }
    assert.ok(modelRequests > beforeRequests, 'TUI did not call the loopback model: ' + capture())
    assert.ok(capture().includes(`ISOLATED_PROBE_OK_${modelRequests}`), 'TUI did not display the new model reply')
    const hookExecuted = hookState === 'absent' || (existsSync(marker) && readFileSync(marker, 'utf8').length > beforeHook)
    assert.ok(hookExecuted, 'invocation-trusted Stop hook did not execute')
    if (hookState !== 'absent') assert.ok(readFileSync(marker, 'utf8').endsWith(hookState === 'modified' ? 'modified\n' : 'initial\n'))
    const configUnchanged = readFileSync(join(root, 'config.toml'), 'utf8') === originalConfig
    assert.ok(configUnchanged, 'test configuration changed unexpectedly')
    assert.equal(existsSync(hookFile) ? readFileSync(hookFile, 'utf8') : undefined, originalHook)
    const stopped = spawnSync('python3', [join(runtime, 'workshop/ops/runtimes/codex/stop-runtime.py'), runtime, 'isolated-tty', 'isolated-tty', '1'], { env, encoding: 'utf8', timeout: 15000 })
    assert.equal(stopped.status, 0, 'verified runtime stop failed: ' + stopped.stderr)
    console.log(JSON.stringify({ scenario: name, hookState, fresh, hookPrompt, ready, raw, arrowEditing,
      enterStatus, postLaunchConfirmed: true, localModelTurn: true, hookExecuted, configUnchanged, verifiedStop: true }))
  } catch (error) {
    failure = error
    throw error
  } finally {
    {
      const ownerFile = join(runtime, 'state/codex-app-servers/isolated-tty.instance.lock/pid')
      if (existsSync(ownerFile)) {
        // Stop the verified isolated group BEFORE removing its tmux owner.
        const cleanup = spawnSync('python3', [join(runtime, 'workshop/ops/runtimes/codex/stop-runtime.py'), runtime, 'isolated-tty', 'isolated-tty', '1'], { env, encoding: 'utf8', timeout: 15000 })
        if (!failure) assert.equal(cleanup.status, 0, 'fixture cleanup failed: ' + cleanup.stderr)
      }
    }
    tmux('kill-server')
    ws?.close()
    for (const call of pending.values()) clearTimeout(call.timer)
    sidecar.kill('SIGTERM')
    if (sidecar.exitCode === null && sidecar.signalCode === null) {
      await Promise.race([new Promise(done => sidecar.once('exit', done)), delay(7000)])
      assert.ok(sidecar.exitCode !== null || sidecar.signalCode !== null, 'isolated sidecar cleanup timed out')
    }
  }
}

async function verifyActualUpdateMenu() {
  // Prime only the temporary Codex version cache, not the installation. Never
  // press Enter here: the real updater must not run against the host binary.
  writeFileSync(join(root, 'version.json'), JSON.stringify({latest_version: '99.99.99',
    last_checked_at: new Date().toISOString(), dismissed_version: null}))
  rmSync(join(root, 'hooks.json'), {force: true})
  const cwd = join(root, 'update-menu-work'); mkdirSync(cwd)
  writeFileSync(join(root, 'config.toml'), config + `\n[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`)
  const socket = `ka-isolated-update-menu-${process.pid}`
  const tmux = (...args) => spawnSync('tmux', ['-L', socket, ...args], {env, encoding: 'utf8', timeout: 5000})
  const requestsBefore = modelRequests
  try {
    const command = 'exec ' + ['codex', '--no-alt-screen', '--dangerously-bypass-hook-trust',
      '--dangerously-bypass-approvals-and-sandbox'].map(shellQuote).join(' ')
    assert.equal(tmux('new-session', '-d', '-s', 'fixture', '-x', '130', '-y', '45', '-c', cwd, command).status, 0)
    let prompt, notice, screen = ''
    for (let attempt = 0; attempt < 100; attempt++) {
      screen = tmux('capture-pane', '-p', '-J', '-t', 'fixture:0').stdout || ''
      prompt = parseUpdatePrompt(screen)
      notice = parseUpdateNotice(screen)
      if (prompt || (notice && /Ask Codex|for shortcuts/.test(screen))) break
      await delay(200)
    }
    const diagnostic = {menu: screen.split('\n').filter(s => /Update available|Update now|Skip|Press enter/.test(s))
      .map(s => s.replace(/`[^`]*`/g, '`[installer]`').slice(0, 150)),
      composer: /Ask Codex|for shortcuts/.test(screen), login: /Sign in|Log in/i.test(screen),
      trustDialog: /trust.*directory|trust.*folder|Do you trust/i.test(screen)}
    assert.ok(notice, 'actual Codex update UI was not recognized: ' + JSON.stringify(diagnostic))
    assert.equal(notice.to, '99.99.99')
    if (prompt) assert.equal(prompt.selected, true)
    const matched = spawnSync('bash', ['-c', 'source "$1"; runtime::ready_match "$2"', 'test',
      join(runtime, 'workshop/ops/runtimes/codex/ready-signals.sh'), screen], {env, encoding: 'utf8'})
    assert.equal(matched.status, prompt ? 1 : 0, 'real update UI readiness classification is wrong')
    assert.equal(modelRequests, requestsBefore, 'observing the update menu must not start a model turn')
    console.log(JSON.stringify({scenario: 'actual-update-ui', kind: prompt ? 'confirmation' : 'notice-only', recognized: true,
      updateSelected: prompt?.selected, keysSent: 0, installerRun: false}))
  } finally {tmux('kill-server')}
}

try {
  if (!process.argv.includes('--update-menu-only')) {
    await runScenario('resume')
    await runScenario('second-launch')
    await runScenario('untrusted-hook', 'untrusted')
    await runScenario('trusted-hook', 'trusted')
    await runScenario('modified-hook', 'modified')
    await runScenario('fresh-thread', 'untrusted', true)
  }
  await verifyActualUpdateMenu()
  console.log(JSON.stringify({ passed: true, loopbackModelUsed: modelRequests >= 2 }))
} finally {
  modelServer.closeAllConnections()
  await new Promise(done => modelServer.close(done))
  rmSync(root, { recursive: true, force: true })
}
