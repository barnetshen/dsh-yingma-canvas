// CLI 对 --dry-run 的解析：写错一种写法就会把预演变成真执行。
import { cli, reachedNetwork } from './helpers.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const create = ['canvas', 'create', '--project', 'p1', '--name', 't']

test('--dry-run=true 是预演，不发请求', () => {
  assert.match(cli([...create, '--dry-run=true']), /"dry_run": true/)
})

test('裸 --dry-run 是预演', () => {
  assert.match(cli([...create, '--dry-run']), /"dry_run": true/)
})

test('--dry-run=false 会真的发请求', () => {
  assert.ok(reachedNetwork(cli([...create, '--dry-run=false'])))
})

test('--dry-run 之后的 --no-dry-run 覆盖前面的预演', () => {
  assert.ok(reachedNetwork(cli([...create, '--dry-run', '--no-dry-run'])))
})

test('会扣费的导出下载链接被 --dry-run 拦下', () => {
  assert.match(cli(['interactive', 'export', 'download-link', '--project', 'p1', '--yes', '--dry-run']), /"dry_run": true/)
})

test('普通 GET 不受 --dry-run 影响', () => {
  assert.ok(reachedNetwork(cli(['project', 'get', '--project', 'p1', '--dry-run'])))
})
