import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))

function fixture(scenario, runtime = 'codex') {
  const root = mkdtempSync(join(tmpdir(), 'ka-start-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const env = {
    ...process.env, KA_HOME: home, KA_STATE_DIR: join(home, 'state'), KA_CONFIG_DIR: join(home, 'config'),
    OPS_CONFIG: join(home, 'config/workshop.yaml'), KA_CONFIG: join(home, 'config/config.yaml'),
    TMUX: '', NO_COLOR: '1', KA_WORKSHOP_START_TIMEOUT: '3', TEST_ROOT: root, TEST_SCENARIO: scenario,
    TMUX_BIN: join(bin, 'tmux'),
  }
  const installed = spawnSync('/bin/bash', [join(repo, 'install.sh'), '--only', 'ka'], { env, encoding: 'utf8', timeout: 15000 })
  assert.equal(installed.status, 0, installed.stdout + installed.stderr)
  writeFileSync(env.OPS_CONFIG, `session: isolated\nruntime: ${runtime}\nmates:\n  - name: test-mate\n    cwd: ${root}\n`)
  writeFileSync(env.KA_CONFIG, 'channel_kind: telegram\nchannels:\n  telegram:\n    port: 1\n')
  writeFileSync(env.TMUX_BIN, `#!/usr/bin/env python3
import os,sys,json
from pathlib import Path
root=Path(os.environ['TEST_ROOT'])
scenario=os.environ['TEST_SCENARIO']
args=sys.argv[1:]
with (root/'journal').open('a') as f: f.write(json.dumps(args)+'\\n')
cmd=args[0]
created=root/'created'
if cmd=='has-session': sys.exit(0 if created.exists() else 1)
if cmd in ['new-session','split-window','new-window']:
 if scenario=='creation-error' or (scenario=='split-error' and cmd!='new-session'): sys.exit(1)
 created.touch()
 if cmd!='new-session': print('%1')
elif cmd=='list-windows': print('0')
elif cmd=='list-panes':
 if scenario=='no-pane': sys.exit(0)
 fmt=args[-1]
 if fmt=='#{pane_id}': print('%1')
 elif fmt=='#{@ka_channel}': print('sibling' if scenario in ['split-error','sibling-window'] else 'test-mate')
 elif fmt=='#{pane_id} #{@ka_channel}': print('%1 test-mate')
elif cmd=='display-message':
 if scenario=='vanished': sys.exit(1)
 fmt=args[-1]
 if fmt=='#{pane_id}': print('%1')
 elif fmt=='#{pane_dead}':
  p=root/'polls'; count=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(count))
  print('1' if scenario in ['dead','existing-dead'] or (scenario=='ready-then-exit' and count>1) else '0')
elif cmd=='show-options':
 if args[-1]=='@ka_codex_tui_state':
  if scenario=='fallback-shell': print('exited')
  elif scenario=='starting-with-prompt': print('starting')
elif cmd=='capture-pane':
 p=root/'captures';count=int(p.read_text())+1 if p.exists() else 1;p.write_text(str(count))
 ready=scenario not in ['timeout','existing-timeout'] and (scenario!='delayed' or count>1)
 if scenario=='update-dialog': print('? for shortcuts\\n  Update available · synthetic-old → synthetic-new\\nenter continue · esc skip')
 elif scenario=='legacy-fallback-shell': print('? for shortcuts\\n[start-pane:test-mate] Codex TUI exited with status 1')
 else: print('? for shortcuts' if ready else 'Starting Codex...')
`, { mode: 0o755 })
  if (scenario.startsWith('existing-') || ['split-error', 'sibling-window'].includes(scenario)) writeFileSync(join(root, 'created'), '')
  const invoke = (...args) => {
    const r = spawnSync('/bin/bash', [join(home, 'shared/bin/ka'), 'workshop', ...args], { env, encoding: 'utf8', timeout: 15000 })
    assert.equal(r.error, undefined, String(r.error))
    return { ...r, output: r.stdout + r.stderr }
  }
  const journal = () => readFileSync(join(root, 'journal'), 'utf8').trim().split('\n').map(JSON.parse)
  return { root, home, env, invoke, journal, close: () => rmSync(root, { recursive: true, force: true }) }
}

for (const scenario of ['ready', 'delayed', 'existing-ready']) {
  for (const layout of ['--pane', '--window']) {
    test(`workshop start confirms ${scenario} Codex runtime (${layout}) without KB or Channel`, () => {
      const f = fixture(scenario)
      try {
        const r = f.invoke('start', 'test-mate', layout, '--skip-daemon')
        assert.equal(r.status, 0, r.output)
        assert.match(r.output, /ready \(/)
        assert.match(r.output, scenario === 'existing-ready' ? /already running in session/ : /start: launched/)
        assert.ok(f.journal().some(a => a[0] === 'capture-pane'))
        if (scenario === 'existing-ready') assert.equal(f.journal().some(a => ['new-session', 'split-window', 'new-window'].includes(a[0])), false)
        if (scenario === 'delayed') assert.ok(Number(readFileSync(join(f.root, 'captures'), 'utf8')) > 1)
      } finally { f.close() }
    })
  }
}

for (const scenario of ['dead', 'vanished', 'no-pane', 'creation-error', 'split-error', 'timeout', 'ready-then-exit', 'existing-dead', 'existing-timeout', 'fallback-shell', 'legacy-fallback-shell', 'update-dialog', 'starting-with-prompt']) {
  test(`workshop start rejects ${scenario}; no successful launch is reported`, () => {
    const f = fixture(scenario)
    try {
      const r = f.invoke('start', 'test-mate', '--skip-daemon')
      assert.notEqual(r.status, 0, r.output)
      assert.doesNotMatch(r.output, /start: launched|already running in session/)
      if (scenario.includes('timeout')) assert.match(r.output, /timeout.*never reached ready state/)
      if (scenario === 'dead' || scenario === 'existing-dead' || scenario === 'ready-then-exit') assert.match(r.output, /exited before runtime readiness/)
      if (scenario === 'no-pane') assert.match(r.output, /failed to create runtime pane/)
    } finally { f.close() }
  })
}

test('dry-run never creates panes or polls runtime readiness', () => {
  const f = fixture('timeout')
  try {
    const r = f.invoke('start', 'test-mate', '--dry-run')
    assert.equal(r.status, 0, r.output)
    assert.match(r.output, /dry-run summary/)
    assert.equal(f.journal().some(a => ['new-session', 'capture-pane', 'display-message'].includes(a[0])), false)
    assert.doesNotMatch(r.output, /start: launched/)
  } finally { f.close() }
})

test('window layout does not mistake a sibling window index for the requested runtime', () => {
  const f = fixture('sibling-window')
  try {
    const r = f.invoke('start', 'test-mate', '--window', '--skip-daemon')
    assert.equal(r.status, 0, r.output)
    assert.match(r.output, /start: launched/)
    assert.ok(f.journal().some(a => a[0] === 'new-window'))
    assert.ok(f.journal().some(a => a[0] === 'list-panes' && a.includes('-s')))
  } finally { f.close() }
})

test('a stopped Channel is a warning, not a Codex startup dependency', () => {
  const f = fixture('ready')
  try {
    const r = f.invoke('start', 'test-mate')
    assert.equal(r.status, 0, r.output)
    assert.match(r.output, /daemon not running/)
    assert.match(r.output, /start: launched/)
  } finally { f.close() }
})

test('readiness timeout rejects invalid values before polling', () => {
  const f = fixture('ready')
  try {
    for (const value of ['invalid', '1:2']) {
      f.env.KA_WORKSHOP_START_TIMEOUT = value
      const r = f.invoke('start', 'test-mate', '--skip-daemon')
      assert.notEqual(r.status, 0, r.output)
      assert.match(r.output, /timeout and stable must be non-negative integers/)
      assert.doesNotMatch(r.output, /start: launched/)
    }
    const r = spawnSync('/bin/bash', [join(f.home, 'workshop/ops/wait-ready.sh'), '--stable', '1:2'], { env: f.env, encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /timeout and stable must be non-negative integers/)
  } finally { f.close() }
})

test('runtime dispatch clears the Codex post-launch hook when changing adapters', () => {
  const f = fixture('ready')
  try {
    const r = spawnSync('/bin/bash', ['-c', 'source "$KA_HOME/shared/ops/common.sh"; source "$KA_RUNTIMES_DIR/dispatch.sh"; runtime_load codex; declare -f runtime::post_launch; runtime_load cc; declare -f runtime::post_launch'], { env: f.env, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal((r.stdout.match(/wait-ready.sh/g) || []).length, 1)
    assert.match(r.stdout, /dev-channels gate/)
  } finally { f.close() }
})

const tmux = spawnSync('which', ['tmux'], { encoding: 'utf8' }).stdout.trim()
test('real tmux rejects dead ready-looking screens and confirms a live Codex screen', { skip: !tmux }, () => {
  const f = fixture('ready')
  const socket = `ka-start-test-${process.pid}-${Date.now()}`
  const realTmux = (...args) => spawnSync(tmux, ['-L', socket, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 5000 })
  try {
    const wrapper = join(f.root, 'real-tmux')
    writeFileSync(wrapper, `#!/bin/sh\nexec '${tmux}' -L '${socket}' "$@"\n`, { mode: 0o755 })
    f.env.TMUX_BIN = wrapper
    assert.equal(realTmux('new-session', '-d', '-s', 'isolated', 'sleep 60').status, 0)
    assert.equal(realTmux('set-option', '-g', 'remain-on-exit', 'on').status, 0)
    for (const dead of [false, true]) {
      const pane = realTmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'isolated', `printf '? for shortcuts\\n'; ${dead ? 'exit 1' : 'sleep 60'}`).stdout.trim()
      assert.match(pane, /^%\d+$/)
      // Give the child time to render and, in the failure case, exit.
      spawnSync('sleep', ['0.2'])
      const r = spawnSync('/bin/bash', [join(f.home, 'workshop/ops/wait-ready.sh'), '--target', pane, '--timeout', '4', '--stable', '1'], { env: f.env, encoding: 'utf8', timeout: 8000 })
      assert.equal(r.status, dead ? 3 : 0, r.stdout + r.stderr)
      assert.match(r.stderr, dead ? /exited before runtime readiness/ : /ready \(/)
    }
    const fallback = realTmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'isolated', "printf '? for shortcuts\\n'; sleep 60").stdout.trim()
    assert.equal(realTmux('set-option', '-p', '-t', fallback, '@ka_codex_tui_state', 'exited').status, 0)
    const r = spawnSync('/bin/bash', [join(f.home, 'workshop/ops/wait-ready.sh'), '--target', fallback, '--timeout', '4'], { env: f.env, encoding: 'utf8', timeout: 8000 })
    assert.equal(r.status, 3, r.stdout + r.stderr)
    assert.match(r.stderr, /Codex TUI.*exited before runtime readiness/)
  } finally { realTmux('kill-server'); f.close() }
})
