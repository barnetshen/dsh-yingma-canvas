// 测试公共环境：所有用例只连假地址，绝不碰线上影马、也不读写真实的 ~/.yingma 和 ~/.dsh。
// 必须最先 import：后面的模块在调用时才读这些环境变量。
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PLUGIN = fileURLToPath(new URL('..', import.meta.url))
export const CLI = join(PLUGIN, 'skills', 'yingma-cli', 'scripts', 'yingma.js')
// 端口 9（discard）上没有服务，请求必然失败：用来证明命令"真的发出去了"。
export const DEAD_API = 'http://127.0.0.1:9'
export const PROJECT = 'proj-test-1'

export const TMP = mkdtempSync(join(tmpdir(), 'yingma-plugin-test-'))
const configFile = join(TMP, 'config.json')
writeFileSync(configFile, JSON.stringify({ access_token: 'fake' }))
mkdirSync(join(TMP, 'dsh', 'yingma-canvas'), { recursive: true })

process.env.YINGMA_CONFIG = configFile
process.env.YINGMA_API_BASE = DEAD_API
process.env.DSH_HOME = join(TMP, 'dsh')
delete process.env.YINGMA_TOKEN
// 网页授权登录会打开浏览器；测试里一律不开
process.env.YINGMA_NO_BROWSER = '1'
delete process.env.YINGMA_CLI

export function writePluginState(state) {
  writeFileSync(join(TMP, 'dsh', 'yingma-canvas', 'state.json'), JSON.stringify(state))
}
writePluginState({ projectId: PROJECT, origin: 'https://yingma.tv' })

/** 直接跑 CLI，返回 stdout + stderr。 */
export function cli(args, env = {}) {
  const out = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 20_000,
  })
  return (out.stdout || '') + (out.stderr || '')
}

export const reachedNetwork = (text) => /Network request failed|fetch failed/.test(text)

/** 本机假 API：handler(req, res) 自己决定回什么；返回 base 地址和关闭函数。 */
export async function fakeApi(handler) {
  const server = http.createServer(handler).listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}
