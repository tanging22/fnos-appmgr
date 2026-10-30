// 28080 上的管理接口 + 单页面板。只绑回环，跟 dsh 面板一个思路。
import { createServer } from 'node:http'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Manager } from './lib/manager.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
// 打包后是 cmd/server.mjs + cmd/public/，源码目录则是 server.mjs + public/。
// 两种布局都得认：先看同目录，再退回上一级 —— 只写死 '..' 的话装完就是一片 404。
const PUBLIC_DIR = existsSync(resolve(HERE, 'public', 'index.html'))
  ? resolve(HERE, 'public')
  : resolve(HERE, '..', 'public')
const PORT = Number(process.env.APPMGR_PORT ?? 28080)
const HOST = process.env.APPMGR_HOST ?? '127.0.0.1'
// 被 fnOS 统一网关接管时，它把 unix socket 交给我们监听，路径前缀也由它决定：
// 浏览器看到的是 /app/fnos-appmgr/xxx，网关转给 socket 的路径仍带着这个前缀，
// 所以这里先剥掉再路由。裸跑（没给 SOCK_PATH）就退回 TCP、无前缀。
const SOCK_PATH = (process.env.SOCK_PATH ?? '').trim()
const GATEWAY_PREFIX = (process.env.GATEWAY_PREFIX ?? '/app/fnos-appmgr').replace(/\/+$/, '')
const MAX_BODY = 1024 * 1024

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const manager = new Manager()

// 绑回环之后，Host 校验就只剩防 DNS rebinding 这一层意义
const allowHosts = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
  ...(process.env.APPMGR_ALLOW_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean),
])
const trustAnyHost = process.env.APPMGR_TRUST_ANY_HOST === '1'

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('请求体太大了')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

function serveStatic(res, pathname) {
  const target = pathname === '/' ? '/index.html' : pathname
  const file = resolve(PUBLIC_DIR, `.${target}`)
  if (!file.startsWith(PUBLIC_DIR + sep) && file !== PUBLIC_DIR) {
    json(res, 403, { ok: false, error: '越界了' })
    return
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    json(res, 404, { ok: false, error: '没有这个文件' })
    return
  }
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  })
  createReadStream(file).pipe(res)
}

const routes = [
  ['GET', /^\/api\/users$/, async () => ({ ok: true, users: listUsers() })],
  ['GET', /^\/api\/system$/, async () => ({ ok: true, system: systemView() })],
  ['GET', /^\/api\/apps$/, async () => ({ ok: true, apps: manager.state.apps.map((app) => manager.snapshot(app)) })],
  ['POST', /^\/api\/apps$/, async ({ body }) => ({ ok: true, app: manager.create(body) })],
  ['PUT', /^\/api\/apps\/([^/]+)$/, async ({ params, body }) => ({ ok: true, app: manager.update(params[0], body) })],
  ['DELETE', /^\/api\/apps\/([^/]+)$/, async ({ params }) => {
    manager.remove(params[0])
    return { ok: true }
  }],
  ['GET', /^\/api\/apps\/([^/]+)\/logs$/, async ({ params, query }) => {
    const result = manager.readLog(params[0], query.get('lines') ?? 200)
    return { ok: true, ...result }
  }],
  ['GET', /^\/api\/apps\/([^/]+)\/source$/, async ({ params }) => ({ ok: true, code: manager.readSource(params[0]) })],
  ['POST', /^\/api\/apps\/([^/]+)\/(start|stop|restart|enable|disable)$/, async ({ params }) => {
    const [id, action] = params
    if (action === 'start') return { ok: true, app: await manager.start(id) }
    if (action === 'stop') return { ok: true, app: await manager.stop(id) }
    if (action === 'restart') return { ok: true, app: await manager.restart(id) }
    if (action === 'enable') return { ok: true, app: manager.setEnabled(id, true) }
    return { ok: true, app: manager.setEnabled(id, false) }
  }],
]

