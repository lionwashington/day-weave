import test from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

const helper=fileURLToPath(new URL('../workshop/ops/runtimes/codex/exec-without-tty.py',import.meta.url))

test('sidecar drops only its controlling TTY, preserves PID/group and raw keyboard input', {skip:process.platform==='win32'},()=>{
  const python=String.raw`
import os,pty,termios,tty,subprocess,json,select,sys
pid,master=pty.fork()
if pid==0:
 try:
  tty.setraw(0)
  attack='''import os,json,termios
opened=False
try:
 fd=os.open('/dev/tty',os.O_RDWR)
 attrs=termios.tcgetattr(fd);attrs[3]|=termios.ICANON|termios.ECHO
 termios.tcsetattr(fd,termios.TCSANOW,attrs);os.close(fd);opened=True
except OSError: pass
print(json.dumps({'opened':opened,'pid':os.getpid(),'group':os.getpgrp(),'session':os.getsid(0)}))
'''
  baseline=subprocess.run([sys.executable,'-c',attack],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=5)
  assert json.loads(baseline.stdout)['opened'] is True
  assert termios.tcgetattr(0)[3]&termios.ICANON
  tty.setraw(0)
  child=subprocess.Popen([sys.executable,sys.argv[1],sys.executable,'-c',attack],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
  output,error=child.communicate(timeout=5);assert child.returncode==0,error
  result=json.loads(output)
  assert result['opened'] is False,result
  assert result['pid']==child.pid,'bootstrap must exec, not supervise'
  assert result['group']==os.getpgrp(),'verified Workshop group must remain unchanged'
  assert result['session']==os.getsid(0),'no extra session or process-group lifecycle'
  attrs=termios.tcgetattr(0)
  assert not attrs[3]&(termios.ICANON|termios.ECHO)
  assert not attrs[0]&termios.ICRNL
  os.write(1,b'READY\n');keys=b''
  while len(keys)<4:
   assert select.select([0],[],[],3)[0],'keyboard timeout'
   keys+=os.read(0,4-len(keys))
  assert keys==b'\x1b[B\r',repr(keys)
  os.write(1,b'PASS\n');os._exit(0)
 except BaseException as error:
  os.write(2,('FAIL '+str(error)+'\n').encode());os._exit(1)
data=b''
try:
 while b'READY\n' not in data:
  assert select.select([master],[],[],12)[0],'sidecar timeout'
  data+=os.read(master,4096)
 os.write(master,b'\x1b[B\r')
 while b'PASS\n' not in data:
  assert select.select([master],[],[],5)[0],'raw input timeout'
  data+=os.read(master,4096)
 assert b'^[[B' not in data,'unexpected arrow echo'
 _,status=os.waitpid(pid,0);assert os.waitstatus_to_exitcode(status)==0,data
finally: os.close(master)
`
  const r=spawnSync('python3',['-c',python,helper],{encoding:'utf8',timeout:20000})
  assert.equal(r.status,0,r.stderr||r.stdout||String(r.error))
})

test('exec bootstrap preserves exit status and hides failed executable arguments',()=>{
  const exit=spawnSync('python3',[helper,process.execPath,'-e','process.exit(23)'],{encoding:'utf8'})
  assert.equal(exit.status,23)
  const missing=spawnSync('python3',[helper,'/no-such-synthetic-executable','synthetic-private'],{encoding:'utf8'})
  assert.equal(missing.status,127)
  assert.match(missing.stderr,/isolated exec failed/)
  assert.doesNotMatch(missing.stderr,/synthetic-private/)
})
