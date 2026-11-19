// yingma CLI 的宿主侧执行器。
// 1. 找到 node：插件宿主是 Electron，process.execPath 不是 node；依次找 YINGMA_NODE、
//    dsh 自带运行时、nvm、homebrew、系统路径。
// 2. 找到 CLI 脚本：用户装过的 ~/.yingma/bin/yingma 优先，否则用插件随包带的 0.5.3 快照。
// 3. 串行执行：CLI 会写 ~/.yingma/config.json 和 canvas-cache，并发跑会互相覆盖。
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = homedir()
const BUNDLE = fileURLToPath(new URL('..', import.meta.url))
const IS_WIN = process.platform === 'win32'
const NODE_BIN = IS_WIN ? 'node.exe' : 'node'

let nodeCache
let scriptCache

function firstExisting(paths, check = (p) => existsSync(p)) {
  for (const p of paths) {
    if (!p) continue
    try {
      if (check(p)) return p
    } catch {
      /* 跳过不可读的候选 */
    }
  }
  return null
}

export function findNode() {
  if (nodeCache) return nodeCache
  const candidates = [
    process.env.YINGMA_NODE,
    process.env.DSH_NODE,
    join(dirname(process.execPath), NODE_BIN),
  ]
  const dshHome = process.env.DSH_HOME || join(HOME, '.dsh')
  const runtimes = join(dshHome, 'dsh-runtimes')
  if (existsSync(runtimes)) {
    try {
      for (const name of readdirSync(runtimes)) {
        candidates.push(join(runtimes, name, 'dependencies', 'node', 'bin', NODE_BIN))
      }
    } catch {
      /* 运行时目录不可读时继续 */
    }
  }
  const nvm = join(HOME, '.nvm', 'versions', 'node')
  if (existsSync(nvm)) {
    try {
      const versions = readdirSync(nvm).sort((a, b) => {
        const pa = a.split('.').map(Number)
        const pb = b.split('.').map(Number)
        for (let i = 0; i < 3; i += 1) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0)
        return 0
      })
      for (const v of versions) candidates.push(join(nvm, v, 'bin', NODE_BIN))
    } catch {
      /* 忽略 */
    }
  }
  candidates.push('/opt/homebrew/bin/' + NODE_BIN, '/usr/local/bin/' + NODE_BIN, '/usr/bin/' + NODE_BIN)
  nodeCache = firstExisting(candidates, (p) => existsSync(p) && statSync(p).size > 100 * 1024)
  return nodeCache
}

export function cliScript() {
  if (scriptCache) return scriptCache
  const installed = join(HOME, '.yingma', 'bin', IS_WIN ? 'yingma.cmd' : 'yingma')
  const bundled = join(BUNDLE, 'skills', 'yingma-cli', 'scripts', 'yingma.js')
  // 优先用随包快照：插件带的命令（auth handoff）和版本是确定的，
  // 用户机器上那份 ~/.yingma/bin/yingma 可能还是旧版。
  scriptCache = firstExisting([process.env.YINGMA_CLI, bundled, installed])
  return scriptCache
}

// ---- 输出解析 ----

function cleanError(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/^yingma:\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .slice(0, 1200)
}

