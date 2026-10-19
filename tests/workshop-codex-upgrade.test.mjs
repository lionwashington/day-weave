import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, chmodSync, symlinkSync, existsSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {compareVersions, parseUpdatePrompt, upgradeOnRestart} from '../workshop/ops/runtimes/codex/upgrade-on-restart.mjs'
const repo = fileURLToPath(new URL('..', import.meta.url))
const prompt = '✨ Update available! 1.2.3 → 1.2.4\n› 1. Update now (runs `synthetic updater`)\n  2. Skip\n  3. Skip until next version'

test('update detection requires an exact modal, versions, three choices and selected Update now', () => {
  assert.deepEqual(parseUpdatePrompt(prompt), {from: '1.2.3', to: '1.2.4', selected: true, selectedIndex: 1})
  assert.equal(parseUpdatePrompt(prompt.replace('→', '->')).to, '1.2.4')
  assert.equal(parseUpdatePrompt(prompt.replace('› 1.', '  1.').replace('  2.', '› 2.')).selected, false)
  assert.deepEqual(parseUpdatePrompt(prompt.split('\n').map(s => `│ ${s} │`).join('\n')), parseUpdatePrompt(prompt))
  for (const text of ['Update available! 1.2.3 → 1.2.4\nAsk Codex',
    'We discussed "' + prompt.replaceAll('\n', ' ') + '"\nAsk Codex',
    prompt.replace('1.2.4', '1.2.2'), prompt + '\nUpdate available! 1.2.3 → 1.2.5',
    prompt.replace('3. Skip until next version', '3. Some other action'),
    prompt.replace('`synthetic updater`', 'missing command'),
  ]) assert.equal(parseUpdatePrompt(text), null, text)
})
test('update versions use semantic ordering, including prereleases', () => {
  for (const [a, b, expected] of [['1.2.3', '1.2.3', 0], ['1.2.10', '1.2.9', 1], ['1.2.3-beta.2', '1.2.3-beta.11', -1],
    ['1.2.3', '1.2.3-beta.2', 1], ['1.2.3-alpha', '1.2.3-beta', -1], ['1.2.3-beta', '1.2.3-beta.1', -1],
    ['1.2.3-alpha-branch.2', '1.2.3-alpha-branch.11', -1], ['1.2.3-alpha-one', '1.2.3-alpha-two', -1]]) {
    assert.equal(compareVersions(a, b), expected)
  }
  assert.throws(() => compareVersions('invalid', '1.2.3'))
})

test('one-shot updater rechecks selection; already-installed and symlink CLI paths never reinstall', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-update-guard-'))
  try {
    const tmux = join(root, 'tmux'), codex = join(root, 'codex'), counter = join(root, 'counter'), keys = join(root, 'keys')
    const screen = join(root, 'screen'); writeFileSync(screen, prompt)
    writeFileSync(tmux, `#!${process.execPath}\nconst fs=require('fs'),a=process.argv.slice(2);if(a[0]==='display-message')console.log('0');else if(a[0]==='capture-pane'){let n=fs.existsSync(${JSON.stringify(counter)})?Number(fs.readFileSync(${JSON.stringify(counter)})):0;fs.writeFileSync(${JSON.stringify(counter)},String(n+1));const s=fs.readFileSync(${JSON.stringify(screen)},'utf8');console.log(n>0?s.replace('› 1.','  1.').replace('  2.','› 2.'):s)}else fs.writeFileSync(${JSON.stringify(keys)},'sent');\n`, {mode: 0o755})
    writeFileSync(codex, '#!/bin/sh\necho codex-cli 1.2.3\n', {mode: 0o755})
    await assert.rejects(upgradeOnRestart({pane: '%9', tmux, codex, timeoutSeconds: 8}), /upgrade_dialog_changed/)
    assert.equal(existsSync(keys), false)
    rmSync(counter); writeFileSync(codex, '#!/bin/sh\necho codex-cli 1.2.4\n', {mode: 0o755})
    const installed = await upgradeOnRestart({pane: '%9', tmux, codex, timeoutSeconds: 8})
    assert.deepEqual(installed, {ok: true, status: 'already_installed', version: '1.2.4'})
    assert.equal(existsSync(keys), false)
    rmSync(counter)
    const discovery = join(root, 'discovery.mjs')
    symlinkSync(join(repo, 'workshop/ops/runtimes/codex/upgrade-on-restart.mjs'), discovery)
    const cli = spawnSync(process.execPath, [discovery, '%9', '8'], {env: {PATH: root + ':' + process.env.PATH, TMUX_BIN: tmux}, encoding: 'utf8', timeout: 10000})
    assert.equal(cli.status, 0, cli.stderr); assert.deepEqual(JSON.parse(cli.stdout), installed)
    assert.equal(existsSync(keys), false)
    await assert.rejects(upgradeOnRestart({pane: '-a', tmux, codex}), /invalid_upgrade_arguments/)
  } finally {rmSync(root, {recursive: true, force: true})}
})

