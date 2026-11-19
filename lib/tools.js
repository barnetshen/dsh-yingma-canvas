// 给模型的一个工具：在宿主机执行 yingma CLI。
// 它不经过模型的 bash 沙箱，所以能写 ~/.yingma/config.json 和 canvas-cache；
// 同时这里统一加 --project、拒绝令牌类参数、把 --yes 和用户确认绑在一起。
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { commandNeedsProject, isReadOnly, projectOf, resolveProjectArgs, runCli } from './cli.js'
import { readState, touchMutation } from './store.js'

const MAX_ARGS = 50
const MAX_ARG_LEN = 4000
const MAX_RESULT = 8000

const PARAMS = {
  type: 'object',
  additionalProperties: false,
  required: ['args'],
  properties: {
    args: {
      type: 'array',
      items: { type: 'string' },
      description:
        'CLI 参数数组，第一个是命令域，例如 ["canvas","summary"]、["canvas","node","list"]、["project","list"]。不要包含 node 或脚本路径。',
    },
    confirm: {
      type: 'boolean',
      description:
        '写操作带 --yes 时必须为 true。只在用户看过目标和参数、明确同意执行后设置；生成/渲染/删除/导入前必须确认。',
    },
    cwd: {
      type: 'string',
      description:
        '可选：本次命令的工作目录（绝对路径），用于「跟随目录」模式读取该目录的 .yingma/project.json。插件会自动探测会话工作目录，探测不到时再显式传这个。',
    },
  },
}

const FORBIDDEN_FLAGS = ['--token', '--token-stdin', '--password', '--password-stdin']

function badRequest(message) {
  return { ok: false, result: '', error: message }
}

// 和 CLI 的 parseArgs 同一套规则取位置参数：选项可以写在命令前面，
// `--json auth logout` 这种写法里 auth 不一定是 args[0]，甚至 `--x y auth logout` 的 y 是选项值。
function commandWords(args) {
  const words = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      words.push(arg)
      continue
    }
    if (arg.startsWith('--no-') || arg.includes('=')) continue
    if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) i += 1
  }
  return words
}

function validate(args, confirm) {
  if (!Array.isArray(args) || args.length === 0) return 'args 必须是非空的参数数组。'
  if (args.length > MAX_ARGS) return `参数太多（最多 ${MAX_ARGS} 个）。`
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg.trim()) return 'args 的每一项都必须是非空字符串。'
    if (arg.length > MAX_ARG_LEN) return '有一个参数太长。'
  }
  for (const arg of args) {
    if (FORBIDDEN_FLAGS.some((flag) => arg === flag || arg.startsWith(flag + '='))) {
      return '令牌和密码不允许通过这个工具传递；登录请让用户在侧栏「小影马画布」里完成。'
    }
  }
  const [area, action] = commandWords(args)
  if (area === 'auth' && action !== 'status') {
    return 'auth 只允许 status；登录、登出和 set-token 请走侧栏「小影马画布」的登录向导，不要由 Agent 执行。'
  }
  // CLI 把 --yes=true、--yes=1 也当确认，所以带等号的写法同样要 confirm。
  if (args.some((arg) => arg === '--yes' || arg.startsWith('--yes=')) && confirm !== true) {
    return '这条命令带 --yes，会真的改动画布或花钱。先用 --dry-run 把目标和参数给用户看，用户确认后再带 --yes 且 confirm: true。'
  }
  return null
}

// 这个工具在宿主机上跑 CLI，绕过了模型的文件沙箱。读文件的参数会把内容上传到影马，
// --output 会写本机文件，所以只放行会话工作目录里的路径，并挡掉凭据类目录和文件。
const PATH_FLAGS = ['--file', '--data-file', '--links-file', '--ranges-file', '--boxes-file', '--output']
const SENSITIVE_SEGMENTS = new Set(['.yingma', '.ssh', '.dsh', '.gnupg', '.aws', '.git'])

/** 按 CLI parseArgs 的规则取出路径参数：--flag=值，或 --flag 后面不以 -- 开头的那个词。 */
function pathArgs(args) {
  const found = []
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    for (const flag of PATH_FLAGS) {
      if (arg.startsWith(flag + '=')) found.push({ flag, value: arg.slice(flag.length + 1) })
      else if (arg === flag && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) {
        found.push({ flag, value: args[i + 1] })
      }
    }
  }
  return found
}

/** 解析符号链接；目标还不存在时（--output 新文件）解析最近一级存在的父目录。 */
function realTarget(target) {
  let current = target
  const rest = []
  for (;;) {
    try {
      return join(realpathSync(current), ...rest)
    } catch {
      const parent = dirname(current)
      if (parent === current) return target
      rest.unshift(basename(current))
      current = parent
    }
  }
}

function isSensitive(absolute) {
  return absolute.split(sep).some((part) => SENSITIVE_SEGMENTS.has(part)) || /^\.env(\.|$)/.test(basename(absolute))
}

/**
 * 根只认宿主给的会话目录（trustedRoot），模型传的 cwd 只决定相对路径从哪算，
 * 最终路径仍要落在会话目录里；否则模型传 cwd=~/.ssh 就能把私钥当"工作目录里的文件"读走。
 */
