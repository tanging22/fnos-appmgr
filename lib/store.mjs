// 应用清单的读写。只有一条铁律：任何一次写磁盘都不能留下半截文件。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

export const BASE_DIR = process.env.APPMGR_BASE ?? join(HERE, '..')
export const DATA_DIR = process.env.APPMGR_DATA ?? join(BASE_DIR, 'data')
export const LOG_DIR = join(DATA_DIR, 'logs')
export const RUN_DIR = join(DATA_DIR, 'run')
export const APPS_FILE = join(DATA_DIR, 'apps.json')

// 贴进来的代码落在这里，一个程序一个目录。放在 data 下面是为了跟 apps.json
// 一起被备份/迁移时带走，省得用户还要自己去别处找脚本文件。
export const APP_SRC_DIR = join(DATA_DIR, 'apps')

export function ensureDirs() {
  for (const dir of [DATA_DIR, LOG_DIR, RUN_DIR]) mkdirSync(dir, { recursive: true })
}

export function loadApps() {
  ensureDirs()
  if (!existsSync(APPS_FILE)) return { apps: [] }
  try {
    const raw = readFileSync(APPS_FILE, 'utf8')
    if (!raw.trim()) return { apps: [] }
    const parsed = JSON.parse(raw)
    return { apps: Array.isArray(parsed?.apps) ? parsed.apps : [] }
  } catch (error) {
    // 坏掉的清单不能静默丢掉：改名留档，人还能自己捞回来。
    const backup = `${APPS_FILE}.corrupt-${Date.now()}`
    try { renameSync(APPS_FILE, backup) } catch { /* 留档失败也不拦启动 */ }
    console.error(`[appmgr] apps.json 解析失败 (${error?.message ?? error})，已另存为 ${backup}，本次按空清单启动`)
    return { apps: [] }
  }
}

export function saveApps(state) {
  ensureDirs()
  const tmp = `${APPS_FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, APPS_FILE)
}