// 设备上的用户列表 —— 面板「运行用户」下拉要填的就是它。
// 只列真能登录的：root 与普通用户(uid>=1000)，且 shell 不是 nologin/false，
// 否则下拉里会混进一堆 daemon 账号，选中只会换来一句 permission denied。
function listUsers() {
  const out = []
  let text = ''
  try {
    text = readFileSync('/etc/passwd', 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const parts = line.split(':')
    if (parts.length < 7) continue
    const [name, , uid, gid, , , shell] = parts
    const id = Number(uid)
    if (!Number.isFinite(id)) continue
    if (id !== 0 && id < 1000) continue
    if (/nologin|false|sync|shutdown/i.test(shell)) continue
    out.push({ name, uid: id, gid: Number(gid) })
  }
  return out
}

function systemView() {
  const apps = manager.state.apps.map((app) => manager.snapshot(app))
  return {
    node: process.version,
    pid: process.pid,
    platform: `${process.platform}/${process.arch}`,
    uptimeMs: Math.round(process.uptime() * 1000),
    total: apps.length,
    running: apps.filter((app) => app.status === 'running').length,
    crashed: apps.filter((app) => app.status === 'crashed').length,
  }
}

const server = createServer((req, res) => {
  void handle(req, res)
})

async function handle(req, res) {
  try {
    const host = String(req.headers.host ?? '').toLowerCase()
    // 走 fnOS 统一网关时（unix socket），Host 头是用户浏览器访问的那个地址
    // （NAS 的 IP:端口，或者 xxx.fnos.net），白名单里从来不会有它。
    // 而这条路上前缀本来就只有网关能连进来，没有局域网暴露面 ——
    // 所以网关模式不校验 Host，只有本机 TCP 调试模式才校验（那是防 DNS rebinding 的）。
    if (!SOCK_PATH && !trustAnyHost && host && !allowHosts.has(host)) {
      json(res, 403, { ok: false, error: '不受信任的 Host' })
      return
    }
    const url = new URL(req.url ?? '/', `http://${host || `127.0.0.1:${PORT}`}`)
    let pathname = url.pathname
    if (GATEWAY_PREFIX && (pathname === GATEWAY_PREFIX || pathname.startsWith(`${GATEWAY_PREFIX}/`))) {
      pathname = pathname.slice(GATEWAY_PREFIX.length) || '/'
    }
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        json(res, 405, { ok: false, error: '只支持 GET' })
        return
      }
      serveStatic(res, pathname)
      return
    }
    const matched = routes.find(([method, pattern]) => method === req.method && pattern.test(pathname))
    if (!matched) {
      json(res, 404, { ok: false, error: '没有这个接口' })
      return
    }
    const params = matched[1].exec(pathname)?.slice(1) ?? []
    const body = req.method === 'GET' ? {} : await readBody(req)
    const result = await matched[2]({ params, body, query: url.searchParams, req })
    json(res, 200, result)
  } catch (error) {
    const message = String(error?.message ?? error)
    console.error(`[appmgr] ${req.method} ${req.url} 失败：${message}`)
    json(res, 400, { ok: false, error: message })
  }
}

function bootAutostart() {
  const wanted = manager.state.apps.filter((app) => app.enabled && app.autostart)
  for (const app of wanted) {
    manager.start(app.id).catch((error) => {
      console.error(`[appmgr] 开机拉起 ${app.name} 失败：${error?.message ?? error}`)
    })
  }
}

function onReady() {
  console.log(`[appmgr] 管理器在 ${SOCK_PATH || `http://${HOST}:${PORT}/`} 上（前缀 ${GATEWAY_PREFIX}），${manager.state.apps.length} 个程序`)
  manager.startWatchdog()
  bootAutostart()
}

if (SOCK_PATH) {
  // 上一轮留下的 socket 文件会挡住 bind，先清掉；目录可能还不存在
  try { rmSync(SOCK_PATH, { force: true }) } catch { /* 清不掉就让 bind 自己报错 */ }
  mkdirSync(dirname(SOCK_PATH), { recursive: true })
  server.listen(SOCK_PATH, onReady)
} else {
  server.listen(PORT, HOST, onReady)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[appmgr] 收到 ${signal}，管理器退出（它管的程序不停）`)
    manager.shutdown()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref()
  })
}
