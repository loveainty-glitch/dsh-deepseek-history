/**
 * Local persistence for the plugin: credential handling, sync state, and the
 * plain Markdown folder export. State files stay inside DSH_HOME, never in the
 * plugin source directory.
 *
 * Credentials go through the ctx.credentials service with plain-string refs
 * (brands are compile-time only; the runtime accepts plain strings). We never
 * import @deepseek-ai/* packages: this plugin installs as a linked directory,
 * so package imports would resolve from the workspace, not the profile.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CRED_REF = 'DEEPSEEK_WEB_TOKEN'

export function resolveHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

export function dataDir() {
  return path.join(resolveHome(), 'deepseek-history')
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

function credentialsOf(ctx) {
  try { return ctx?.get?.('credentials') || ctx?.credentials || null } catch { return null }
}

function stripEnvelope(value) {
  const text = String(value || '').trim()
  if (text.startsWith('{')) {
    try { return String(JSON.parse(text).value || '') } catch { return '' }
  }
  return text
}

/** Get the stored web token (returns '' when absent). Never logs the value. */
export async function getToken(ctx) {
  const svc = credentialsOf(ctx)
  if (!svc?.resolve) return ''
  try {
    const hit = await svc.resolve(CRED_REF)
    return stripEnvelope(hit?.value)
  } catch {}
  return ''
}

/** Save the validated web token into the DSH credential store. */
export async function setToken(ctx, token) {
  const svc = credentialsOf(ctx)
  if (!svc?.set) throw new Error('当前环境没有 DSH 凭据存储（ctx.credentials）')
  await svc.set(CRED_REF, String(token || '').trim())
  return true
}

export async function clearToken(ctx) {
  const svc = credentialsOf(ctx)
  if (!svc?.unset) return false
  try {
    await svc.unset(CRED_REF)
    return true
  } catch { return false }
}

export function loadState() {
  return readJson(path.join(dataDir(), 'state.json'), {
    version: 1,
    imported: {},   // chat session id -> { updatedAt, sessionId, title, importedAt }
    lastSyncAt: 0,
  })
}

export function saveState(state) {
  writeJson(path.join(dataDir(), 'state.json'), state)
}

function safeName(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80)
  return cleaned || fallback
}

function dateFolder(ts) {
  const d = new Date(ts || Date.now())
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Export one normalized conversation into a dated Markdown folder.
 * Layout: <dataDir>/export/<YYYY-MM-DD>/<safe-title>-<shortid>.md
 */
export function exportConversation(session, messages, meta = {}) {
  const root = path.join(dataDir(), 'export')
  const updatedAt = Number(session?.updated_at || Date.now())
  const dir = path.join(root, dateFolder(updatedAt))
  ensureDir(dir)
  const title = safeName(session?.title || meta.title || '未命名对话', '未命名对话')
  const shortId = String(session?.id || 'unknown').slice(-8).replace(/[^a-zA-Z0-9]/g, '') || 'id'
  let file = path.join(dir, `${title}-${shortId}.md`)
  let n = 2
  while (fs.existsSync(file)) file = path.join(dir, `${title}-${shortId}-${n++}.md`)

  const lines = [
    `# ${session?.title || meta.title || '未命名对话'}`,
    '',
    `- 会话 ID: ${session?.id || ''}`,
    `- 创建: ${new Date(Number(session?.inserted_at || 0) || Date.now()).toLocaleString('zh-CN')}`,
    `- 更新: ${new Date(updatedAt || Date.now()).toLocaleString('zh-CN')}`,
    `- 消息数: ${messages.length}`,
    `- 来源: chat.deepseek.com`,
    '',
    '---',
    '',
  ]
  for (const m of messages) {
    const who = m.role === 'user' ? '## 我' : '## DeepSeek'
    lines.push(who, '', m.text || (m.role === 'assistant' ? '（无文本）' : ''), '')
    if (m.thinking) {
      lines.push('<details><summary>思考过程</summary>', '', m.thinking, '', '</details>', '')
    }
  }
  fs.writeFileSync(file, lines.join('\n'), 'utf8')
  return file
}
