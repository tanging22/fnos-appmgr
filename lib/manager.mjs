// 进程生命周期。这层的全部意义只有一句：程序死了要有人知道，而且要拉起来。
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { detectLanguage } from './detect.mjs'
import { BASE_DIR, LOG_DIR, RUN_DIR, ensureDirs, loadApps, saveApps, APP_SRC_DIR } from './store.mjs'

const TICK_MS = Number(process.env.APPMGR_TICK ?? 1500)
const MAX_LOG_BYTES = Number(process.env.APPMGR_LOG_MAX ?? 2 * 1024 * 1024)
const TERM_GRACE_MS = Number(process.env.APPMGR_TERM_GRACE ?? 5000)
// 稳定跑满这么久就把重启计数清零，否则偶发崩几次之后会永久罢工
const STABLE_MS = 60000

const PYTHON = process.env.APPMGR_PYTHON ?? '/usr/bin/python3'
const BASH = process.env.APPMGR_BASH ?? '/usr/bin/bash'
const GO = process.env.APPMGR_GO ?? '/usr/bin/go'

// 「程序类型」在这里落成具体命令行。go 源码走 go run，编好的二进制直接执行。
function resolveCommand(app) {
  const custom = (app.interpreter ?? '').trim()
  if (custom) return { cmd: custom, args: [app.path, ...(app.args ?? [])] }
  switch (app.type) {
    case 'node':
      return { cmd: process.execPath, args: [app.path, ...(app.args ?? [])] }
    case 'python':
      return { cmd: PYTHON, args: [app.path, ...(app.args ?? [])] }
    case 'go':
      return app.path.endsWith('.go')
        ? { cmd: GO, args: ['run', app.path, ...(app.args ?? [])] }
        : { cmd: app.path, args: [...(app.args ?? [])] }
    case 'bash':
      return { cmd: BASH, args: [app.path, ...(app.args ?? [])] }
    default:
      return { cmd: app.path, args: [...(app.args ?? [])] }
  }
}

