/**
 * dsh-deepseek-history — DeepSeek 网页会话归档插件（Host 半）
 *
 * 能力：
 *  - 面板里粘贴 chat.deepseek.com 的 userToken，校验后存入 DSH 凭据库
 *  - 拉取网页会话列表 + 历史消息
 *  - 导出成按日期分文件夹的 Markdown
 *  - 导入为原生 DSH Session（自研事件日志，不依赖其它插件）
 *  - 提供 agent 工具，可在对话里直接操作
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyToken, listAllSessions } from './src/deepseek.js'
import { getToken, setToken, clearToken, loadState, saveState, dataDir } from './src/store.js'
import { syncHistory } from './src/sync.js'

const ROUTE = '/dsh-deepseek-history'
const MARKER = 'dsh-deepseek-history/client.js'
const CLIENT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'client.js')
const LOADER_SCRIPT =
  '(function(){try{' +
  'if(window.__DSH_DSHIST_LOADER__)return;window.__DSH_DSHIST_LOADER__=true;' +
  'var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="/dsh-deepseek-history/client.js";' +
  's.async=true;s.onerror=function(){};d.appendChild(s)' +
  '}catch(e){}})();'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
let log = () => {}
let activeAbort = null

function makeLogger() {
  const file = path.join(dataDir(), 'plugin.log')
  return (message) => {
    const line = `${new Date().toISOString()} ${String(message).replace(/\r?\n/g, ' ')}\n`
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, line) } catch {}
    if (process.env.DSH_DEEPSEEK_HISTORY_DEBUG === '1') console.log('[deepseek-history]', message)
  }
}

function isTrusted(req) {
  try {
    const headers = req?.headers ?? {}
    if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') return false
    const origin = headers.origin
    if (typeof origin !== 'string' || !origin || origin === 'null') return true
    if (origin === 'dsh-app://app') return true
    let hostUrl, originUrl
    try { hostUrl = new URL(`http://${String(headers.host ?? '')}`) } catch { return false }
    try { originUrl = new URL(origin) } catch { return false }
    return originUrl.host.toLowerCase() === hostUrl.host.toLowerCase()
  } catch { return false }
}

function readBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) { reject(new Error('请求体过大')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

function parseBody(raw) {
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}

function createRouteHandler(ctx) {
  return async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const p = url.pathname
    try {
      if (!isTrusted(req)) { sendJson(res, 403, { ok: false, error: '不受信任的请求来源' }); return }

      // Serve the browser panel script.
      if (p === `${ROUTE}/client.js`) {
        let code
        try { code = fs.readFileSync(CLIENT_FILE) } catch { code = Buffer.from('console.error("dsh-deepseek-history: client.js missing")') }
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(code)
        return
      }

      if (req.method === 'GET' && p === `${ROUTE}/api/status`) {
        const token = await getToken(ctx)
        const state = loadState()
        sendJson(res, 200, {
          ok: true,
          connected: !!token,
          account: state.account || null,
          lastSyncAt: state.lastSyncAt || 0,
          importedCount: Object.keys(state.imported || {}).length,
          folder: path.join(dataDir(), 'export'),
          running: !!activeAbort,
        })
        return
      }

      if (req.method === 'POST' && p === `${ROUTE}/api/login`) {
        const body = parseBody(await readBody(req))
        const raw = String(body.token || '').trim()
        if (!raw) { sendJson(res, 400, { ok: false, error: '请粘贴 userToken' }); return }
        try {
          const auth = await verifyToken(raw)
          await setToken(ctx, raw)
          const state = loadState()
          state.account = { userId: auth.userId, email: auth.email }
          // Token changed -> force full re-sync next time.
          state.imported = {}
          state.lastSyncAt = 0
          saveState(state)
          log(`login ok uid=${auth.userId}`)
          sendJson(res, 200, { ok: true, account: { userId: auth.userId, email: auth.email } })
        } catch (err) {
          log(`login failed: ${err?.message || err}`)
          sendJson(res, 400, { ok: false, error: String(err?.message || err) })
        }
        return
      }

      if (req.method === 'POST' && p === `${ROUTE}/api/logout`) {
        await clearToken(ctx)
        const state = loadState()
        state.account = null
        saveState(state)
        sendJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && p === `${ROUTE}/api/sessions`) {
        const token = await getToken(ctx)
        if (!token) { sendJson(res, 401, { ok: false, error: '尚未登录' }); return }
        try {
          const auth = await verifyToken(token)
          const sessions = await listAllSessions(auth.accessToken, { max: 100000 })
          const state = loadState()
          const list = sessions.map((s) => ({
            id: s.id,
            title: s.title || '',
            updatedAt: Number(s.updated_at || 0),
            insertedAt: Number(s.inserted_at || 0),
            imported: !!state.imported?.[String(s.id)] && !state.imported[String(s.id)].error,
          }))
          sendJson(res, 200, { ok: true, total: list.length, sessions: list })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String(err?.message || err) })
        }
        return
      }

      if (req.method === 'POST' && p === `${ROUTE}/api/sync`) {
        if (activeAbort) { sendJson(res, 409, { ok: false, error: '已有同步任务在运行' }); return }
        const body = parseBody(await readBody(req))
        const controller = new AbortController()
        activeAbort = controller
        try {
          const result = await syncHistory(ctx, {
            tokenOverride: body.token || '',
            maxSessions: Number(body.maxSessions) || 100000,
            importSessions: body.importSessions !== false,
            exportMarkdown: body.exportMarkdown !== false,
            signal: controller.signal,
          })
          const state = loadState()
          if (result.account) state.account = result.account
          saveState(state)
          sendJson(res, 200, { ok: true, result })
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String(err?.message || err) })
        } finally {
          activeAbort = null
        }
        return
      }

      if (req.method === 'POST' && p === `${ROUTE}/api/cancel`) {
        if (activeAbort) { activeAbort.abort(); activeAbort = null }
        sendJson(res, 200, { ok: true })
        return
      }

      if (p === `${ROUTE}/` || p === ROUTE) {
        sendJson(res, 200, { ok: true, name: 'dsh-deepseek-history', version: '1.0.0' })
        return
      }
      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (err) {
      log(`route error ${p}: ${err?.stack || err}`)
      try { sendJson(res, 500, { ok: false, error: String(err?.message || err) }) } catch {}
    }
  }
}

function promptText() {
  return [
    '【DeepSeek 历史助手】',
    '- 用户要把 DeepSeek 网页版（chat.deepseek.com）的对话历史整理进 Harness、导入为会话、导出成文件夹、或连接网页账号时，用 deepseek_history_* 工具。',
    '- 网页历史只能通过浏览器会话令牌读取，官方 API 不存历史；用户需在面板里粘贴 chat.deepseek.com 的 userToken 登录一次。',
    '- 同步默认增量去重：已导入且未变更的会话不会重复导入。',
  ].join('\n')
}

async function loadDefineTool(ctx) {
  const candidates = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-tool', '@deepseek-ai/dsh-agent']
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      if (typeof mod?.defineTool === 'function') return mod.defineTool
    } catch {}
  }
  try {
    const svc = ctx?.get?.('tools')
    if (typeof svc?.defineTool === 'function') return svc.defineTool
  } catch {}
  return (options) => {
    const properties = {}
    const required = []
    for (const [key, spec] of Object.entries(options.parameters || {})) {
      if (!spec || typeof spec !== 'object') continue
      const prop = { type: spec.type || 'string' }
      if (spec.description) prop.description = spec.description
      if (spec.enum) prop.enum = spec.enum
      if (spec.items && typeof spec.items === 'object') prop.items = { type: spec.items.type || 'string' }
      properties[key] = prop
      if (spec.required) required.push(key)
    }
    return {
      name: options.name,
      description: options.description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: options.output,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
      execute: options.execute,
    }
  }
}

export function apply(ctx, config) {
  log = makeLogger()
  if (config?.enabled === false) { log('disabled'); return }
  log('apply start')

  const handler = createRouteHandler(ctx)

  // Inject the browser panel script into every served page.
  ctx.effect(() => ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      if (table.some((row) => row && typeof row.text === 'string' && row.text.includes(MARKER))) return
      table.push({ kind: 'script', placement: 'body', text: LOADER_SCRIPT })
    } catch (err) { log(`index-inject: ${err?.message || err}`) }
  }))

  // Register HTTP routes when webServer is available.
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const dispose = webCtx.webServer.register({ kind: 'prefix', path: ROUTE, handler })
      ctx.effect(() => dispose)
      log('routes registered')
    } catch (err) { log(`route register failed: ${err?.message || err}`) }
  })

  // System prompt guidance.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    try {
      ctx.effect(() => promptCtx.systemPrompt.section({
        name: 'deepseek-history:brief',
        order: 10150,
        text: () => promptText(),
      }))
    } catch (err) { log(`systemPrompt: ${err?.message || err}`) }
  })

  // Agent tools.
  ctx.inject(['tools'], async (toolCtx) => {
    const defineTool = await loadDefineTool(toolCtx)
    const textOutput = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: String(v) }] }
    const reg = (opts) => { try { toolCtx.effect(() => toolCtx.tools.register(defineTool(opts))) } catch (e) { log(`register ${opts.name}: ${e?.message || e}`) } }

    reg({
      name: 'deepseek_history_status',
      description: '查看 DeepSeek 网页历史助手的连接状态、已导入会话数和归档文件夹位置。',
      parameters: {},
      output: textOutput,
      async execute() {
        const token = await getToken(ctx)
        const state = loadState()
        return JSON.stringify({
          connected: !!token,
          account: state.account || null,
          lastSyncAt: state.lastSyncAt || 0,
          importedCount: Object.keys(state.imported || {}).length,
          folder: path.join(dataDir(), 'export'),
        }, null, 2)
      },
    })

    reg({
      name: 'deepseek_history_list',
      description: '列出 DeepSeek 网页账号下的所有会话（标题、ID、更新时间、是否已导入）。需先连接账号。',
      parameters: {},
      output: textOutput,
      async execute() {
        const token = await getToken(ctx)
        if (!token) return '尚未连接：请打开插件面板粘贴 chat.deepseek.com 的 userToken。'
        const auth = await verifyToken(token)
        const sessions = await listAllSessions(auth.accessToken, { max: 100000 })
        const state = loadState()
        const lines = sessions.map((s) => {
          const done = state.imported?.[String(s.id)] && !state.imported[String(s.id)].error ? '✓' : ' '
          return `- [${done}] ${s.title || '(无标题)'} · ${s.id} · ${new Date(Number(s.updated_at || 0)).toLocaleString('zh-CN')}`
        })
        return `共 ${sessions.length} 个会话：\n${lines.slice(0, 500).join('\n')}${lines.length > 500 ? `\n…还有 ${lines.length - 500} 条` : ''}`
      },
    })

    reg({
      name: 'deepseek_history_sync',
      description: '同步 DeepSeek 网页会话历史：导出 Markdown 文件夹并导入为原生 DSH Session（增量去重）。用户说“整理 DeepSeek 历史 / 导入对话 / 同步会话”时使用。',
      parameters: {
        maxSessions: { type: 'integer', description: '最多同步多少个会话，默认全部' },
        importSessions: { type: 'boolean', description: '是否导入为原生 DSH Session，默认 true' },
        exportMarkdown: { type: 'boolean', description: '是否导出 Markdown 文件夹，默认 true' },
      },
      output: textOutput,
      async execute(args) {
        const result = await syncHistory(ctx, {
          maxSessions: Number(args.maxSessions) || 100000,
          importSessions: args.importSessions !== false,
          exportMarkdown: args.exportMarkdown !== false,
        })
        return [
          `同步完成：共 ${result.total} 个会话，新建 Session ${result.created}，跳过 ${result.skipped}。`,
          result.folder ? `Markdown 文件夹：${result.folder}` : '',
          result.errors?.length ? `失败 ${result.errors.length} 条：\n${result.errors.slice(0, 10).map(e => `- ${e.title || e.id}: ${e.error}`).join('\n')}` : '',
        ].filter(Boolean).join('\n')
      },
    })

    reg({
      name: 'deepseek_history_open_panel',
      description: '提示如何打开 DeepSeek 历史助手的浮动面板（刷新页面后点右下角的「🕘」按钮）。',
      parameters: {},
      output: textOutput,
      async execute() {
        return '请刷新 DSH 页面，然后点右下角的「🕘」浮动按钮打开面板。'
      },
    })
  })

  log('apply done')
}
