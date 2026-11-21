/** Orchestrate: token -> list sessions -> history -> markdown folder + native session import, with incremental dedup. */

import { verifyToken, listAllSessions, getHistory, normalizeMessages } from './deepseek.js'
import { loadState, saveState, exportConversation, getToken, dataDir } from './store.js'
import { buildSeedEvents, persistSession } from './importer.js'

/** Whether the session-title service (and its `session/title` projection) is mounted. */
function titleServiceAvailable(ctx) {
  try { return !!(ctx.get?.('sessionTitle') || ctx.sessionTitle) } catch { return false }
}

/** The working directory imported Sessions attach to: the first workspace, else the sync folder. */
function resolveCwd(ctx) {
  try {
    const registry = ctx.get?.('workspaceRegistry')
    const first = registry?.list?.()?.[0]
    if (first?.path) return String(first.path)
  } catch {}
  return dataDir()
}

export async function syncHistory(ctx, {
  token: tokenOverride = '',
  maxSessions = 100000,
  importSessions = true,
  exportMarkdown = true,
  signal,
  onProgress,
} = {}) {
  const report = (p) => { if (typeof onProgress === 'function') onProgress(p) }

  const token = tokenOverride || await getToken(ctx)
  if (!token) throw new Error('还没有连接 DeepSeek 网页账号。请先在插件面板里粘贴 userToken 登录。')

  report({ phase: 'auth', done: 0, total: 0, message: '正在验证账号令牌…' })
  const auth = await verifyToken(token, signal)
  const access = auth.accessToken

  report({ phase: 'list', done: 0, total: 0, message: '正在拉取会话列表…' })
  const sessions = await listAllSessions(access, { max: maxSessions, signal })
  const state = loadState()
  const cwd = resolveCwd(ctx)
  const allowTitle = titleServiceAvailable(ctx)
  const total = sessions.length
  let done = 0
  let created = 0
  let updated = 0
  let skipped = 0
  const files = []
  const errors = []

  for (const session of sessions) {
    if (signal?.aborted) break
    done++
    const id = String(session?.id || '')
    if (!id) { skipped++; continue }
    const updatedAt = Number(session?.updated_at || 0)
    const prev = state.imported[id]
    // Incremental: skip when unchanged and already processed.
    if (prev && prev.updatedAt === updatedAt && !prev.error) {
      skipped++
      report({ phase: 'sync', done, total, message: `跳过未变更：${session.title || id}` })
      continue
    }
    try {
      const history = await getHistory(access, id, signal)
      const rawMessages = history.messages || []
      const messages = normalizeMessages(rawMessages)
      if (!messages.length) { skipped++; state.imported[id] = { updatedAt, skipped: true, title: session.title || '' }; continue }

      let file = ''
      if (exportMarkdown) {
        file = exportConversation(session, messages, { title: session.title || '' })
        files.push(file)
      }

      let sessionId = ''
      if (importSessions) {
        const title = session.title || String(session.id || '').slice(-8)
        const { events, createdAt } = buildSeedEvents(messages, {
          title,
          createdAt: Number(session.inserted_at || updatedAt || Date.now()),
          allowTitleEvent: allowTitle,
        })
        sessionId = await persistSession(ctx, events, { createdAt, cwd, signal })
        created++
      } else {
        updated++
      }

      state.imported[id] = {
        updatedAt,
        sessionId,
        title: session.title || '',
        messageCount: messages.length,
        file,
        importedAt: Date.now(),
      }
      report({ phase: 'sync', done, total, message: `已处理：${session.title || id}`, imported: created })
    } catch (err) {
      errors.push({ id, title: session.title || '', error: String(err?.message || err) })
      state.imported[id] = { updatedAt, error: String(err?.message || err), title: session.title || '' }
    }
  }

  state.lastSyncAt = Date.now()
  saveState(state)

  return {
    ok: true,
    account: { userId: auth.userId, email: auth.email },
    cwd,
    total,
    processed: done,
    created,
    updated,
    skipped,
    errors: errors.slice(0, 50),
    files: files.slice(0, 200),
    folder: files.length ? files[0].replace(/[\\/][^\\/]+$/, '') : '',
    lastSyncAt: state.lastSyncAt,
  }
}
