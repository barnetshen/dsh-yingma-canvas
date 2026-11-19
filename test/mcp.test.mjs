// yingma mcp：起真子进程，按 stdio 协议逐条收发；后端用本机假 API。
import { CLI, TMP, fakeApi } from './helpers.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const CANVAS_TOOLS = [
  { name: 'read_nodes', domain: 'canvas', risk: 'read', description: '读节点', input_schema: { type: 'object', properties: { nodes: { type: 'array' } } } },
  { name: 'delete_nodes', domain: 'canvas', risk: 'destructive', description: '删除节点', input_schema: { type: 'object' } },
]
const PIPELINE_TOOLS = [
  { name: 'script_read', domain: 'pipeline', risk: 'read', description: '读剧本', input_schema: { type: 'object' } },
]

let api
const seen = []

before(async () => {
  api = await fakeApi((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })
      const reply = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(value))
      }
      const m = req.url.match(/^\/api\/projects\/([^/?]+)(\/.*)?$/)
      if (req.url.startsWith('/api/projects?')) return reply(200, [{ id: 'p1', title: '画布', kind: 'canvas' }, { id: 'p2', title: '短剧', kind: 'pipeline' }])
      if (!m) return reply(404, { detail: 'nope' })
      const [, pid, rest = ''] = m
      if (rest === '') return reply(200, { id: pid, title: pid, kind: pid === 'p2' ? 'pipeline' : 'canvas' })
      if (rest === '/agent-tools') return reply(200, { kind: pid === 'p2' ? 'pipeline' : 'canvas', tools: pid === 'p2' ? PIPELINE_TOOLS : CANVAS_TOOLS })
      if (rest === '/agent-tools/read_nodes') return reply(200, { ok: true, result: { nodes: [{ id: 'a' }] } })
      if (rest === '/agent-tools/delete_nodes') return reply(200, { ok: false, error: '节点 x 不在当前画布上' })
      return reply(404, { detail: 'nope' })
    })
  })
})

after(() => api.close())

/** 启动 yingma mcp，返回 send(message) / next() / stop()。 */
function startMcp(env = {}) {
  const child = spawn(process.execPath, [CLI, 'mcp'], {
    env: { ...process.env, YINGMA_API_BASE: api.base, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const queue = []
  const waiters = []
  let buffer = ''
  const raw = []
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    raw.push(String(chunk))
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      const message = JSON.parse(line) // stdout 里出现非 JSON 行会直接让用例失败
      const waiter = waiters.shift()
      if (waiter) waiter(message)
      else queue.push(message)
    }
  })
  return {
    send: (message) => child.stdin.write(JSON.stringify(message) + '\n'),
    sendRaw: (text) => child.stdin.write(text + '\n'),
    next: () =>
      queue.length
        ? Promise.resolve(queue.shift())
        : new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('等 MCP 响应超时')), 8000)
            waiters.push((message) => {
              clearTimeout(timer)
              resolve(message)
            })
          }),
    stop: () => child.stdin.end(),
    raw,
  }
}

async function request(mcp, id, method, params) {
  mcp.send({ jsonrpc: '2.0', id, method, params })
  for (;;) {
    const message = await mcp.next()
    if (message.id === id) return message
  }
}

test('initialize 回显支持的协议版本，并声明工具会变化', async () => {
  const mcp = startMcp({ YINGMA_PROJECT: 'p1' })
  const out = await request(mcp, 1, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't' } })
  assert.equal(out.result.protocolVersion, '2025-03-26')
  assert.deepEqual(out.result.capabilities, { tools: { listChanged: true } })
  assert.equal(out.result.serverInfo.name, 'yingma')
  mcp.stop()
})

test('tools/list 按项目类型给工具，删除类带确认标记', async () => {
  const mcp = startMcp({ YINGMA_PROJECT: 'p1' })
  const { result } = await request(mcp, 1, 'tools/list', {})
  const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]))
  assert.ok(byName.yingma_project_list && byName.yingma_project_use)
  assert.equal(byName.read_nodes.annotations.readOnlyHint, true)
  assert.equal(byName.delete_nodes.annotations.destructiveHint, true)
  assert.match(byName.delete_nodes.description, /确认/)
  mcp.stop()
})

