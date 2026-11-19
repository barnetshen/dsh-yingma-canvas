# 小影马 CLI 工作流

以下流程只使用已实现的命令。读取、校验和预演可以先执行；会消耗额度、提交后台任务、删除内容或覆盖画布状态的操作仍需要用户明确确认与 `--yes`。每一步执行后先回报真实结果，不要自动接着生成或渲染。

## 0. 安装后自检

```bash
yingma doctor
yingma auth status
```

`doctor` 会显示 CLI 版本、令牌来源（不显示令牌本身）及当前目录的项目绑定状态。未登录时，按验证码登录流程完成认证；未绑定项目时，先列出项目并选定目标。

```bash
yingma project list --limit 20 --scope mine
yingma project use PROJECT_ID
yingma canvas summary
```

## 1. 已有项目的安全诊断

当用户只要求“看看项目”或“找问题”时，只读状态并回报最小修复建议：

```bash
yingma project get
yingma canvas summary
yingma canvas node list
yingma artifact list
yingma episode list
```

如果需要实际修改，先列出受影响节点和预演命令；不要将诊断直接升级为写入或生成。

## 2. 从想法到可检查的剧本

```bash
yingma project create --title "雨夜追凶" --idea "失踪案引出旧城秘密" --kind pipeline --locale zh --use
yingma script save --file ./episode-01.md
yingma script develop --feedback "强化结尾悬念" --yes --dry-run
```

先检查预演结果中的项目与请求内容，确认后再去掉 `--dry-run` 发起剧本生成。完成后以真实数据继续，而不要自行编造标识符：

```bash
yingma scene list
yingma shot list
yingma artifact list
```

需要取回生成结果时，从节点或资产响应复制真实 URL，再由 CLI 下载，不要自行读取认证配置：

```bash
yingma download --url /storage/PROJECT_ID/canvas/assets/voice.mp3 --output ./voice.mp3 --dry-run
yingma download --url /storage/PROJECT_ID/canvas/assets/voice.mp3 --output ./voice.mp3
```

## 3. 画布的安全修改

```bash
yingma canvas list
yingma canvas create --name "第一集分镜"
yingma canvas use CANVAS_ID
yingma canvas node add --canvas CANVAS_ID --kind text --label "开场" --text "雨夜的旧巷" --x 120 --y 80 --dry-run
yingma canvas node add --canvas CANVAS_ID --kind text --label "开场" --text "雨夜的旧巷" --x 120 --y 80
yingma canvas summary
```

需要全量修改前，先导出、校验并比较差异：

```bash
yingma canvas export --output ./canvas-before.json
yingma canvas validate
yingma canvas diff --file ./canvas-next.json
yingma canvas import --file ./canvas-next.json --yes --dry-run
```

确认差异正确后，去掉 `--dry-run` 才可导入。小范围编辑优先使用 `canvas node`、`canvas edge` 和 `canvas connect`，避免使用全量导入。

## 4. 生成与交付

先检查节点和生成请求：

```bash
yingma canvas node inspect --id NODE_ID
yingma canvas node generate --id NODE_ID --skill image --prompt "雨夜霓虹旧巷" --aspect 9:16 --image-count 1 --yes --dry-run
```

确认目标、参数与费用后，才发起真实任务：

```bash
yingma canvas node generate --id NODE_ID --skill image --prompt "雨夜霓虹旧巷" --aspect 9:16 --image-count 1 --yes
yingma episode list
yingma episode render --episode 1 --include-bgm --yes --dry-run
```

渲染同样应在预演确认后再去掉 `--dry-run`。多人编辑时，先查看占用、只认领自己要编辑的节点，完成后及时释放：

```bash
yingma canvas collab
yingma canvas collab claim --nodes NODE_ID --yes --dry-run
yingma canvas collab claim --nodes NODE_ID --yes
yingma canvas collab release --nodes NODE_ID --yes
```

脚本节点现在可以先生成逐镜分镜预览，再决定视频生成是否采用预览图：

```bash
yingma canvas node storyboard-preview --id SCRIPT_NODE --yes --dry-run
yingma canvas node script-batch --id SCRIPT_NODE --scope videos --use-storyboard-preview --yes --dry-run
```

两条命令都会调用生成能力。预览完成并经用户检查后，才执行第二条真实请求。

复用结构时可预演 `canvas snippet apply`，或先读取 `canvas library character-list`。脚本表格可以用 `script-patch` 精确更新，再用 `script-generate-nodes --nodes SHOT_ID,...` 只铺指定镜头；已有节点结构可用 `node duplicate` 复制，避免全量导入画布。画布内 Agent 对话不通过 CLI 开放。

## 6. Agent 流水线与互动影游

流水线先查看状态与协作占用，再认领具体场、镜或素材；互动影游先检查完整图，再修改节点和连线：

```bash
yingma pipeline status
yingma pipeline collab list
yingma pipeline collab claim --kind shot --id SHOT_ID --yes --dry-run
yingma interactive get
yingma interactive node add --type video --title "新分支" --after NODE_ID --yes --dry-run
yingma interactive edge connect --source NODE_ID --target NEW_NODE_ID --yes --dry-run
yingma interactive produce status
```

互动影游的 `script confirm`、`produce start`、节点分镜/合成与 `export start` 可能启动后台任务或消耗额度，必须逐项预演并获得用户确认。

## 5. 先优化提示词，再精修视频

先从节点读取现有提示词或视频状态，再提交可审查的后台任务。下面只展示预演；用户确认目标节点和参数后才去掉 `--dry-run`：

```bash
yingma canvas node inspect --id VIDEO_NODE
yingma canvas prompt optimize-video --id VIDEO_NODE --prompt "主角从雨夜巷口冲出，镜头跟拍" --duration 8 --yes --dry-run
yingma canvas video trim --id VIDEO_NODE --start-sec 1.5 --end-sec 6.5 --yes --dry-run
yingma canvas video hd --id VIDEO_NODE --resolution 2k --interpolate 60 --yes --dry-run
```

视频重拍、裁剪、分割、变帧、擦除、音画分离、景深，图片擦除和音频剪辑同样遵循这一顺序。提交后重新执行 `yingma canvas node inspect --id NODE_ID` 或 `yingma canvas summary` 检查平台返回的状态；不要凭预演结果宣称任务已完成。正在运行且平台允许取消的媒体任务可用 `yingma canvas node media-cancel --id NODE_ID --yes --dry-run` 先预演。
