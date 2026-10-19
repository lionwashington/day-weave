// One-shot, opt-in restart recovery. Never execute commands copied from the TUI.
import {spawnSync} from 'node:child_process'
import {realpathSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

const semver = '(\\d+\\.\\d+\\.\\d+(?:-[a-zA-Z0-9.-]+)?)'
const release = new RegExp(`^${semver}$`)
const header = new RegExp(`^Update available!?[ ·:]*${semver}\\s*(?:→|->)\\s*${semver}$`)
const clean = text => text.split('\n').map(s => s.trim().replace(/^[│┃]\s*/, '').replace(/\s*[│┃]$/, '').replace(/^✨\s*/, '').trim())
const completed = lines => lines.some(s => /^(?:🎉\s*|✔\s*|✓\s*)?Update ran successfully! Please restart Codex\.$/.test(s))

export function compareVersions(a, b) {
  if (!release.test(a) || !release.test(b)) throw new Error('invalid_version')
  const ac = a.split('-')[0], bc = b.split('-')[0]
  const ap = a.includes('-') ? a.slice(ac.length + 1) : undefined
  const bp = b.includes('-') ? b.slice(bc.length + 1) : undefined
  for (let i = 0; i < 3; i++) {
    const x = BigInt(ac.split('.')[i]), y = BigInt(bc.split('.')[i])
    if (x !== y) return x > y ? 1 : -1
  }
  if (ap === bp) return 0
  if (ap === undefined || bp === undefined) return ap === undefined ? 1 : -1
  const x = ap.split('.'), y = bp.split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? -1 : 1
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i])
    if (xn && yn) return BigInt(x[i]) > BigInt(y[i]) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x[i] > y[i] ? 1 : -1
  }
  return 0
}

export function parseUpdateNotice(text) {
  const lines = clean(text), matches = lines.map(s => s.match(header)).filter(Boolean)
  if (matches.length !== 1) return null
  const [, from, to] = matches[0]
  if (compareVersions(to, from) <= 0) return null
  return {from, to}
}

export function parseUpdatePrompt(text) {
  const notice = parseUpdateNotice(text)
  if (!notice) return null
  const lines = clean(text)
  const option = lines.filter(s => /^[›❯>]?\s*1[.)]\s+Update now \(runs `[^`]+`\)$/.test(s))
  if (option.length !== 1 || !lines.some(s => /^[›❯>]?\s*2[.)]\s+Skip$/.test(s)) ||
      !lines.some(s => /^[›❯>]?\s*3[.)]\s+Skip until next version$/.test(s))) return null
  const selections = lines.map(s => s.match(/^[›❯>]\s*([123])[.)]\s+(?:Update now|Skip)/)).filter(Boolean)
  if (selections.length !== 1) return null
  const selectedIndex = Number(selections[0][1])
  return {...notice, selected: selectedIndex === 1, selectedIndex}
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
export async function upgradeOnRestart({pane, timeoutSeconds = 300, tmux = process.env.TMUX_BIN || 'tmux', codex = 'codex'}) {
  if (!/^%\d+$/.test(pane) || !Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error('invalid_upgrade_arguments')
  const deadline = performance.now() + timeoutSeconds * 1000
  function run(command, args) {
    if (performance.now() >= deadline) throw new Error('codex_update_timeout_installer_left_untouched')
    const budget = Math.floor(Math.min(5000, Math.max(1, deadline - performance.now())))
    const result = spawnSync(command, args, {encoding: 'utf8', timeout: budget, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']})
    if (result.error?.code === 'ETIMEDOUT' && performance.now() >= deadline) throw new Error('codex_update_timeout_installer_left_untouched')
    if (result.status !== 0 || result.error) throw new Error(command === tmux ? 'upgrade_pane_unavailable' : 'installed_codex_version_failed')
    return result.stdout
  }
  const capture = () => {
    if (run(tmux, ['display-message', '-p', '-t', pane, '#{pane_dead}']).trim() !== '0') throw new Error('upgrade_pane_exited')
    return run(tmux, ['capture-pane', '-p', '-J', '-t', pane])
  }
  const version = () => {
    const value = run(codex, ['--version']).trim().replace(/^codex-cli /, '')
    if (!release.test(value)) throw new Error('installed_codex_version_invalid')
    return value
  }
  const initialScreen = capture()
  const initial = parseUpdatePrompt(initialScreen)
  if (!initial) throw new Error('upgrade_dialog_not_recognized')
  if (completed(clean(initialScreen))) throw new Error('ambiguous_upgrade_completion')
  const before = version()
  // Another mate in the same explicitly requested restart may have completed
  // the shared installation already. Reload this old process; do not reinstall.
  if (compareVersions(before, initial.to) >= 0) return {ok: true, status: 'already_installed', version: before}
  await delay(200)
  const confirm = parseUpdatePrompt(capture())
  if (!confirm || JSON.stringify(confirm) !== JSON.stringify(initial)) throw new Error('upgrade_dialog_changed')
  if (!initial.selected) {
    // Move from the known highlighted option 2/3 to 1 without crossing the
    // boundary (so wrap-vs-clamp behavior cannot matter). Confirm the rendered
    // selection afterwards; a lost/rebound arrow must never turn into "Skip".
    run(tmux, ['send-keys', '-t', pane, ...Array(initial.selectedIndex - 1).fill('Up')])
    const renderDeadline = Math.min(deadline, performance.now() + 2000)
    let selected
    do {
      await delay(100)
      selected = parseUpdatePrompt(capture())
      if (selected && (selected.from !== initial.from || selected.to !== initial.to)) throw new Error('upgrade_dialog_changed')
      if (selected?.selected) break
    } while (performance.now() < renderDeadline)
    if (!selected?.selected || selected.from !== initial.from || selected.to !== initial.to) throw new Error('upgrade_selection_failed')
  }
  // Enter only on the explicitly selected built-in Update now option. Never
  // send arbitrary shell commands, credentials, or keys to other panes.
  run(tmux, ['send-keys', '-t', pane, 'Enter'])
  while (performance.now() < deadline) {
    const screen = capture(), lines = clean(screen)
    if (completed(lines)) {
      const installed = version()
      if (compareVersions(installed, initial.to) < 0 || compareVersions(installed, before) <= 0) throw new Error('upgrade_version_not_advanced')
      return {ok: true, status: 'updated', version: installed}
    }
    if (lines.some(s => /^(?:Error:|Update failed|Failed to update Codex)/i.test(s))) throw new Error('codex_update_failed')
    await delay(250)
  }
  // Do not kill an installer on timeout. The caller must not restart this mate.
  throw new Error('codex_update_timeout_installer_left_untouched')
}

let isMain = false
try { isMain = realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch {}
if (isMain) {
  try {
    console.log(JSON.stringify(await upgradeOnRestart({pane: process.argv[2], timeoutSeconds: Number(process.argv[3] || 300)})))
  } catch (error) {
    // These are our fixed error codes, never raw screen/process stderr.
    const reason = /^[a-z_]+$/.test(error.message) ? error.message : 'codex_update_failed'
    console.error(JSON.stringify({ok: false, reason})); process.exitCode = 1
  }
}
