import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createServer as tcpServer} from 'node:net'
import {createHash} from 'node:crypto'
import {spawn, spawnSync} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

const repo=fileURLToPath(new URL('..',import.meta.url))
const probe=join(repo,'workshop/ops/runtimes/codex/probe-ready.mjs')
async function run(args,options={}) {
  const child=spawn(args[0],args.slice(1),{...options,stdio:['ignore','pipe','pipe']})
  let stdout='',stderr=''
  child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x)
  const timer=setTimeout(()=>child.kill('SIGKILL'),10000)
  const [code]=await once(child,'exit');clearTimeout(timer)
  return {code,stdout,stderr}
}
function frame(text) {
  const payload=Buffer.from(text)
  const header=payload.length<126?Buffer.from([0x81,payload.length]):Buffer.from([0x81,126,payload.length>>8,payload.length&255])
  return Buffer.concat([header,payload])
}
// Real TCP and WebSocket frames, with synthetic RPC responses only.
async function server(t,mode='ok') {
  const sockets=new Set(),methods=[]
  const http=createServer()
  http.on('upgrade',(req,socket)=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{})
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n')
    let pending=Buffer.alloc(0)
    socket.on('data',chunk=>{
      pending=Buffer.concat([pending,chunk])
      while(pending.length>=2) {
        const opcode=pending[0]&15,masked=!!(pending[1]&128)
        let length=pending[1]&127,offset=2
        if(length===126){if(pending.length<4)return;length=pending.readUInt16BE(2);offset=4}
        if(length===127){socket.destroy();return}
        if(pending.length<offset+(masked?4:0)+length)return
        const mask=masked?pending.subarray(offset,offset+4):null;offset+=masked?4:0
        const body=Buffer.from(pending.subarray(offset,offset+length));pending=pending.subarray(offset+length)
        if(mask)for(let i=0;i<body.length;i++)body[i]^=mask[i%4]
        if(opcode===8){if(mode!=='stall-close')socket.end(Buffer.from([0x88,0]));return}
        if(opcode!==1)continue
        const m=JSON.parse(body.toString());methods.push(m.method)
        if(m.method!=='initialize')continue
        if(mode==='silent')continue
        if(mode==='disconnect'){socket.destroy();return}
        if(mode==='malformed'){socket.write(frame('synthetic-private-not-json'));continue}
        if(mode==='null-response'){socket.write(frame('null'));continue}
        const result=mode==='missing-version'?{userAgent:'synthetic-private'}:{userAgent:'synthetic/1.2.3 (test)'}
        if(mode==='wrong-version-type')result.userAgent=123
        const response=mode==='reject'?{id:m.id,error:{code:-32001,message:'synthetic-private'}}:{id:m.id,result}
        socket.write(frame(JSON.stringify(response)))
      }
    })
  })
  await new Promise(r=>http.listen(0,'127.0.0.1',r))
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>http.close(r))})
  return {endpoint:`ws://127.0.0.1:${http.address().port}`,methods}
}
for(const [mode,expected,reason] of [
  ['ok','1.2.3',null],['stall-close','1.2.3',null],['ok','9.9.9','version_mismatch'],
  ['silent','1.2.3','protocol_timeout'],['disconnect','1.2.3','transport_closed'],
  ['malformed','1.2.3','invalid_protocol_response'],['reject','1.2.3','initialize_rejected'],
  ['missing-version','1.2.3','server_version_missing'],
  ['null-response','1.2.3','invalid_protocol_response'],['wrong-version-type','1.2.3','server_version_missing'],
]) test(`real protocol probe: ${mode}/${expected}`,async t=>{
  const s=await server(t,mode),start=Date.now()
  // Healthy protocol cases use the real startup probe's 1s budget. Keep a
  // short budget only for the deliberately silent peer, not as a CI speed race.
  const r=await run([process.execPath,probe,s.endpoint,expected,mode==='silent'?'250':'1000'])
  const output=JSON.parse(r.stdout)
  assert.equal(r.code,reason?1:0,r.stderr);assert.equal(output.ok,!reason)
  if(reason)assert.equal(output.reason,reason)
  // Include OS process-start scheduling under the real-TUI E2E workload. The
  // protocol budget is still 1s (250ms for a silent peer), and the 10s parent
  // watchdog still catches a stalled WebSocket close that would hang for 30s.
  assert.ok(Date.now()-start<8000,'probe or WebSocket close exceeded its bounded budget')
  assert.doesNotMatch(r.stdout+r.stderr,/synthetic-private/)
  assert.ok(s.methods.length>0)
  assert.ok(s.methods.every(m=>['initialize','initialized'].includes(m)),'probe must never start/resume a thread or turn')
})