function parseStdout(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return { data: null, text: '' }
  try {
    return { data: JSON.parse(trimmed), text: trimmed }
  } catch {
    // CLI 偶尔会在 JSON 前面打印一行提示，取第一个 { 或 [ 到结尾再试一次
    const start = trimmed.search(/[[{]/)
    if (start >= 0) {
      try {
        return { data: JSON.parse(trimmed.slice(start)), text: trimmed }
      } catch {
        /* 不是 JSON */
      }
    }
    return { data: null, text: trimmed }
  }
}

// ---- 执行 ----

let queue = Promise.resolve()

/**
 * 串行执行 yingma CLI。
 * @param {string[]} args argv（不含 node 和脚本路径）
 * @param {{timeoutMs?: number, cwd?: string, parallel?: boolean}} [opts]
 */
// parallel：壳页的状态/列表查询不写 config.json，不必排在 Agent 的长任务（最长 200 秒）后面，
// 否则侧栏会一直转圈。canvas list 会刷新 canvas-cache，但缓存是原子替换、只作加速用，
// 写到旧版本也只是下次多拉一段增量。
export function runCli(args, opts = {}) {
  if (opts.parallel) return exec(args, opts)
  const task = queue.then(() => exec(args, opts))
  queue = task.then(
    () => undefined,
    () => undefined
  )
  return task
}

function exec(args, { timeoutMs = 60_000, cwd, input } = {}) {
  return new Promise((resolve) => {
    const node = findNode()
    const script = cliScript()
    if (!node) {
      resolve({
        ok: false,
        error:
          '找不到 node 可执行文件。安装 Node.js 18+，或在环境变量 YINGMA_NODE 里指定 node 的绝对路径。',
      })
      return
    }
    if (!script) {
      resolve({ ok: false, error: '找不到 yingma CLI 脚本（~/.yingma/bin/yingma 或插件随包版本）。' })
      return
    }
    const env = {
      ...process.env,
      PATH: [dirname(node), process.env.PATH || ''].filter(Boolean).join(IS_WIN ? ';' : ':'),
    }
    let child
    try {
      child = spawn(node, [script, ...args], {
        cwd: cwd || process.cwd(),
        env,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      if (input !== undefined) child.stdin.end(input)
    } catch (error) {
      resolve({ ok: false, error: cleanError(error && error.message) })
      return
    }
    const chunks = []
    const errChunks = []
    let size = 0
    let timedOut = false
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已退出 */
      }
    }, timeoutMs)
    child.stdout.on('data', (buf) => {
      size += buf.length
      if (size > 16 * 1024 * 1024) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已退出 */
        }
        return
      }
      chunks.push(buf)
    })
    child.stderr.on('data', (buf) => errChunks.push(buf))
    child.on('error', (error) => finish({ ok: false, error: cleanError(error && error.message) }))
    child.on('close', (code) => {
      if (timedOut) {
        finish({ ok: false, error: `命令超时（${Math.round(timeoutMs / 1000)}s）。` })
        return
      }
      const stdout = Buffer.concat(chunks).toString('utf8')
      const stderr = Buffer.concat(errChunks).toString('utf8')
      const parsed = parseStdout(stdout)
      if (code !== 0) {
        finish({
          ok: false,
          code,
          error: cleanError(stderr) || cleanError(parsed.text) || `yingma 退出码 ${code}`,
          data: parsed.data,
        })
        return
      }
      finish({
        ok: true,
        code: 0,
        data: parsed.data,
        text: parsed.text,
        warning: cleanError(stderr) || undefined,
      })
    })
  })
}

// ---- 具体命令 ----

export const cliVersion = () => runCli(['--version'], { timeoutMs: 20_000, parallel: true })
export const authStatus = () => runCli(['auth', 'status'], { timeoutMs: 20_000, parallel: true })
export const accountMe = () => runCli(['account', 'me'], { timeoutMs: 20_000, parallel: true })
export const listProjects = (limit = 80) =>
  runCli(['project', 'list', '--limit', String(limit)], { timeoutMs: 60_000, parallel: true })
export const listCanvases = (projectId) =>
  runCli(['canvas', 'list', '--project', projectId], { timeoutMs: 60_000, parallel: true })
export const useCanvas = (projectId, canvasId) =>
  runCli(['canvas', 'use', canvasId, '--project', projectId], { timeoutMs: 60_000 })
// 网页授权登录：发起拿到确认码和授权页地址；device_code 通过 stdin 回传轮询，不进进程列表
export const startWebLogin = (origin) =>
  runCli(['auth', 'web-start', '--client', 'dsh', '--web-origin', origin, '--open'], { timeoutMs: 30_000 })
export const pollWebLogin = (deviceCode) =>
  runCli(['auth', 'web-poll', '--device-code-stdin'], { timeoutMs: 30_000, parallel: true, input: deviceCode })
export const logout = () => runCli(['auth', 'logout'], { timeoutMs: 30_000 })
export const createHandoff = () => runCli(['auth', 'handoff'], { timeoutMs: 30_000 })

// ---- 读写判断 ----

// 只列不改服务端状态的命令。interactive settings/vars/items 是 PATCH，
// canvas library 的 apply/place 和 pipeline collab 的 claim/release 都是写，不能按前缀整组算读。
const READ_PREFIXES = [
  ['--version'],
  ['version'],
  ['doctor'],
  ['auth', 'status'],
  ['account', 'me'],
  ['account', 'balance'],
  ['project', 'list'],
  ['project', 'stats'],
  ['project', 'get'],
  ['project', 'current'],
  ['canvas', 'list'],
  ['canvas', 'get'],
  ['canvas', 'summary'],
  ['canvas', 'validate'],
  ['canvas', 'diff'],
  ['canvas', 'export'],
  ['canvas', 'skill', 'list'],
  ['canvas', 'node', 'list'],
  ['canvas', 'node', 'inspect'],
  ['canvas', 'edge', 'list'],
  ['canvas', 'library', 'character-list'],
  ['script', 'get'],
  ['scene', 'list'],
  ['shot', 'list'],
  ['artifact', 'list'],
  ['episode', 'list'],
  ['pipeline', 'status'],
  ['pipeline', 'script-versions'],
  ['pipeline', 'delivery-plan'],
  ['interactive', 'get'],
  ['interactive', 'node', 'studio'],
  ['interactive', 'produce', 'status'],
  ['interactive', 'export', 'status'],
]

