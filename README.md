# @open-agfs/dsh-agfs

English | [中文](README.zh.md)

File-browser web app served by the dsh webserver, with a human `/dsh-agfs` command. The package ports the standalone `server.js` file-browser backend (same `{success:true,data}` / `{success:false,error}` contract and path-safety rules) into a Cordis plugin: it registers a prefix route under `basePath` that serves the React file-browser frontend and its REST API, and a command that opens the app in the system default browser. It rides the composing `dsh web` server — no separate port and no subprocess.

This repository is the standalone home of the plugin (previously developed inside the deepseek-harness monorepo); it builds, tests, and publishes as an ordinary npm package.

## Install

Published users install the plugin as a profile layer in one line:

```sh
dsh plugin --profile web add @open-agfs/dsh-agfs
```

From a checkout of this repository, mount the source through a `--patch` overlay row instead:

```yaml
- insert:
    - id: dsh-agfs
      name: 'file:///absolute/path/to/dsh-agfs/src/index.ts'
```

then start `dsh web --patch ./overlay.yml` and run `/dsh-agfs` in the GUI. Plugin code changes need a dsh restart; frontend assets are served from disk per request.

## Command

`/dsh-agfs` opens the file browser in the system default browser and reports its URL. When the current session carries a workspace directory (its cwd), the browser boots directly at that workspace directory. With `openOnCommand: false` it only reports the URL. Extra arguments are rejected.

## Config

| Key | Default | Meaning |
|---|---|---|
| `basePath` | `/dsh-agfs` | Webserver route prefix serving the app and its API; must start with `/` and have no trailing slash. |
| `fileRoot` | current working directory | File-browser root; drives stay reachable through the sidebar. |
| `projectRoot` | working directory | Project root shown in the sidebar. |
| `remoteMode` | `false` | When true, the `open`, `open_location`, and `copy` endpoints are disabled. |
| `readOnly` | `false` | When true, the `delete`, `create_folder`, `rename`, and `copy` endpoints answer 403; browsing stays fully readable. |
| `strictRoot` | `false` | When true, browsing is locked inside `fileRoot`: absolute paths are rejected and relative paths are verified through real paths, so symlink and junction escapes fail with a 400 envelope. |
| `roots` | `{}` | Named browse roots shown in the sidebar as `name -> path`; entries that do not resolve to an existing directory are dropped, the rest sort by name. |
| `openOnCommand` | `true` | Whether `/dsh-agfs` opens the system default browser. |

## API

The frontend calls the same endpoint set as the original backend under `${basePath}/api/file_browser/`: `list`, `read`, `download`, `open`, `open_location`, `search`, `info`, `workspace`, `sidebar`, `thumbnail`, `mode`, `debug`, `delete`, `create_folder`, `rename`, and `copy`. Paths are confined under the browsable root; absolute paths outside the root are rejected. The `mode` endpoint classifies a request as remote when the client IP is not local or `remoteMode` is on.

`search` accepts `recursive=1` (also `true`/`yes`) to walk the tree with a 200-hit cap and a directory-depth cap of 5; unreadable directories are skipped silently. The `sidebar` response carries the configured `roots`. Every response includes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`; static assets answer GET/HEAD only, and path-safety violations surface as clean 400 envelopes. The frontend previews images and common text formats (markdown, code, logs) in an overlay.

## Model tool

The plugin registers `browse_files` (parameters `path`, `keyword`, `recursive`) over the same pure core the HTTP layer uses; the model can list or search the browser root directly. See the Model Experience section for the model-visible contract.

## Development

```sh
pnpm install
pnpm test        # vitest: unit suites plus the real-Loader composition suite
pnpm typecheck   # tsc --noEmit over src and tests
pnpm lint        # oxlint
pnpm build       # tsc types + tsdown bundles -> lib/
```

The frontend source is `assets/app.jsx`; its compiled form `assets/app.js` (classic JSX runtime, no Babel at runtime) and the vendored React/ReactDOM UMD builds under `assets/vendor/` ship in the package so the app boots without a CDN. After editing `app.jsx`, regenerate:

```sh
pnpm run build:frontend
```

## Publishing

Bump the version, tag it, and push — the Publish workflow (`.github/workflows/publish.yml`) publishes the tagged version to npm:

```sh
pnpm version patch   # or minor/major; sets package.json version and a git tag
git push --follow-tags
```

Publishing needs an `NPM_TOKEN` secret on the GitHub repository. The package declares the published `@deepseek-ai/dsh-*` harness packages as peers, so a published install resolves them from npm.

## Model Experience

### File browsing tools

#### What the model sees

The plugin registers the `browse_files` tool on the tool registry; its parameter schema (path, keyword, recursive) and description flow into the assembled prompt like every other registered tool. The tool lists directory entries or searches entry names over the configured browser root and returns a canonical `{ items: [...] }` value, rendered as `TYPE<TAB>SIZE<TAB>PATH` text lines.

#### Token effect

One schema entry plus the tool description per prompt assembly; tool results contribute one rendered block per call. Both are fixed-size relative to the tree depth the call touches.

#### KV Cache effect

The prompt contribution is stable across turns (schema and description are static per configuration), so assembled prefixes remain reusable; only configuration changes invalidate the prompt portion.

## Known Limitations and Deferred Work

- **Font Awesome icons load from cdnjs** — boot no longer needs a CDN (React/ReactDOM are vendored and Babel is eliminated by the precompiled `app.js`), but the toolbar icons still come from cdnjs; without network access the app works without icons.
- **Shallow search only** — `search` matches entry names in one directory (200-hit cap), matching the original backend; recursive content search is not implemented.
- **Thumbnails stream the original image** — no resize is performed; large images are sent in full and scaled by CSS.
- **`openOnCommand` spawns on the host** — the browser opens on the machine running dsh, which is correct for a loopback deployment but surprising for remote clients.
