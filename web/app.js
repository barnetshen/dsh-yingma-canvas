// 小影马画布壳页：顶栏（项目/画布/登录）、内层 iframe、登录向导、设置。
// 所有请求都发给同源的 /yingma-canvas/api/*，由插件 Host 半边执行 yingma CLI。
const BASE = '/yingma-canvas'
const $ = (id) => document.getElementById(id)

const state = {
  app: { projectId: null, projectTitle: '', origin: 'https://yingma.tv', mutations: {} },
  status: null,
  projects: [],
  canvases: [],
  activeCanvasId: null,
  // 每个项目各记一份「已同步到的改动时间」，切项目不会把别的项目的改动当成本项目的更新。
  seen: {},
}

let frameReady = false
let fallbackNoticeShown = false
let staleProjectId = ''
let notified = {}

function mutationAt() {
  const id = state.app.projectId
  return (id && state.app.mutations && Number(state.app.mutations[id])) || 0
}

// 首次看到某个项目时它刚整页加载，之前的改动都算已同步。
function seenAt() {
  const id = state.app.projectId
  if (!id) return 0
  if (state.seen[id] === undefined) state.seen[id] = mutationAt()
  return state.seen[id]
}

function markSeen() {
  const id = state.app.projectId
  if (!id) return
  state.seen[id] = Math.max(seenAt(), mutationAt())
  notified[id] = Math.max(notified[id] || 0, state.seen[id])
}
let versionsData = null
let projectFilter = ''
let activeProjectIndex = -1
let toastTimer = 0

const ICONS = {
  canvas:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="3.2" width="8.2" height="8.2" rx="2"/><path d="M11.4 7.3h3.6V12.6"/><rect x="12.6" y="12.6" width="8.2" height="8.2" rx="2"/></g><path d="M19.6 2.6c.22 1.96 1.02 2.76 3 2.8-1.98.04-2.78.84-3 2.8-.22-1.96-1.02-2.76-3-2.8 1.98-.04 2.78-.84 3-2.8Z" fill="#61dafb" stroke="none"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2.5"/><path d="M8.5 10V7.5a3.5 3.5 0 0 1 7 0V10"/></svg>',
  alert:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.2v.3"/></svg>',
  folder:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h3l2 2.5h6A2.5 2.5 0 0 1 20 10v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>',
  check:
    '<svg class="menu-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-6.5"/></svg>',
}

// ---------- 基础 ----------

const esc = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch])

async function api(path, options = {}) {
  const response = await fetch(BASE + path, {
    ...options,
    // 插件接口要求这个头，用来挡跨站请求。
    headers: { 'content-type': 'application/json', 'x-yingma-canvas': '1', ...(options.headers || {}) },
  })
  let data = null
  try {
    data = await response.json()
  } catch {
    /* 非 JSON */
  }
  if (!data) throw new Error(`接口返回 ${response.status}`)
  return data
}

function toast(message) {
  const el = $('toast')
  el.textContent = message
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.hidden = true
  }, 3200)
}

function formatTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// ---------- 状态 ----------

function setChip(label, kind, title, onClick) {
  const chip = $('login-chip')
  chip.className = 'chip' + (kind ? ' ' + kind : '')
  chip.querySelector('.chip-text').textContent = label
  chip.title = title
  chip.onclick = onClick
}

function renderStatus() {
  const status = state.status || {}
  const cli = status.cli || {}
  const auth = status.auth || {}
  if (!cli.ok) {
    setChip('CLI 异常', 'error', cli.error || '找不到 node 或 yingma CLI', openSettings)
    return
  }
  if (status.envWarning) {
    setChip('环境不一致', 'warn', status.envWarning, openSettings)
    return
  }
  if (auth.expired) {
    setChip('Agent 登录已过期', 'warn', '登录已失效，点击在小影马网页上重新授权。', openLogin)
    return
  }
  if (!auth.authenticated) {
    setChip('Agent 未登录', 'warn', '点击在小影马网页上授权登录，Agent 和画布共用。', openLogin)
    return
  }
  setChip(
    'Agent 已登录',
    'ok',
    `Agent 和画布共用这次登录。yingma ${cli.version || ''}${
      auth.source === 'env' ? '（YINGMA_TOKEN）' : '（本机配置）'
    }；点击同步登录态和项目`,
    async () => {
      await refreshStatus(true)
      await loadProjects(true)
      toast('已同步登录态和项目')
    }
  )
}