const tmux = spawnSync('which', ['tmux'], {encoding: 'utf8'}).stdout.trim()
function fixture(scenario, fresh = false) {
  const root = mkdtempSync(join(tmpdir(), 'ka-upgrade-e2e-')), runtime = join(root, 'runtime')
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'home')); mkdirSync(join(root, 'work'))
  const env = {PATH: join(root, 'bin') + ':' + process.env.PATH, HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex'),
    SHELL: '/bin/bash', TERM: 'xterm-256color', LANG: 'C.UTF-8', TMUX: '',
    KA_HOME: runtime, KA_STATE_DIR: join(runtime, 'state'), KA_CONFIG_DIR: join(runtime, 'config'),
    KA_CONFIG: join(runtime, 'config/config.yaml'), OPS_CONFIG: join(runtime, 'config/workshop.yaml'),
    KA_CHANNEL_KIND: 'telegram', KA_CHANNEL_PORT: '1', KA_WORKSHOP_START_TIMEOUT: '20',
    KA_CODEX_UPGRADE_TIMEOUT: scenario === 'timeout' ? '5' : '20',
    UPGRADE_FIXTURE_ROOT: root, UPGRADE_FIXTURE_SCENARIO: scenario,
    KA_CODEX_THREAD_SELECTOR: join(root, 'selector.mjs'),
  }
  const installed = spawnSync('bash', [join(repo, 'install.sh'), '--only', 'ka'], {env, encoding: 'utf8', timeout: 20000})
  assert.equal(installed.status, 0, installed.stderr)
  const config = `session: isolated\nruntime: codex\nmates:\n  - name: test-mate\n    main: true\n    cwd: ${join(root, 'work')}\n    args:\n      - --model\n      - synthetic-model\n      - -c\n      - model_reasoning_effort=medium\n`
  writeFileSync(env.OPS_CONFIG, config)
  writeFileSync(env.KA_CONFIG, 'channel_kind: telegram\nchannels:\n  telegram:\n    port: 1\n')
  for (const release of ['release-old.mjs', 'release-new.mjs']) {
    copyFileSync(join(repo, 'tests/fixtures/codex-upgrade.mjs'), join(root, release)); chmodSync(join(root, release), 0o755)
  }
  symlinkSync(join(root, 'release-old.mjs'), join(root, 'bin/codex'))
  writeFileSync(join(root, 'broken-release'), '#!/bin/sh\nexit 77\n', {mode: 0o755})
  writeFileSync(env.KA_CODEX_THREAD_SELECTOR, `console.log(JSON.stringify({fresh:${fresh}&&process.argv[5]!=='wait',id:'synthetic-thread',path:'synthetic-rollout'}))\n`)
  const socket = `ka-upgrade-${process.pid}-${Date.now()}`
  const realTmux = (...args) => spawnSync(tmux, ['-L', socket, ...args], {env, encoding: 'utf8', timeout: 5000})
  env.TMUX_BIN = join(root, 'tmux')
  writeFileSync(env.TMUX_BIN, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${join(root, 'tmux-journal')}'\nexec '${tmux}' -L '${socket}' "$@"\n`, {mode: 0o755})
  assert.equal(realTmux('new-session', '-d', '-s', 'isolated', '-x', '130', '-y', '45', 'exec sleep 300').status, 0)
  const sibling = realTmux('display-message', '-p', '-t', 'isolated:0', '#{pane_id}').stdout.trim()
  realTmux('set-option', '-p', '-t', sibling, '@ka_channel', 'sibling')
  const invoke = (verb = 'restart', extraEnv = {}, target = 'test-mate') => spawnSync('bash', [join(runtime, 'shared/bin/ka'), 'workshop', verb, ...(target ? [target] : []), '--skip-daemon'],
    {env: {...env, ...extraEnv}, encoding: 'utf8', timeout: target ? 60000 : 150000})
  const journal = () => existsSync(join(root, 'journal.jsonl')) ? readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : []
  return {root, env, runtime, config, realTmux, sibling, invoke, journal,
    close() {
      spawnSync('python3', [join(runtime, 'workshop/ops/runtimes/codex/stop-runtime.py'), runtime, 'main', 'test-mate', '1'], {env, timeout: 10000, stdio: 'ignore'})
      realTmux('kill-server'); rmSync(root, {recursive: true, force: true})
    }}
}

