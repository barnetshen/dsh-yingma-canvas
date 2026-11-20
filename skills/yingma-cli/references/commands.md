# 小影马 CLI 命令参考

CLI 默认调用 https://api.yingma.tv。只有在已明确授权的兼容部署中才设置 YINGMA_API_BASE。自动化环境可设置 YINGMA_TOKEN；其他情况下使用登录命令保存的本机会话。

## 安装与认证

    bash scripts/install-yingma-cli.sh
    yingma auth login --web
    yingma auth login
    yingma auth login --email you@example.com
    yingma auth login --phone 13800000000

`auth login --web`（推荐）在浏览器打开小影马授权页（`/cli/authorize`），在网页上用任意方式登录、核对确认码后点「授权」，CLI 轮询拿到令牌。授权页地址默认由 API 地址推出（`api.X` → `X`，本地 8181 → 3000），可用 `--web-origin` 或 `YINGMA_WEB_ORIGIN` 指定；`--no-open` 只打印链接；`--client workbuddy|doubao|dsh` 让授权页显示是哪个客户端在请求（连接器配置里已带上，平时不用手动传）。登录成功只输出用户 ID，不打印手机号等账号信息。程序化调用用 `auth web-start [--client dsh] [--open]` 发起、`auth web-poll --device-code-stdin` 轮询一次。

不带 `--web` 的交互式登录会自动获取并打开图形验证码，然后继续询问邮件或短信验证码。CI 或无交互终端仍可使用 `auth captcha`、`request-email|request-sms`、`login-email|login-sms` 分步完成。

Other credential commands:

    yingma auth login-password --account you@example.com --captcha-id ID --captcha-code CODE --password-stdin
    printf '%s' TOKEN | yingma auth set-token --token-stdin
    yingma auth status
    yingma auth logout
    yingma auth handoff

`auth handoff` 生成一次性 embed 登录码（90 秒、只能兑换一次），给 `/embed/canvas` 页面在 iframe 里换 token；普通用户不需要手动执行。

Password and token stdin modes keep secrets out of shell history. Captcha output is local-only and the output file should not be committed.

## 项目生命周期

    yingma project list --limit 20 --scope mine
    yingma project create --title "雨夜追凶" --idea "悬疑短剧梗概" --kind pipeline --locale zh
    yingma project use PROJECT_ID
    yingma project current
    yingma doctor
    yingma project get
    yingma project get --project PROJECT_ID
    yingma project unuse

Kinds are `pipeline` and `canvas`. Locales are zh, en, ja, ko, es, fr, de, and pt. Project creation and editing modify the account but do not start a generation task.

`yingma project use` 会先校验项目访问权限，再写入当前目录的 `.yingma/project.json`。`yingma doctor` 不发起网络请求，可用于检查本机 CLI、登录态与目录绑定。

## 剧本与制作信息读取

    yingma script get
    yingma script save --file ./episode-01.md
    yingma script save --text "第一集：雨夜..."
    yingma scene list
    yingma shot list
    yingma artifact list
    yingma episode list

All of these use the current project unless --project is supplied.

## 媒体下载

从节点、资产或成片响应中取得真实的 `url` 后，可直接下载。站内 `/storage/...` URL 会自动使用本机登录态；令牌只放在请求头，不会打印。默认拒绝覆盖已有文件：

    yingma download --url /storage/PROJECT_ID/canvas/assets/voice.mp3 --output ./voice.mp3
    yingma download --url https://oss.yingma.tv/PROJECT_ID/path/audio.mp3 --project PROJECT_ID --output ./audio.mp3
    yingma download --url URL --output ./result.mp3 --force

外部 CDN URL 会先通过项目的下载权限签发短期下载链，因此必须绑定项目或传 `--project`。可先加 `--dry-run` 检查源地址、输出路径及是否会发送站内凭证；预演不会下载文件，也不会显示令牌。

## 无限画布

Create a canvas project with project create --kind canvas, then select the project as usual. The current canvas is server-side; canvas use changes it for the project.

    yingma canvas list
    yingma canvas summary
    yingma canvas create --name "开场设计"
    yingma canvas use CANVAS_ID
    yingma canvas rename --canvas CANVAS_ID --name "第一集"
    yingma canvas view --mode workflow
    yingma canvas node list
    yingma canvas node add --kind text --label "故事梗概" --text "雨夜中的失踪案" --x 120 --y 80
    yingma canvas node move --id NODE_ID --x 320 --y 80
    yingma canvas node patch --id NODE_ID --label "修订梗概"
    yingma canvas connect --source SOURCE_NODE_ID --target TARGET_NODE_ID
    yingma canvas ref-spawn --source SOURCE_NODE_ID --kind image --x 560 --y 80
    yingma canvas edge list
    yingma canvas skill list