// 第三个词缺省或为 list 时才是读（CLI 里缺省就是 list）。
const LIST_DEFAULT = [
  ['pipeline', 'collab'],
  ['canvas', 'collab'],
]

/**
 * 和 CLI 的 parseArgs + dryRunFromOptions 同一套规则：后出现的覆盖先出现的；
 * 裸 --dry-run 后面跟着不以 -- 开头的词时，那个词是它的值；值为 false/0/no 算关闭。
 */
function dryRunRequested(args) {
  let on = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--no-dry-run') on = false
    else if (arg.startsWith('--dry-run=')) on = !['false', '0', 'no'].includes(arg.slice('--dry-run='.length).trim().toLowerCase())
    else if (arg === '--dry-run') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        on = !['false', '0', 'no'].includes(next.trim().toLowerCase())
        i += 1
      } else {
        on = true
      }
    }
  }
  return on
}

/** 读命令（不会改服务端状态）；--dry-run 也算不写。 */
export function isReadOnly(args) {
  if (dryRunRequested(args)) return true
  if (READ_PREFIXES.some((prefix) => prefix.every((part, i) => args[i] === part))) return true
  return LIST_DEFAULT.some(([area, action]) => {
    if (args[0] !== area || args[1] !== action) return false
    const next = args[2]
    return next === undefined || next === 'list' || next.startsWith('--')
  })
}

/** 补完 --project 之后的 argv 里取项目 ID，用于按项目记改动时间。 */
export function projectOf(args) {
  const found = explicitProject(args)
  return found.present && PROJECT_ID_RE.test(found.value) ? found.value : ''
}

const PROJECT_AREAS = new Set([
  'canvas',
  'script',
  'scene',
  'shot',
  'artifact',
  'episode',
  'pipeline',
  'interactive',
  'download',
])

// ---- 项目绑定 ----

/** 命令域是否需要项目；和 PROJECT_AREAS 共用一份定义。 */
export const commandNeedsProject = (args) => PROJECT_AREAS.has(args[0])

// 和 index.js 的 ID_RE 对齐：只接受像项目 ID 的字符串，避免脏数据进 argv。
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{4,80}$/

/** --project ID 和 --project=ID 两种写法都认；present 表示用户确实传了这个参数。 */
function explicitProject(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--project') return { present: true, value: args[i + 1] || '' }
    if (arg.startsWith('--project=')) return { present: true, value: arg.slice('--project='.length) }
  }
  return { present: false, value: '' }
}

/**
 * 读单个目录里的 .yingma/project.json，返回校验过的项目 ID。
 */
function projectFileIn(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, '.yingma', 'project.json'), 'utf8'))
    const id = parsed && typeof parsed.project_id === 'string' ? parsed.project_id.trim() : ''
    return PROJECT_ID_RE.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * 从目录向上找 .yingma/project.json（最多 6 层，像 git 找仓库那样）。
 * 只读——插件永远不会写这个文件，所以不会污染仓库，也不会和终端的 project use 打架。
 * @returns {{id: string, dir: string} | null}
 */
export function readDirProject(startCwd) {
  let dir = startCwd
  for (let depth = 0; dir && depth < 6; depth += 1) {
    const id = projectFileIn(dir)
    if (id) return { id, dir }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 给需要项目的命令定下 --project。
 * 优先级：显式 --project > 插件里选的项目 > 当前目录（向上找）的 .yingma/project.json。
 * 显式与插件选择不一致时回 warning：多项目来回切时，这是最容易静默打错项目的地方。
 * @returns {{args: string[], source: 'explicit'|'plugin'|'workspace'|'none', warning?: string}}
 */
export function resolveProjectArgs(args, { projectId, cwd } = {}) {
  if (!PROJECT_AREAS.has(args[0])) return { args, source: 'none' }

  const explicit = explicitProject(args)
  if (explicit.present) {
    // 只传了 --project 却没给值：保持原样交给 CLI 报错，别再补一个，否则会拼出
    // `--project --project <id>` 这种畸形 argv。
    const warning =
      explicit.value && projectId && projectId !== explicit.value
        ? `本次命令显式用了 --project ${explicit.value}，但侧栏「小影马画布」当前选的是 ${projectId}。确认没切错项目再继续。`
        : undefined
    return warning ? { args, source: 'explicit', warning } : { args, source: 'explicit' }
  }
  if (projectId) return { args: [...args, '--project', projectId], source: 'plugin' }

  const local = readDirProject(cwd)
  if (local) return { args: [...args, '--project', local.id], source: 'workspace' }

  return { args, source: 'none' }
}