async function refreshStatus(force, silent) {
  try {
    const result = await api('/api/status' + (force ? '?refresh=1' : ''))
    state.status = result.status
    state.app = result.state
    renderStatus()
    if (!$('settings-overlay').hidden) renderSettingStatus()
  } catch (error) {
    if (!silent) toast(`检查登录状态失败：${error.message}`)
  }
}

function sortedProjects() {
  return state.projects
    .filter((project) => project.kind === 'canvas')
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
}

function filteredProjects() {
  const query = projectFilter.trim().toLowerCase()
  const items = sortedProjects()
  if (!query) return items
  return items.filter((project) =>
    String(project.title || '未命名项目').toLowerCase().includes(query)
  )
}

// ---------- 顶栏上下文 ----------

function renderContext() {
  const projectTitle = $('project-title')
  const hasProject = Boolean(state.app.projectId)
  projectTitle.textContent = hasProject ? state.app.projectTitle || '未命名项目' : '选择项目'
  projectTitle.classList.toggle('is-placeholder', !hasProject)

  const canvas = state.canvases.find((item) => item.id === state.activeCanvasId)
  const canvasTitle = $('canvas-title')
  canvasTitle.textContent = !hasProject ? '—' : canvas ? canvas.name || '未命名画布' : '—'
  canvasTitle.classList.toggle('is-placeholder', !canvas)
  $('canvas-trigger').disabled = !hasProject || state.canvases.length === 0
}

// ---------- 下拉菜单 ----------

function closeMenus() {
  $('project-menu').hidden = true
  $('canvas-menu').hidden = true
  $('project-trigger').setAttribute('aria-expanded', 'false')
  $('canvas-trigger').setAttribute('aria-expanded', 'false')
  activeProjectIndex = -1
}

function renderProjectMenu() {
  const items = filteredProjects()
  const list = $('project-list')
  const following = !state.app.projectId
  const rows = items.length
    ? items
        .map((project, index) => {
          const selected = project.id === state.app.projectId
          return `<button class="menu-item${selected ? ' is-selected' : ''}${
            index === activeProjectIndex ? ' is-active' : ''
          }" role="option" aria-selected="${selected}" data-project="${esc(project.id)}" data-index="${index}">
            <span class="menu-item-text">
              <span class="menu-item-title">${esc(project.title || '未命名项目')}</span>
              <span class="menu-item-meta">${esc(formatTime(project.updated_at) || '画布项目')}</span>
            </span>
            ${selected ? ICONS.check : ''}
          </button>`
        })
        .join('')
    : '<div class="menu-empty">没有匹配的项目</div>'
  // 多项目/多仓库时不用反复切：让 CLI 按当前工作区的 .yingma/project.json 定项目。
  list.innerHTML = `${rows}
    <div class="menu-sep" role="separator"></div>
    <button class="menu-item${following ? ' is-selected' : ''}" role="option" aria-selected="${following}" data-follow="1">
      <span class="menu-item-text">
        <span class="menu-item-title">跟随当前目录</span>
        <span class="menu-item-meta">不指定项目，用工作区的 .yingma/project.json</span>
      </span>
      ${following ? ICONS.check : ''}
    </button>`
  $('project-count').textContent = `${items.length} / ${sortedProjects().length} 个画布项目`
  requestAnimationFrame(() => updateListFade(list))
}

function updateListFade(list) {
  if (!list) return
  const canScroll = list.scrollHeight > list.clientHeight + 1
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 2
  list.classList.toggle('has-more', canScroll && !atBottom)
}

function openProjectMenu() {
  closeMenus()
  projectFilter = ''
  $('project-search').value = ''
  renderProjectMenu()
  $('project-menu').hidden = false
  $('project-trigger').setAttribute('aria-expanded', 'true')
  requestAnimationFrame(() => $('project-search').focus())
}

function renderCanvasMenu() {
  const list = $('canvas-list')
  list.innerHTML = state.canvases.length
    ? state.canvases
        .map((canvas) => {
          const selected = canvas.id === state.activeCanvasId
          const count = canvas.node_count != null ? `${canvas.node_count} 个节点` : ''
          return `<button class="menu-item${selected ? ' is-selected' : ''}" role="option" aria-selected="${selected}" data-canvas="${esc(canvas.id)}">
            <span class="menu-item-text">
              <span class="menu-item-title">${esc(canvas.name || '未命名画布')}</span>
              <span class="menu-item-meta">${esc(count)}</span>
            </span>
            ${selected ? ICONS.check : ''}
          </button>`
        })
        .join('')
    : '<div class="menu-empty">这个项目还没有画布</div>'
  requestAnimationFrame(() => updateListFade(list))
}

