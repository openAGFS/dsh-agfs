# @open-agfs/dsh-agfs

[English](README.md) | 中文

由 dsh webserver 托管的文件浏览器 Web 应用，并附带 `/dsh-agfs` 命令。本包把独立 `server.js` 文件浏览器后端（相同的 `{success:true,data}` / `{success:false,error}` 契约与路径安全规则）移植为 Cordis 插件：注册 `basePath` 前缀路由，提供 React 文件浏览器前端与 REST API，并注册一个在系统默认浏览器中打开应用的命令。它随 `dsh web` 同进程运行——无独立端口、无子进程。

本仓库是该插件的独立家园（此前在 deepseek-harness monorepo 内开发）；作为普通 npm 包独立构建、测试与发布。

## 安装

发布用户一条命令安装为 profile 层：

```sh
dsh plugin --profile web add @open-agfs/dsh-agfs
```

从本仓库检出则改用 `--patch` 覆盖层挂载源码：

```yaml
- insert:
    - id: dsh-agfs
      name: 'file:///绝对路径/dsh-agfs/src/index.ts'
```

然后 `dsh web --patch ./overlay.yml` 并在 GUI 输入 `/dsh-agfs`。插件代码改动需重启 dsh；前端资源按请求从磁盘读取。

## 命令

`/dsh-agfs` 在系统默认浏览器中打开文件浏览器并返回地址；当当前会话带有工作区目录（session cwd）时，浏览器会直接定位到该工作区目录。设置 `openOnCommand: false` 时只返回地址。带参数会报错。

## 配置

| Key | 默认 | 含义 |
|---|---|---|
| `basePath` | `/dsh-agfs` | 服务应用与 API 的路由前缀；必须以 `/` 开头且不以 `/` 结尾 |
| `fileRoot` | 当前工作目录 | 浏览根；侧边栏仍可访问各磁盘 |
| `projectRoot` | 当前工作目录 | 侧边栏「项目目录」 |
| `remoteMode` | `false` | 为 true 时禁用 `open`、`open_location`、`copy` 端点 |
| `readOnly` | `false` | 为 true 时 `delete`、`create_folder`、`rename`、`copy` 返回 403；浏览保持可读 |
| `strictRoot` | `false` | 为 true 时浏览锁定在 `fileRoot` 内：拒绝绝对路径，相对路径经 realpath 校验，符号链接/连接点逃逸返回 400 信封 |
| `roots` | `{}` | 侧边栏「自定义根」，`name -> path`；解析不到目录的条目自动丢弃，其余按名排序 |
| `openOnCommand` | `true` | `/dsh-agfs` 是否自动打开系统默认浏览器 |

## API

前端调用与原始后端相同的端点集合，位于 `${basePath}/api/file_browser/` 下：`list`、`read`、`download`、`open`、`open_location`、`search`、`info`、`workspace`、`sidebar`、`thumbnail`、`mode`、`debug`、`delete`、`create_folder`、`rename`、`copy`。路径被限定在浏览根内；根外的绝对路径被拒绝。`mode` 端点根据客户端 IP 是否本地或 `remoteMode` 是否开启来判定远程模式。

`search` 支持 `recursive=1`（也接受 `true`/`yes`）递归遍历，命中上限 200、目录深度上限 5，不可读目录静默跳过。`sidebar` 响应携带配置的 `roots`。所有响应均带 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`；静态资源只响应 GET/HEAD，路径安全违规返回干净的 400 信封。前端在浮层中预览图片与常见文本格式（markdown、代码、日志）。

## 模型工具

插件注册 `browse_files` 工具（参数 `path`、`keyword`、`recursive`），复用与 HTTP 层相同的纯函数核心，模型可直接列出或搜索浏览根。

## 开发

```sh
pnpm install
pnpm test        # vitest：单元套件 + 真实 Loader 组合套件
pnpm typecheck   # 对 src 与 tests 执行 tsc --noEmit
pnpm lint        # oxlint
pnpm build       # tsc 类型 + tsdown 打包 -> lib/
```

前端源码是 `assets/app.jsx`；其编译产物 `assets/app.js`（classic JSX runtime，运行时无需 Babel）与 `assets/vendor/` 下的 React/ReactDOM UMD 构建随包发布，应用可无 CDN 启动。修改 `app.jsx` 后重新生成：

```sh
pnpm run build:frontend
```

## 发布

升级版本号、打 tag 并推送——Publish 工作流（`.github/workflows/publish.yml`）会把该版本发布到 npm：

```sh
pnpm version patch   # 或 minor/major；同时设置 package.json 版本与 git tag
git push --follow-tags
```

发布需要在 GitHub 仓库配置 `NPM_TOKEN` secret。本包把已发布的 `@deepseek-ai/dsh-*` 工具链包声明为 peer 依赖，发布安装可从 npm 解析。

## Model Experience

### 文件浏览工具

#### What the model sees

插件在工具注册表注册 `browse_files` 工具；其参数 schema（path、keyword、recursive）与描述与其他已注册工具一样流入组装后的提示词。工具列出目录条目或搜索浏览根下的条目名，返回规范值 `{ items: [...] }`，渲染为 `TYPE<TAB>SIZE<TAB>PATH` 文本行。

#### Token effect

每次提示词组装一个 schema 条目与工具描述；每次调用贡献一个渲染块。两者相对调用触及的树深度为固定大小。

#### KV Cache effect

提示词贡献跨轮次稳定（schema 与描述按配置静态），组装前缀可复用；仅配置变更会使提示词部分失效。

## 已知局限与待办

- **Font Awesome 图标来自 cdnjs** —— 启动不再依赖 CDN（React/ReactDOM 已随包携带，Babel 由预编译的 `app.js` 取代），但工具栏图标仍来自 cdnjs；无网络时应用可用但无图标。
- **仅浅层搜索** —— `search` 匹配单目录内的条目名（上限 200），与原始后端一致；未实现递归内容搜索。
- **缩略图流式返回原图** —— 不做缩放；大图完整传输并由 CSS 缩放。
- **`openOnCommand` 在宿主机上产生副作用** —— 浏览器在运行 dsh 的机器上打开，loopback 部署正确，但对远程客户端有违直觉。