test('TCP accepting connections but not speaking WebSocket never counts as ready',async t=>{
  const sockets=new Set(),tcp=tcpServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))})
  await new Promise(r=>tcp.listen(0,'127.0.0.1',r))
  t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>tcp.close(r))})
  const r=await run([process.execPath,probe,`ws://127.0.0.1:${tcp.address().port}`,'1.2.3','250'])
  assert.equal(r.code,1);assert.equal(JSON.parse(r.stdout).reason,'protocol_timeout')
})

test('refused connections and unsafe probe arguments fail without leaking input',async t=>{
  const tcp=tcpServer();await new Promise(r=>tcp.listen(0,'127.0.0.1',r))
  const endpoint=`ws://127.0.0.1:${tcp.address().port}`;await new Promise(r=>tcp.close(r))
  const r=await run([process.execPath,probe,endpoint,'1.2.3','250'])
  assert.equal(r.code,1);assert.match(JSON.parse(r.stdout).reason,/transport_/)
  for(const args of [['ws://example.invalid:1','1.2.3','250'],['ws://user:synthetic-private@127.0.0.1:1','1.2.3','250'],
    [endpoint,'synthetic-private','250'],[endpoint,'1.2.3','0']]){
    const bad=await run([process.execPath,probe,...args]);assert.equal(bad.code,2)
    assert.doesNotMatch(bad.stdout+bad.stderr,/synthetic-private|example.invalid/)
  }
})

const tmux=spawnSync('which',['tmux'],{encoding:'utf8'}).stdout.trim()
test('isolated real tmux plus protocol: healthy TUI, wrong version, dead server and exited TUI', {skip:!tmux},async t=>{
  const root=mkdtempSync(join(tmpdir(),'ka-health-e2e-')),home=join(root,'runtime')
  const socket=`ka-health-${process.pid}-${Date.now()}`
  const tm=(...args)=>spawnSync(tmux,['-L',socket,'-f','/dev/null',...args],{encoding:'utf8'})
  t.after(()=>{tm('kill-server');rmSync(root,{recursive:true,force:true})})
  const env={...process.env,KA_HOME:home,KA_CONFIG_DIR:join(home,'config'),KA_STATE_DIR:join(home,'state'),
    OPS_CONFIG:join(home,'config/workshop.yaml'),KA_CONFIG:join(home,'config/config.yaml'),
    KA_CODEX_READY_PROBE:join(home,'workshop/ops/runtimes/codex/probe-ready.mjs'),KA_CHANNEL_PORT:'1',TMUX:'',TMUX_PANE:''}
  assert.equal(spawnSync('bash',[join(repo,'install.sh'),'--only','ka'],{env,encoding:'utf8'}).status,0)
  writeFileSync(env.OPS_CONFIG,'session: isolated\nruntime: codex\nmates:\n  - name: synthetic\n    cwd: /synthetic/work\n')
  const wrapper=join(root,'tmux');writeFileSync(wrapper,`#!/bin/sh\nexec '${tmux}' -L '${socket}' "$@"\n`,{mode:0o755});env.TMUX_BIN=wrapper
  assert.equal(tm('new-session','-d','-s','isolated',"printf '? for shortcuts\\n'; sleep 60").status,0)
  const pane=tm('list-panes','-t','isolated','-F','#{pane_id}').stdout.trim()
  const live=await server(t)
  const wait=(version)=>run(['/bin/bash',join(home,'workshop/ops/wait-ready.sh'),'--target',pane,'--timeout','3','--stable','0','--app-server-endpoint',live.endpoint,'--expected-version',version],{env})
  let r=await wait('1.2.3');assert.equal(r.code,0,r.stdout+r.stderr);assert.match(r.stderr,/ready \(.*app-server/)
  r=await wait('9.9.9');assert.equal(r.code,3);assert.match(r.stderr,/version_mismatch/);assert.doesNotMatch(r.stderr,/^\[ka\] %\d+ ready \(/m)
  assert.equal(tm('set-option','-p','-t',pane,'@ka_codex_tui_state','exited').status,0)
  r=await wait('1.2.3');assert.equal(r.code,3);assert.match(r.stderr,/TUI.*exited/)
  assert.equal(tm('set-option','-p','-t',pane,'@ka_codex_tui_state','running').status,0)
  // An actually dead server with a still-live, ready-looking foreground pane.
  const closed=tcpServer();await new Promise(r=>closed.listen(0,'127.0.0.1',r));const deadEndpoint=`ws://127.0.0.1:${closed.address().port}`;await new Promise(r=>closed.close(r))
  r=await run(['/bin/bash',join(home,'workshop/ops/wait-ready.sh'),'--target',pane,'--timeout','3','--app-server-endpoint',deadEndpoint,'--expected-version','1.2.3'],{env})
  assert.equal(r.code,1);assert.match(r.stderr,/transport_unavailable|transport_closed/)
  assert.doesNotMatch(r.stderr,/^\[ka\] %\d+ ready \(/m)
})
