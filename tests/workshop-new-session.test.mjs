import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cli = fileURLToPath(new URL('../workshop/ops/runtimes/codex/new-session.mjs', import.meta.url))
for (const scenario of ['success', 'first-session', 'start-failure', 'rollback-failure', 'release-uncertain', 'busy', 'recover']) {
  test(`isolated controller HTTP + process lifecycle: ${scenario}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'workshop-switch-'))
    const state = join(root, 'codex-app-servers')
    mkdirSync(state)
    const session = join(state, 'math.session.json')
    const journal = join(state, 'math.session-switch.json')
    const statusFile = join(root, 'status.json')
    const old = { schema_version: 1, cwd: '/synthetic/shared', threadId: 'old-thread', fresh: false }
    writeFileSync(statusFile, JSON.stringify(scenario === 'first-session' ? { alive: false } : { threadId: 'old-thread', alive: true }))
    let held = scenario === 'recover'
    if (held) writeFileSync(journal, JSON.stringify({ cwd: old.cwd, channel: 'math', previous: old, phase: 'switching' }))
    const actions = []
    const server = createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw); actions.push(body.action)
      let result
      const current = JSON.parse(readFileSync(statusFile, 'utf8'))
      if (body.action === 'begin' || body.action === 'begin-new') {
        if (scenario === 'busy') { res.writeHead(409); res.end(JSON.stringify({ ok: false, error: 'mate is not idle' })); return }
        held = true; result = { cwd: old.cwd, threadId: 'old-thread' }
      } else if (body.action === 'release') {
        if (scenario === 'release-uncertain') { res.writeHead(503); res.end(JSON.stringify({ ok: false, error: 'synthetic release uncertainty' })); return }
        assert.equal(body.thread_id, current.threadId); held = false; result = { released: true }
      } else result = { ...current, held, cwd: old.cwd }
      res.end(JSON.stringify({ ok: true, result }))
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const workflow = join(root, 'workshop.sh')
    const worker = join(root, 'worker.mjs')
    writeFileSync(workflow, 'exec node "$TEST_SWITCH_WORKER" "$@"\n')
    writeFileSync(worker, `import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const verb=process.argv[2],file=${JSON.stringify(session)},status=${JSON.stringify(statusFile)};
if(verb==='stop'){writeFileSync(status,JSON.stringify({alive:false}));process.exit(0)}
const s=JSON.parse(readFileSync(file,'utf8'));
if(${JSON.stringify(scenario)}==='rollback-failure' || (s.fresh && ${JSON.stringify(scenario)}==='start-failure'))process.exit(1);
if(s.fresh){s.threadId='new-thread';s.fresh=false;writeFileSync(file,JSON.stringify(s))}
writeFileSync(status,JSON.stringify({alive:true,threadId:s.threadId}));
`)
    try {
      const child = spawn(process.execPath, [cli, 'math', 'math', old.cwd, workflow, String(server.address().port), scenario === 'recover' ? '1' : '0'], {
        env: { ...process.env, KA_STATE_DIR: root, TEST_SWITCH_WORKER: worker }, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = '', errors = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => errors += b)
      const code = await new Promise(resolve => child.on('exit', resolve))
      assert.equal(code, ['busy', 'start-failure', 'rollback-failure', 'release-uncertain'].includes(scenario) ? 1 : 0, errors)
      if (scenario === 'busy') { assert.equal(existsSync(session), false); assert.equal(actions.includes('release'), false) }
      else if (scenario === 'release-uncertain') {
        assert.equal(held, true)
        assert.equal(JSON.parse(readFileSync(session)).threadId, 'new-thread')
        assert.equal(JSON.parse(readFileSync(journal)).phase, 'releasing')
      } else if (scenario === 'rollback-failure') {
        assert.equal(held, true)
        assert.equal(JSON.parse(readFileSync(session)).threadId, 'old-thread')
        assert.equal(JSON.parse(readFileSync(journal)).phase, 'recovery-required')
      }
      else {
        const fresh = ['success', 'first-session'].includes(scenario)
        assert.equal(held, false)
        assert.equal(JSON.parse(readFileSync(session)).threadId, fresh ? 'new-thread' : 'old-thread')
        assert.equal(JSON.parse(readFileSync(journal)).phase, fresh ? 'complete' : 'rolled-back')
        assert.equal(JSON.parse(output).mate, 'math')
      }
    } finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true, force: true }) }
  })
}
