// 插件 HTTP 路由：Host 校验、请求头、登录码只发给影马、登录状态、请求体上限。
import { DEAD_API, PROJECT, fakeApi, writePluginState } from './helpers.mjs'
import assert from 'node:assert/strict'
import http from 'node:http'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'

let server
let port

before(async () => {
  let handler
  apply({
    effect: (fn) => fn(),
    skills: { registerProvider() {} },
    tools: { register() {} },
    webServer: { register: (route) => { handler = route.handler } },
  })
  server = http.createServer((req, res) => handler(req, res)).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  port = server.address().port
})

after(() => server.close())

function call(path, { host = `127.0.0.1:${port}`, header = true, method = 'GET', body, raw } = {}) {
  return new Promise((resolve) => {
    const headers = { host }
    if (header) headers['x-yingma-canvas'] = '1'
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json'
    const req = http.request({ host: '127.0.0.1', port, path: '/yingma-canvas' + path, method, headers }, (res) => {
      let text = ''
      res.on('data', (chunk) => (text += chunk))
      res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }))
    })
    if (raw !== undefined) req.write(raw)
    else if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const embed = (options = {}) =>
  call('/api/embed', { method: 'POST', body: { project: PROJECT, parent: 'http://127.0.0.1' }, ...options })

test('伪造 Host 一律 403（挡 DNS 重绑定）', async () => {
  const evil = `evil.example:${port}`
  assert.equal((await call('/api/state', { host: evil })).status, 403)
  assert.equal((await call('/', { host: evil })).status, 403)
  assert.equal((await embed({ host: evil })).status, 403)
})

test('接口缺 x-yingma-canvas 头 403，壳页静态文件不要求', async () => {
  assert.equal((await call('/api/state', { header: false })).status, 403)
  assert.equal((await call('/', { header: false })).status, 200)
})

test('本机 Host 正常访问', async () => {
  assert.equal((await call('/api/state')).status, 200)
  assert.equal((await call('/api/state', { host: `localhost:${port}` })).status, 200)
})

test('登录码只能 POST 申请', async () => {
  assert.equal((await call(`/api/embed?project=${PROJECT}`)).status, 404)
})

test('画布地址不是影马域名时不发登录码', async () => {
  writePluginState({ projectId: PROJECT, origin: 'https://evil.example' })
  try {
    const result = (await embed()).json()
    assert.equal(result.fallback, true)
    assert.match(result.error, /不是影马域名/)
  } finally {
    writePluginState({ projectId: PROJECT, origin: 'https://yingma.tv' })
  }
})

test('画布地址和 CLI 接口地址不是同一环境时提示，并且不发登录码', async () => {
  // DEAD_API 是 127.0.0.1，和 https://yingma.tv 不是同一套环境。
  assert.equal(process.env.YINGMA_API_BASE, DEAD_API)
  const status = (await call('/api/status?refresh=1')).json().status
  assert.match(status.envWarning, /不是同一套环境/)
  const result = (await embed()).json()
  assert.equal(result.fallback, true)
  assert.match(result.error, /不是同一套环境/)
})

test('同一环境（本机画布 + 本机接口）不提示', async () => {
  writePluginState({ projectId: PROJECT, origin: 'http://localhost:3000' })
  try {
    const status = (await call('/api/status?refresh=1')).json().status
    assert.equal(status.envWarning, null)
  } finally {
    writePluginState({ projectId: PROJECT, origin: 'https://yingma.tv' })
  }
})

test('令牌已失效时显示过期，网络失败时不判过期', async () => {
  const api = await fakeApi((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ detail: 'expired' }))
  })
  process.env.YINGMA_API_BASE = api.base
  try {
    const auth = (await call('/api/status?refresh=1')).json().status.auth
    assert.equal(auth.expired, true)
    assert.equal(auth.authenticated, false)
  } finally {
    process.env.YINGMA_API_BASE = DEAD_API
    api.close()
  }
  const auth = (await call('/api/status?refresh=1')).json().status.auth
  assert.equal(auth.expired, false)
  assert.equal(auth.verified, false)
  assert.equal(auth.authenticated, true)
})