Canvas node kinds are text, image, video, audio, script, frame_breakdown, director, assemble, group, and subject. Use real node and canvas IDs from canvas list or canvas node list.

`canvas node list` 和 `canvas edge list` 默认只输出精简字段并分页（每页 30 条）：节点给 `id`、`kind`、`label`、`x`、`y`，以及有值时的 `title`（和 label 相同时省略）、`status`、`parent_group`、`shot_id`、`has_output`、`last_error`；连线给 `id`、`source`、`target`。结果带 `total` 和 `next_offset`，`next_offset` 不为 null 时用 `--offset` 翻下一页。大画布先看 `canvas summary`，再按条件筛：

    yingma canvas node list --kind video --status failed
    yingma canvas node list --group GROUP_NODE_ID --edges
    yingma canvas node list --offset 30 --limit 30
    yingma canvas edge list --node NODE_ID

单个节点的完整字段用 `canvas node inspect --id NODE_ID`；确实需要整页完整节点时加 `--full`。`canvas get` 输出整份画布状态，几百个节点时有几 MB，只用于导出、比对等需要完整状态的场景。

批量挂参考时可一次提交 1–64 条连线。文件是一个包含 `source_node_id`、`target_node_id`，以及可选 handle/edge ID 的 JSON 数组：

    yingma canvas connect-many --links-file ./links.json --dry-run

从节点的加号向右生成后续节点使用默认的 `generate`；向左补充上下文时使用 `context`：

    yingma canvas ref-spawn --source VIDEO_NODE --kind subject --direction context --dry-run

Back up and restore complete canvas state:

    yingma canvas export --output ./canvas-state.json
    yingma canvas validate
    yingma canvas diff --file ./canvas-state.json
    yingma canvas import --file ./canvas-state.json --yes

Import replaces the full remote state. The CLI blocks structural errors such as duplicate IDs, dangling edges, invalid node kinds, and an active canvas that does not exist. Use canvas patch --file PATCH.json --yes only when the file is a verified CanvasGraphPatch; ordinary changes should use the specific node, edge, and canvas commands. Removing a node or edge is destructive and needs explicit confirmation:

    yingma canvas node remove --id NODE_ID --yes
    yingma canvas edge remove --id EDGE_ID --yes

Inspect a node before changing or running it:

    yingma canvas node inspect --id NODE_ID

## 预演与校验

Add --dry-run to a write operation to print the request without sending it. The preview itself does not need login, but commands that require the existing remote canvas state, such as node move, still need read access. A canvas-scoped dry run must name the canvas explicitly because it does not fetch the active canvas:

    yingma project create --title "雨夜追凶" --dry-run
    yingma canvas node add --canvas CANVAS_ID --kind text --text "第一幕" --dry-run
    yingma canvas node generate --project PROJECT_ID --id IMAGE_NODE --prompt "雨夜巷道" --yes --dry-run
    yingma canvas import --project PROJECT_ID --file ./canvas-state.json --yes --dry-run

The CLI validates canvas node kinds locally. Skill generation also checks duration from 4 to 30 seconds and image/video counts from 1 to 4 before submitting.

真实执行 `canvas node add` 时，CLI 会先读取当前画布版本，将 `rev` 随增量补丁发送，并验证返回图中确实出现新节点；遇到一次并发版本变化会以相同节点 ID 和最新 `rev` 重试一次，避免“返回成功但节点未创建”。

