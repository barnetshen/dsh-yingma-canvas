// 小影马画布 · 插件 Host 半边
// 1. 把随包的 yingma-cli skill 注册进 ctx.skills
// 2. 注册 yingma_run 工具（在 Host 进程执行 CLI，不受模型 bash 沙箱限制）
// 3. 提供 /yingma-canvas/：壳页、状态、项目/画布列表、登录向导
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs'
import { extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  accountMe,
  authStatus,
  cliScript,
  cliVersion,
  createHandoff,
  findNode,
  listCanvases,
  listProjects,
  logout as cliLogout,
  pollWebLogin,
  startWebLogin,
  useCanvas,
} from './cli.js'
import { createSkillProvider } from './skills.js'
import { readState, touchMutation, writeState } from './store.js'
import { TOOLS } from './tools.js'
import { versionReport } from './versions.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BASE = '/yingma-canvas'
const WEB = join(ROOT, 'web')

export const name = 'yingma-canvas'
export const inject = ['webServer', 'skills', 'tools']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function notFound(res) {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found')
}

// DSH 只监听本机。Host 不是本机名就拒绝：挡 DNS 重绑定（恶意域名临时解析到 127.0.0.1，
// 浏览器会把它当同源，Origin 和 Host 都是那个假域名，readJson 的同源检查拦不住）。
function localHost(req) {
  const raw = String(req.headers.host || '')
  let hostname
  try {
    hostname = new URL(`http://${raw}`).hostname
  } catch {
    return false
  }
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost' || hostname.endsWith('.localhost')
}

// 跨站页面不经预检带不上自定义头，而插件不回 CORS 头，预检必然失败。
const API_HEADER = 'x-yingma-canvas'

// 一次性登录码只发给影马自己的页面；设置里填了别的地址时退回普通画布页，不发码。
function trustedCanvasOrigin(origin) {
  try {
    const { hostname, protocol } = new URL(origin)
    if (hostname === 'yingma.tv' || hostname.endsWith('.yingma.tv')) return protocol === 'https:'
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')
  } catch {
    return false
  }
}

// 画布地址（壳页设置）和 CLI 接口地址（YINGMA_API_BASE）分开配置，指向不同环境时
// CLI 签的登录码在画布那边兑换不了。约定接口是同域名或 api. 子域名，本机地址互相算一致。
function isLocalName(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost')
}

function envMismatch(origin, apiBase) {
  if (!origin || !apiBase) return null
  let canvasHost
  let apiHost
  try {
    canvasHost = new URL(origin).hostname
    apiHost = new URL(apiBase).hostname
  } catch {
    return null
  }
  if (isLocalName(canvasHost) && isLocalName(apiHost)) return null
  if (apiHost === canvasHost || apiHost === `api.${canvasHost}`) return null
  return `画布地址 ${origin} 和 CLI 接口地址 ${apiBase} 不是同一套环境。改壳页设置里的画布地址，或者改环境变量 YINGMA_API_BASE。`
}

function redirect(res, to) {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' })
  res.end()
}

// 只在 dir 里找文件：拒绝 ..、点文件和目录外的符号链接
function safeFile(dir, rel) {
  if (!dir || !rel || rel.split('/').some((p) => p.startsWith('.'))) return null
  let base
  try {
    base = realpathSync(dir)
  } catch {
    return null
  }
  const file = normalize(join(base, rel))
  if (!file.startsWith(base + sep) || !existsSync(file)) return null
  const real = realpathSync(file)
  return real.startsWith(base + sep) && statSync(real).isFile() ? real : null
}

function serveFile(req, res, file) {
  const type = MIME[extname(file).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'content-length': statSync(file).size,
    'cache-control': 'no-cache',
  })
  if (req.method === 'HEAD') return res.end()
  createReadStream(file).pipe(res)
}