export function isAlive(pid) {
  if (!pid || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ')
  } catch {
    return ''
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export class Manager {
  constructor() {
    ensureDirs()
    this.state = loadApps()
    this.procs = new Map() // id -> { pid, pgid, startedAt, restarts, stopping, child }
    this.crashed = new Set()
    this.lastExit = new Map()
    this.logWrites = new Map()
    this.timer = null
    this.adopt()
  }

  find(id) {
    return this.state.apps.find((app) => app.id === id) ?? null
  }

  persist() {
    saveApps(this.state)
  }

  runFile(id) {
    return join(RUN_DIR, `${id}.json`)
  }

  readRun(id) {
    try {
      return JSON.parse(readFileSync(this.runFile(id), 'utf8'))
    } catch {
      return null
    }
  }

  writeRun(id, info) {
    try {
      writeFileSync(this.runFile(id), `${JSON.stringify(info)}\n`, 'utf8')
    } catch { /* 记不住就算了，不能因为写不了状态文件而拦着进程 */ }
  }

  clearRun(id) {
    try { rmSync(this.runFile(id), { force: true }) } catch { /* ignore */ }
  }

  // 管理器自己被重启时，把上次还活着的子进程认回来，别当它不存在。
  adopt() {
    for (const app of this.state.apps) {
      const saved = this.readRun(app.id)
      if (!saved?.pid) continue
      if (!isAlive(saved.pid)) {
        this.clearRun(app.id)
        continue
      }
      const live = cmdlineOf(saved.pid)
      if (!live.includes(app.path)) {
        this.clearRun(app.id)
        continue
      }
      this.procs.set(app.id, {
        pid: saved.pid,
        pgid: saved.pgid ?? saved.pid,
        startedAt: saved.startedAt ?? Date.now(),
        restarts: saved.restarts ?? 0,
        stopping: false,
        child: null,
      })
    }
  }

  logPath(app) {
    return join(LOG_DIR, `${app.id}.log`)
  }

  appendLog(app, buf) {
    const path = this.logPath(app)
    try {
      appendFileSync(path, buf)
    } catch { /* 日志写不进去也不该让程序倒下 */ }
    const n = (this.logWrites.get(app.id) ?? 0) + 1
    this.logWrites.set(app.id, n)
    if (n % 100 === 0) this.rotateLog(app, path)
  }

  rotateLog(app, path) {
    try {
      if (statSync(path).size <= MAX_LOG_BYTES) return
      renameSync(path, `${path}.1`)
    } catch { /* 轮转失败不影响主流程 */ }
  }

  async killTree(pid, pgid) {
    const group = pgid || pid
    const send = (signal) => {
      try {
        process.kill(-group, signal)
        return true
      } catch {
        try {
          process.kill(pid, signal)
          return true
        } catch {
          return false
        }
      }
    }
    if (!send('SIGTERM')) return true
    if (await this.waitGone(pid, TERM_GRACE_MS)) return true
    send('SIGKILL')
    return this.waitGone(pid, 3000)
  }

  async waitGone(pid, timeoutMs) {
    const until = Date.now() + timeoutMs
    while (Date.now() < until) {
      if (!isAlive(pid)) return true
      await sleep(100)
    }
    return !isAlive(pid)
  }

  snapshot(app) {
    const rt = this.procs.get(app.id)
    const saved = rt ? null : this.readRun(app.id)
    const pid = rt?.pid ?? saved?.pid ?? null
    const alive = isAlive(pid)
    const startedAt = alive ? (rt?.startedAt ?? saved?.startedAt ?? null) : null
    let status = 'stopped'
    if (!app.enabled) status = 'disabled'
    else if (alive) status = rt?.stopping ? 'stopping' : 'running'
    else if (this.crashed.has(app.id)) status = 'crashed'
    return {
      ...app,
      status,
      pid: alive ? pid : null,
      startedAt,
      uptimeMs: startedAt ? Date.now() - startedAt : 0,
      // 三个来源按新鲜度排：内存里的运行时记录 → 清单里落盘的计数 → run 文件。
      // 少了中间那个，进程一退（procs 被删、run 文件被清）就只剩 0，
      // 明明已经重启了三次，面板上还是「重启 0 次」。
      restarts: rt?.restarts ?? app.restarts ?? saved?.restarts ?? 0,
      lastExit: this.lastExit.get(app.id) ?? null,
    }
  }

  async start(id, { byGuard = false } = {}) {
    const app = this.find(id)
    if (!app) throw new Error('没有这个应用')
    if (!app.enabled) throw new Error('应用已停用，先启用再运行')
    const current = this.procs.get(id)
    if (current && isAlive(current.pid)) throw new Error('已经在运行了')
    if (!existsSync(app.path)) throw new Error(`启动文件不存在：${app.path}`)

    const { cmd, args } = resolveCommand(app)
    // 指定了运行用户就走 sudo -n（免密）。没配好 sudoers 会立刻失败，
    // 这比在日志里只看到一句「permission denied」却不知道为什么强。
    // 注意：这里不用 spawn 的 uid 选项 —— 那要求管理器自己就是 root，
    // 而它是 fpk 的包用户，只能借 sudo 走。
    const runAs = String(app.runAs ?? '').trim()
    let runCmd = cmd
    let runArgs = args
    if (runAs) {
      runCmd = '/usr/bin/sudo'
      runArgs = ['-n', '-u', runAs, '--', cmd, ...args]
    }
    // cwd 默认是管理器根目录。以前拿 dirname(path) 当默认，于是相对路径的脚本
    // 被 cwd 和参数各拼一次，实际执行成 tests/tests/heartbeat.py 这种双份路径。
    const cwd = app.cwd?.trim() ? resolve(app.cwd) : BASE_DIR
    const env = { ...process.env, ...(app.env ?? {}), APPMGR_APP: app.id }

    let child
    try {
      child = spawn(runCmd, runArgs, {
        cwd,
        env,
        detached: true, // 自成进程组，停的时候能连子孙一起收
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      this.lastExit.set(id, { at: Date.now(), code: null, signal: null, error: String(error?.message ?? error) })
      throw error
    }

    const restarts = byGuard ? (current?.restarts ?? 0) : 0
    if (!byGuard && app.restarts) {
      // 手动点启动 = 重新开始计数
      app.restarts = 0
      this.persist()
    }
    const startedAt = Date.now()
    const info = { pid: child.pid, pgid: child.pid, startedAt, restarts, stopping: false, child }
    this.procs.set(id, info)
    this.crashed.delete(id)
    this.writeRun(id, { pid: child.pid, pgid: child.pid, startedAt, restarts })

    const stamp = `[appmgr] ${new Date().toISOString()} 启动 ${cmd} ${args.join(' ')} (pid ${child.pid})\n`
    this.appendLog(app, Buffer.from(stamp, 'utf8'))

    child.stdout?.on('data', (buf) => this.appendLog(app, buf))
    child.stderr?.on('data', (buf) => this.appendLog(app, buf))
    child.on('error', (error) => {
      this.lastExit.set(id, { at: Date.now(), code: null, signal: null, error: String(error?.message ?? error) })
    })
    child.on('exit', (code, signal) => {
      const live = this.procs.get(id)
      const wasStopping = live?.stopping ?? false
      this.lastExit.set(id, { at: Date.now(), code, signal })
      this.procs.delete(id)
      this.clearRun(id)
      this.appendLog(app, Buffer.from(`[appmgr] ${new Date().toISOString()} 退出 code=${code} signal=${signal}\n`, 'utf8'))
      if (!wasStopping && app.enabled) {
        // code=0 且不是被信号杀掉 = 程序自己跑完了，不是崩。
        // 以前这里一视同仁，于是任何「跑完就退」的脚本都会被无限重拉 ——
        // 日志里就是 起-退-起-退 每 40ms 一圈、重启次数一路涨到 8。
        if (code === 0 && !signal) {
          this.crashed.delete(id)
          return
        }
        const count = (live?.restarts ?? 0) + 1
        // 计数必须落盘：this.procs 里的记录随进程一起消失，不写回清单的话
        // 前端只能读到 apps.json 里那个从没更新过的数，永远显示 0。
        app.restarts = count
        this.persist()
        const max = Number(app.maxRestarts ?? 5)
        if (app.guard !== false && count <= max) {
          this.keepRestart(id, count, live?.startedAt ?? startedAt)
        } else {
          this.crashed.add(id)
        }
      }
    })
    child.unref()
    child.stdout?.unref?.()
    child.stderr?.unref?.()

    return this.snapshot(app)
  }

  // 退避重拉：1s、2s、4s… 最多 60s 一次，免得一启动就崩的程序把机器拖住
  keepRestart(id, count, startedAt) {
    const lived = Date.now() - startedAt
    const base = lived >= STABLE_MS ? 0 : count
    const delay = Math.min(60000, 1000 * 2 ** Math.min(base, 6))
    const timer = setTimeout(async () => {
      if (!this.find(id)?.enabled) return
      try {
        const rt = this.procs.get(id)
        const fresh = { restarts: count }
        this.procs.set(id, { ...(rt ?? {}), ...fresh, pid: 0, stopping: false })
        const prev = this.procs.get(id)
        this.procs.delete(id)
        await this.start(id, { byGuard: true })
        const now = this.procs.get(id)
        if (now) {
          now.restarts = count
          this.writeRun(id, { pid: now.pid, pgid: now.pgid, startedAt: now.startedAt, restarts: count })
        }
        void prev
      } catch {
        const app = this.find(id)
        const max = Number(app?.maxRestarts ?? 5)
        if (count < max) this.keepRestart(id, count + 1, Date.now())
        else this.crashed.add(id)
      }
    }, delay)
    timer.unref?.()
  }

  async stop(id) {
    const app = this.find(id)
    if (!app) throw new Error('没有这个应用')
    const rt = this.procs.get(id)
    const saved = this.readRun(id)
    const pid = rt?.pid ?? saved?.pid
    if (rt) rt.stopping = true
    if (!pid || !isAlive(pid)) {
      this.procs.delete(id)
      this.clearRun(id)
      this.crashed.delete(id)
      return this.snapshot(app)
    }
    await this.killTree(pid, rt?.pgid ?? saved?.pgid)
    this.procs.delete(id)
    this.clearRun(id)
    this.crashed.delete(id)
    this.appendLog(app, Buffer.from(`[appmgr] ${new Date().toISOString()} 已手动停止\n`, 'utf8'))
    return this.snapshot(app)
  }

  async restart(id) {
    await this.stop(id)
    await sleep(300)
    return this.start(id)
  }

  setEnabled(id, enabled) {
    const app = this.find(id)
    if (!app) throw new Error('没有这个应用')
    app.enabled = Boolean(enabled)
    this.persist()
    if (!enabled) this.stop(id).catch(() => {})
    return this.snapshot(app)
  }

  /**
   * 把用户贴的那段代码落到磁盘上，并顺手把 type / path / cwd 全部改对。
   * 用户不该关心 extension、解释器、工作目录 —— 他说「贴代码就能跑」，
   * 那这三个东西就该由这里决定。
   */
  writeSource(app, code) {
    const { type, ext } = detectLanguage(code)
    const dir = join(APP_SRC_DIR, app.id)
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `main.${ext}`)
    writeFileSync(file, String(code), 'utf8')
    app.type = type
    app.path = file
    app.cwd = dir
    app.sourcePath = file
    return app
  }

  readSource(id) {
    const app = this.find(id)
    if (!app) throw new Error('没有这个应用')
    const file = app.sourcePath || app.path
    if (!file || !existsSync(file)) return ''
    return readFileSync(file, 'utf8')
  }

  update(id, patch) {
    const app = this.find(id)
    if (!app) throw new Error('没有这个应用')
    const { code, ...rest } = patch ?? {}
    Object.assign(app, rest)
    // 贴了代码就以代码为准：它会改写 type / path / cwd，
    // 所以必须放在 Object.assign 之后，不然会被表单里的旧字段盖回去。
    if (typeof code === 'string' && code.trim()) this.writeSource(app, code)
    this.persist()
    return this.snapshot(app)
  }

  remove(id) {
    const app = this.find(id)
    if (!app) throw new Error('没有这个应用')
    this.stop(id).catch(() => {})
    this.state.apps = this.state.apps.filter((item) => item.id !== id)
    this.persist()
    return true
  }

  create(input) {
    const app = {
      id: `app_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: input.name || '未命名程序',
      type: input.type || 'node',
      path: input.path || '',
      args: Array.isArray(input.args) ? input.args : [],
      cwd: input.cwd || '',
      env: input.env && typeof input.env === 'object' ? input.env : {},
      interpreter: input.interpreter || '',
      enabled: input.enabled !== false,
      autostart: Boolean(input.autostart),
      guard: input.guard !== false,
      maxRestarts: Number(input.maxRestarts ?? 5),
      createdAt: Date.now(),
    }
    // 有代码就不用再管类型和路径了，全交给 detect + writeSource。
    if (typeof input.code === 'string' && input.code.trim()) this.writeSource(app, input.code)
    this.state.apps.push(app)
    this.persist()
    return this.snapshot(app)
  }

  readLog(id, lines = 200) {
    const app = this.find(id)
    if (!app) throw new Error('没有这个应用')
    const path = this.logPath(app)
    if (!existsSync(path)) return { text: '', lines: 0, truncated: false }
    const raw = readFileSync(path, 'utf8')
    const all = raw.split('\n')
    const want = Math.max(1, Math.min(5000, Number(lines) || 200))
    const tail = all.slice(Math.max(0, all.length - want))
    return { text: tail.join('\n'), lines: all.length, truncated: all.length > want }
  }

  startWatchdog() {
    if (this.timer) return
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch (error) {
        console.error(`[appmgr] 守护巡检出错：${error?.message ?? error}`)
      }
    }, TICK_MS)
    this.timer.unref?.()
  }

  tick() {
    for (const app of this.state.apps) {
      const rt = this.procs.get(app.id)
      if (!rt?.pid) continue
      if (rt.stopping) continue
      if (!isAlive(rt.pid)) {
        // exit 事件一般会先到，这里只是兜底：进程没了但事件没来
        this.procs.delete(app.id)
        this.clearRun(app.id)
        continue
      }
      const saved = this.readRun(app.id)
      if (!saved) this.writeRun(app.id, { pid: rt.pid, pgid: rt.pgid, startedAt: rt.startedAt, restarts: rt.restarts })
    }
  }

  shutdown() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
