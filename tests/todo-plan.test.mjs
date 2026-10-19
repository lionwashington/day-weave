import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {digest,makePlan,parseBoard,updateTask,validateTask} from '../kb/ops/todo-plan.mjs';
const task=(id,extra={})=>({id,title:`Synthetic ${id}`,priority:'P1',priority_reason:'Preparation risk',status:'active',next_action:'Check source',owner:'user',waiting_for:null,next_check:'2031-04-04',dependencies:[],source:'synthetic note',last_verified:'2031-04-03',hard_deadline:null,prepare_by:null,...extra});
const block=t=>'```todo-task\n'+JSON.stringify(t)+'\n```';
const board=ts=>'## 当前执行看板（2031-04-03）\n'+ts.map(block).join('\n')+'\n## 历史状态参考\n- unfinished ancient task\n';
const plan=(ts,opts={})=>makePlan(board(ts),{date:'2031-04-03',...opts});
test('caps owner actions, preserves reason/deadline distinction and separates assistant',()=>{
 const p=plan(['a','b','c','d'].map(id=>task(id)).concat(task('helper',{owner:'assistant'})));
 assert.equal(p.user_actions.length,3);assert.equal(p.assistant_preparation.length,1);assert.equal(p.deferred.length,1);
 assert.equal(p.user_actions[0].hard_deadline,null);assert.equal(p.automatic_checks,false);
});
test('historical tasks never activated, malformed board fails closed',()=>{
 const p=plan([]);assert.equal(p.review_candidates.length,0);
 assert.throws(()=>makePlan('# legacy tasks',{date:'2031-04-03'}));
 const p2=makePlan('## 当前执行看板\n### 紧急\n| 1 | 资料待核 | 检查 | 明天 |\n## 历史\n| 2 | 旧事项 | 做 | 今天 |',{date:'2031-04-03'});
 assert.equal(p2.review_candidates.length,1);assert.equal(p2.user_actions.length,0);assert.ok(p2.issues.some(x=>x.code==='legacy_status_needs_review'));
});
test('waiting tasks surface only at checkpoint; deferred stays deferred',()=>{
 const t=task('wait',{status:'waiting',waiting_for:'external',next_check:'2031-04-04'});
 assert.equal(plan([t]).user_actions.length,0);
 assert.equal(plan([t],{date:'2031-04-04'}).user_actions.length,1);
 assert.equal(plan([task('defer',{status:'deferred',next_check:'2031-04-01'})]).user_actions.length,0);
});
test('unconfirmed completion is rejected, dependencies and cycles block action',()=>{
 assert.ok(plan([task('done',{status:'completed'})]).issues.some(x=>x.code==='invalid_task_block'));
 const p=plan([task('a',{dependencies:['b']}),task('b',{dependencies:['a']}),task('c',{dependencies:['missing']})]);
 assert.equal(p.user_actions.length,0);assert.ok(p.issues.some(x=>x.code==='dependency_cycle'));
 const done=task('b',{status:'completed',completion:{confirmed:true,evidence:'user confirmation'}});
 assert.equal(plan([task('a',{dependencies:['b']}),done]).user_actions.length,1);
});
test('duplicate IDs and preparation after real deadline produce review issues',()=>{
 const p=plan([task('a'),task('a'),task('b',{prepare_by:'2031-04-05',hard_deadline:'2031-04-04',deadline_source:'official'})]);
 assert.ok(p.issues.some(x=>x.code==='duplicate_task_id'));assert.ok(p.issues.some(x=>x.code==='preparation_after_deadline'));
 assert.ok(p.user_actions.every(x=>x.id!=='a'));
});
test('read-only planning retains urgent legacy deadline tasks with explicit verification warning',()=>{
 const urgent=task('packet',{priority:'P0',hard_deadline:'2031-04-22',prepare_by:'2031-04-19'});
 for(const deadline_source of [undefined,null,'', '   ']){
   const t={...urgent,deadline_source};
   const original=board([task('ordinary'),t]);
   const p=makePlan(original,{date:'2031-04-03'});
   assert.equal(p.user_actions[0].id,'packet');
   assert.equal(p.user_actions[0].hard_deadline,'2031-04-22');
   assert.equal(p.user_actions[0].deadline_verified,false);
   assert.equal(p.source_hash,digest(original));
   assert.ok(p.issues.some(x=>x.code==='deadline_source_missing'&&x.id==='packet'&&Number.isInteger(x.line)));
   assert.ok(!p.issues.some(x=>x.code==='invalid_task_block'));
   assert.throws(()=>validateTask(t),/deadline_source/);
 }
 const verified=plan([{...urgent,deadline_source:'Synthetic source'}]);
 assert.equal(verified.user_actions[0].deadline_verified,true);assert.equal(verified.issues.length,0);
 assert.equal(plan([task('no-date')]).user_actions[0].deadline_verified,null);
});
test('parser still rejects invalid JSON, invalid dates and unconfirmed completion with safe reasons',()=>{
 const text='## 当前执行看板\n```todo-task\n{"private-payload":broken}\n```\n';
 const p=makePlan(text,{date:'2031-04-03'});
 assert.deepEqual(p.issues,[{code:'invalid_task_block',line:2,reason:'invalid_json'}]);
 assert.ok(!JSON.stringify(p).includes('private-payload'));
 const invalid=plan([task('bad-date',{hard_deadline:'2031-02-30'}),task('unconfirmed',{status:'completed'})]);
 assert.equal(invalid.user_actions.length,0);
 assert.ok(invalid.issues.some(x=>x.reason==='hard_deadline must be ISO date or null'));
 assert.ok(invalid.issues.some(x=>x.reason==='completion requires explicit confirmation and evidence'));
});
test('unverified deadline is never used as a confirmed deadline sort key',()=>{
 const p=plan([task('unverified',{hard_deadline:'2031-04-01',prepare_by:'2031-04-20'}),
   task('verified',{hard_deadline:'2031-04-10',deadline_source:'Synthetic source'})]);
 assert.equal(p.user_actions[0].id,'verified');
});
const event=(id,start='2031-04-04T10:00:00+08:00',end='2031-04-04T11:00:00+08:00',extra={})=>({id,start:{dateTime:start},end:{dateTime:end},summary:'Synthetic appointment',...extra});
test('calendar overlap and preparation are proposals, not executed checks',()=>{
 const p=plan([],{calendar:{as_of:'2031-04-03',events:[event('a'),event('b'),event('free',undefined,undefined,{transparency:'transparent'})]}});
 assert.deepEqual(p.calendar.conflicts,[['a','b']]);assert.ok(p.calendar.preparation_checks.every(x=>x.executed===false));
});
test('existing reminder receipts deduplicate proposals, quiet hours create nothing',()=>{
 const calendar={as_of:'2031-04-03',events:[]};
 const text=board([task('a')]).replace('## 历史','### 新增行动检查提醒\n- 2031-04-04：check；Google Calendar ID：synthetic-receipt\n## 历史');
 assert.equal(makePlan(text,{date:'2031-04-03',calendar}).reminder_proposals.length,0);
 assert.equal(plan([task('a')],{calendar,hour:22}).reminder_proposals.length,0);
 assert.equal(plan([task('a',{reminder_ids:['existing']})],{calendar}).reminder_proposals.length,0);
 assert.deepEqual(plan([task('a')],{calendar}).reminder_proposals,plan([task('a')],{calendar}).reminder_proposals);
});
test('cleanup never removes appointments, protected course reminders, or shared reminders',()=>{
 const done=task('done',{status:'completed',completion:{confirmed:true,evidence:'confirmed'},reminder_ids:['old','course','appointment','shared'],appointment_ids:['appointment']});
 const events=['old','course','appointment','shared'].map(id=>event(id,undefined,undefined,{kind:id==='appointment'?'appointment':'reminder',protected:id==='course'}));
 const p=plan([done,task('active',{reminder_ids:['shared']})],{calendar:{as_of:'2031-04-03',events}});
 assert.deepEqual(p.reminder_proposals.map(x=>x.event_id),['old']);assert.equal(p.reminder_proposals[0].requires_confirmation,true);
});
test('stale calendar and missing calendar cannot claim checking or propose writes',()=>{
 assert.equal(plan([task('a')]).calendar.checked,false);
 const p=plan([task('a')],{calendar:{as_of:'2031-04-02',events:[]}});
 assert.equal(p.calendar.checked,false);assert.equal(p.reminder_proposals.length,0);
});
test('single task update defaults preview, detects races, preserves history, idempotent',()=>{
 const root=mkdtempSync(join(tmpdir(),'todo-plan-'));
 try {const dir=join(root,'memory/topics');mkdirSync(dir,{recursive:true});const file=join(dir,'todo.md');const original=board([task('a')]);writeFileSync(file,original);
 const t=task('a',{next_action:'Review new evidence'});
 assert.equal(updateTask(file,t,digest(original)).applied,false);assert.equal(readFileSync(file,'utf8'),original);
 assert.throws(()=>updateTask(file,t,'stale',{apply:true}));
 const r=updateTask(file,t,digest(original),{apply:true});assert.equal(r.applied,true);
 const now=readFileSync(file,'utf8');assert.ok(now.endsWith('## 历史状态参考\n- unfinished ancient task\n'));
 assert.equal(updateTask(file,t,digest(now),{apply:true}).changed,false);
 assert.throws(()=>updateTask(file,{...t,status:'completed'},digest(now),{apply:true}));
 assert.throws(()=>updateTask(file,{...t,hard_deadline:'2031-04-22'},digest(now),{apply:true}),/deadline_source/);
 assert.equal(readFileSync(file,'utf8'),now);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('CLI works through discovery symlink with JSON and never alters input',()=>{
 const root=mkdtempSync(join(tmpdir(),'todo-cli-'));try{
 const source=board([task('a',{priority:'P0',hard_deadline:'2031-04-22'})]);
 const file=join(root,'todo.md');writeFileSync(file,source);const link=join(root,'cli.mjs');symlinkSync(fileURLToPath(new URL('../kb/ops/todo-plan.mjs',import.meta.url)),link);
 const r=spawnSync(process.execPath,[link,'plan','--file',file,'--date','2031-04-03'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);const output=JSON.parse(r.stdout);
 assert.equal(output.user_actions.length,1);assert.equal(output.user_actions[0].deadline_verified,false);
 assert.ok(output.issues.some(x=>x.code==='deadline_source_missing'));
 assert.equal(readFileSync(file,'utf8'),source);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('isolated real installer deploys planner and daily-brief discovery without production changes',()=>{
 const root=mkdtempSync(join(tmpdir(),'todo-install-'));
 try {
 const repo=fileURLToPath(new URL('..',import.meta.url));
 const runtime=join(root,'runtime');
 const env={...process.env,KA_HOME:runtime,KA_CLAUDE_SKILLS:join(root,'claude'),KA_CODEX_SKILLS:join(root,'codex')};
 for(const args of [['--only','ka'],['--only','skills','--skill','daily-brief','--switch']]){
   const r=spawnSync('bash',['install.sh',...args],{cwd:repo,env,encoding:'utf8',timeout:30000});assert.equal(r.status,0,r.stderr);
 }
 const file=join(root,'todo.md');writeFileSync(file,board([task('a')]));
 const r=spawnSync(process.execPath,[join(runtime,'kb/ops/todo-plan.mjs'),'plan','--file',file,'--date','2031-04-03'],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).user_actions.length,1);
 for(const kind of ['codex','claude'])assert.match(readFileSync(join(root,kind,'daily-brief/SKILL.md'),'utf8'),/todo-plan\.mjs/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
