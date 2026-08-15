# dsh-agfs — 仓库规则

DeepSeek Harness 的文件浏览器插件。单包仓库：React 前端 + REST API 由宿主 webserver 托管，附带 `/dsh-agfs` 命令与 `browse_files` 模型工具。插件是独立的 cordis bundle 包，经 `cordis.patch.yml` + profile 机制挂载到 `dsh web`，**绝不修改 DSH 源码**。

## 仓库布局

```text
src/                 服务端插件源码（TypeScript，ESM）
  index.ts           插件入口：name / inject / Config / apply 具名导出，无默认导出
  handler.ts         纯函数 API 核心（路径安全、端点、静态资源），无 HTTP 依赖
  open.ts            系统打开器（浏览器 / 默认应用 / 资源管理器），命令构建与 spawn 封装
  tool.ts            browse_files 模型工具
  invariant.ts       包级 invariant 伴侣（注册 manifest 名）
  types.ts           仅类型，无运行时代码
assets/              前端资产（随包发布，离线可启动）
  app.jsx            前端源码（React，classic JSX runtime）
  app.js             esbuild 编译产物（pnpm run build:frontend 重新生成）
  index.html         入口页（含 <!--DSH-AGFS-CONFIG--> 注入标记）
  webbrowser.css     样式
  vendor/            随包 React/ReactDOM UMD（无 CDN）
tests/               vitest 套件（单元 + 真实 Loader 组合）
  handler.spec.ts    纯核心单元测试
  open.spec.ts       打开命令构造测试
  tool.spec.ts       browse_files 工具测试
  composition.spec.ts 真实 Loader + 真实 HTTP socket 组合测试（生命周期/HMR 安全）
scripts/
  release.mjs        发布规则助手：每 10 次提交发一次版
docs/screenshots/    README 截图与演示 GIF
.github/workflows/   ci.yml（lint/typecheck/test/build/pack）+ publish.yml（tag 触发 npm 发布）
cordis.patch.yml     bundle 补丁层（挂载行）
```

## 常用命令

```sh
pnpm install                  # 安装依赖（pnpm 11）
pnpm test                     # vitest：单元 + 组合套件（94 测试）
pnpm typecheck                # tsc --noEmit（src + tests）
pnpm lint                     # oxlint（精选规则，关闭默认噪音）
pnpm build                    # tsc 类型 + tsdown 打包 -> lib/
pnpm run build:frontend       # 改 assets/app.jsx 后重新编译 assets/app.js
pnpm run release              # 满 10 次提交时发版（打 tag 触发 CI 发布）
pnpm run release -- --dry-run # 预览发版
```

改动提交前至少跑一遍 `pnpm test && pnpm typecheck && pnpm lint`；改过前端必须再 `pnpm run build:frontend` 并确认组合测试的标记断言仍通过（CI 全量跑所有门禁）。

## 全局约定