// 只接受同源页面发来的 JSON
function readJson(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const origin = req.headers.origin
    if (req.method !== 'POST') return reject(Object.assign(new Error('method'), { status: 405 }))
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) {
      return reject(Object.assign(new Error('content-type'), { status: 415 }))
    }
    if (origin && origin.replace(/^https?:\/\//, '') !== req.headers.host) {
      return reject(Object.assign(new Error('origin'), { status: 403 }))
    }
    // 超限时不 destroy：那样不一定触发 error/end，Promise 会一直挂着、请求永远不回。
    // 改成丢弃剩余数据，读完后回 413。
    let size = 0
    let tooLarge = false
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > max) tooLarge = true
      if (!tooLarge) chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('请求体太大'), { status: 413 }))
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

// ---- 状态缓存 ----

let statusCache = null
let statusAt = 0
let projectsCache = null
let projectsAt = 0

async function status(force) {
  if (!force && statusCache && Date.now() - statusAt < 10_000) return statusCache
  const [version, auth] = await Promise.all([cliVersion(), authStatus()])
  const hasToken = Boolean(auth.ok && auth.data?.authenticated)
  // auth status 只看本地有没有令牌；再请求一次 account me 才知道令牌是否还有效。
  // 网络失败时不判过期，只标 verified: false。
  let expired = false
  let verified = false
  if (hasToken) {
    const me = await accountMe()
    verified = me.ok
    expired = !me.ok && /\bAPI 401\b/.test(me.error || '')
  }
  statusCache = {
    cli: {
      ok: version.ok,
      version: version.ok ? version.data?.version ?? null : null,
      apiBase: version.ok ? version.data?.api_base ?? null : null,
      node: findNode() || null,
      script: cliScript() ? 'ready' : null,
      error: version.ok ? null : version.error,
    },
    auth: {
      authenticated: hasToken && !expired,
      expired,
      verified,
      source: auth.ok ? (auth.data?.credential_source === 'YINGMA_TOKEN' ? 'env' : 'file') : null,
      error: auth.ok ? null : auth.error,
    },
    checkedAt: Date.now(),
  }
  statusAt = Date.now()
  return statusCache
}

async function projects(force) {
  const ttl = projectsCache && projectsCache.ok ? 120_000 : 15_000
  if (!force && projectsCache && Date.now() - projectsAt < ttl) return projectsCache
  const result = await listProjects(80)
  projectsCache = {
    ok: result.ok,
    items: result.ok && Array.isArray(result.data) ? result.data : [],
    error: result.ok ? null : result.error,
  }
  projectsAt = Date.now()
  return projectsCache
}

// ---- 参数校验 ----

const ID_RE = /^[A-Za-z0-9_-]{4,80}$/

function normalizeOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const url = new URL(raw.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.origin
  } catch {
    return null
  }
}

// 壳页来源：DSH 桌面版的页面在 Electron 注册的 dsh-app:// 标准协议下。URL 解析器对
// 非 http 协议的 .origin 一律给 "null"，所以按 协议//主机 自己拼。
const PARENT_PROTOCOLS = new Set(['http:', 'https:', 'dsh-app:'])

function parentOrigin(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const url = new URL(raw.trim())
    if (!PARENT_PROTOCOLS.has(url.protocol) || !url.host) return null
    return `${url.protocol}//${url.host}`
  } catch {
    return null
  }
}

function text(value, max = 200) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > max ? '' : trimmed
}

// ---- 登录：打开小影马网页授权，插件只轮询 ----

// device_code 只留在 Host 进程内存里，不发给壳页
let pendingLogin = null

