// 插件本地状态：只记用户选的项目、画布地址和最近一次改动时间。
// 存在 $DSH_HOME/yingma-canvas/state.json（默认 ~/.dsh/yingma-canvas）。
// 认证令牌不在这里：它只由 CLI 写入 ~/.yingma/config.json。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const dataDir = () =>
  join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'yingma-canvas')

const stateFile = () => join(dataDir(), 'state.json')

const DEFAULT_STATE = {
  projectId: null,
  projectTitle: '',
  origin: 'https://yingma.tv',
  // 画布里「画布助手」「加入对话」交给谁：dsh（DSH 的 Agent）或 yingma（小影马自带的画布助手）
  canvasAgent: 'dsh',
  // 项目 ID → Agent 最近一次改动它的时间。壳页按当前项目比较，切项目不会误报「画布有更新」。
  mutations: {},
}

const MAX_TRACKED = 50

export function readState() {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8'))
    return { ...DEFAULT_STATE, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export function writeState(patch) {
  const next = { ...readState(), ...patch }
  mkdirSync(dataDir(), { recursive: true })
  const tmp = stateFile() + '.' + process.pid
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
  renameSync(tmp, stateFile())
  return next
}

export function touchMutation(projectId) {
  if (!projectId) return readState()
  const mutations = { ...readState().mutations, [projectId]: Date.now() }
  const recent = Object.entries(mutations)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TRACKED)
  return writeState({ mutations: Object.fromEntries(recent) })
}