function openCanvasMenu() {
  closeMenus()
  renderCanvasMenu()
  $('canvas-menu').hidden = false
  $('canvas-trigger').setAttribute('aria-expanded', 'true')
}

function toggleProjectMenu() {
  if ($('project-menu').hidden) openProjectMenu()
  else closeMenus()
}

function toggleCanvasMenu() {
  if ($('canvas-trigger').disabled) return
  if ($('canvas-menu').hidden) openCanvasMenu()
  else closeMenus()
}

// ---------- 项目 / 画布数据 ----------

async function loadProjects(force) {
  try {
    const result = await api('/api/projects' + (force ? '?refresh=1' : ''))
    state.projects = result.ok ? result.items : []
    if (!result.ok && result.error) toast(`项目列表：${result.error}`)
    renderContext()
    if (!$('project-menu').hidden) renderProjectMenu()
    if (!state.app.projectId || !$('empty').hidden) showEmpty()

    // 绑定的项目被删/换账号后，画布 iframe 只会拿到 404，再被误当成登录失效。
    // 项目列表能加载时先把它抓出来，直接让用户重选，别在坏 iframe 里打转。
    const currentId = state.app.projectId
    if (currentId && state.projects.length) {
      const exists = state.projects.some((project) => project.id === currentId)
      if (!exists && staleProjectId !== currentId) {
        staleProjectId = currentId
        toast('当前绑定的画布项目不存在或已删除，请重新选择项目。')
        openProjectMenu()
      } else if (exists) {
        staleProjectId = ''
      }
    }
  } catch (error) {
    toast(`加载项目失败：${error.message}`)
  }
}

async function loadCanvases() {
  if (!state.app.projectId) return
  try {
    const result = await api('/api/canvases?project=' + encodeURIComponent(state.app.projectId))
    if (!result.ok) {
      state.canvases = []
      state.activeCanvasId = null
    } else {
      state.canvases = result.canvases || []
      state.activeCanvasId = result.active_canvas_id || state.canvases[0]?.id || null
    }
    renderContext()
    if (!$('canvas-menu').hidden) renderCanvasMenu()
  } catch {
    state.canvases = []
    state.activeCanvasId = null
    renderContext()
  }
}

async function chooseProject(projectId) {
  // null / '' 表示「不指定项目」，交给 CLI 按当前工作目录的绑定决定。
  const next = projectId || null
  closeMenus()
  if (next === (state.app.projectId || null)) {
    if ($('canvas-frame').hidden) showFrame()
    return
  }
  const project = state.projects.find((item) => item.id === next)
  try {
    const result = await api('/api/project', {
      method: 'POST',
      body: JSON.stringify({ projectId: next || '', projectTitle: project?.title || '' }),
    })
    if (!result.ok) {
      toast(result.error)
      return
    }
    state.app = result.state
    state.canvases = []
    state.activeCanvasId = null
    renderContext()
    if (!next) {
      showEmpty()
      return
    }
    showFrame()
    await loadCanvases()
  } catch (error) {
    toast(`切换项目失败：${error.message}`)
  }
}

async function chooseCanvas(canvasId) {
  if (!canvasId || !state.app.projectId) return
  closeMenus()
  if (canvasId === state.activeCanvasId) return
  try {
    const result = await api('/api/canvas/use', {
      method: 'POST',
      body: JSON.stringify({ projectId: state.app.projectId, canvasId }),
    })
    if (!result.ok) {
      toast(result.error)
      return
    }
    state.activeCanvasId = canvasId
    renderContext()
    toast('已切换画布')
    void refreshFrame()
  } catch (error) {
    toast(`切换画布失败：${error.message}`)
  }
}

// ---------- 画布 iframe ----------

function canvasUrl() {
  const origin = String(state.app.origin || 'https://yingma.tv').replace(/\/+$/, '')
  return `${origin}/project/${state.app.projectId}/canvas`
}

// 优先走 /embed/canvas + 一次性登录码；影马那侧还没部署 embed 时，退回普通画布页。
async function frameSrc() {
  if (!state.app.projectId) return 'about:blank'
  try {
    const result = await api('/api/embed', {
      method: 'POST',
      body: JSON.stringify({ project: state.app.projectId, parent: location.origin }),
    })
    if (result.ok && typeof result.url === 'string' && result.url) {
      if (result.fallback) {
        if (!fallbackNoticeShown) {
          fallbackNoticeShown = true
          const reason = /401|登录|expired/i.test(String(result.error || ''))
            ? 'Agent 登录已过期'
            : '画布登录码不可用'
          toast(`${reason}，画布已改用网页登录。点右上角状态可重新授权。`)
          void refreshStatus(true, true)
        }
      } else {
        fallbackNoticeShown = false
      }
      return result.url
    }
  } catch {
    /* 退回普通画布页 */
  }
  return canvasUrl()
}