test('tools/call 转发到 agent-tools，带固定的 X-Agent-Caller', async () => {
  const mcp = startMcp({ YINGMA_PROJECT: 'p1' })
  const first = await request(mcp, 1, 'tools/call', { name: 'read_nodes', arguments: { nodes: ['a'] } })
  const second = await request(mcp, 2, 'tools/call', { name: 'read_nodes', arguments: { nodes: ['a'] } })
  assert.equal(first.result.isError, false)
  assert.deepEqual(JSON.parse(first.result.content[0].text).result, { nodes: [{ id: 'a' }] })
  const calls = seen.filter((r) => r.url === '/api/projects/p1/agent-tools/read_nodes')
  assert.deepEqual(calls.at(-1).body, { args: { nodes: ['a'] } })
  const callers = new Set(calls.slice(-2).map((r) => r.headers['x-agent-caller']))
  assert.equal(callers.size, 1, '同一个 MCP 连接的 caller 必须固定，否则先读后写会失效')
  assert.match([...callers][0], /^mcp-[0-9a-f]{12}$/)
  assert.equal(second.result.isError, false)
  mcp.stop()
})

test('工具返回 ok:false 时 isError 为 true', async () => {
  const mcp = startMcp({ YINGMA_PROJECT: 'p1' })
  const out = await request(mcp, 1, 'tools/call', { name: 'delete_nodes', arguments: { nodes: ['x'] } })
  assert.equal(out.result.isError, true)
  assert.match(out.result.content[0].text, /不在当前画布/)
  mcp.stop()
})

test('切换到别的类型的项目会通知工具清单变了', async () => {
  const mcp = startMcp({ YINGMA_PROJECT: 'p1' })
  await request(mcp, 1, 'tools/list', {})
  mcp.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'yingma_project_use', arguments: { project_id: 'p2' } } })
  const messages = [await mcp.next(), await mcp.next()]
  assert.ok(messages.some((m) => m.method === 'notifications/tools/list_changed'))
  const { result } = await request(mcp, 3, 'tools/list', {})
  const names = result.tools.map((t) => t.name)
  assert.ok(names.includes('script_read') && !names.includes('read_nodes'))
  mcp.stop()
})

test('没选项目时只给项目工具，并提示先选项目', async () => {
  const dir = join(TMP, 'empty-cwd')
  mkdirSync(dir, { recursive: true })
  const mcp = startMcp({ YINGMA_PROJECT: '', YINGMA_PROJECT_SOURCE: '' })
  const { result } = await request(mcp, 1, 'tools/list', {})
  assert.deepEqual(result.tools.map((t) => t.name).sort(), ['yingma_project_list', 'yingma_project_use'])
  const out = await request(mcp, 2, 'tools/call', { name: 'read_nodes', arguments: {} })
  assert.equal(out.result.isError, true)
  assert.match(out.result.content[0].text, /yingma_project_use/)
  mcp.stop()
})

test('DSH 来源：跟着插件里选的项目走', async () => {
  const dsh = join(TMP, 'dsh-mcp')
  mkdirSync(join(dsh, 'yingma-canvas'), { recursive: true })
  writeFileSync(join(dsh, 'yingma-canvas', 'state.json'), JSON.stringify({ projectId: 'p2' }))
  const mcp = startMcp({ YINGMA_PROJECT: '', YINGMA_PROJECT_SOURCE: 'dsh', DSH_HOME: dsh })
  const { result } = await request(mcp, 1, 'tools/list', {})
  assert.ok(result.tools.some((t) => t.name === 'script_read'))
  mcp.stop()
})

test('未知方法回 -32601，坏 JSON 回 -32700', async () => {
  const mcp = startMcp({ YINGMA_PROJECT: 'p1' })
  const out = await request(mcp, 1, 'resources/list', {})
  assert.equal(out.error.code, -32601)
  mcp.sendRaw('不是 JSON')
  const bad = await mcp.next()
  assert.equal(bad.error.code, -32700)
  mcp.send('合法 JSON 但不是请求对象')
  const invalid = await mcp.next()
  assert.equal(invalid.error.code, -32600)
  assert.equal(invalid.id, null)
  mcp.stop()
})