For the platform canvas model operations, require explicit confirmation:

    yingma canvas node run --id NODE_ID --prompt "夜雨巷战" --yes
    yingma canvas node generate --id IMAGE_NODE --prompt "雨夜霓虹巷道" --skill image --aspect 9:16 --image-count 1 --yes
    yingma canvas node generate --id IMAGE_NODE --prompt "换一版构图" --replace-candidates --yes --dry-run
    yingma canvas node script-generate --id SCRIPT_NODE --prompt "写一段反转结尾" --yes
    yingma canvas node script-compose --id SCRIPT_NODE --kind both --shot-ids s001,s002 --yes
    yingma canvas node script-spawn --id SCRIPT_NODE --kind video --shot-ids s001,s002 --yes
    yingma canvas node storyboard-preview --id SCRIPT_NODE --yes --dry-run
    yingma canvas node storyboard-preview --id SCRIPT_NODE --shot-ids s001,s002 --yes --dry-run
    yingma canvas node script-patch --id SCRIPT_NODE --file ./script-patch.json --yes --dry-run
    yingma canvas node script-generate-nodes --id SCRIPT_NODE --nodes s001,s002 --use-storyboard-preview --yes --dry-run
    yingma canvas node script-batch --id SCRIPT_NODE --scope videos --shot-ids s001,s002 --use-storyboard-preview --yes
    yingma canvas node duplicate --nodes IMAGE_NODE,VIDEO_NODE --offset-x 48 --offset-y 48 --yes --dry-run
    yingma canvas node media-cancel --id VIDEO_NODE --yes --dry-run

Upload can create an unplaced asset or target an existing node and canvas position:

    yingma canvas upload --file ./reference.png
    yingma canvas upload --file ./reference.mp4 --kind video --target VIDEO_NODE --x 720 --y 240 --dry-run

Reusable snippets and platform libraries can place prepared structures and assets onto the canvas:

    yingma canvas snippet apply --skill cinematic --x 320 --y 180 --yes --dry-run
    yingma canvas snippet apply --file ./snippet.json --x 320 --y 180 --yes --dry-run
    yingma canvas library character-list
    yingma canvas library character-apply --id ARCHETYPE_ID --yes --dry-run
    yingma canvas library starter-apply --ids STARTER_A,STARTER_B --yes --dry-run
    yingma canvas library team-place --team TEAM_ID --asset ASSET_ID --x 640 --y 180 --yes --dry-run

For a coordinated edit session:

    yingma canvas collab
    yingma canvas collab claim --nodes NODE_ID --yes --dry-run
    yingma canvas collab release --nodes NODE_ID --yes

Only claim nodes that the user has asked to edit, and release them as soon as that edit is complete. `canvas session acquire|release|heartbeat` remains available for compatibility with existing workflows; prefer node-level claims for new work.

## 提示词处理

提示词翻译、优化与反推会调用平台模型，且可能写回节点。先检查节点，再预演并等待确认：

    yingma canvas node inspect --id VIDEO_NODE
    yingma canvas prompt translate --node TEXT_NODE --text "雨夜巷道追逐" --target en --yes --dry-run
    yingma canvas prompt optimize-image --id IMAGE_NODE --prompt "雨夜的旧巷" --skill cinematic --aspect 9:16 --yes --dry-run
    yingma canvas prompt optimize-video --id VIDEO_NODE --prompt "主角冲出巷口" --duration 8 --yes --dry-run
    yingma canvas prompt reverse --id IMAGE_OR_VIDEO_NODE --yes --dry-run

确认后再去掉 `--dry-run`。`translate` 不带 `--node` 时只返回翻译文本，但仍会调用模型，因此同样需要用户确认与 `--yes`。

## 视频与音频精修

视频精修以现有视频节点为输入；所有命令都会提交后台任务或创建后续节点，必须先用 `--dry-run` 确认目标和参数：

    yingma canvas video reshoot --id VIDEO_NODE --start-sec 1.5 --end-sec 6.5 --yes --dry-run
    yingma canvas video clone --id VIDEO_NODE --yes --dry-run
    yingma canvas video trim --id VIDEO_NODE --start-sec 1.5 --end-sec 6.5 --mute --yes --dry-run
    yingma canvas video split --id VIDEO_NODE --ranges-file ./ranges.json --yes --dry-run
    yingma canvas video crop --id VIDEO_NODE --x 0.1 --y 0.1 --w 0.8 --h 0.8 --yes --dry-run
    yingma canvas video hd --id VIDEO_NODE --resolution 2k --interpolate 60 --slowmo 1 --yes --dry-run
    yingma canvas video fps --id VIDEO_NODE --fps 24 --yes --dry-run
    yingma canvas video frame --id VIDEO_NODE --kind current --at-sec 3.2 --yes --dry-run
    yingma canvas video erase --id VIDEO_NODE --boxes-file ./boxes.json --fill delogo --yes --dry-run
    yingma canvas video av-split --id VIDEO_NODE --yes --dry-run
    yingma canvas video depth --id VIDEO_NODE --yes --dry-run
    yingma canvas image erase --id IMAGE_NODE --boxes-file ./boxes.json --fill color --color '#ffffff' --yes --dry-run
    yingma canvas audio edit --id AUDIO_NODE --action speed --rate 1.15 --yes --dry-run
    yingma canvas director screenshot --id DIRECTOR_NODE --file ./director-markup.png --label "机位标注" --yes --dry-run