async function showFrame() {
  if (!state.app.projectId) {
    showEmpty()
    return
  }
  const frame = $('canvas-frame')
  $('empty').hidden = true
  frame.hidden = false
  frameReady = false
  frame.src = await frameSrc()
  const external = $('open-external')
  external.hidden = false
  external.href = canvasUrl()
  $('back-to-canvas').hidden = false
}

async function refreshFrame() {
  if (!state.app.projectId) return
  markSeen()
  $('update-chip').hidden = true
  const frame = $('canvas-frame')
  frameReady = false
  frame.src = await frameSrc()
}

// 嵌入页收到消息后拉一次增量再合回；不支持软刷新的页面不会回 canvas-refreshed，
// 右下角的「画布有更新」会留着，用户点同步再整页重载。
function softRefresh() {
  if (!frameReady) return false
  const frame = $('canvas-frame')
  if (!frame || !frame.contentWindow) return false
  try {
    frame.contentWindow.postMessage(
      { type: 'yingma:refresh-canvas' },
      new URL(state.app.origin).origin
    )
    return true
  } catch {
    return false
  }
}

// ---------- 空状态 ----------

function emptyCard(icon, title, description, actions) {
  return `<div class="empty-card">
    <span class="empty-icon">${icon}</span>
    <h2>${esc(title)}</h2>
    <p>${esc(description)}</p>
    <div class="empty-actions">${actions}</div>
  </div>`
}

function showEmpty() {
  const frame = $('canvas-frame')
  frame.hidden = true
  frame.src = 'about:blank'
  $('open-external').hidden = true
  $('back-to-canvas').hidden = true
  const empty = $('empty')
  empty.hidden = false

  const status = state.status || {}
  const cli = status.cli || {}
  const auth = status.auth || {}
  const origin = String(state.app.origin || 'https://yingma.tv').replace(/\/+$/, '')
  let html = ''

  if (!cli.ok) {
    html = emptyCard(
      ICONS.alert,
      'CLI 不可用',
      cli.error || '找不到 node 或 yingma CLI。检查设置里的运行环境。',
      '<button class="btn" data-action="settings" type="button">检查设置</button>'
    )
  } else if (!auth.authenticated) {
    html = emptyCard(
      ICONS.lock,
      '先登录 Agent',
      'Agent 通过 yingma CLI 读写画布。点登录会打开小影马网页授权，Agent 和画布共用这次登录。',
      '<button class="btn primary" data-action="login" type="button">登录 Agent</button>' +
        '<button class="btn ghost" data-action="refresh-projects" type="button">刷新项目</button>'
    )
  } else if (!sortedProjects().length) {
    html = emptyCard(
      ICONS.folder,
      '还没有画布项目',
      '账号下没有找到画布项目。可以在影马网页里新建一个画布项目，再回来刷新。',
      '<button class="btn" data-action="refresh-projects" type="button">刷新项目</button>' +
        `<a class="btn ghost" href="${esc(origin)}/projects" target="_blank" rel="noopener">去影马新建</a>`
    )
  } else {
    const cards = sortedProjects()
      .map(
        (project) => `<button class="project-card" data-project="${esc(project.id)}" type="button">
          <span class="title">${esc(project.title || '未命名项目')}</span>
          <span class="meta">${esc(formatTime(project.updated_at) || '画布项目')}</span>
        </button>`
      )
      .join('')
    html = `<div class="empty-card">
      <span class="empty-icon">${ICONS.canvas}</span>
      <h2>选择要打开的画布</h2>
      <p>画布在影马服务端，Agent 的改动和你的手动操作改的是同一份。</p>
      <div class="project-grid">${cards}</div>
      <div class="empty-actions">
        <button class="btn ghost" data-action="refresh-projects" type="button">刷新项目</button>
      </div>
    </div>`
  }

  empty.innerHTML = html
  empty.querySelectorAll('[data-action]').forEach((button) => {
    const action = button.dataset.action
    if (action === 'login') button.addEventListener('click', openLogin)
    if (action === 'settings') button.addEventListener('click', openSettings)
    if (action === 'refresh-projects') button.addEventListener('click', () => loadProjects(true))
  })
  empty.querySelectorAll('[data-project]').forEach((button) => {
    button.addEventListener('click', () => void chooseProject(button.dataset.project))
  })
}

