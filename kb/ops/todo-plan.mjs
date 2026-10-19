#!/usr/bin/env node
// Read-only planning by default. The only mutable source is the selected todo.md.
import {readFileSync, realpathSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync} from 'node:fs';
import {resolve, dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const digest = text => createHash('sha256').update(text).digest('hex');
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ACTIVE = /^## (?:当前执行看板|Current execution board).*$/m;
const BLOCK = /^```todo-task[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const validDay = x => typeof x === 'string' && DAY.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString().slice(0,10) === x;
const fail = message => { throw new Error(message); };
const deadlineVerified = t => typeof t.deadline_source==='string' && !!t.deadline_source.trim();

export function validateTask(t,{allowMissingDeadlineSource=false}={}) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) fail('task must be an object');
  for (const k of ['id','title','priority_reason','next_action','source','last_verified'])
    if (typeof t[k] !== 'string' || !t[k].trim()) fail(`task requires ${k}`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(t.id)) fail('invalid stable task id');
  if (!['P0','P1','P2','P3'].includes(t.priority)) fail('invalid priority');
  if (!['active','waiting','deferred','completed'].includes(t.status)) fail('invalid status');
  if (!['user','assistant'].includes(t.owner)) fail('invalid owner');
  if (!validDay(t.last_verified)) fail('last_verified must be an ISO date');
  for (const k of ['hard_deadline','prepare_by','next_check']) {
    if (!Object.hasOwn(t,k) || (t[k] !== null && !validDay(t[k]))) fail(`${k} must be ISO date or null`);
  }
  if (!Object.hasOwn(t,'waiting_for') || (t.waiting_for !== null && typeof t.waiting_for !== 'string')) fail('waiting_for must be text or null');
  if (!Array.isArray(t.dependencies) || t.dependencies.some(x=>typeof x!=='string')) fail('dependencies must be IDs');
  if (t.status==='completed' && (t.completion?.confirmed!==true || typeof t.completion.evidence!=='string' || !t.completion.evidence.trim())) fail('completion requires explicit confirmation and evidence');
  if (t.hard_deadline && !deadlineVerified(t) && !allowMissingDeadlineSource) fail('hard deadline requires deadline_source');
  for (const k of ['reminder_ids','appointment_ids']) if (t[k]!==undefined && (!Array.isArray(t[k]) || t[k].some(x=>typeof x!=='string'))) fail(`${k} must be an array of IDs`);
  return t;
}

export function parseBoard(text) {
  const match=ACTIVE.exec(text);
  if (!match) fail('current board heading missing; refusing to activate historical tasks');
  const from=match.index+match[0].length;
  const next=/^## /m.exec(text.slice(from));
  const end=next?from+next.index:text.length;
  const body=text.slice(from,end),tasks=[],blocks=[],issues=[];
  for(const b of body.matchAll(BLOCK)) {
    const line=text.slice(0,from+b.index).split('\n').length;
    try {
      const task=validateTask(JSON.parse(b[1]),{allowMissingDeadlineSource:true});
      tasks.push(task);blocks.push({id:task.id,start:from+b.index,end:from+b.index+b[0].length});
      if(task.hard_deadline&&!deadlineVerified(task))issues.push({code:'deadline_source_missing',id:task.id,line});
    }
    catch(error) { issues.push({code:'invalid_task_block',line,reason:error instanceof SyntaxError?'invalid_json':error.message}); }
  }
  const candidates=[];let group='review';
  for(const line of body.replace(BLOCK,'').split('\n')) {
    if(line.startsWith('### ')) {
      group=/待跟进|等待|Waiting/i.test(line)?'waiting':/日常|暂缓|Deferred/i.test(line)?'deferred':/紧急|进行中|Active/i.test(line)?'review':'ignore';
    }
    if(group==='ignore')continue;
    const cells=line.startsWith('|')?line.split('|').slice(1,-1).map(x=>x.trim()):[];
    if(cells.length>=4 && /^\d+$/.test(cells[0])) candidates.push({group,text:cells[1],next_action:cells[2],checkpoint_text:cells[3],needs_review:true});
    else if (/^- \*\*.+\*\*/.test(line)) candidates.push({group,text:line.slice(2),needs_review:true});
  }
  const knownReminders=[...body.matchAll(/(\d{4}-\d{2}-\d{2})[^\n]*Google Calendar ID[：:]\s*([\w-]+)/g)].map(m=>({date:m[1],id:m[2]}));
  return {tasks,blocks,candidates,knownReminders,issues,from,end,source_hash:digest(text)};
}

export function makePlan(text,{date,hour=10,calendar=null}={}) {
  if(!validDay(date))fail('plan requires --date YYYY-MM-DD');
  if(!Number.isInteger(hour)||hour<0||hour>23)fail('invalid local hour');
  const b=parseBoard(text),issues=[...b.issues],ids=new Map(),duplicate=new Set();
  for(const t of b.tasks){if(ids.has(t.id))duplicate.add(t.id);ids.set(t.id,t);}
  for(const id of duplicate)issues.push({code:'duplicate_task_id',id});
  const result={schema_version:1,date,source_hash:b.source_hash,mode:'review_only',automatic_checks:false,
    user_actions:[],assistant_preparation:[],waiting:[],deferred:[],completed:[],review_candidates:b.candidates,
    known_reminders:b.knownReminders,issues,calendar:{checked:false,conflicts:[],preparation_checks:[]},reminder_proposals:[]};
  const sortDay=t=>(deadlineVerified(t)&&t.hard_deadline)||t.prepare_by||'9999';
  const sorted=[...b.tasks].sort((a,c)=>a.priority.localeCompare(c.priority)||sortDay(a).localeCompare(sortDay(c))||a.id.localeCompare(c.id));
  const cycle=id=>{const visit=(cur,path)=>path.has(cur)|| (ids.get(cur)?.dependencies||[]).some(d=>visit(d,new Set([...path,cur])));return visit(id,new Set());};
  for(const t of sorted){
    if(duplicate.has(t.id))continue;
    if(t.last_verified>date)issues.push({code:'future_verification',id:t.id});
    if(t.prepare_by&&t.hard_deadline&&t.prepare_by>t.hard_deadline)issues.push({code:'preparation_after_deadline',id:t.id});
    if(t.status==='waiting'&&(!t.next_check||!t.waiting_for))issues.push({code:'waiting_checkpoint_or_party_missing',id:t.id});
    if(/冲突|未核定|待核正/.test(t.title+' '+t.next_action))issues.push({code:'source_conflict_needs_review',id:t.id});
    if(cycle(t.id))issues.push({code:'dependency_cycle',id:t.id});
    const blocked=t.dependencies.filter(id=>!ids.has(id)||ids.get(id).status!=='completed'||duplicate.has(id));
    if(blocked.length)issues.push({code:'dependency_unresolved',id:t.id,dependencies:blocked});
    const row={...t,deadline_verified:t.hard_deadline?deadlineVerified(t):null,checkpoint_due:!!t.next_check&&t.next_check<=date,blocked_by:blocked};
    if(t.status==='completed'){result.completed.push(row);continue;}
    if(t.status==='deferred'){result.deferred.push(row);continue;}
    if(blocked.length||cycle(t.id)||t.last_verified>date||(t.status==='waiting'&&!row.checkpoint_due)){result.waiting.push(row);continue;}
    if(t.owner==='assistant')result.assistant_preparation.push(row);
    else if(result.user_actions.length<3)result.user_actions.push(row);
    else result.deferred.push({...row,reason:'daily_user_action_cap'});
  }
  // Legacy prose is never silently upgraded to verified execution state.
  for(const c of b.candidates)if(/冲突|未确认|待核|不一致/.test(c.text))issues.push({code:'legacy_status_needs_review',candidate:b.candidates.indexOf(c)});
  if(calendar){
    if(!validDay(calendar.as_of)||!Array.isArray(calendar.events))fail('calendar snapshot requires as_of and events');
    result.calendar.checked=calendar.as_of===date;
    if(!result.calendar.checked)issues.push({code:'stale_calendar_snapshot'});
    const events=calendar.events.filter(e=>e.status!=='cancelled');
    const start=e=>e.start?.dateTime||e.start,finish=e=>e.end?.dateTime||e.end;
    const timed=s=>typeof s==='string'&&/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s)&&Number.isFinite(Date.parse(s));
    for(let i=0;i<events.length;i++){
      const a=events[i];
      if(!timed(start(a))||!timed(finish(a))) {issues.push({code:'calendar_time_needs_review',event_id:a.id});continue;}
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:calendar.timezone||'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(start(a)));
      if(day>=date&&Date.parse(day)-Date.parse(date)<=7*86400000&&a.kind!=='reminder')result.calendar.preparation_checks.push({event_id:a.id,title:a.summary,day,checks:['materials','travel','schedule_conflicts'],executed:false});
      if(a.transparency==='transparent'||a.kind==='reminder')continue;
      for(const c of events.slice(i+1))if(c.id!==a.id&&c.transparency!=='transparent'&&c.kind!=='reminder'&&timed(start(c))&&timed(finish(c))&&Date.parse(start(a))<Date.parse(finish(c))&&Date.parse(start(c))<Date.parse(finish(a)))result.calendar.conflicts.push([a.id,c.id]);
    }
    if(result.calendar.checked)for(const t of sorted){
      if(duplicate.has(t.id))continue;
      const linked=t.reminder_ids||[];
      if(t.status==='completed')for(const id of linked){
        const e=events.find(e=>e.id===id);
        const shared=sorted.some(x=>x.id!==t.id&&x.status!=='completed'&&(x.reminder_ids||[]).includes(id));
        if(e?.kind==='reminder'&&!e.protected&&!shared&&!(t.appointment_ids||[]).includes(id))result.reminder_proposals.push({action:'review_remove',event_id:id,task_id:t.id,requires_confirmation:true});
      }
      else if(t.next_check&&t.status!=='deferred'){
        const existing=linked.length||b.knownReminders.some(r=>r.date===t.next_check)||events.some(e=>e.task_id===t.id&&e.checkpoint===t.next_check);
        if(!existing&&hour>=8&&hour<20)result.reminder_proposals.push({action:'review_create',task_id:t.id,key:`${t.id}:${t.next_check}`,date:t.next_check<date?date:t.next_check,local_time:'10:00',requires_confirmation:true});
      }
    }
  }
  result.reminder_proposals=[...new Map(result.reminder_proposals.map(x=>[x.event_id||x.key,x])).values()];
  return result;
}

export function updateTask(file,task,expectedHash,{apply=false}={}) {
  validateTask(task);
  const path=realpathSync(file);
  if(!path.endsWith('/memory/topics/todo.md'))fail('writes restricted to memory/topics/todo.md');
  const codeRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  if(path.startsWith(codeRoot+'/'))fail('private tasks cannot be written into code/runtime root');
  const original=readFileSync(path,'utf8'),board=parseBoard(original);
  if(board.source_hash!==expectedHash)fail('source changed; reread before updating');
  if(board.issues.length)fail('invalid task blocks require manual review');
  const blocks=board.blocks.filter(b=>b.id===task.id);
  if(blocks.length!==1)fail('update requires exactly one existing structured task; migration is manual review');
  const block=blocks[0],body='```todo-task\n'+JSON.stringify(task,null,2)+'\n```';
  const proposed=original.slice(0,block.start)+body+original.slice(block.end);
  if(!apply)return {applied:false,source_hash:board.source_hash,task,changed:proposed!==original};
  const lock=path+'.plan.lock',temp=path+'.plan.tmp-'+process.pid;
  const fd=openSync(lock,'wx',0o600);
  try {
    if(digest(readFileSync(path,'utf8'))!==expectedHash)fail('source changed; update cancelled');
    if(proposed!==original){writeFileSync(temp,proposed,{mode:statSync(path).mode&0o777,flag:'wx'});renameSync(temp,path);}
    return {applied:true,changed:proposed!==original,source_hash:digest(proposed)};
  }finally{closeSync(fd);unlinkSync(lock);try{unlinkSync(temp);}catch{}}
}

export function cli(argv) {
  const command=argv.shift()||'plan',args={};
  while(argv.length){const key=argv.shift();if(!key.startsWith('--'))fail('invalid argument');args[key.slice(2)]=key==='--apply'?true:argv.shift();}
  const file=resolve(args.file||join(process.cwd(),'memory/topics/todo.md'));
  if(command==='update')return updateTask(file,JSON.parse(readFileSync(args.task,'utf8')),args['expected-hash'],{apply:args.apply===true});
  if(command!=='plan')fail('commands: plan, update');
  const now=new Date(),tz=args.timezone||'Asia/Hong_Kong';
  const date=args.date||new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const hour=Number(args.hour??new Intl.DateTimeFormat('en-GB',{timeZone:tz,hour:'2-digit',hourCycle:'h23'}).format(now));
  return makePlan(readFileSync(file,'utf8'),{date,hour,calendar:args.calendar?JSON.parse(readFileSync(args.calendar,'utf8')):null});
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.stdout.write(JSON.stringify(cli(process.argv.slice(2)))+'\n');}
  catch{process.stderr.write('todo-plan: invalid input, stale source, or unavailable file; no external action performed\n');process.exitCode=2;}
}
