// 网页授权登录：插件只发起和轮询，device_code 不出 Host 进程；批准后 CLI 存下令牌。
import { TMP, cli, fakeApi } from './helpers.mjs'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { apply } from '../lib/index.js'

const CONFIG = join(TMP, 'config.json')
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

function post(path) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/yingma-canvas' + path,
        method: 'POST',
        headers: { host: `127.0.0.1:${port}`, 'x-yingma-canvas': '1', 'content-type': 'application/json' },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk) => (text += chunk))
        res.on('end', () => resolve({ status: res.statusCode, text, json: JSON.parse(text) }))
      }
    )
    req.end('{}')
  })
}

async function withApi(handler, fn) {
  const api = await fakeApi(handler)
  const previous = process.env.YINGMA_API_BASE
  const config = readFileSync(CONFIG, 'utf8')
  process.env.YINGMA_API_BASE = api.base
  try {
    await fn(api)
  } finally {
    process.env.YINGMA_API_BASE = previous
    writeFileSync(CONFIG, config)
    api.close()
  }
}

function body(req) {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (c) => (text += c))
    req.on('end', () => resolve(text ? JSON.parse(text) : {}))
  })
}

test('发起 → 等待 → 批准：令牌存进 CLI 配置，device_code 不给壳页', async () => {
  const polled = []
  let approved = false
  await withApi(async (req, res) => {
    const data = await body(req)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/auth/cli/requests') {
      assert.equal(data.client, 'dsh')
      return res.end(JSON.stringify({ device_code: 'dev-secret-0123456789', user_code: 'ABCD-EFGH', expires_in: 600, interval: 2 }))
    }
    if (req.url === '/api/auth/cli/token') {
      polled.push(data.device_code)
      if (!approved) return res.end(JSON.stringify({ status: 'pending' }))
      return res.end(JSON.stringify({ status: 'approved', access_token: 'tok-from-web', user: { email: 'a@b.c' } }))
    }
    res.statusCode = 404
    res.end('{}')
  }, async () => {
    const start = await post('/api/login/start')
    assert.equal(start.json.ok, true, start.text)
    assert.equal(start.json.userCode, 'ABCD-EFGH')
    assert.equal(start.json.url, 'https://yingma.tv/cli/authorize?code=ABCD-EFGH')
    assert.ok(!start.text.includes('dev-secret'), '壳页拿不到 device_code')

    assert.equal((await post('/api/login/poll')).json.status, 'pending')
    approved = true
    const done = await post('/api/login/poll')
    assert.equal(done.json.status, 'approved', done.text)
    assert.ok(!done.text.includes('a@b.c'), '账号信息不传给壳页')
    assert.equal(JSON.parse(readFileSync(CONFIG, 'utf8')).access_token, 'tok-from-web')
    assert.deepEqual(polled, ['dev-secret-0123456789', 'dev-secret-0123456789'])
    // 批准后这次请求就结束了，再轮询不会再去问服务端
    assert.equal((await post('/api/login/poll')).json.status, 'expired')
    assert.equal(polled.length, 2)
  })
})

test('拒绝和取消', async () => {
  await withApi(async (req, res) => {
    await body(req)
    res.setHeader('content-type', 'application/json')
    if (req.url === '/api/auth/cli/requests') {
      return res.end(JSON.stringify({ device_code: 'dev-secret-0123456789', user_code: 'ABCD-EFGH', expires_in: 600, interval: 2 }))
    }
    res.end(JSON.stringify({ status: 'denied' }))
  }, async () => {
    await post('/api/login/start')
    assert.equal((await post('/api/login/poll')).json.status, 'denied')
    assert.equal(JSON.parse(readFileSync(CONFIG, 'utf8')).access_token, 'fake', '拒绝不能改令牌')

    await post('/api/login/start')
    await post('/api/login/cancel')
    assert.equal((await post('/api/login/poll')).json.status, 'expired')
  })
})

test('没发起就轮询：expired', async () => {
  await post('/api/login/cancel')
  assert.equal((await post('/api/login/poll')).json.status, 'expired')
})

test('授权页地址：api.X → X，本地 8181 → 3000，可显式指定', () => {
  const origin = (env, extra = []) => JSON.parse(cli(['auth', 'web-start', '--dry-run', ...extra], env)).web_origin
  assert.equal(origin({ YINGMA_API_BASE: 'https://api.yingma.tv' }), 'https://yingma.tv')
  assert.equal(origin({ YINGMA_API_BASE: 'http://localhost:8181' }), 'http://localhost:3000')
  assert.equal(origin({ YINGMA_API_BASE: 'https://yingma.example' }), 'https://yingma.example')
  assert.equal(origin({ YINGMA_API_BASE: 'https://api.yingma.tv' }, ['--web-origin', 'http://127.0.0.1:3000/x']), 'http://127.0.0.1:3000')
})

test('web-poll 必须从 stdin 读 device_code', () => {
  assert.match(cli(['auth', 'web-poll']), /--device-code-stdin/)
})

test('后端还没有授权接口（401/404）：提示更新后端，不提示去跑 auth login', async () => {
  await withApi(async (req, res) => {
    await body(req)
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ detail: '未登录或登录已过期' }))
  }, async () => {
    const out = (await post('/api/login/start')).json
    assert.equal(out.ok, false)
    assert.match(out.error, /后端还不支持网页授权/)
  })
})
