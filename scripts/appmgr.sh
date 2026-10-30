#!/usr/bin/env bash
# appmgr 自己的启停脚本。
#
# ★ 注意管的是「管理器」，不是它管的那些程序 —— 停掉管理器不会杀掉被托管的程序，
#   它们是被 adopt() 认领回去的，管理器下次起来还能接着管。
#
# fnOS 上没有 user systemd（systemctl --user 直接报 "Failed to connect to bus"），
# 所以开机自启只能挂 crontab 的 @reboot。
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
PID_FILE="${ROOT}/data/appmgr.pid"
OUT_LOG="${ROOT}/data/appmgr.out"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /vol1/@appcenter/nodejs_v20/bin/node)}"
PORT="${APPMGR_PORT:-28080}"
CRON_TAG="# appmgr-autostart"

# pid 文件不是唯一真相。手工起过一次、或者上次异常退出没留下文件，
# 光看文件会说「没在运行」，于是再起一个 —— 两套管理器抢同一个 28080。
# 文件里那份不靠谱时，按命令行扫一遍 /proc 把它认领回来。
discover_pid() {
    # 用 python 读 /proc/<pid>/cmdline：那是一串 NUL 分隔的 argv，shell 的
    # command substitution 会把 NUL 丢掉并每行刷一条 warning，判断也跟着失真。
    # 判据只留两条：argv[0] 的 basename 是 node，argv 里出现 server.mjs。
    # 曾经还想核对 /proc/<pid>/cwd 是否指向本目录，但这个沙箱不给读那个符号链接
    # （readlink 直接 permission denied），所以退回两条了 —— 宁可少认，也不乱认。
    python3 - <<'INNER'
import os, sys
for name in os.listdir('/proc'):
    if not name.isdigit():
        continue
    try:
        raw = open('/proc/%s/cmdline' % name, 'rb').read()
    except OSError:
        continue
    if b'server.mjs' not in raw:
        continue
    argv = [piece for piece in raw.split(b'\0') if piece]
    if not argv:
        continue
    if os.path.basename(argv[0].decode('utf-8', 'replace')) != 'node':
        continue
    print(name)
    sys.exit(0)
sys.exit(1)
INNER
}

port_answers() {
    curl -fsS -m 2 "http://127.0.0.1:${PORT}/api/system" >/dev/null 2>&1
}

alive() {
    # 最实在的判据是接口答不答话 —— pid 文件只是省一次扫描，丢了不该让状态变成「没在跑」。
    local pid
    if [ -f "${PID_FILE}" ]; then
        pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
        if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null && port_answers; then
            return 0
        fi
    fi
    if port_answers; then
        if pid="$(discover_pid)"; then
            printf '%s
' "${pid}" > "${PID_FILE}" 2>/dev/null || true
        fi
        return 0
    fi
    return 1
}

start() {
    if alive; then
        echo "已在运行 (pid $(cat "${PID_FILE}"))"
        return 0
    fi
    mkdir -p "${ROOT}/data/logs"
    setsid nohup "${NODE_BIN}" "${ROOT}/server.mjs" >> "${OUT_LOG}" 2>&1 &
    echo $! > "${PID_FILE}"
    local _
    for _ in $(seq 1 40); do
        if curl -fsS "http://127.0.0.1:${PORT}/api/system" >/dev/null 2>&1; then
            echo "已启动 (pid $(cat "${PID_FILE}")) → http://127.0.0.1:${PORT}/"
            return 0
        fi
        sleep 0.2
    done
    echo "启动失败，日志在 ${OUT_LOG}" >&2
    return 1
}

stop() {
    if ! alive; then
        echo "没在运行"
        rm -f "${PID_FILE}"
        return 0
    fi
    local pid n
    pid="$(cat "${PID_FILE}")"
    kill "${pid}" 2>/dev/null
    n=0
    while [ "${n}" -lt 30 ] && kill -0 "${pid}" 2>/dev/null; do
        sleep 0.2
        n=$((n + 1))
    done
    if kill -0 "${pid}" 2>/dev/null; then
        kill -9 "${pid}" 2>/dev/null
    fi
    rm -f "${PID_FILE}"
    echo "已停止"
}

status() {
    if alive; then
        echo "运行中 (pid $(cat "${PID_FILE}"))"
        curl -fsS "http://127.0.0.1:${PORT}/api/system" 2>/dev/null | head -c 240
        echo
        return 0
    fi
    echo "未运行"
    return 1
}

# crontab 能不能写，得真写一次才知道：沙箱里 /var/spool/cron 常常是只读的，
# 而 `crontab -` 失败时不一定给非零退出码 —— 只看退出码会谎报「已写入」。
# 所以写完还要读回来验证，读不回来说明它根本没落盘。
write_crontab() {
    local err
    err="$(mktemp 2>/dev/null || echo /tmp/appmgr-cron.$$)"
    if ! crontab - 2>"${err}"; then
        echo "写 crontab 失败：$(tr '\n' ' ' < "${err}" 2>/dev/null)" >&2
        rm -f "${err}"
        return 1
    fi
    rm -f "${err}"
    return 0
}

# 开机自启：@reboot + 延迟 20 秒，等 fnOS 那套目录挂载完
boot_install() {
    local line current
    line="@reboot sleep 20 && cd ${ROOT} && ${NODE_BIN} ${ROOT}/server.mjs >> ${OUT_LOG} 2>&1"
    current="$(crontab -l 2>/dev/null || true)"
    if printf '%s\n' "${current}" | grep -qF "${CRON_TAG}"; then
        echo "开机自启已经在 crontab 里了"
        return 0
    fi
    if ! { printf '%s\n' "${current}" | sed '/^[[:space:]]*$/d'; printf '%s %s\n' "${line}" "${CRON_TAG}"; } | write_crontab; then
        echo "开机自启没装上。手动加这一行也一样：" >&2
        echo "${line} ${CRON_TAG}" >&2
        return 1
    fi
    if crontab -l 2>/dev/null | grep -qF "${CRON_TAG}"; then
        echo "已写入 crontab：${line}"
        return 0
    fi
    echo "crontab 报了成功但读不回来（大概被沙箱拦了），手动加这一行：" >&2
    echo "${line} ${CRON_TAG}" >&2
    return 1
}

boot_remove() {
    local current
    current="$(crontab -l 2>/dev/null || true)"
    if ! printf '%s\n' "${current}" | grep -vF "${CRON_TAG}" | write_crontab; then
        echo "从 crontab 移除失败" >&2
        return 1
    fi
    echo "已从 crontab 移除"
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart) stop; start ;;
    status) status ;;
    boot-install) boot_install ;;
    boot-remove) boot_remove ;;
    *)
        echo "用法: $0 {start|stop|restart|status|boot-install|boot-remove}"
        exit 1
        ;;
esac
