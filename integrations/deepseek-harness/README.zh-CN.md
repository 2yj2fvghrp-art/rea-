# REA × DeepSeek Harness 最新版安装说明

适用：DeepSeek Harness 新版 CLI（`dsh.bundle` + Cordis），macOS/Linux。
截至 2026-10-13，npm 的 `@deepseek-ai/dsh@latest` 指向 `0.2.0-rc.2`，
而上游 `master` 仍在快速迭代。安装 REA 时建议使用正式发布、版本固定的插件压缩包。

## 一键复制安装指令

要求：Node.js `^22.19.0 || ^24.11.0 || >=26.0.0`，npm、pnpm，以及初次安装时的网络访问。

```sh
# Node.js: ^22.19, ^24.11, or >=26; macOS/Linux
npm install --global @deepseek-ai/dsh@latest pnpm@11

curl -fL --retry 3 --output dsh-rea-bundle-0.1.0.tgz https://github.com/xxxxxwater/rea/releases/download/dsh-v0.1.0/dsh-rea-bundle-0.1.0.tgz
printf '%s  %s\n' '03a525a9b266bb4b43ae7c92b79b7a9752b0414bf338edb025ee1ce8e3c6500e' 'dsh-rea-bundle-0.1.0.tgz' | shasum -a 256 -c -

dsh plugin --profile web add ./dsh-rea-bundle-0.1.0.tgz
dsh --profile web --dump-config
dsh --profile web
```

其中 SHA-256 为 GitHub Release `dsh-v0.1.0` 的附件摘要。校验失败时应停止安装；
不要绕过校验。最后的 `dsh --profile web` 将启动 Web 版 Harness。
可以通过 `dsh --version` 查看本机版本、
`npm view @deepseek-ai/dsh dist-tags --json` 查看 npm 当前标签。

## 安装成功如何确认

运行 `dsh --profile web --dump-config`，在输出中找到
`dsh-rea-bundle`、`rea-launcher` 和 `rea-mcp`。
启动后，REA 工具应按 `mcp__rea__*` 命名空间注册。
配置预览本身不证明真实的 MCP 连接、模型 API 调用或 Desktop 能运行。
安装、升级或修改配置后需重启当前 Harness 会话。

## 已经有旧的 `rea setup --client dsh`

旧安装器可能将 `rea-mcp` 写在 `$DSH_HOME/cordis.patch.yml`
（默认 `~/.dsh/cordis.patch.yml`）。此全局配置优先于 profile 插件，
可能覆盖新版本。请先备份配置，只删除旧 REA 的 `rea-mcp` 插入项，
保留其他工具与设置，再重新启动 Harness。

## 升级、卸载

```sh
# 查看正在使用的插件包
dsh plugin --profile web why dsh-rea-bundle

# 删除原生插件
dsh plugin --profile web remove dsh-rea-bundle

# 更新 Harness CLI（插件升级需另行下载新版本的 .tgz）
npm install --global @deepseek-ai/dsh@latest
```

REA 新版本发布后，下载新版本 `.tgz`，执行
`dsh plugin --profile web add /absolute/path/to/new-version.tgz`。
请勿认为对旧的本地 `.tgz` 执行 `pnpm update` 会自动取得新版。

## 使用本仓库源码 / Intel Mac Desktop

如果要执行 `xxxxxwater/rea` 的本地代码（而不是默认预编译的
`rea-agents@6.4.0`），先按仓库构建说明运行 `npm ci` 和
`npm run build:cached`，并设置环境变量
`REA_DSH_ENTRYPOINT=/绝对路径/rea/scripts/rea.mjs`。
该覆盖必须在启动 Harness 的进程环境中可见。

Desktop 有自己的应用插件配置，不能直接把 CLI 的 `web` profile 当作
Desktop 插件，也不能使用 `dsh --profile desktop`；
具体安装需使用对应 Desktop 版本支持的插件管理入口。
尤其是 Intel macOS，以上 CLI 验证不能证明原生 Desktop 应用已通过兼容性验收。

## 已验证边界

该插件复用 REA 的 MCP 服务器，而不是独立的逆向引擎。
GitHub CI 测试包括 Node/Cordis 插件合同、REA MCP 握手、
工具列表和 Harness CLI 原生配置组合。
真实 DeepSeek 付费模型调用、macOS Desktop 图形界面以及 Ghidra/IDA 等
第三方分析工具的工作状态不在这组验证之内。
