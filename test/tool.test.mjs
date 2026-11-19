// yingma_run 工具：--yes 和用户确认绑定、文件参数不能越出会话目录、按项目记改动。
import { PROJECT, TMP, reachedNetwork } from './helpers.mjs'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isReadOnly, projectOf } from '../lib/cli.js'
import { readState } from '../lib/store.js'
import { runTool } from '../lib/tools.js'

const HOME = homedir()
const W = join(TMP, 'workspace')
mkdirSync(join(W, 'sub'), { recursive: true })
mkdirSync(join(W, '.git'), { recursive: true })
writeFileSync(join(W, 'a.json'), '{}')
writeFileSync(join(W, '.env'), 'K=1')
symlinkSync(join(HOME, '.yingma'), join(W, 'link'))
symlinkSync('/etc/hosts', join(W, 'hosts'))

/** extra 是工具调用参数（cwd、confirm），session 是宿主给的上下文（会话目录）。 */
const run = (args, extra = {}, session = { cwd: W }) => runTool.execute({ args, ...extra }, session)
const blocked = async (promise, pattern) => {
  const result = await promise
  assert.equal(result.ok, false)
  assert.match(result.error, pattern)
}
const reached = async (promise) => {
  const result = await promise
  assert.equal(result.ok, false)
  assert.ok(reachedNetwork(result.error), result.error)
}

test('--yes=true / --yes=1 也要 confirm', async () => {
  await blocked(run(['canvas', 'node', 'remove', '--id', 'n1', '--yes=true']), /confirm/)
  await blocked(run(['canvas', 'node', 'remove', '--id', 'n1', '--yes=1']), /confirm/)
})

test('文件参数：挡住越出会话目录的各种写法', async () => {
  await blocked(run(['canvas', 'upload', '--file', join(HOME, '.yingma', 'config.json')]), /只能指向会话工作目录/)
  await blocked(run(['canvas', 'upload', '--file', '../config.json']), /只能指向会话工作目录/)
  await blocked(run(['script', 'save', '--file=/etc/hosts']), /只能指向会话工作目录/)
  await blocked(run(['canvas', 'upload', '--file', 'link/config.json']), /只能指向会话工作目录/)
  await blocked(run(['canvas', 'upload', '--file', 'hosts']), /只能指向会话工作目录/)
  await blocked(run(['canvas', 'export', '--output', join(HOME, '.zshrc')], { confirm: true }), /只能指向会话工作目录/)
})

test('文件参数：会话目录里的凭据文件也不行', async () => {
  await blocked(run(['canvas', 'node', 'add', '--kind', 'text', '--data-file', '.env']), /凭据/)
  await blocked(run(['canvas', 'upload', '--file', '.git/config']), /凭据/)
})

test('文件参数：模型传的 cwd 不能扩大范围', async () => {
  await blocked(run(['canvas', 'upload', '--file', 'id_rsa'], { cwd: join(HOME, '.ssh') }), /只能指向会话工作目录/)
  await blocked(run(['canvas', 'upload', '--file', 'hosts'], { cwd: '/etc' }), /只能指向会话工作目录/)
  await blocked(run(['canvas', 'upload', '--file', 'a.json'], { cwd: W }, {}), /探测不到/)
})

test('文件参数：会话目录太宽或本身是凭据目录', async () => {
  await blocked(run(['canvas', 'upload', '--file', 'x.png'], {}, { cwd: HOME }), /太宽/)
  await blocked(run(['canvas', 'upload', '--file', 'x.png'], {}, { cwd: '/' }), /太宽/)
  await blocked(run(['canvas', 'upload', '--file', 'id_rsa'], {}, { cwd: join(HOME, '.ssh') }), /凭据目录|太宽/)
})

test('--output 写本机文件要 confirm', async () => {
  await blocked(run(['canvas', 'export', '--output', 'out.json']), /confirm/)
})

test('文件参数：正常用法放行', async () => {
  await reached(run(['canvas', 'upload', '--file', 'a.json']))
  await reached(run(['canvas', 'export', '--output', 'sub/new.json'], { confirm: true }))
  await reached(run(['canvas', 'export', '--output', 'x.json'], { cwd: join(W, 'sub'), confirm: true }))
  await reached(run(['canvas', 'summary']))
})

test('只读判断：--dry-run 的各种写法和 CLI 一致', () => {
  assert.equal(isReadOnly(['canvas', 'create', '--dry-run=true']), true)
  assert.equal(isReadOnly(['canvas', 'create', '--dry-run', '--yes']), true)
  assert.equal(isReadOnly(['canvas', 'create', '--dry-run', 'false']), false)
  assert.equal(isReadOnly(['canvas', 'create', '--dry-run', '--no-dry-run']), false)
})

test('只读判断：写命令不能因为前缀相同被算成读', () => {
  for (const args of [
    ['interactive', 'settings', '--yes'],
    ['interactive', 'vars', '--yes'],
    ['interactive', 'items', '--yes'],
    ['canvas', 'library', 'character-apply', '--yes'],
    ['canvas', 'library', 'starter-apply', '--yes'],
    ['pipeline', 'collab', 'claim', '--yes'],
    ['canvas', 'collab', 'release', '--yes'],
  ]) {
    assert.equal(isReadOnly(args), false, args.join(' '))
  }
  for (const args of [
    ['canvas', 'library', 'character-list'],
    ['pipeline', 'collab'],
    ['canvas', 'collab', 'list'],
    ['canvas', 'collab', '--project', PROJECT],
    ['account', 'balance'],
  ]) {
    assert.equal(isReadOnly(args), true, args.join(' '))
  }
})

test('改动按项目记录', async () => {
  assert.equal(projectOf(['canvas', 'summary', '--project', 'proj-abc1']), 'proj-abc1')
  const { fakeApi } = await import('./helpers.mjs')
  // 假 API 对写请求回成功，工具才会记一次改动。
  const api = await fakeApi((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
  })
  const previous = process.env.YINGMA_API_BASE
  process.env.YINGMA_API_BASE = api.base
  try {
    const result = await run(['canvas', 'view', '--mode', 'workflow', '--project', 'proj-other'])
    assert.equal(result.ok, true, result.error)
  } finally {
    process.env.YINGMA_API_BASE = previous
    api.close()
  }
  const { mutations } = readState()
  assert.ok(mutations['proj-other'] > 0)
  assert.equal(mutations[PROJECT], undefined)
})

test('auth 限制看的是 CLI 实际解析出的命令，选项写在前面绕不过去', async () => {
  const pattern = /auth 只允许 status/
  await blocked(run(['auth', 'logout']), pattern)
  await blocked(run(['--pretty=1', 'auth', 'logout']), pattern)
  await blocked(run(['--no-color', 'auth', 'set-token']), pattern)
  await blocked(run(['--profile', 'x', 'auth', 'login', '--web']), pattern)
  await blocked(run(['--json', '--pretty', 'x', 'auth', 'web-start']), pattern)
  // 选项写在前面的 auth status 仍然放行
  assert.doesNotMatch((await run(['--pretty=1', 'auth', 'status'])).error || '', pattern)
})
