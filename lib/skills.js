// 把插件随包带的 yingma-cli skill 注册进 DSH 的 skill 目录。
// 用户自己在 ~/.agents/skills 或项目里装了同名 skill 时，那一份优先（本提供方 rank 600）。
// 加载正文时做两处改写：安装步骤和交互式登录在插件里不适用；末尾补插件环境下的工具用法。
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const RANK = 600
const INVOCATION = { modelInvocable: true, userInvocable: true }

function parse(file) {
  const text = readFileSync(file, 'utf8')
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return null
  const field = (k) =>
    (m[1].match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) || [])[1]?.trim().replace(/^(["'])(.*)\1$/, '$2')
  const name = field('name')
  const description = field('description')
  return name && description ? { name, description, body: text.slice(m[0].length) } : null
}

export function readSkills(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'SKILL.md')))
    .map((d) => ({ dir: join(dir, d.name), file: join(dir, d.name, 'SKILL.md'), ...parse(join(dir, d.name, 'SKILL.md')) }))
    .filter((s) => s.name)
}

// 独立仓库写给命令行安装的步骤，在插件里换成插件自己的做法。
const REWRITES = [
  [
    /首次安装、运行 `yingma doctor` 以及将检查结果交给用户时，阅读 \[references\/installation\.md\]\(references\/installation\.md\)。/,
    'CLI 由插件自带并在宿主机执行，不需要用户安装。`references/installation.md` 只作参考，不要照着执行安装脚本。要确认本机状态时用 `yingma_run` 运行 `["doctor"]`。',
  ],
  [
    /用户要求登录时，运行 `yingma auth login`，由 CLI 打开图形验证码并引导完成邮箱或短信验证。/,
    '用户要求登录时，请用户在侧栏「小影马画布」里完成登录（插件提供图形验证码和邮箱/短信验证码向导），不要运行交互式 `yingma auth login`。',
  ],
]

const ADDENDUM = `
---

## 在小影马画布插件（DSH）里使用

- **操作项目优先用 \`mcp__yingma__*\` 工具**（画布、流水线、互动影游）：参数有类型、改之前必须先读、写操作返回 \`op_id\` 可用 \`undo\` 撤销，删除和扣费会进入「待确认」，由用户在小影马页面上确认后执行——告诉用户去确认，再用 \`action_status\` 查结果，不要改用 CLI 绕过确认。工具跟着侧栏「小影马画布」里选的项目走，也可以用 \`yingma_project_use\` 切换。
- 批量处理、和本地文件/脚本配合（例如下载素材、本地剪辑后再上传）、以及剧本分集渲染等没有对应工具的功能，用下面的 CLI。
- CLI 由插件在宿主机执行。用 \`yingma_run\` 工具传 argv 数组运行命令，例如 \`{"args":["canvas","summary"]}\`；不要在 bash 里直接跑 \`yingma\`（宿主 PATH 里可能没有 node）。
- 插件里选的项目会由工具自动补 \`--project\`；要操作其他项目时显式传 \`--project PROJECT_ID\`。显式 \`--project\` 和插件选择不一致时，工具会返回 warning，先跟用户确认是不是切错了项目。没在插件里选项目时，工具会回退读当前目录（含上级目录）的 \`.yingma/project.json\`（只读，插件不会写这个文件因此不会污染仓库）；探测不到会话目录时，用工具的 \`cwd\` 参数显式指定工作目录。
- 登录由用户在侧栏「小影马画布」完成，不要运行 \`yingma auth login\`。
- 会改动画布、花钱或不可逆的命令：先用 \`--dry-run\` 把目标和参数给用户看；用户确认后再带 \`--yes\`，并把工具的 \`confirm\` 设为 \`true\`，否则工具会拒绝。
- \`--file\`、\`--data-file\`、\`--output\` 等文件参数只能指向会话工作目录里的文件，凭据类文件（\`.env\`、\`.ssh\`、\`.yingma\` 等）一律拒绝；\`--output\` 会写本机文件，先把路径给用户看，用户同意后设 \`confirm: true\`。
- 生成、渲染、删除、导入、媒体精修之后，简要回报真实的项目 / 画布 / 节点 ID 和任务状态，再等用户确认下一步。
`

export function createSkillProvider(dir) {
  const candidate = (s) => ({
    name: s.name,
    description: s.description,
    path: s.file,
    invocation: INVOCATION,
    source: 'bundled',
    provider: 'yingma-canvas',
    rank: RANK,
    locator: s.dir,
    resourceBase: { kind: 'directory', path: s.dir },
  })

  const load = (s) => {
    let body = s.body
    for (const [from, to] of REWRITES) body = body.replace(from, to)
    return body + ADDENDUM
  }

  return {
    name: 'yingma-canvas',
    async list() {
      return readSkills(dir).map(candidate)
    },
    async get(c) {
      const skill = readSkills(dir).find((s) => s.dir === c.locator && s.name === c.name)
      if (!skill) return undefined
      const { rank, locator, ...summary } = candidate(skill)
      return { ...summary, content: load(skill) }
    },
  }
}
