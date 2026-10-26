import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SwitchBuffer } from '../../channels/core/src/codex/switch-buffer.ts'

test('session switch preserves ordered attachments and restores a durable hold without replaying uncertain deliveries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'switch-buffer-'))
  try {
    const file = join(root, 'math.json')
    const buffer = new SwitchBuffer('math', file)
    await buffer.deliver({ content: 'synthetic A', meta: {}, attachments: [{ path: '/synthetic/a.jpg', kind: 'photo' }] })
    await buffer.deliver({ content: 'synthetic B', meta: {} })
    assert.equal(statSync(file).mode & 0o777, 0o600)
    const restored = new SwitchBuffer('math', file)
    const seen: string[] = []
    await restored.drain({ name: 'math', runtime: 'codex', deliver: async message => {
      seen.push(message.content)
      if (message.content.endsWith('A')) { assert.equal(message.attachments?.length, 1); throw new Error('synthetic disconnect') }
    } })
    assert.deepEqual(seen, ['synthetic A', 'synthetic B'])
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries[0].status, 'uncertain')
    await new SwitchBuffer('math', file).drain({ name: 'math', runtime: 'codex', deliver: async () => { assert.fail('must not replay') } })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('messages arriving during drain stay in sequence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'switch-order-'))
  try {
    const buffer = new SwitchBuffer('math', join(root, 'math.json'))
    await buffer.deliver({ content: '1', meta: {} })
    const seen: string[] = []
    await buffer.drain({ name: 'math', runtime: 'codex', deliver: async message => {
      seen.push(message.content)
      if (message.content === '1') await buffer.deliver({ content: '2', meta: {} })
    } })
    assert.deepEqual(seen, ['1', '2'])
    assert.equal(buffer.state.held, false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
