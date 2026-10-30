#!/usr/bin/env bash
# 打 fpk 包。用法：bash scripts/build-fpk.sh [fnpack 路径]
#
# 包里的 cmd/ 是「运行时代码」，源在仓库根的 server.mjs / lib/ / public/ ——
# 这里把它们复制进去，而不是在仓库里再放一份，否则改完代码忘了同步就是两套。
set -eu

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FNPCK="${1:-fnpack}"
APPNAME="fnos-appmgr"
VERSION="$(sed -n 's/^version=//p' "${ROOT}/manifest" | head -n1)"
[ -n "${VERSION}" ] || { echo "error: manifest 里没有 version" >&2; exit 1; }

# mktemp 跟着外部 TMPDIR 走，而 TMPDIR 不一定真能写（fnOS 沙箱里常是只读挂载点，
# 而 [ -w ] 仍然返回真）。所以不预判，挨个真试。
make_work_dir() {
    local base work
    for base in "${TMPBASE:-}" "${TMPDIR:-}" /tmp "${ROOT}/.build-tmp"; do
        [ -n "${base}" ] || continue
        if mkdir -p "${base}" 2>/dev/null && work="$(mktemp -d "${base}/fnos-appmgr.build.XXXXXXXX" 2>/dev/null)"; then
            printf '%s\n' "${work}"
            return 0
        fi
    done
    return 1
}

WORK="$(make_work_dir)" || { echo "error: 找不到可写的工作目录" >&2; exit 1; }
STAGE="${WORK}/${APPNAME}"
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${STAGE}/cmd" "${STAGE}/app"

for entry in manifest ICON.PNG ICON_256.PNG config ui; do
    if [ ! -e "${ROOT}/${entry}" ]; then
        echo "error: 缺 ${entry}（打包少不了它，缺了就别出包）" >&2
        exit 1
    fi
    cp -a "${ROOT}/${entry}" "${STAGE}/${entry}"
done

# 运行时代码
cp "${ROOT}/server.mjs" "${STAGE}/cmd/server.mjs"
cp -a "${ROOT}/lib" "${STAGE}/cmd/lib"
cp -a "${ROOT}/public" "${STAGE}/cmd/public"
# cmd/ 整个拷进去：main 加 install_init / install_callback / uninstall_* /
# upgrade_* / config_* 这一整套生命周期脚本，fnpack 每一道校验都要求它们在。
cp -a "${ROOT}/cmd/." "${STAGE}/cmd/"

# app/ 是 fnpack 的网关入口，里面的 ui 必须是 ui/ 的全量镜像
mkdir -p "${STAGE}/app/ui"
cp -a "${ROOT}/ui/." "${STAGE}/app/ui/"

# 不跟 symlink 出包（fnpack 不支持），顺手把 CRLF 洗掉
find "${STAGE}" -type l -delete
python3 - "${STAGE}/cmd" <<'PYEOF'
import os, sys
root = sys.argv[1]
for base, _dirs, files in os.walk(root):
    for name in files:
        path = os.path.join(base, name)
        try:
            with open(path, 'rb') as handle:
                raw = handle.read()
        except OSError:
            continue
        if b'\r\n' in raw:
            with open(path, 'wb') as handle:
                handle.write(raw.replace(b'\r\n', b'\n'))
PYEOF

chmod 755 "${STAGE}/cmd/main"
find "${STAGE}/cmd" -type f ! -name '*.mjs' ! -name '*.js' ! -name '*.json' ! -name '*.html' ! -name '*.css' -exec chmod 755 {} +
find "${STAGE}/cmd" -type f \( -name '*.mjs' -o -name '*.js' -o -name '*.json' -o -name '*.html' -o -name '*.css' \) -exec chmod 644 {} +

echo "packing ${APPNAME} ${VERSION}"

# fnpack 自己也 mkstemp，而且照样跟随外部 TMPDIR —— 外面那个在沙箱里是只读挂载点，
# 不显式指过来它就会在「打好的包已经在临时目录里」的最后一刻失败。
mkdir -p "${WORK}/tmp"
( cd "${STAGE}" && TMPDIR="${WORK}/tmp" TMP="${WORK}/tmp" TEMP="${WORK}/tmp" "${FNPCK}" build )

ARCH="$(uname -m)"
# dist/ 在 .gitignore 里，新 checkout（CI）上根本没有这个目录，
# 不先建的话 fnpack 都打包成功了，最后一步 mv 会直接摔掉。
mkdir -p "${ROOT}/dist"
OUT="${ROOT}/dist/${APPNAME}-${VERSION}-${ARCH}.fpk"
mv "${STAGE}"/*.fpk "${OUT}"
echo "wrote ${OUT}"
