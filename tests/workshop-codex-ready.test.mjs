import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const adapter = fileURLToPath(new URL('../workshop/ops/runtimes/codex/ready-signals.sh', import.meta.url))
const matches = content => spawnSync('bash', ['-c', 'source "$1"; runtime::ready_match "$2"', 'test', adapter, content], { encoding: 'utf8' })

test('Codex idle prompt and status are ready', () => {
  for (const content of ['header\n  ›  \n? for shortcuts', '100% context left', 'Ask Codex']) {
    assert.equal(matches(content).status, 0)
  }
})

test('hook review blocks readiness even with prompt/status visible behind it', () => {
  for (const content of [
    'Hooks need review\n1 hook is new or changed\n1. Review hooks\n2. Trust all and continue\n3. Continue without trusting',
    'Hooks need review\n  ›  \n? for shortcuts',
    '2. Trust all and continue\n100% context left',
    '3. Continue without trusting\nAsk Codex',
    '│ Hooks need review │\nAsk Codex',
    '› 2. Trust all and continue\nAsk Codex',
    'Starting Codex...',
  ]) assert.equal(matches(content).status, 1, content)
})

test('ordinary conversation quoting hook-review phrases does not block a live composer',()=>{
  for(const content of [
    'We fixed the "Hooks need review" dialog.\nAsk Codex',
    'The option "Trust all and continue" requires review.\n? for shortcuts',
    'Do not use Continue without trusting during this test.\n100% context left',
  ])assert.equal(matches(content).status,0,content)
})

test('passive release notices leave a composer usable; actionable update menus do not', () => {
  for (const text of ['Update available · 1.2.3 → 1.2.4', '✨ Update available! 1.2.3 → 1.2.4',
    '│ ✨ Update available! 1.2.3 -> 1.2.4 │']) {
    assert.equal(matches(text + '\nAsk Codex').status, 0)
    assert.equal(matches(text + '\nPress enter to continue\nAsk Codex').status, 1)
    assert.equal(matches(text + '\nenter continue · esc skip\nAsk Codex').status, 1)
  }
  assert.equal(matches('We fixed the "Update available" menu.\nAsk Codex').status, 0)
})