async function handleLogin(kind) {
  if (kind === 'start') {
    const origin = readState().origin
    const result = await startWebLogin(origin)
    const data = result.data || {}
    if (!result.ok || !data.device_code || !data.verification_url) {
      // 发起授权是公开接口：401/404 只会是后端还没有这个接口（没更新或没重启）
      const outdated = /API (401|404)\b/.test(result.error || '')
      const error = outdated
        ? '当前后端还不支持网页授权，请确认后端已更新到最新版本并重启。'
        : result.error || '发起授权失败，请重试。'
      return { status: 200, body: { ok: false, error } }
    }
    pendingLogin = {
      deviceCode: String(data.device_code),
      expiresAt: Date.now() + (Number(data.expires_in) || 600) * 1000,
    }
    return {
      status: 200,
      body: {
        ok: true,
        userCode: String(data.user_code || ''),
        url: String(data.verification_url),
        expiresIn: Number(data.expires_in) || 600,
        interval: Number(data.interval) || 2,
      },
    }
  }

  if (kind === 'poll') {
    if (!pendingLogin || Date.now() > pendingLogin.expiresAt) {
      pendingLogin = null
      return { status: 200, body: { ok: true, status: 'expired' } }
    }
    const result = await pollWebLogin(pendingLogin.deviceCode)
    if (!result.ok) return { status: 200, body: { ok: false, error: result.error } }
    const status = String(result.data?.status || 'expired')
    if (status !== 'pending') pendingLogin = null
    if (status === 'approved') {
      statusCache = null
      projectsCache = null
      return { status: 200, body: { ok: true, status, user: result.data?.user ?? null } }
    }
    return { status: 200, body: { ok: true, status } }
  }

  if (kind === 'cancel') {
    pendingLogin = null
    return { status: 200, body: { ok: true } }
  }

  return { status: 404, body: { ok: false, error: 'not found' } }
}

// ---- 路由 ----