// ---------- 轮询 ----------

async function poll() {
  if (document.hidden) return
  try {
    const result = await api('/api/state')
    if (!result.ok) return
    state.app = result.state
    const mutation = mutationAt()
    const id = state.app.projectId
    if (id && mutation > seenAt()) {
      $('update-chip').hidden = false
      if (mutation > (notified[id] || 0)) {
        notified[id] = mutation
        softRefresh()
      }
    } else {
      $('update-chip').hidden = true
    }
  } catch {
    /* 忽略一次轮询失败 */
  }
}

// ---------- 登录：网页授权 ----------

let loginTimer = null
let loginDeadline = 0
let loginRun = 0

function showLoginPart(part) {
  $('login-starting').hidden = part !== 'starting'
  $('login-waiting').hidden = part !== 'waiting'
  $('login-restart').hidden = part !== 'failed'
}

function loginError(message) {
  const element = $('login-error')
  element.textContent = message || ''
  element.hidden = !message
}

function stopLoginPolling() {
  loginRun += 1
  clearTimeout(loginTimer)
  loginTimer = null
}

function openLogin() {
  $('login-overlay').hidden = false
  void startLogin()
}

function closeLogin() {
  $('login-overlay').hidden = true
  stopLoginPolling()
  void api('/api/login/cancel', { method: 'POST', body: '{}' }).catch(() => {})
}

async function startLogin() {
  stopLoginPolling()
  const run = loginRun
  loginError('')
  showLoginPart('starting')
  try {
    const result = await api('/api/login/start', { method: 'POST', body: '{}' })
    if (run !== loginRun) return
    if (!result.ok) {
      loginError(result.error)
      showLoginPart('failed')
      return
    }
    $('login-user-code').textContent = result.userCode
    $('login-url').value = result.url
    loginDeadline = Date.now() + result.expiresIn * 1000
    showLoginPart('waiting')
    scheduleLoginPoll(run, result.interval)
  } catch (error) {
    if (run !== loginRun) return
    loginError(`发起授权失败：${error.message}`)
    showLoginPart('failed')
  }
}

function scheduleLoginPoll(run, interval) {
  const left = Math.max(0, Math.round((loginDeadline - Date.now()) / 1000))
  $('login-countdown').textContent = `等待授权… ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} 后过期`
  loginTimer = setTimeout(() => void pollLogin(run, interval), Math.max(1, interval) * 1000)
}

async function pollLogin(run, interval) {
  if (run !== loginRun) return
  let result
  try {
    result = await api('/api/login/poll', { method: 'POST', body: '{}' })
  } catch {
    result = { ok: true, status: 'pending' }
  }
  if (run !== loginRun) return
  if (!result.ok) {
    loginError(result.error)
    showLoginPart('failed')
    return
  }
  if (result.status === 'pending') {
    if (Date.now() < loginDeadline) return scheduleLoginPoll(run, interval)
    result.status = 'expired'
  }
  if (result.status === 'approved') {
    stopLoginPolling()
    $('login-overlay').hidden = true
    toast('已登录小影马')
    await refreshStatus(true)
    await loadProjects(true)
    if (state.app.projectId) {
      showFrame()
      loadCanvases()
    } else {
      showEmpty()
    }
    return
  }
  loginError(result.status === 'denied' ? '网页上拒绝了这次授权。' : '授权请求已过期。')
  showLoginPart('failed')
}

async function copyLoginUrl() {
  const input = $('login-url')
  try {
    await navigator.clipboard.writeText(input.value)
  } catch {
    input.select()
    document.execCommand('copy')
  }
  toast('已复制授权链接')
}

// ---------- 设置 ----------

function openSettings() {
  $('setting-origin').value = state.app.origin || 'https://yingma.tv'
  $('setting-agent').value = state.app.canvasAgent === 'yingma' ? 'yingma' : 'dsh'
  hideSettingError()
  resetLogoutButton()
  renderSettingStatus()
  $('settings-overlay').hidden = false
  $('setting-origin').focus()
  void loadVersions(false)
}

function versionGt(a, b) {
  const pa = String(a || '').split('.').map((part) => parseInt(part, 10) || 0)
  const pb = String(b || '').split('.').map((part) => parseInt(part, 10) || 0)
  const length = Math.max(pa.length, pb.length)
  for (let i = 0; i < length; i += 1) {
    const left = pa[i] || 0
    const right = pb[i] || 0
    if (left !== right) return left > right
  }
  return false
}

