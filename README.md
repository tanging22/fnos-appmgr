# fnos-appmgr · 程序管理器

fnOS 上的轻量程序管理器：贴一段代码，自动认出 Node / Python / Go / Shell，落盘、跑起来、挂了自动拉。

零第三方依赖（只有 Node 内置模块），管理器本体跑在 fnOS 应用沙箱里，面板走 fnOS 统一网关。

## 功能

- **贴代码即运行**：新建时把代码粘进去，自动识别语言（shebang / Go package+func main / Python def-import / Node require-export / Shell set-fi-done），落盘到应用数据目录并启动
- **启停管理**：启动 / 停止 / 重启 / 删除，状态灯 + PID + 运行时长实时刷新
- **进程守护**：异常退出自动拉起，指数退避（1s 起，封顶 60s），连续崩太多次转 crashed 不再硬撑；正常跑完（exit 0）不重拉
- **开机自启**：按应用勾选；管理器自身由 fnOS 应用系统拉起
- **日志**：每个程序独立日志文件，面板实时查看尾部 400 行
- **运行用户**：选设备上的账号跑（管理器以 root 运行，见下）
- **手机适配**：620px 断点下表格转卡片，弹层可滚、滑动不误关

## 安装

1. 从 [Releases](../../releases) 下载 `fnos-appmgr-*-x86_64.fpk`
2. fnOS 应用中心 → 手动安装 → 选 fpk

## 构建

```bash
node scripts/make-icons.mjs     # 从 assets-src/icon.png 重算整套图标
bash scripts/build-fpk.sh       # 出 dist/fnos-appmgr-<version>-<arch>.fpk
```

CI：推 `v*` tag 自动构建并在 Release 挂包（见 `.github/workflows/build.yml`）。

## 注意

- 管理器以 root 运行（`config/privilege` 的 `run-as: root`）——它需要以任意用户身份启动程序。装它的机器请自己权衡。
- `data/` 是运行时数据（用户贴的程序、日志），不进仓库。
- Go 程序用 `go run` 跑，无 HOME 环境时会自动注入 GOCACHE。
