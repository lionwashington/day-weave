import { resolve } from 'node:path'
import { realpathSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createCaptureSnapshot, acknowledgeCaptureSnapshot } from './snapshot.js'
import { planDistill, pendingDistill } from './distill-plan.js'
import { recoverMessages } from './recover-messages.js'

export function main(args = process.argv.slice(2)): void {
  const [command, ...rest] = args
  const flags = new Map<string, string>()
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error('expected option/value pairs')
    flags.set(rest[i], rest[i + 1])
  }
  const required = (key: string) => { const v = flags.get(key); if (!v) throw new Error(`missing ${key}`); return v }
  if (command === 'recover') {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(JSON.stringify(recoverMessages(required('--raw-dir'), required('--session'), input, flags.get('--apply') === 'true')) + '\n')
  } else if (command === 'plan') {
    const plan = planDistill(required('--raw-dir'), required('--session'), Number(required('--upper')), required('--dir'))
    process.stdout.write(JSON.stringify({ ok: true, count: plan.count, deferred: plan.deferred }) + '\n')
  } else if (command === 'pending') {
    process.stdout.write(JSON.stringify(pendingDistill(required('--plan'))) + '\n')
  } else if (command === 'read') {
    const snapshot = JSON.parse(readFileSync(required('--job'), 'utf8'))
    const sections = snapshot.body.split(/(?=^## (?:User|Assistant)$)/m).filter((s: string) => s.trim())
    process.stdout.write(JSON.stringify({ file: snapshot.file, text: sections.slice(snapshot.processedPrefix).join('') }) + '\n')
  } else if (command === 'snapshot') {
    const snapshot = createCaptureSnapshot(required('--raw-dir'), required('--file'), required('--job'))
    // Explicit snapshot reading is the only command that returns private text.
    const sections = snapshot.body.split(/(?=^## (?:User|Assistant)$)/m).filter(s => s.trim())
    process.stdout.write(JSON.stringify({ ok: true, hash: snapshot.hash, text: sections.slice(snapshot.processedPrefix).join('') }) + '\n')
  } else if (command === 'ack') {
    const result = acknowledgeCaptureSnapshot(required('--job'), JSON.parse(required('--topics-json')))
    process.stdout.write(JSON.stringify({ ok: result.status !== 'conflict', ...result }) + '\n')
    if (result.status === 'conflict') process.exitCode = 3
  } else throw new Error('expected snapshot or ack')
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try { main() } catch { process.stderr.write('capture snapshot failed; check arguments, source and local file access\n'); process.exitCode = 1 }
}