for (const [scenario, fresh] of [['success', false], ['success-exit', true], ['skip-selected', false], ['last-selected', false]]) {
  test(`real tmux + installed runtime: ${scenario}; verified full restart, same pane/cwd/model/thread, sibling untouched`, {skip: !tmux}, () => {
    const f = fixture(scenario, fresh)
    try {
      const r = f.invoke(); assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stdout + r.stderr)
      const journal = f.journal(), servers = journal.filter(j => j.kind === 'server'), tuis = journal.filter(j => j.kind === 'tui')
      assert.ok(journal.every(j => !j.upgradePermissionLeaked))
      assert.deepEqual(servers.map(j => j.version), ['1.2.3', '1.2.4'])
      assert.deepEqual(tuis.map(j => j.version), ['1.2.3', '1.2.4'])
      const keys = journal.filter(j => j.kind === 'keys')
      // PTY reads can split/coalesce input. Assert the complete key stream,
      // not the number of Node data events carrying one/two Up keys.
      const upCount = scenario === 'last-selected' ? 2 : scenario === 'skip-selected' ? 1 : 0
      assert.match(keys.map(k => k.keys).join(''), new RegExp(`^(?:\\x1b\\[A){${upCount}}[\\r\\n]+$`))
      assert.equal(tuis[1].cwd, join(f.root, 'work'))
      assert.ok(tuis[1].args.includes('synthetic-model')); assert.ok(tuis[1].args.includes('model_reasoning_effort=medium'))
      assert.equal(tuis[1].args.includes('resume'), !fresh)
      assert.equal(readFileSync(join(f.runtime, 'state/codex-app-servers/main.thread'), 'utf8').trim(), 'synthetic-thread')
      for (const old of [servers[0], tuis[0]]) assert.throws(() => process.kill(old.pid, 0), {code: 'ESRCH'})
      assert.equal(f.realTmux('display-message', '-p', '-t', f.sibling, '#{pane_dead}').stdout.trim(), '0')
      assert.equal(readFileSync(f.env.OPS_CONFIG, 'utf8'), f.config)
      const calls = readFileSync(join(f.root, 'tmux-journal'), 'utf8')
      assert.equal(calls.split('\n').filter(s => s.startsWith('respawn-pane')).length, 1)
      assert.match(r.stdout + r.stderr, /start: launched/)
    } finally {f.close()}
  })
}