function checkPaths(args, cwd, trustedRoot, confirm) {
  const items = pathArgs(args)
  if (items.length === 0) return null
  if (!trustedRoot) {
    return '探测不到会话工作目录，不能读写本机文件。请让用户把文件放进项目目录，在那个目录里打开会话后再试。'
  }
  const root = realTarget(resolve(trustedRoot))
  const home = realTarget(homedir())
  // 会话开在 / 或 ~ 时，整个家目录都会被当成"工作目录"。
  if (root === home || !relative(root, home).startsWith('..') || root === parse(root).root || isSensitive(root)) {
    return `会话工作目录 ${root} 太宽或是凭据目录，不能读写本机文件。请在项目目录里打开会话。`
  }
  for (const { flag, value } of items) {
    const target = realTarget(resolve(cwd, value))
    const rel = relative(root, target)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      return `${flag} 只能指向会话工作目录 ${root} 里的文件，${value} 不在里面。`
    }
    if (isSensitive(target)) return `${flag} 不能指向凭据或配置文件（${value}）。`
  }
  if (items.some((item) => item.flag === '--output') && confirm !== true) {
    return '--output 会在本机写文件（已存在时可能覆盖）。先把输出路径给用户看，用户同意后把 confirm 设为 true。'
  }
  return null
}

function summarize(data, text) {
  if (data === null || data === undefined) return String(text || '').slice(0, MAX_RESULT)
  try {
    // 不缩进：同样 8000 字符能多装约四成内容，模型读紧凑 JSON 没有障碍。
    const json = JSON.stringify(data)
    return json.length > MAX_RESULT
      ? json.slice(0, MAX_RESULT) +
          `\n…（已截断，只显示了 ${json.length} 个字符里的前 ${MAX_RESULT} 个。列表用 --limit/--offset 分页或加筛选条件，单个节点用 canvas node inspect --id，概况用 canvas summary）`
      : json
  } catch {
    return String(text || '').slice(0, MAX_RESULT)
  }
}

/** 宿主给的会话工作目录；这是文件参数唯一可信的根，模型传的 cwd 不算。取不到返回空串。 */
function sessionCwd(extra) {
  const agent = extra && extra.agent
  const session = agent && agent.session
  const candidates = [
    extra && extra.cwd,
    extra && extra.workspaceRoot,
    extra && extra.sessionCwd,
    session && session.header && session.header.cwd,
    session && session.cwd,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value && existsSync(value)) return value
  }
  return ''
}

export const runTool = {
  name: 'yingma_run',
  description:
    '执行小影马的 yingma CLI（项目、无限画布、剧本/分镜、生成、媒体处理）。读命令直接跑；写命令先用 --dry-run 给用户看，确认后带 --yes 并把 confirm 设为 true。项目按「显式 --project > 插件里选的项目 > 当前目录 .yingma/project.json」自动补；显式 --project 和插件选择不一致时会返回 warning。返回 CLI 的 JSON。',
  parameters: PARAMS,
  timeoutMs: 240_000,
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok', 'result'],
      properties: {
        ok: { type: 'boolean' },
        result: { type: 'string' },
        error: { type: 'string' },
        warning: { type: 'string' },
      },
    },
    render: (_args, value) => {
      const text = value.ok ? value.result || '（无输出）' : `失败：${value.error || '未知错误'}`
      return [{ type: 'text', text: value.warning ? `${text}\n\n⚠️ ${value.warning}` : text }]
    },
  },
  async execute(args, extra) {
    const confirm = args && args.confirm
    let argv = args && args.args
    const invalid = validate(argv, confirm)
    if (invalid) return badRequest(invalid)

    const state = readState()
    const requestedCwd = args && typeof args.cwd === 'string' && args.cwd ? args.cwd : ''
    const trustedRoot = sessionCwd(extra)
    const cwd = requestedCwd || trustedRoot || process.cwd()
    const resolved = resolveProjectArgs(argv, { projectId: state.projectId, cwd })
    if (commandNeedsProject(argv) && resolved.source === 'none') {
      return badRequest(
        `还没有可用的项目：侧栏没选项目，${cwd}（含上级目录）也没有 .yingma/project.json。请在侧栏「小影马画布」里选一个，在项目目录跑 yingma project use PROJECT_ID，或显式传 --project PROJECT_ID。`
      )
    }
    argv = resolved.args
    const pathProblem = checkPaths(argv, cwd, trustedRoot, confirm)
    if (pathProblem) return badRequest(pathProblem)

    const mutation = !isReadOnly(argv)
    const result = await runCli(argv, {
      timeoutMs: mutation ? 200_000 : 90_000,
      cwd,
    })
    if (!result.ok) {
      // 切错项目经常就是失败原因，所以失败时也把不一致的告警带回去。
      const warnings = [resolved.warning, result.warning].filter(Boolean)
      return {
        ok: false,
        result: '',
        error: result.error || 'yingma 执行失败',
        ...(warnings.length ? { warning: warnings.join('\n') } : {}),
      }
    }
    if (mutation) touchMutation(projectOf(argv))
    const warnings = [resolved.warning, result.warning].filter(Boolean)
    return {
      ok: true,
      result: summarize(result.data, result.text),
      ...(warnings.length ? { warning: warnings.join('\n') } : {}),
    }
  },
}

export const TOOLS = [runTool]