`ranges.json` 是一个时间段数组，例如 `[ {"id":"part-1","start_sec":1.5,"end_sec":6.5} ]`。图片和视频区域擦除需要 `--boxes` 或 `--boxes-file`；每个框使用标准化的 `x`、`y`、`w`、`h`（0–1）。`--fill color` 时可用 `--color` 指定颜色。裁剪区域也必须完全落在 0–1 的画面范围内。变帧只接受 12、24、30 或 60 fps。

## 主体节点

主体节点可同时保存主体图和参考音色，并作为视频节点的复合参考。先上传素材；若有侧面图，再用平台返回的项目媒体路径拼主体图。两步都会写入项目，必须预演并确认：

    yingma canvas node add --canvas CANVAS_ID --kind subject --label "主体1" --dry-run
    yingma canvas subject upload --project PROJECT_ID --file ./lead.png --role image --yes --dry-run
    yingma canvas subject upload --project PROJECT_ID --file ./voice.mp3 --role voice --yes --dry-run
    yingma canvas subject sheet --project PROJECT_ID --main-path canvas/assets/MAIN.png --side-paths canvas/assets/LEFT.png,canvas/assets/RIGHT.png --yes --dry-run

上传和拼图只返回素材路径，不会自动写入主体节点。检查结果后，用 `canvas node patch --data-file` 精确更新目标主体节点，再用 `canvas connect` 或 `connect-many` 把主体接到视频节点。

## 脚本节点的资产准备

脚本节点可先抽取资产并只铺设节点，再由用户决定是否进行图片、视频或成片生成：

    yingma canvas node script-extract-assets --id SCRIPT_NODE --yes --dry-run
    yingma canvas node script-spawn-assets --id SCRIPT_NODE --yes --dry-run
    yingma canvas node script-compose --id SCRIPT_NODE --kind both --yes --dry-run

资产抽取和提示词合成会进入后台队列；不要把入队结果表述为已经生成完成。

## 消耗额度或耗时的操作

Each generation or render operation must include --yes after the user has explicitly confirmed its target and cost:

    yingma script develop --feedback "强化结尾悬念" --yes
    yingma asset generate --item CHARACTER_SLUG --count 2 --aspect 9:16 --yes
    yingma keyframe generate --shot SHOT_ID --count 1 --yes
    yingma video generate --shot SHOT_ID --count 1 --yes
    yingma episode render --episode 1 --include-bgm --yes

Use project get, scene list, shot list, and episode list to obtain real identifiers. Do not invent item, scene, shot, or project IDs.

## Agent 流水线与互动影游

流水线沿用现有 `script`、`scene`、`shot`、`asset`、`keyframe`、`video` 和 `episode` 命令，并增加状态、交付计划、剧本版本与协作认领：

    yingma pipeline status
    yingma pipeline script-versions
    yingma pipeline delivery-plan
    yingma pipeline collab list
    yingma pipeline collab claim --kind shot --id SHOT_ID --yes --dry-run
    yingma pipeline collab release --kind shot --id SHOT_ID --yes

互动影游使用独立命令组。所有写命令都要 `--yes`；先读取图与生产状态，再预演修改：

    yingma interactive get
    yingma interactive settings --data '{"orientation":"portrait"}' --yes --dry-run
    yingma interactive node add --type video --title "开场" --x 120 --y 80 --yes --dry-run
    yingma interactive node patch --id NODE_ID --file ./node-patch.json --yes --dry-run
    yingma interactive edge connect --source NODE_A --target NODE_B --label "选择 A" --yes --dry-run
    yingma interactive script save --file ./interactive-script.md --yes --dry-run
    yingma interactive script scene-add --title "雨夜入口" --chapter CHAPTER_ID --yes --dry-run
    yingma interactive script confirm --yes --dry-run
    yingma interactive produce status
    yingma interactive produce start --yes --dry-run
    yingma interactive node studio --id NODE_ID
    yingma interactive node storyboard --id NODE_ID --yes --dry-run
    yingma interactive export start --yes --dry-run
    yingma interactive export status
