import { test, expect } from 'vitest'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recoverMessages } from '../src/capture/recover-messages.js'
test('explicit recovery is dry-run by default, source-preserving and idempotent', () => {
 const raw=mkdtempSync(join(tmpdir(),'recover-test-'))
 try {
  const input={progress:{offset:100},messages:[{role:'user',content:'Synthetic missing anchor',timestamp:'2000-01-01T00:00:00Z'}]}
  expect(recoverMessages(raw,'synthetic',input)).toEqual({checked:1,missing:1,added:0})
  expect(readdirSync(raw)).toHaveLength(0)
  expect(recoverMessages(raw,'synthetic',input,true).added).toBe(1)
  expect(recoverMessages(raw,'synthetic',input,true)).toEqual({checked:1,missing:0,added:0})
  expect(()=>recoverMessages(raw,'synthetic',{...input,progress:{offset:NaN}},true)).toThrow()
 } finally {rmSync(raw,{recursive:true,force:true})}
})
