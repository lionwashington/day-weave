import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicUpdateText, textHash } from './atomic-update.js'
import { parseFrontmatter, serializeWithFrontmatter } from '../knowledge-store/markdown.js'

/** Explicit recovery of messages extracted by the official runtime adapter CLI.
 * Never rewrites existing captures. Original rollout remains the audit source. */
export function recoverMessages(rawDir: string, session: string, extracted: {
  progress: { offset: number }; messages: { role: string; content: string; timestamp: string }[]
}, apply = false) {
  if (!session || !Number.isSafeInteger(extracted.progress?.offset) || extracted.progress.offset < 0 || !Array.isArray(extracted.messages)) throw new Error('invalid extraction')
  let corpus = ''
  for (const f of readdirSync(rawDir).filter(f => f.endsWith('.md'))) {
    const { data, content } = parseFrontmatter(readFileSync(join(rawDir,f),'utf8'))
    const meta = data.metadata as Record<string,unknown> | undefined
    if (meta?.codex_session_id === session || data.session_id === session) corpus += '\n' + content
  }
  let missing = 0, added = 0
  for (const message of extracted.messages) {
    if (!['user','assistant'].includes(message.role) || typeof message.content !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(message.timestamp)) throw new Error('invalid message')
    const content = message.content.trim()
    if (!content || corpus.includes(content)) continue
    missing++
    if (apply) {
      const id = textHash(JSON.stringify([session,message.timestamp,message.role,content])).slice(0,24)
      const body = `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${content}`
      const changed = atomicUpdateText(join(rawDir,`${message.timestamp.slice(0,10)}-recovered-${id}.md`), old => {
        if (old !== null) return null
        return serializeWithFrontmatter({id,source:'codex',session_id:`${session}:recovered:${id}`,timestamp:message.timestamp,
          distilled:false,topics:[],content_hash:textHash(body),distilled_message_count:0,
          metadata:{codex_session_id:session,recovered:true,rollout_end_offset:extracted.progress.offset}},body)
      })
      if (changed) added++
    }
    corpus += '\n' + content
  }
  return { checked: extracted.messages.length, missing, added }
}