function setVersionBadge(id, text, kind) {
  const element = $(id)
  element.textContent = text || ''
  element.className = 'version-badge' + (kind ? ' ' + kind : '')
}

async function loadVersions(check) {
  const button = $('check-updates')
  if (check) {
    button.disabled = true
    button.textContent = '检查中…'
  }
  try {
    const result = await api('/api/versions' + (check ? '?check=1' : ''))
    if (!result.ok) return
    versionsData = result
    renderVersions()
  } catch (error) {
    if (check) toast(`检查更新失败：${error.message}`)
  } finally {
    button.disabled = false
    button.textContent = '检查更新'
  }
}

function renderVersions() {
  const data = versionsData
  if (!data) return
  const plugin = data.plugin || {}
  const cli = data.cli || {}
  $('version-plugin').textContent = plugin.current ? `v${plugin.current}` : '—'
  $('version-cli').textContent = cli.bundled ? `v${cli.bundled}` : '—'
  $('version-cli-installed').textContent = cli.installed ? `v${cli.installed}` : '未安装'

  if (!plugin.checked) {
    setVersionBadge('version-plugin-badge', '')
  } else if (!plugin.latest) {
    setVersionBadge('version-plugin-badge', '本地安装')
  } else if (versionGt(plugin.latest, plugin.current)) {
    setVersionBadge('version-plugin-badge', `有新版 v${plugin.latest}`, 'warn')
  } else {
    setVersionBadge('version-plugin-badge', '已是最新', 'ok')
  }

  const repoNewer = versionGt(cli.repo, cli.bundled)
  const installedNewer = versionGt(cli.installed, cli.bundled)
  if (!cli.checked) {
    setVersionBadge('version-cli-badge', '')
    setVersionBadge('version-cli-installed-badge', '')
  } else if (repoNewer) {
    setVersionBadge('version-cli-badge', `仓库有 v${cli.repo}`, 'warn')
    setVersionBadge('version-cli-installed-badge', installedNewer ? `系统有 v${cli.installed}` : '')
  } else if (installedNewer) {
    setVersionBadge('version-cli-badge', `系统有 v${cli.installed}`, 'warn')
    setVersionBadge('version-cli-installed-badge', '')
  } else {
    setVersionBadge('version-cli-badge', '已是最新', 'ok')
    setVersionBadge('version-cli-installed-badge', '')
  }

  const hints = []
  if (plugin.checked && plugin.latest && versionGt(plugin.latest, plugin.current)) {
    hints.push('插件：从插件页更新，或重新安装本地包。')
  }
  if (cli.checked && repoNewer) {
    hints.push('CLI：仓库版本比随包新，重新同步 skills/yingma-cli 后重装插件。')
  } else if (cli.checked && installedNewer) {
    hints.push('CLI：系统版本比随包新，可重装插件同步。')
  }
  $('version-hint').textContent = hints.length
    ? hints.join(' ')
    : '插件随仓库/插件页更新；CLI 随插件包更新。'
}

function resetLogoutButton() {
  const button = $('logout')
  button.dataset.confirm = ''
  button.textContent = '退出登录'
  button.disabled = false
}

async function logoutAgent() {
  const button = $('logout')
  if (button.dataset.confirm !== '1') {
    button.dataset.confirm = '1'
    button.textContent = '确认退出？'
    setTimeout(() => {
      if (button.dataset.confirm === '1') {
        button.dataset.confirm = ''
        button.textContent = '退出登录'
      }
    }, 4000)
    return
  }
  button.dataset.confirm = ''
  button.disabled = true
  button.textContent = '退出中…'
  try {
    const result = await api('/api/logout', { method: 'POST', body: '{}' })
    if (!result.ok) {
      toast(result.error || '退出失败')
      return
    }
    toast('已退出 Agent 登录')
    await refreshStatus(true)
    renderSettingStatus()
    if (!state.app.projectId) showEmpty()
  } catch (error) {
    toast(`退出失败：${error.message}`)
  } finally {
    button.textContent = '退出登录'
    button.disabled = !(state.status && state.status.auth && state.status.auth.authenticated)
  }
}

function renderSettingStatus() {
  const status = state.status || {}
  const cli = status.cli || {}
  const auth = status.auth || {}
  $('status-cli').textContent = cli.ok ? cli.version || '已就绪' : '不可用'
  $('status-cli').title = cli.error || ''
  $('status-node').textContent = cli.node || '未找到'
  $('status-node').title = cli.node || ''
  $('status-auth').textContent = auth.authenticated
    ? auth.source === 'env'
      ? '已登录（YINGMA_TOKEN）'
      : '已登录（本机配置）'
    : '未登录'
  const logout = $('logout')
  logout.disabled = !auth.authenticated
  logout.title = auth.authenticated ? '退出 Agent 用的 CLI 登录' : '当前没有 Agent 登录'
}

