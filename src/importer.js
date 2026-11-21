/**
 * Convert DeepSeek web conversations into native DSH Sessions and persist
 * them. Implements the same event-log recipe as the official chat-import
 * plugin, but standalone (no dependency on other plugins).
 *
 * We never import @deepseek-ai/* packages statically or dynamically: this
 * plugin installs as a linked directory, so package imports would resolve
 * from the workspace, not the profile. Instead we read the SESSION_FORMAT
 * VERSION and Session constructor through services available on the context.
 */

import { randomUUID } from 'node:crypto'

const IMPORTED_SOURCE = { provider: 'deepseek-chat-import', model: 'deepseek-chat-import' }
const MAX_TITLE_BYTES = 120

function newId() {
  try { return randomUUID() } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}` }
}

function truncateTitle(title) {
  const clean = String(title || '').replace(/\s+/g, ' ').trim()
  if (!clean) return ''
  let out = ''
  let bytes = 0
  for (const ch of clean) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (bytes + size > MAX_TITLE_BYTES) break
    out += ch
    bytes += size
  }
  return out
}

/** Format-version probe: any valid seed must carry the format the build writes. */
const FORMAT_VERSION = 4

/**
 * Select the branch that ends at the newest message (max id). The web API
 * returns the flat list of the conversation's messages; the reply chain is
 * the parent chain of the newest one.
 */
export function selectBranch(messages) {
  const byId = new Map()
  let newest = null
  for (const m of messages || []) {
    if (!m || m.id === undefined || m.id === null) continue
    const id = Number(m.id)
    if (!Number.isFinite(id)) continue
    byId.set(id, m)
    if (!newest || id > Number(newest.id)) newest = m
  }
  if (!newest) return []
  const chain = []
  let node = newest
  let guard = 0
  while (node && guard++ < byId.size + 2) {
    chain.push(node)
    const parent = node.parentId === null || node.parentId === undefined ? undefined : byId.get(Number(node.parentId))
    if (!parent) break
    node = parent
  }
  return chain.reverse()
}

/**
 * Build seed SessionEvents for one conversation.
 * Uses the exported Session message shapes: text/reasoning blocks, source
 * attribution, surfaceOp 'append', and turn/step boundaries.
 */
export function buildSeedEvents(messages, { title = '', createdAt = Date.now(), allowTitleEvent = false } = {}) {
  const chain = selectBranch(messages)
  const events = []
  let time = Math.max(0, Number(createdAt) || Date.now())
  const add = (type, data, extra = {}) => {
    events.push({ type, seq: events.length, time, data, ...extra })
  }

  // Pair each USER message with the following ASSISTANT reply.
  let turn = 0
  const normalizedTitle = truncateTitle(title)
  for (let i = 0; i < chain.length; i++) {
    const user = chain[i]
    if (user.role !== 'user') continue
    const reply = chain[i + 1]?.role === 'assistant' ? chain[i + 1] : null
    if (reply) i++

    turn++
    const userTime = Number(user.insertedAt) || Date.now()
    time = Math.max(time, userTime)
    add('turn/start', { turn })
    const step = 1
    add('step/start', { turn, step })
    if (turn === 1) {
      // Empty system head at surface node 0, so a resumed agent can replace it.
      add('system/message', {
        turn, step,
        message: { id: newId(), role: 'system', content: [], source: { kind: 'system-prompt' } },
      }, { surfaceOp: 'append' })
    }
    const userContent = []
    if (user.text && String(user.text).trim()) userContent.push({ type: 'text', text: String(user.text) })
    if (!userContent.length) userContent.push({ type: 'text', text: '' })
    add('user/message', {
      id: newId(), role: 'user', content: userContent, source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    // Titles are log-only state owned by the title service; when the service
    // is not mounted, the event would fail seed validation, so gate it.
    if (normalizedTitle && turn === 1 && allowTitleEvent) {
      add('session/title', {
        title: normalizedTitle,
        messageSeqs: [],
        source: { kind: 'user' },
      })
    }

    if (!reply) {
      add('step/end', { turn, step })
      add('turn/end', { turn, reason: { kind: 'error', error: { code: 'DEEPSEEK_IMPORT_NO_REPLY', message: '网页历史中没有这条问题的回复。' } } })
      continue
    }

    time = Math.max(time, Number(reply.insertedAt) || Date.now())
    const content = []
    if (reply.thinking && String(reply.thinking).trim()) {
      content.push({ type: 'reasoning', text: String(reply.thinking) })
    }
    if (reply.text && String(reply.text).trim()) {
      content.push({ type: 'text', text: String(reply.text) })
    }
    if (!content.length) content.push({ type: 'text', text: '' })

    add('assistant/message', {
      turn, step,
      message: {
        id: newId(), role: 'assistant', content,
        source: { kind: 'model', ...IMPORTED_SOURCE },
      },
      stream: [],
    }, { surfaceOp: 'append' })
    add('step/end', { turn, step })
    add('turn/end', { turn, reason: { kind: 'completed' } })
  }

  if (!events.length) return { events: [], title: normalizedTitle, createdAt: time }
  return { events, title: normalizedTitle, createdAt: events[0].time }
}

/**
 * Persist one transformed conversation as a native DSH Session.
 * @param ctx Cordis context.
 * @param events seed events from buildSeedEvents.
 * @param options {createdAt, cwd, signal}
 */
export async function persistSession(ctx, events, { createdAt = Date.now(), cwd, signal } = {}) {
  if (!events.length) throw new Error('空对话，无法导入')

  const persistence = ctx.get?.('sessionPersistence')
  if (!persistence?.create) {
    throw new Error('当前环境没有 sessionPersistence（会话持久化后端未挂载）')
  }

  const id = newId()
  const header = {
    version: FORMAT_VERSION,
    id,
    createdAt: Math.max(0, Number(createdAt) || Date.now()),
    ...(cwd ? { cwd: String(cwd) } : {}),
    isSeeded: false,
  }

  // Persist directly; the storage seam validates every record against the
  // build's format vocabulary on append, so a malformed event fails loudly.
  const handle = await persistence.create(header, { signal })
  try {
    await handle.append(events)
    if (typeof handle.flush === 'function') await handle.flush()
  } finally {
    if (typeof handle.close === 'function') await handle.close()
  }

  // Best-effort workspace attach: the workspace whose directory equals cwd.
  try {
    const registry = ctx.get?.('workspaceRegistry')
    if (registry?.list && cwd) {
      const all = registry.list()
      const project = (all || []).find((w) => w?.path === cwd) || (all || [])[0]
      if (project?.attachSession) await project.attachSession(id)
    }
  } catch {}

  return id
}