for (const [scenario, reason, restarted] of [
  ['update-error', 'codex_update_failed', false], ['timeout', 'codex_update_timeout_installer_left_untouched', false],
  ['no-version-change', 'upgrade_version_not_advanced', false], ['broken-install', 'installed_codex_version_failed', false],
  ['selection-refuses', 'upgrade_selection_failed', false], ['repeated-prompt', 'did not become ready', true],
  ['stale-success', 'ambiguous_upgrade_completion', false],
]) test(`real tmux upgrade fails safely: ${scenario}`, {skip: !tmux}, () => {
  const f = fixture(scenario)
  try {
    const r = f.invoke(); assert.equal(r.error, undefined); assert.notEqual(r.status, 0, r.stdout + r.stderr)
    assert.match(r.stdout + r.stderr, new RegExp(reason)); assert.doesNotMatch(r.stdout, /start: launched/)
    assert.doesNotMatch(r.stdout + r.stderr, /synthetic-private/)
    const journal = f.journal()
    assert.equal(journal.filter(j => j.kind === 'server').length, restarted ? 2 : 1)
    assert.equal(journal.filter(j => j.kind === 'keys').length, scenario === 'stale-success' ? 0 : 1)
    if (scenario === 'selection-refuses') assert.equal(journal.some(j => j.kind === 'keys' && /[\r\n]/.test(j.keys)), false)
    if (!restarted) for (const old of journal.filter(j => ['server', 'tui'].includes(j.kind))) assert.doesNotThrow(() => process.kill(old.pid, 0))
    assert.equal(f.realTmux('display-message', '-p', '-t', f.sibling, '#{pane_dead}').stdout.trim(), '0')
    assert.equal(readFileSync(f.env.OPS_CONFIG, 'utf8'), f.config)
  } finally {f.close()}
})

test('ordinary start never selects an update, and an existing pane is not upgraded even with restart context', {skip: !tmux}, () => {
  const f = fixture('success')
  try {
    const r = f.invoke('start'); assert.notEqual(r.status, 0)
    const again = f.invoke('start', {KA_CODEX_UPGRADE_ON_RESTART: '1'}); assert.notEqual(again.status, 0)
    assert.equal(f.journal().filter(j => j.kind === 'keys').length, 0)
    assert.equal(f.journal().filter(j => j.kind === 'server').length, 1)
  } finally {f.close()}
})

test('whole-workshop restart upgrades once and reloads both old pinned mates without reinstalling', {skip: !tmux}, () => {
  const f = fixture('success')
  try {
    const secondCwd = join(f.root, 'second-work'); mkdirSync(secondCwd)
    const config = f.config + `  - name: second-mate\n    cwd: ${secondCwd}\n`
    writeFileSync(f.env.OPS_CONFIG, config)
    const r = f.invoke('restart', {}, ''); assert.equal(r.error, undefined); assert.equal(r.status, 0, r.stdout + r.stderr)
    const journal = f.journal(), servers = journal.filter(j => j.kind === 'server')
    assert.ok(journal.every(j => !j.upgradePermissionLeaked))
    assert.equal(journal.filter(j => j.kind === 'keys').length, 1)
    for (const cwd of [join(f.root, 'work'), secondCwd]) {
      assert.deepEqual(servers.filter(j => j.cwd === cwd).map(j => j.version), ['1.2.3', '1.2.4'])
    }
    assert.equal(readFileSync(f.env.OPS_CONFIG, 'utf8'), config)
    const calls = readFileSync(join(f.root, 'tmux-journal'), 'utf8')
    assert.equal(calls.split('\n').filter(s => s.startsWith('respawn-pane')).length, 2)
  } finally {
    spawnSync('python3', [join(f.runtime, 'workshop/ops/runtimes/codex/stop-runtime.py'), f.runtime, 'second-mate', 'second-mate', '1'], {env: f.env, timeout: 10000, stdio: 'ignore'})
    f.close()
  }
})
