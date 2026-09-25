import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

for (const fail of [false, true]) test(`isolated Codex worker ledger: ${fail ? 'no ack fails closed' : 'drain and second-run no-op'}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'ka-ledger-e2e-'))
  try {
    for (const d of ['config','state','kb/core/dist','mock','memory/raw','memory/topics','memory/conversations']) mkdirSync(join(root,d),{recursive:true})
    cpSync(resolve('kb/core/dist'),join(root,'kb/core/dist'),{recursive:true})
    writeFileSync(join(root,'kb/core/dist/package.json'),' {"type":"module"}')
    writeFileSync(join(root,'config/config.yaml'),`knowledge_base_path: ${root}/memory\n`)
    writeFileSync(join(root,'state/status.json'),'{}')
    for (let i=0;i<3;i++) writeFileSync(join(root,`memory/raw/${i}.md`),`---\nid: synthetic-${i}\nsource: codex\ndistilled: false\nmetadata:\n  codex_session_id: synthetic\n  rollout_end_offset: ${i+1}\n---\n## User\n\nSynthetic preference ${i}\n`)
    writeFileSync(join(root,'memory/raw/legacy.md'),'---\nsource: claude-code\nsession_id: synthetic\nlast_parsed_offset: 1\ndistilled: false\n---\nLegacy remains untouched\n')
    writeFileSync(join(root,'mock/dispatch.sh'),`distill_runtime_load() { return 0; }
distill_runtime_is_retriable() { return 1; }
distill_runtime_run() { node "$KA_HOME/mock/agent.cjs" "$CODEX_BATCH" "$KA_HOME/kb/core/dist/capture-snapshot-cli.js" > "$2"; }
`)
    writeFileSync(join(root,'mock/agent.cjs'),`const fs=require('fs'),{spawnSync}=require('child_process');
if (!process.env.TEST_NO_ACK) for(const job of JSON.parse(fs.readFileSync(process.argv[2]))) {
 fs.appendFileSync(process.env.KA_HOME+'/memory/topics/synthetic.md','Synthetic distilled fact\\n');
 const r=spawnSync(process.execPath,[process.argv[3],'ack','--job',job,'--topics-json','["synthetic"]']);if(r.status)process.exit(r.status);
}
console.log('{"type":"turn.completed"}');`)
    const run = () => spawnSync('bash',[resolve('kb/ops/distill-bg-worker.sh'),'--jsonl',join(root,'unused.jsonl'),'--session-id','synthetic','--snapshot-offset','99999999','--snapshot-count','3','--log-path',join(root,'state/worker.log'),'--status-file',join(root,'state/status.json'),'--workspace-cwd',root],{encoding:'utf8',timeout:60000,env:{...process.env,KA_HOME:root,KA_CONFIG:join(root,'config/config.yaml'),KA_DISTILL_RUNTIME:'codex',KA_DISTILL_RUNTIMES_DIR:join(root,'mock'),KA_CODEX_DISTILL_BATCH_SIZE:'2',TEST_NO_ACK:fail?'1':''}})
    const r=run(); assert.equal(r.status,fail?7:0,r.stderr)
    const state=JSON.parse(readFileSync(join(root,'state/status.json')))
    assert.equal(state.status,fail?'failed':'done')
    assert.match(readFileSync(join(root,'memory/raw/legacy.md'),'utf8'),/distilled: false/)
    if (!fail) {
      assert.equal(state.raw_added,3); assert.equal(state.codex_batches,2);assert.equal(state.topics_updated,1)
      const before=readFileSync(join(root,'memory/topics/synthetic.md'),'utf8')
      assert.equal(run().status,0)
      assert.equal(JSON.parse(readFileSync(join(root,'state/status.json'))).raw_added,0)
      assert.equal(readFileSync(join(root,'memory/topics/synthetic.md'),'utf8'),before)
    }
  } finally { rmSync(root,{recursive:true,force:true}) }
})
