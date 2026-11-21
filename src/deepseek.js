/**
 * DeepSeek web API client (read-only history).
 *
 * Chat history lives only in the chat.deepseek.com web session. The official
 * api.deepseek.com API is stateless and has no conversation history, so this
 * client talks to the web endpoints with the browser session's Bearer token.
 *
 * Token flow (matching the browser): localStorage.userToken is a JSON envelope
 *   {"value":"<refresh token>","__version":"1"}
 * GET /api/v0/users/current with Authorization: Bearer <refresh token>
 * returns the user info including a short-lived access token; that access
 * token is used as the Bearer token for the other endpoints.
 */

const BASE = 'https://chat.deepseek.com'

function parseUserToken(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('令牌为空')
  let value = raw.trim()
  // Accept the whole localStorage envelope or just the inner value.
  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value)
      value = parsed && typeof parsed.value === 'string' ? parsed.value : ''
    } catch {
      throw new Error('userToken 不是有效 JSON')
    }
  }
  if (!value) throw new Error('userToken 里没有 value')
  return value
}

async function http(path, { token, method = 'GET', body, timeoutMs = 30000, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const headers = {
      'accept': 'application/json',
      'x-client-platform': 'web',
      'x-client-version': '1.0.0',
      'x-client-locale': 'zh_CN',
    }
    if (token) headers.authorization = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let json
    try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text.slice(0, 500) } }
    if (!res.ok) {
      throw new Error(`DeepSeek ${path} HTTP ${res.status}: ${json?.msg || json?.message || text.slice(0, 200)}`)
    }
    if (json && typeof json.code === 'number' && json.code !== 0 && json.code !== 200) {
      throw new Error(`DeepSeek ${path} code ${json.code}: ${json.msg || json.message || ''}`)
    }
    return json
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

/** Exchange the pasted userToken for the current user + short-lived access token. */
export async function verifyToken(rawToken, signal) {
  const refresh = parseUserToken(rawToken)
  const data = await http('/api/v0/users/current', { token: refresh, signal })
  // Different web builds surface the access token under different keys.
  const access = data?.data?.access_token || data?.data?.token || data?.access_token || data?.token || refresh
  const user = data?.data?.user || data?.data || data?.user || {}
  const userId = user?.id || data?.data?.id || ''
  if (!userId && !access) throw new Error('无法从 userToken 解析出登录信息')
  return {
    refreshToken: refresh,
    accessToken: typeof access === 'string' ? access : refresh,
    userId: String(userId),
    email: String(user?.email || ''),
  }
}

/** List sessions with automatic pagination. */
export async function listAllSessions(accessToken, { max = 100000, signal } = {}) {
  const out = []
  let cursor = undefined
  let guard = 0
  while (out.length < max && guard++ < 10000) {
    const query = new URLSearchParams()
    query.set('count', '100')
    if (cursor && cursor.updated_at !== undefined) query.set('updated_at', String(cursor.updated_at))
    if (cursor?.pinned !== undefined) query.set('pinned', String(cursor.pinned))
    const data = await http(`/api/v0/chat/session/list?${query}`, { token: accessToken, signal })
    const d = data?.data || data || {}
    const sessions = Array.isArray(d.chat_sessions) ? d.chat_sessions : []
    out.push(...sessions)
    if (!d.has_more || sessions.length === 0) break
    const last = sessions[sessions.length - 1]
    cursor = { updated_at: last?.updated_at, pinned: last?.pinned }
    if (cursor.updated_at === undefined) break
  }
  return out.slice(0, max)
}

/** Fetch the full message history of one session. */
export async function getHistory(accessToken, sessionId, signal) {
  const data = await http('/api/v0/chat/session/get_history_messages', {
    token: accessToken,
    method: 'POST',
    body: { chat_session_id: sessionId },
    signal,
  })
  const d = data?.data || data || {}
  return {
    session: d.chat_session || {},
    messages: Array.isArray(d.chat_messages) ? d.chat_messages : [],
  }
}

/** Normalize the raw web message fragments into {role, text, thinking, status}. */
export function normalizeMessages(messages) {
  const normalized = []
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue
    const role = m.role === 'USER' ? 'user' : m.role === 'ASSISTANT' ? 'assistant' : null
    if (!role) continue
    const fragments = Array.isArray(m.fragments) ? m.fragments : []
    let text = ''
    let thinking = ''
    for (const f of fragments) {
      if (!f || typeof f !== 'object') continue
      const content = typeof f.content === 'string' ? f.content : ''
      if (!content) continue
      if (f.type === 'RESPONSE' || f.type === 'REQUEST') {
        text += (text ? '\n' : '') + content
      } else if (f.type === 'THINK' || f.type === 'THINKING') {
        thinking += (thinking ? '\n' : '') + content
      }
    }
    normalized.push({
      id: m.message_id,
      parentId: m.parent_id ?? null,
      role,
      text,
      thinking,
      status: String(m.status || ''),
      insertedAt: Number(m.inserted_at || 0),
    })
  }
  return normalized
}

export { parseUserToken }
