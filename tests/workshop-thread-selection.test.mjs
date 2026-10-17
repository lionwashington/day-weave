import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const selector = fileURLToPath(new URL('../workshop/ops/runtimes/codex/select-thread.mjs', import.meta.url))
for (const scenario of ['latest', 'fresh', 'wait', 'explicit', 'explicit-missing', 'explicit-timeout', 'explicit-wrong-cwd', 'list-error', 'list-wrong-cwd', 'resume-error', 'resume-wrong-cwd', 'explicit-unloaded', 'explicit-unloaded-wrong-cwd', 'explicit-unloaded-resume-missing', 'explicit-unloaded-other-thread']) {
  test(`selector subprocess: ${scenario}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'ka-thread-test-'))
    try {
      const owner = join(root, 'owner')
      const journal = join(root, 'requests.jsonl')
      const shim = join(root, 'websocket.mjs')
      writeFileSync(owner, 'old-thread\n')
      writeFileSync(shim, `
import { appendFileSync } from 'node:fs';
globalThis.WebSocket = class extends EventTarget {
  constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
  send(raw) {
    const req = JSON.parse(raw);
    appendFileSync(process.env.TEST_JOURNAL, raw + '\\n');
    if (!req.id) return;
    const s = process.env.TEST_SCENARIO;
    if (s.includes('unloaded') && req.method === 'thread/read') {
      const error = { code: -32600, message: 'thread not loaded: ' + (s === 'explicit-unloaded-other-thread' ? 'another-thread' : req.params.threadId) };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: req.id, error }) })));
      return;
    }
    if (s === 'explicit-timeout' && req.method === 'thread/read') return;
    const error = (s === 'explicit-missing' && req.method === 'thread/read') ||
      (s === 'list-error' && req.method === 'thread/list') ||
      (['resume-error', 'explicit-unloaded-resume-missing'].includes(s) && req.method === 'thread/resume');
    const wrong = (s === 'explicit-wrong-cwd' && req.method === 'thread/read') ||
      (s === 'list-wrong-cwd' && req.method === 'thread/list') ||
      (['resume-wrong-cwd', 'explicit-unloaded-wrong-cwd'].includes(s) && req.method === 'thread/resume');
    const cwd = wrong ? '/synthetic/other-mate' : '/synthetic/work';
    const result = req.method === 'thread/list' ? { data: s === 'fresh' ? [] : [{ id: 'latest-thread', cwd }] } :
      req.method.startsWith('thread/') ? { thread: { id: req.params.threadId, cwd } } : {};
    const response = error ? { error: { code: -32600, message: 'synthetic failure' } } : { result };
    queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: req.id, ...response }) })));
  }
  close() {}
};`)
      const explicit = scenario.startsWith('explicit')
      const result = spawnSync(process.execPath, ['--import', shim, selector, 'ws://synthetic', '/synthetic/work', explicit ? 'explicit-thread' : '', scenario === 'wait' ? 'wait' : 'select'], {
        encoding: 'utf8', timeout: 5000,
        env: { ...process.env, KA_CODEX_THREAD_OWNER_FILE: owner, KA_CODEX_MODEL: 'synthetic-model', TEST_JOURNAL: journal, TEST_SCENARIO: scenario, KA_CODEX_THREAD_RESUME_TIMEOUT_MS: '100' },
      })
      const requests = readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse)
      assert.equal(requests.some(r => r.params?.threadId === 'old-thread'), false)
      assert.equal(readFileSync(owner, 'utf8'), 'old-thread\n')
      if (/missing|timeout|wrong-cwd|error|other-thread/.test(scenario)) {
        assert.notEqual(result.status, 0)
        assert.equal(result.stdout, '')
        assert.match(result.stderr, /another workspace|synthetic failure|timed out|thread not loaded: another-thread/)
      } else {
        assert.equal(result.status, 0, result.stderr)
        const output = JSON.parse(result.stdout)
        assert.equal(output.fresh, scenario === 'fresh')
        assert.equal(output.id, scenario === 'fresh' ? '' : explicit ? 'explicit-thread' : 'latest-thread')
      }
      if (explicit) assert.equal(requests.some(r => r.method === 'thread/list'), false)
      else {
        assert.deepEqual(requests.find(r => r.method === 'thread/list').params,
          { cwd: '/synthetic/work', limit: 1, sortKey: 'recency_at', sortDirection: 'desc' })
        assert.equal(requests.some(r => r.method === 'thread/read'), false)
      }
      for (const r of requests.filter(r => r.method === 'thread/resume')) {
        assert.equal(r.params.model, 'synthetic-model')
        assert.equal(r.params.threadId, explicit ? 'explicit-thread' : 'latest-thread')
      }
      if (['fresh', 'wait', 'list-error', 'list-wrong-cwd', 'explicit-missing', 'explicit-timeout', 'explicit-wrong-cwd', 'explicit-unloaded-other-thread'].includes(scenario)) {
        assert.equal(requests.some(r => r.method === 'thread/resume'), false)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