function showSettingError(message) {
  const element = $('setting-error')
  element.textContent = message
  element.hidden = false
}

function hideSettingError() {
  const element = $('setting-error')
  element.hidden = true
  element.textContent = ''
}

async function saveSettings() {
  const origin = $('setting-origin').value.trim()
  if (!origin) return showSettingError('请填写画布地址。')
  try {
    const result = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify({ origin, canvasAgent: $('setting-agent').value }),
    })
    if (!result.ok) {
      showSettingError(result.error)
      return
    }
    state.app = result.state
    $('settings-overlay').hidden = true
    toast('已保存')
    // 画布地址变了，环境是否一致要重新算。
    refreshStatus()
    if (state.app.projectId) showFrame()
  } catch (error) {
    showSettingError(`保存失败：${error.message}`)
  }
}

// ---------- 交给 Agent ----------

function projectLabel() {
  const project = state.projects.find((item) => item.id === state.app.projectId)
  return `「${project?.title || state.app.projectTitle || '未命名'}」（项目 ${state.app.projectId}）`
}

// 画布里点了「画布助手」或「加入对话」：nodes 是选中的节点（可能为空）
function handoffPrompt(nodes) {
  if (!nodes.length) {
    return `我在小影马画布${projectLabel()}里打开了 Agent。先用 yingma 的 canvas_overview 了解画布，然后问我要做什么，先不要修改。`
  }
  const lines = nodes.map((n) => `- ${n.label || '未命名'}（${n.kind}，${n.id}）`).join('\n')
  return `我在小影马画布${projectLabel()}里选中了这些节点：\n${lines}\n先用 yingma 的 read_nodes 读取它们，然后问我要做什么，先不要修改。`
}

function startAgent(prompt) {
  if (window.parent === window) {
    navigator.clipboard?.writeText(prompt).then(
      () => toast('草稿已复制，粘贴到对话里就能用。'),
      () => toast('复制失败，请手动复制。')
    )
    return
  }
  window.parent.postMessage({ type: 'yingma-canvas:start', prompt }, location.origin)
}

function sendToAgent() {
  if (!state.app.projectId) {
    toast('先在顶栏选一个画布项目。')
    return
  }
  const prompt = `用 yingma 工具看一下小影马画布${projectLabel()}：先用 canvas_overview 汇报画布和节点情况，不要修改。`
  if (window.parent === window) {
    navigator.clipboard?.writeText(prompt).then(
      () => toast('草稿已复制，粘贴到对话里就能用。'),
      () => toast('复制失败，请手动复制。')
    )
    return
  }
  window.parent.postMessage({ type: 'yingma-canvas:start', prompt }, location.origin)
  toast('已把画布交给 Agent，去对话里补全后发送。')
}

// ---------- 绑定 ----------

