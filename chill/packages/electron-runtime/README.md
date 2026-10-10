# @assistant-ai/electron-win32-x64

Electron 28.3.3 预编译运行时（Windows x64），随 npm registry 分发。

## 为什么存在

全档包 `@assistant-ai/chill` 需要 Electron 运行时打开桌面窗口。官方 electron 包在安装时会从 GitHub Releases 下载 ~100MB 二进制——对网络不通的用户是死路。本包把**官方预编译发行包原样搬进 npm registry**：安装链路只剩 registry，零编译、零下载脚本、零 GitHub。

## 内容

- `dist/`：官方 28.3.3 win32-x64 发行包原样（electron.exe、DLL、resources、locales）
- `cli.js`：启动引导（`node cli.js <应用目录>`）
- `LICENSE` / `LICENSES.chromium.html`：Electron MIT 与 Chromium 合规文件

不修改任何官方二进制。版本号与 Electron 版本严格一致——引擎发安全补丁时本包才更新。

## 使用

本包是 `@assistant-ai/chill` 的内部依赖，通常无需直接安装：

```bash
npm install -g @assistant-ai/chill   # 全档：自动带上本运行时
chill → TUI 内 /ui                    # 桌面窗口打开
```

## 许可

Electron（MIT）与 Chromium 的许可文件随包分发，见 `LICENSE` 与 `LICENSES.chromium.html`。