async function handleApi(rest, req, res) {
  const url = new URL(req.url || '/', 'http://x')

  if (rest === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, state: readState() })
  }

  if (rest === '/api/status' && req.method === 'GET') {
    const force = url.searchParams.get('refresh') === '1'
    const current = readState()
    const result = await status(force)
    return sendJson(res, 200, {
      ok: true,
      state: current,
      status: { ...result, envWarning: envMismatch(current.origin, result.cli.apiBase) },
    })
  }

  if (rest === '/api/versions' && req.method === 'GET') {
    const check = url.searchParams.get('check') === '1'
    return sendJson(res, 200, { ok: true, ...(await versionReport(check)) })
  }

  if (rest === '/api/projects' && req.method === 'GET') {
    const force = url.searchParams.get('refresh') === '1'
    return sendJson(res, 200, { ok: true, ...(await projects(force)) })
  }

  if (rest === '/api/canvases' && req.method === 'GET') {
    const projectId = text(url.searchParams.get('project') || '')
    if (!ID_RE.test(projectId)) return sendJson(res, 400, { ok: false, error: 'project 参数不合法。' })
    const result = await listCanvases(projectId)
    if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error })
    const data = result.data || {}
    return sendJson(res, 200, {
      ok: true,
      active_canvas_id: data.active_canvas_id || null,
      view_mode: data.view_mode || null,
      canvases: Array.isArray(data.canvases) ? data.canvases : [],
    })
  }

  if (rest === '/api/settings' && req.method === 'POST') {
    const body = await readJson(req)
    const origin = normalizeOrigin(body.origin)
    if (!origin) return sendJson(res, 400, { ok: false, error: '画布地址必须是 http(s) 地址。' })
    const patch = { origin }
    if (body.canvasAgent !== undefined) {
      if (body.canvasAgent !== 'dsh' && body.canvasAgent !== 'yingma') {
        return sendJson(res, 400, { ok: false, error: '画布里的 Agent 只能选 dsh 或 yingma。' })
      }
      patch.canvasAgent = body.canvasAgent
    }
    return sendJson(res, 200, { ok: true, state: writeState(patch) })
  }

  // 生成带一次性登录码的 embed 地址。embed 还没部署时退回普通画布页，
  // 不阻塞现在的用法。会签发登录码，所以只走 POST。
  if (rest === '/api/embed' && req.method === 'POST') {
    const body = await readJson(req)
    const projectId = text(body.project)
    const parent = parentOrigin(body.parent || '')
    if (!ID_RE.test(projectId)) return sendJson(res, 400, { ok: false, error: 'project 参数不合法。' })
    const current = readState()
    const origin = String(current.origin || 'https://yingma.tv').replace(/\/+$/, '')
    const fallback = `${origin}/project/${encodeURIComponent(projectId)}/canvas`
    if (!trustedCanvasOrigin(origin)) {
      return sendJson(res, 200, {
        ok: true,
        url: fallback,
        fallback: true,
        error: `画布地址 ${origin} 不是影马域名，不发一次性登录码。`,
      })
    }
    const mismatch = envMismatch(origin, (await status(false)).cli.apiBase)
    if (mismatch) return sendJson(res, 200, { ok: true, url: fallback, fallback: true, error: mismatch })
    const handoff = await createHandoff()
    if (!handoff.ok || !handoff.data?.code) {
      return sendJson(res, 200, {
        ok: true,
        url: fallback,
        fallback: true,
        error: handoff.error || 'embed 登录码不可用',
      })
    }
    const params = new URLSearchParams()
    if (parent) params.set('parent', parent)
    // 画布助手入口交给 DSH：嵌入页收到 agent=host 后把「打开助手」「加入对话」发给壳页
    if (current.canvasAgent !== 'yingma') params.set('agent', 'host')
    const query = params.toString() ? `?${params}` : ''
    const embedUrl = `${origin}/embed/canvas/${encodeURIComponent(projectId)}${query}#code=${encodeURIComponent(
      handoff.data.code
    )}`
    return sendJson(res, 200, {
      ok: true,
      url: embedUrl,
      fallback: false,
      expiresIn: handoff.data.expires_in ?? null,
    })
  }

  if (rest === '/api/project' && req.method === 'POST') {
    const body = await readJson(req)
    const projectId = text(body.projectId)
    if (!projectId) {
      return sendJson(res, 200, { ok: true, state: writeState({ projectId: null, projectTitle: '' }) })
    }
    if (!ID_RE.test(projectId)) return sendJson(res, 400, { ok: false, error: '项目 ID 不合法。' })
    const patch = {
      projectId,
      projectTitle: text(body.projectTitle) || '',
    }
    if (body.origin !== undefined) {
      const origin = normalizeOrigin(body.origin)
      if (!origin) return sendJson(res, 400, { ok: false, error: '画布地址必须是 http(s) 地址。' })
      patch.origin = origin
    }
    return sendJson(res, 200, { ok: true, state: writeState(patch) })
  }

  if (rest === '/api/canvas/use' && req.method === 'POST') {
    const body = await readJson(req)
    const projectId = text(body.projectId)
    const canvasId = text(body.canvasId)
    if (!ID_RE.test(projectId) || !ID_RE.test(canvasId)) {
      return sendJson(res, 400, { ok: false, error: '项目或画布 ID 不合法。' })
    }
    const result = await useCanvas(projectId, canvasId)
    if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error })
    touchMutation(projectId)
    return sendJson(res, 200, { ok: true, active_canvas_id: canvasId })
  }

  for (const kind of ['start', 'poll', 'cancel']) {
    if (rest === `/api/login/${kind}` && req.method === 'POST') {
      await readJson(req)
      const out = await handleLogin(kind)
      return sendJson(res, out.status, out.body)
    }
  }

  if (rest === '/api/logout' && req.method === 'POST') {
    await readJson(req)
    const result = await cliLogout()
    statusCache = null
    projectsCache = null
    return sendJson(res, 200, result.ok ? { ok: true } : { ok: false, error: result.error })
  }

  return notFound(res)
}

export function apply(ctx) {
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(join(ROOT, 'skills'))))
  for (const tool of TOOLS) ctx.tools.register(tool)

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: BASE,
      async handler(req, res) {
        if (!localHost(req)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
          return res.end('forbidden host')
        }
        const url = new URL(req.url || '/', 'http://x')
        let rest
        try {
          rest = decodeURIComponent(url.pathname.slice(BASE.length)) || '/'
        } catch {
          return notFound(res)
        }
        if (rest === '' || rest === '/') {
          const file = safeFile(WEB, 'index.html')
          return file ? serveFile(req, res, file) : notFound(res)
        }
        if (rest.startsWith('/api/')) {
          if (req.headers[API_HEADER] !== '1') {
            return sendJson(res, 403, { ok: false, error: `缺少 ${API_HEADER} 请求头。` })
          }
          try {
            return await handleApi(rest, req, res)
          } catch (error) {
            if (error && error.status) {
              return sendJson(res, error.status, { ok: false, error: error.message })
            }
            return sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
          }
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res)
        const file = safeFile(WEB, rest.slice(1))
        return file ? serveFile(req, res, file) : notFound(res)
      },
    })
  )
}
