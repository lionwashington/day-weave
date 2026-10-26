import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RuntimeTarget, RuntimeTargetMessage } from '../targets.ts'

/** Durable hold during an explicit session switch. Never replay an ambiguous
 * in-flight delivery after a crash. No message text is written to diagnostics. */
export class SwitchBuffer implements RuntimeTarget {
  readonly runtime = 'codex'
  readonly name: string
  readonly file: string
  draining = false
  state: { held: boolean; entries: Array<{ message: RuntimeTargetMessage; status: string }> }
  constructor(name: string, file: string) {
    this.name = name; this.file = file
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { held: true, entries: [] }
    this.save()
  }
  isAlive(): boolean { return true }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeFileSync(this.file + '.tmp', JSON.stringify(this.state), { mode: 0o600 })
    renameSync(this.file + '.tmp', this.file)
  }
  async deliver(message: RuntimeTargetMessage): Promise<void> {
    this.state.entries.push({ message, status: 'pending' })
    this.save()
  }
  async drain(target: RuntimeTarget): Promise<void> {
    if (this.draining) throw new Error('queue already draining')
    this.draining = true
    for (const entry of this.state.entries) {
      if (entry.status !== 'pending') continue
      entry.status = 'in-flight'; this.save()
      try { await target.deliver(entry.message); entry.status = 'delivered' }
      catch { entry.status = 'uncertain' }
      this.save()
    }
    this.state.held = false; this.save()
  }
}
