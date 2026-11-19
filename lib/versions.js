// 版本信息：插件版本、随包 CLI、系统 CLI、仓库 CLI。
// “检查更新”只查能查的来源：插件走 npm（未发布就是本地版），CLI 对比仓库/系统里比随包新的版本。
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const VERSION_RE = /const VERSION = '([^']+)'/

function readVersion(file) {
  try {
    const match = VERSION_RE.exec(readFileSync(file, 'utf8'))
    return match ? match[1] : null
  } catch {
    return null
  }
}

export function pluginVersion() {
  try {
    const data = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  }
}

export function bundledCliVersion() {
  return readVersion(join(ROOT, 'skills', 'yingma-cli', 'scripts', 'yingma.js'))
}

export function installedCliVersion() {
  const file = join(homedir(), '.yingma', 'bin', process.platform === 'win32' ? 'yingma.cmd' : 'yingma')
  return existsSync(file) ? readVersion(file) : null
}

// 插件以 link 方式装在仓库里时，../.. 就是仓库根；打包安装时这个文件不存在。
export function repoCliVersion() {
  const file = join(ROOT, '..', '..', 'skills', 'yingma-cli', 'scripts', 'yingma.js')
  return existsSync(file) ? readVersion(file) : null
}

async function npmLatest(name, timeoutMs = 3500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return null
    const data = await response.json()
    return typeof data.version === 'string' ? data.version : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function versionReport(check) {
  const report = {
    plugin: {
      current: pluginVersion(),
      latest: null,
      checked: Boolean(check),
    },
    cli: {
      bundled: bundledCliVersion(),
      installed: installedCliVersion(),
      repo: repoCliVersion(),
      checked: Boolean(check),
    },
  }
  if (check) {
    report.plugin.latest = await npmLatest('dsh-yingma-canvas')
  }
  return report
}