- **禁止修改 DSH 源码**：挂载只走 `cordis.patch.yml` + profile；官方 `@deepseek-ai/*` 一律 `peerDependencies`（不含 workspace/本地路径依赖），类型解析只来自 npm 安装的 SDK。
- **函数插件形态**：`name` / `inject` / `Config` / `apply` 具名导出，**无默认导出**（否则 Loader 丢弃 inject）；一切注册走 `ctx.effect()` / `ctx.on()`，disposer 由注册返回。
- **handler.ts 是纯函数核心**：HTTP 层（index.ts 路由）只是薄封装；所有端点、路径安全、响应信封都在核心内可单测。**路径安全与安全响应头（nosniff / X-Frame-Options: DENY / Referrer-Policy: no-referrer）是不可破坏的契约**。
- **analyze 端点是 ctx 感知例外**：`一键AI分析`（`POST .../analyze`）需要在 index.ts 路由层直接处理（依赖可选的 `workspaceRegistry` / `agents` 服务，经 `ctx.get` 读取，缺省时返回 500 信封）；其编排逻辑 `runAnalysis` 独立导出可单测，不走 handler.ts 纯核心。
- **前端资产纪律**：`app.jsx` 是唯一源码，`app.js` 必须由 `pnpm run build:frontend` 重新生成并随包提交；React/ReactDOM 用 `assets/vendor/` 本地副本，禁止引入 CDN 或运行时 Babel。改 `index.html` 引用的 `app.js?v=N` 时递增 N（静态资源已带 `Cache-Control: no-cache`，但仍保持版本号递增的缓存爆破约定）。
- **前端标记纪律**：组合测试断言 `app.jsx` 与 `app.js` 中同时存在的关键标记（如 `open-local-float`、`isTextPreview`、`自定义根`）——改前端文案/结构时保持标记一致，否则测试变红。
- **双语文档纪律**：README 中英配对（`README.md` + `README.zh.md` + `README.i18n.yaml`）；改任一侧必须同步另一侧并刷新哈希（`git hash-object README.md README.zh.md` 写入 i18n 文件）。
- **文档随代码更新**：任何改动触及 README 描述的行为（命令、配置、功能、发布流程），必须同批更新文档。
- **发布纪律**：发布由 tag 驱动且**每 10 次提交发一次版**（见下方「发布」）。不要每次提交都打 tag；不要直接改版本号绕过 `scripts/release.mjs` 的节奏。
- **不使用 emoji**：代码、注释、文档、提交信息保持纯文本（需要装饰用 `-`、`*`、`×`）。仓库未设 CI 检查，靠约定自律。

## 开发与贡献流程

### 提交规范（Conventional Commits）

提交信息格式 `type(scope): subject`，type 用 `feat` / `fix` / `chore` / `docs` / `test` / `refactor` / `perf`，scope 为包名或主题（如 `frontend`、`handler`、`release`、`readme`）。例：`fix(handler): open windows dirs via direct explorer spawn`。

### 提交前必过门禁

`pnpm test` / `pnpm typecheck` / `pnpm lint`（前端改动另加 `pnpm run build:frontend` 后重跑 test）。CI（.github/workflows/ci.yml）全量执行 lint/typecheck/test/build/pack，红则 PR 不合并。

### PR 要求

- 改 README 必须同 PR 维护中英三件套并刷新 `README.i18n.yaml` 哈希。
- 改服务端行为（端点、配置、安全）必须同步 handler/open/tool 单测或组合测试。
- 用户可见变更（前端 UI）在组合测试中留标记断言，必要时更新 `docs/screenshots/`。

### 发布（维护者）

**每 10 次提交到 main 发一次版**：`scripts/release.mjs` 统计自上次 `v*` tag 以来的提交数，不足 10 次只打印进度；满 10 次时递增 patch 版本、提交 `chore: release vX.Y.Z`、打 `vX.Y.Z` tag 并推送（触发 `.github/workflows/publish.yml` 自动发 npm）。工作树不干净时脚本拒绝执行。发布后如 profile 已安装本包，需 `dsh plugin --profile web add @open-agfs/dsh-agfs@<新版本>` 并重启 dsh 生效（bundle 版本变更属启动时读取）。

## 分层指令体系

| 文件 | 作用 |
| --- | --- |
| 本文件（根 AGENTS.md） | 仓库布局、命令、全局规则，每个会话都需要 |
| README.md / README.zh.md | 用户视角：安装、使用、配置、功能 |
| 上游 [deepseek-harness AGENTS.md](https://github.com/deepseek-ai/deepseek-harness/blob/main/AGENTS.md) | dsh 生态全局约定（注册即 effect、能力缝、双语文档等） |

## 编辑这些指令

规则只在本文件写一次，不跨文件重复展开；保持每条自包含（1-3 行）。精简优于扩充；需要更详细的背景时链接到 README 或上游文档，不在本文件展开。
