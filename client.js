/**
 * Browser panel for dsh-deepseek-history.
 * Injected as a classic script. Renders a floating button + panel that talks
 * to the Host over the plugin's same-origin HTTP routes.
 */
(function () {
  'use strict'
  if (window.__DSH_DSHIST_PANEL__) return
  window.__DSH_DSHIST_PANEL__ = true

  var ROUTE = '/dsh-deepseek-history'
  var open = false
  var busy = false

  function css() {
    if (document.getElementById('dsh-hist-css')) return
    var s = document.createElement('style')
    s.id = 'dsh-hist-css'
    s.textContent = [
      '#dsh-hist-btn{position:fixed;right:18px;bottom:18px;z-index:2147483000;width:46px;height:46px;border-radius:50%;',
      'background:linear-gradient(135deg,#0f6fff,#7b3ff2);color:#fff;border:none;cursor:pointer;font-size:20px;',
      'box-shadow:0 6px 20px rgba(0,0,0,.3);display:flex;align-items:center;justify-content:center;user-select:none}',
      '#dsh-hist-panel{position:fixed;right:18px;bottom:74px;z-index:2147483000;width:380px;max-height:70vh;overflow:auto;',
      'background:var(--dsw-alias-bg-primary,#1e1e28);color:var(--dsw-alias-fg-primary,#e8e8f0);',
      'border:1px solid var(--dsw-alias-border-color,#3a3a4a);border-radius:14px;',
      'box-shadow:0 16px 48px rgba(0,0,0,.45);font-family:inherit;font-size:13px;padding:16px;display:none}',
      '#dsh-hist-panel h3{margin:0 0 8px;font-size:16px}',
      '#dsh-hist-panel .row{display:flex;gap:8px;margin:8px 0;align-items:center;flex-wrap:wrap}',
      '#dsh-hist-panel input[type=password],#dsh-hist-panel input[type=number]{flex:1;min-width:180px;padding:8px 10px;border-radius:8px;',
      'border:1px solid var(--dsw-alias-border-color,#3a3a4a);background:var(--dsw-alias-bg-secondary,#262632);color:inherit;font-family:inherit}',
      '#dsh-hist-panel button{padding:7px 12px;border-radius:8px;border:none;cursor:pointer;background:#0f6fff;color:#fff;font-size:12px}',
      '#dsh-hist-panel button.primary{background:#16a34a}#dsh-hist-panel button:disabled{opacity:.5;cursor:not-allowed}',
      '#dsh-hist-panel button.ghost{background:transparent;border:1px solid var(--dsw-alias-border-color,#3a3a4a);color:inherit}',
      '#dsh-hist-panel .msg{margin:8px 0;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-secondary,#262632);white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto}',
      '#dsh-hist-panel .hint{opacity:.7;font-size:12px;line-height:1.5}',
      '#dsh-hist-panel a{color:#59a5ff}',
    ].join('')
    document.head.appendChild(s)
  }

  function el(id) { return document.getElementById(id) }

  function post(path, body) {
    return fetch(ROUTE + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json() })
  }

  function get(path) {
    return fetch(ROUTE + path).then(function (r) { return r.json() })
  }

  function out(text) {
    var box = el('dsh-hist-msg')
    if (box) box.textContent = String(text || '')
  }

  function render() {
    if (el('dsh-hist-panel')) return
    css()
    var panel = document.createElement('div')
    panel.id = 'dsh-hist-panel'
    panel.innerHTML = [
      '<h3>DeepSeek 历史助手</h3>',
      '<div class="hint">把 chat.deepseek.com 的对话历史整理成文件夹并导入 Harness。</div>',
      '<div class="row" id="dsh-hist-status">状态：加载中…</div>',
      '<hr style="border:none;border-top:1px solid var(--dsw-alias-border-color,#3a3a4a);margin:10px 0">',
      '<div class="hint"><b>1. 连接账号</b>：在浏览器登录 chat.deepseek.com → 打开 DevTools(F12) → Console 执行<br>',
      '<code>JSON.parse(localStorage.userToken).value</code><br>把结果复制到下面：</div>',
      '<div class="row"><input type="password" id="dsh-hist-token" placeholder="粘贴 userToken"></div>',
      '<div class="row"><button id="dsh-hist-login" class="primary">连接</button>',
      '<button id="dsh-hist-open" class="ghost">打开登录页</button>',
      '<button id="dsh-hist-logout" class="ghost">退出</button></div>',
      '<hr style="border:none;border-top:1px solid var(--dsw-alias-border-color,#3a3a4a);margin:10px 0">',
      '<div class="hint"><b>2. 同步历史</b>（导出 Markdown + 导入原生 Session，增量去重）</div>',
      '<div class="row"><label><input type="checkbox" id="dsh-hist-import" checked> 导入为 Session</label>',
      '<label><input type="checkbox" id="dsh-hist-export" checked> 导出 Markdown</label></div>',
      '<div class="row"><button id="dsh-hist-sync" class="primary">开始同步</button>',
      '<button id="dsh-hist-cancel" class="ghost">取消</button></div>',
      '<div class="msg" id="dsh-hist-msg"></div>',
    ].join('')
    document.body.appendChild(panel)

    el('dsh-hist-open').onclick = function () {
      window.open('https://chat.deepseek.com/', '_blank', 'noopener')
    }
    el('dsh-hist-login').onclick = function () {
      var token = (el('dsh-hist-token').value || '').trim()
      if (!token) { out('请先粘贴 userToken'); return }
      busy = true; out('正在验证令牌…')
      post('/api/login', { token: token }).then(function (r) {
        out(r.ok ? '连接成功：' + (r.account?.email || r.account?.userId || '') : ('连接失败：' + (r.error || '')))
        if (r.ok) { el('dsh-hist-token').value = ''; refreshStatus() }
      }).catch(function (e) { out('请求失败：' + (e?.message || e)) }).finally(function () { busy = false })
    }
    el('dsh-hist-logout').onclick = function () {
      post('/api/logout', {}).then(function () { out('已退出'); refreshStatus() })
    }
    el('dsh-hist-sync').onclick = function () {
      if (busy) { out('有任务正在进行'); return }
      busy = true
      el('dsh-hist-sync').disabled = true
      out('正在同步，请稍候…')
      post('/api/sync', {
        importSessions: !!el('dsh-hist-import').checked,
        exportMarkdown: !!el('dsh-hist-export').checked,
      }).then(function (r) {
        if (!r.ok) { out('同步失败：' + (r.error || '')); return }
        var v = r.result || {}
        out('完成！共 ' + v.total + ' 个会话，新建 Session ' + v.created + '，跳过 ' + v.skipped + '。\n文件夹：' + (v.folder || '—') + (v.errors?.length ? '\n失败：' + v.errors.length + ' 条' : ''))
        refreshStatus()
      }).catch(function (e) { out('请求失败：' + (e?.message || e)) }).finally(function () {
        busy = false
        el('dsh-hist-sync').disabled = false
      })
    }
    el('dsh-hist-cancel').onclick = function () {
      post('/api/cancel', {}).then(function () { out('已请求取消') })
    }
    refreshStatus()
  }

  function refreshStatus() {
    get('/api/status').then(function (r) {
      var s = el('dsh-hist-status')
      if (!s || !r?.ok) return
      s.textContent = '状态：' + (r.connected ? '已连接' : '未连接') +
        ' · 已导入 ' + (r.importedCount || 0) + ' 个' +
        (r.lastSyncAt ? ' · 上次同步 ' + new Date(r.lastSyncAt).toLocaleString('zh-CN') : '')
    }).catch(function () {})
  }

  function init() {
    if (el('dsh-hist-btn')) return
    css()
    var btn = document.createElement('button')
    btn.id = 'dsh-hist-btn'
    btn.title = 'DeepSeek 历史助手'
    btn.textContent = '🕘'
    btn.onclick = function () {
      open = !open
      var panel = el('dsh-hist-panel')
      if (open) { render(); var p = el('dsh-hist-panel'); if (p) p.style.display = 'block' }
      else { if (panel) panel.style.display = 'none' }
    }
    document.body.appendChild(btn)
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