function bind() {
  $('brand').addEventListener('click', () => {
    if (state.app.projectId) void refreshFrame()
    else $('project-trigger').focus()
  })
  $('back-to-canvas').addEventListener('click', () => void refreshFrame())
  $('refresh').addEventListener('click', () => void refreshFrame())
  $('update-refresh').addEventListener('click', () => {
    if (!softRefresh()) void refreshFrame()
  })
  $('agent').addEventListener('click', sendToAgent)
  $('settings').addEventListener('click', openSettings)

  $('project-trigger').addEventListener('click', (event) => {
    event.stopPropagation()
    toggleProjectMenu()
  })
  $('canvas-trigger').addEventListener('click', (event) => {
    event.stopPropagation()
    toggleCanvasMenu()
  })

  $('project-search').addEventListener('input', (event) => {
    projectFilter = event.target.value
    activeProjectIndex = -1
    renderProjectMenu()
  })
  $('project-search').addEventListener('keydown', (event) => {
    const items = filteredProjects()
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!items.length) return
      const delta = event.key === 'ArrowDown' ? 1 : -1
      activeProjectIndex = (activeProjectIndex + delta + items.length) % items.length
      renderProjectMenu()
      const active = $('project-list').querySelector('.is-active')
      active?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const target = items[activeProjectIndex] || items[0]
      if (target) void chooseProject(target.id)
    }
  })

  $('project-list').addEventListener('scroll', () => updateListFade($('project-list')), { passive: true })
  $('canvas-list').addEventListener('scroll', () => updateListFade($('canvas-list')), { passive: true })
  $('project-list').addEventListener('click', (event) => {
    if (event.target.closest('[data-follow]')) {
      void chooseProject(null)
      return
    }
    const button = event.target.closest('[data-project]')
    if (button) void chooseProject(button.dataset.project)
  })
  $('canvas-list').addEventListener('click', (event) => {
    const button = event.target.closest('[data-canvas]')
    if (button) void chooseCanvas(button.dataset.canvas)
  })
  $('project-refresh').addEventListener('click', () => {
    void loadProjects(true)
  })

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.picker')) closeMenus()
  })

  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => {
      if (button.dataset.close === 'login') closeLogin()
      if (button.dataset.close === 'settings') $('settings-overlay').hidden = true
    })
  })

  $('login-restart').addEventListener('click', () => void startLogin())
  $('login-copy').addEventListener('click', () => void copyLoginUrl())
  $('setting-save').addEventListener('click', saveSettings)
  $('check-updates').addEventListener('click', () => void loadVersions(true))
  $('logout').addEventListener('click', logoutAgent)
  $('setting-check').addEventListener('click', async () => {
    await refreshStatus(true)
    renderSettingStatus()
    toast('已重新检查')
  })

  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!$('project-menu').hidden || !$('canvas-menu').hidden) {
      closeMenus()
      return
    }
    if (!$('login-overlay').hidden) closeLogin()
    if (!$('settings-overlay').hidden) $('settings-overlay').hidden = true
  })

  addEventListener('message', (event) => {
    if (event.origin !== location.origin) return
    if (event.data && event.data.type === 'yingma-canvas:start-failed') {
      toast(`没能开新对话：${event.data.message}`)
    }
    if (event.data && event.data.type === 'yingma-canvas:inserted') {
      toast('已放进旁边对话的输入框，补全后发送。')
    }
  })

  // 嵌入页的软刷新协议（来自画布 iframe，跨域）
  addEventListener('message', (event) => {
    const frame = $('canvas-frame')
    if (!frame || event.source !== frame.contentWindow) return
    let expected = ''
    try {
      expected = new URL(state.app.origin).origin
    } catch {
      return
    }
    if (event.origin !== expected) return
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'yingma:open-projects') {
      openProjectMenu()
      return
    }
    if (data.type === 'yingma:canvas-ready') {
      frameReady = true
      return
    }
    if (data.type === 'yingma:agent-handoff') {
      const nodes = (Array.isArray(data.nodes) ? data.nodes : [])
        .filter((n) => n && typeof n.id === 'string')
        .slice(0, 50)
        .map((n) => ({ id: String(n.id).slice(0, 80), kind: String(n.kind || '').slice(0, 30), label: String(n.label || '').slice(0, 80) }))
      startAgent(handoffPrompt(nodes))
      return
    }
    if (data.type === 'yingma:canvas-refreshed') {
      frameReady = true
      markSeen()
      $('update-chip').hidden = true
      toast('画布已同步')
    }
  })
}

// ---------- 启动 ----------

async function boot() {
  bind()
  try {
    const [stateResult, statusResult] = await Promise.all([api('/api/state'), api('/api/status')])
    state.app = stateResult.state
    state.status = statusResult.status
    markSeen()
  } catch (error) {
    toast(`插件接口不可用：${error.message}`)
  }
  renderStatus()
  renderContext()
  loadProjects()
  if (state.app.projectId) {
    showFrame()
    loadCanvases()
  } else {
    showEmpty()
  }
  setInterval(poll, 4000)

  // Agent 登录态可能在页面开着的时候过期；切回来或每分钟静默复查一次，
  // 免得顶栏一直停在旧的「Agent 已登录」。
  const refreshAuth = () => {
    if (document.hidden) return
    void refreshStatus(true, true)
  }
  window.addEventListener('focus', refreshAuth)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshAuth()
  })
  setInterval(refreshAuth, 60_000)

  // 深链接：?login=1 直接打开登录向导，?settings=1 打开设置（方便单独打开壳页时调试）
  const params = new URLSearchParams(location.search)
  if (params.get('login') === '1') openLogin()
  if (params.get('settings') === '1') openSettings()
  if (params.get('check') === '1') void loadVersions(true)
  if (params.get('menu') === 'projects') openProjectMenu()
  if (params.get('menu') === 'canvas') openCanvasMenu()
  if (params.get('empty') === '1') showEmpty()
}

boot()
