---
name: yingma-cli
description: 使用 yingma CLI 管理小影马 Agent 流水线、无限画布与互动影游项目、剧本、分镜和生成任务。
---

# 小影马 Agent CLI

使用 `yingma` CLI 操作小影马（yingma.tv）的 Agent 流水线和无限画布。CLI 调用小影马公开 API；本地脚本、认证信息和项目绑定均由当前用户控制。

## 初次安装与交接

首次安装、运行 `yingma doctor` 以及将检查结果交给用户时，阅读 [references/installation.md](references/installation.md)。

用户要求登录时，运行 `yingma auth login --web`：CLI 会在浏览器打开小影马授权页，用户登录网页、核对确认码后点「授权」，CLI 自动拿到令牌（最长等 10 分钟）。只有用户明确要求用验证码登录时，才用不带 `--web` 的 `yingma auth login`。未获得登录授权时，安装完成后只运行 `yingma doctor`。认证令牌仅保存在 `~/.yingma/config.json`，不要打印、提交或发送令牌、验证码、密码或配置文件内容。

## 对话引导

按「先读 → 给方案与预演 → 等确认 → 执行后回报」推进：

1. 先复述创作目标、已有素材、目标项目，以及尚未获得授权的动作。读取项目、画布、节点、场次和成片状态；没有项目 ID 时请用户选择，不要猜测。
2. 对写入、模型任务、媒体处理、删除或导入，先给出最小方案和受影响的项目/节点；能预演的先加 `--dry-run`。预演不是执行。
3. 只有用户明确确认具体目标后，才使用对应写命令；模型任务、视频/音频处理、删除、导入、脚本资产提取与协作占用还必须带 `--yes`。
4. 每次执行后，简洁返回真实的项目 ID、画布/节点 ID、任务状态和下一步。生成、渲染或后续修改仍要再次等待确认。

只覆盖 Agent 流水线、无限画布和互动影游；不要偏离这三条已开放的创作路径。

需要完整的 Agent 对话模板与确认话术时，阅读 [references/agent-guidance.md](references/agent-guidance.md)。

## 工作方式

- 在项目目录运行 yingma project use PROJECT_ID，把默认项目写入 .yingma/project.json。该命令会先校验项目访问权限；随后命令可省略 --project。使用 yingma project current 检查绑定，yingma project unuse 解除绑定。
- 使用 `yingma download --url URL --output FILE` 下载节点或资产返回的站内媒体 URL；CDN URL 还需当前项目或 `--project`，CLI 会通过项目导出权限签发短期下载链。不要用脚本读取或打印本地令牌。
- 先用 yingma project create 创建项目；用 yingma script save 写入剧本草稿；读取场景和分镜分别用 yingma scene list 与 yingma shot list。需要无限画布时，创建时传 --kind canvas。
- 画布通过 yingma canvas list、canvas summary、canvas use、canvas node、canvas edge、canvas connect 和 canvas connect-many 操作。`canvas snippet apply`、`canvas library`、节点复制和定点上传可快速铺设内容。画布内 Agent 对话不通过 CLI 开放。主体节点可用 canvas subject 上传图片/音色并拼主体图。
- Agent 流水线通过 `pipeline status`、`pipeline collab`、剧本/场次/分镜读取、素材、关键帧、视频与成片命令操作。互动影游通过 `interactive` 命令组管理图结构、脚本、节点、连线、变量、生产与发布。
- 每个写命令都可加 --dry-run 预览将发送的方法、URL 与请求体，不会发送写请求。画布范围的预演必须传 --canvas CANVAS_ID，避免读取或猜测当前画布。
- 导入画布前先运行 yingma canvas validate 和 yingma canvas diff --file STATE.json。CLI 会阻止包含重复 ID、悬空连线、无效节点类型或无效 active_canvas_id 的全量导入。
- 用 yingma canvas node inspect --id NODE_ID 查看节点的入边与出边；连线必须指向不同节点，节点类型和生成参数会在本地先校验。
- 会启动模型任务或导出成片的命令必须携带 --yes：script develop、asset generate、keyframe generate、video generate、episode render、interactive produce/assets/export，以及 canvas node run、canvas node generate、storyboard-preview 和脚本节点生成命令。所有互动影游写入、Snippet/素材库落画布、主体素材写入、媒体精修、删除或复制节点也必须带 --yes。
- 多人协作优先用 yingma canvas collab 查看占用；需要编辑指定节点时才用 `yingma canvas collab claim --nodes NODE_ID --yes`，完成后及时 release。旧的 `canvas session` 仅用于兼容已有工作流。
- 普通读取优先使用 project list、project get、artifact list、episode list，不要改用网页抓取或自行拼接未核验 API。

## 命令参考

## 命令与工作流

- 安装、认证、项目绑定、无限画布、提示词和媒体处理命令见 [references/commands.md](references/commands.md)。
- 从项目绑定到画布生成、精修和成片渲染的可复制工作流见 [references/workflows.md](references/workflows.md)。

当命令帮助与参考不一致时，以 `yingma --help` 为准。

## 边界

- 只操作用户已授权的账户、团队和项目。没有账号或令牌时，提示用户自行完成登录。
- 不调用管理端接口，不读取浏览器 Cookie、本地存储或其他应用的凭据。
- 如果接口返回 401，提示用户重新登录；不要尝试绕过认证。
- 不为用户自动发验证码、创建项目、提交生成或渲染任务。必须由用户明确请求相应命令；生成与渲染仍需 --yes。
- 不用 canvas import 或 canvas patch 代替对已有画布的小修改；优先使用节点、连线和画布层级的精确命令。
- 未确认画布差异前，不执行 canvas import；如果校验出现错误，停止并修正状态文件，而不是使用强制覆盖。