test('请求体超限回 413，而不是一直挂着', async () => {
  const big = JSON.stringify({ origin: 'x'.repeat(70 * 1024) })
  const result = await Promise.race([
    call('/api/settings', { method: 'POST', raw: big }),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 5000)),
  ])
  assert.equal(result.status, 413)
})

test('Agent 的长任务排队时，侧栏查询不跟着等', async () => {
  const { runTool } = await import('../lib/tools.js')
  // 写请求拖 4 秒才回，模拟生成类长任务；其它请求立刻回。
  const api = await fakeApi((req, res) => {
    const reply = () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    }
    if (req.method === 'PATCH') setTimeout(reply, 4000)
    else reply()
  })
  process.env.YINGMA_API_BASE = api.base
  try {
    const slow = runTool.execute({ args: ['canvas', 'view', '--mode', 'workflow'] }, {})
    await new Promise((resolve) => setTimeout(resolve, 300))
    const started = Date.now()
    assert.equal((await call('/api/status?refresh=1')).status, 200)
    assert.ok(Date.now() - started < 2500, `状态查询等了 ${Date.now() - started}ms`)
    await slow
  } finally {
    process.env.YINGMA_API_BASE = DEAD_API
    api.close()
  }
})

test('画布 Agent 设置：只接受 dsh / yingma，嵌入地址按设置带 agent=host', async () => {
  const bad = await call('/api/settings', { method: 'POST', body: { origin: 'http://localhost:3000', canvasAgent: 'other' } })
  assert.equal(bad.status, 400)
  const api = await fakeApi((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url === '/api/auth/embed/handoff' ? { code: 'one-time', expires_in: 90 } : { ok: true }))
  })
  process.env.YINGMA_API_BASE = api.base
  try {
    writePluginState({ projectId: PROJECT, origin: 'http://localhost:3000' })
    await call('/api/status?refresh=1')
    const dsh = (await embed()).json()
    assert.equal(dsh.fallback, false, dsh.error)
    assert.equal(new URL(dsh.url).searchParams.get('agent'), 'host')
    assert.match(dsh.url, /#code=one-time$/)
    assert.equal(new URL(dsh.url).searchParams.get('parent'), 'http://127.0.0.1')
    // DSH 桌面版的壳页在 dsh-app:// 下：也要原样带给嵌入页，否则画布不知道自己嵌在谁里面
    const desktop = (await embed({ body: { project: PROJECT, parent: 'dsh-app://app/yingma-canvas/' } })).json()
    assert.equal(new URL(desktop.url).searchParams.get('parent'), 'dsh-app://app')
    const bogus = (await embed({ body: { project: PROJECT, parent: 'file:///tmp/x' } })).json()
    assert.equal(new URL(bogus.url).searchParams.get('parent'), null)
    const saved = await call('/api/settings', { method: 'POST', body: { origin: 'http://localhost:3000', canvasAgent: 'yingma' } })
    assert.equal(saved.json().state.canvasAgent, 'yingma')
    const yingma = (await embed()).json()
    assert.equal(new URL(yingma.url).searchParams.get('agent'), null)
  } finally {
    process.env.YINGMA_API_BASE = DEAD_API
    writePluginState({ projectId: PROJECT, origin: 'https://yingma.tv' })
    api.close()
  }
})

test('停靠模式（?dock=1）：顶栏收成细栏，去掉品牌和「交给 Agent」', async () => {
  const { readFileSync } = await import('node:fs')
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8')
  assert.match(html, /get\('dock'\) === '1'\) root\.dataset\.dock = '1'/)
  assert.match(css, /\[data-dock\] \.brand,\n\[data-dock\] #agent,\n\[data-dock\] \.divider \{ display: none; \}/)
  assert.match(css, /\[data-dock\] \.bar \{ height: 40px;/)
})
