# 输入预测 · Composer prefill

给 DeepSeek Harness 的 Codex 风格「输入预测」：助手回复结束后，在输入框上方建议**下一条你会打的消息**。按 `Tab` 或点击填入草稿，**不会自动发送**。

`@wangxiaocuo/dsh-composer-prefill`

[![npm](https://img.shields.io/npm/v/@wangxiaocuo/dsh-composer-prefill?label=npm)](https://www.npmjs.com/package/@wangxiaocuo/dsh-composer-prefill)
[![license](https://img.shields.io/npm/l/@wangxiaocuo/dsh-composer-prefill)](LICENSE)
[![CI](https://github.com/wangxiaocuo/dsh-composer-prefill/actions/workflows/ci.yml/badge.svg)](https://github.com/wangxiaocuo/dsh-composer-prefill/actions/workflows/ci.yml)

---

## 它做什么

| 时机 | 行为 |
|---|---|
| 助手回复结束、且输入框为空 | 出现一条建议（单行，同语言，≤120 字符） |
| 按 `Tab` / 点击文字 | 填入草稿，不发送；可继续编辑 |
| 点击 `↻` | 换一条：强制重新生成（跳过缓存与最小间隔，一次模型调用），请求期间显示「换一条中…」；新建议为空时保留旧的 |
| 按 `Esc` / 点击 `✕` | 本轮不再出现（打字再删空也不会回来，直到下一轮） |
| 开始打字 | 立刻隐藏，并中止正在进行的请求（省 token） |
| 把刚打的字删空 | 建议**立刻**回来（本地恢复，不发请求） |
| 切到别的会话再切回 | 立刻回来（读宿主缓存，**零模型调用**） |
| 提交发送 | 等这一轮结束再给下一条建议 |
| 模型判断没有合理的下一句 | 输出 `NONE`，什么都不显示 |

界面就是输入卡上方的一条淡色建议（`conversation.input.dock`，order 15），带 `↵` 前缀、`Tab` 键帽和 `✕`。

## 安装

已发布到 npm：<https://www.npmjs.com/package/@wangxiaocuo/dsh-composer-prefill>

**从 npm 安装（推荐给其他人）**

```
设置 → 插件 → 安装  →  填 @wangxiaocuo/dsh-composer-prefill
```

**本地开发（当前本机的方式）**

```
设置 → 插件 → 安装  →  填本仓库目录的绝对路径
```

安装后在 **设置 → 通用** 里有一行「输入预测」开关（即时生效），**设置 → 插件 → 输入预测 → 配置** 里能看到全部 9 个字段。

## 工作方式

```
浏览器 client 半                                   宿主 host 半
┌──────────────────────────────┐   POST 同源     ┌─────────────────────────────┐
│ conversation.input.dock 建议条 │ ─────────────▶ │ /composer-prefill/predict    │
│ useInput / useSessionStatus   │                │  Host/Origin 围栏 + owner 校验 │
│ AbortController（打字即取消）  │ ◀───────────── │  按 (session, seq) 的 LRU 缓存 │
│ inputActions.insertText(span) │  {enabled,text}│  deriveMessages() 截最近 N 轮  │
└──────────────────────────────┘                │  ctx.llm 一次小调用（跟随会话）│
                                                └─────────────────────────────┘
```

两个模式：

| 请求 | 含义 |
|---|---|
| `{sessionId}` | 回合结束后的正常请求；缓存未命中才会真的调用模型 |
| `{sessionId, mode:"cached"}` | 只读缓存：会话重新挂载时用，命中即回显，**永不生成** |
| `{sessionId, mode:"refresh"}` | `↻ 换一条`：跳过缓存和最小间隔强制重生成，结果覆盖缓存；host 会带上 `attempt` 计数，从第 2 次起要求模型换个角度而不是重复最显然的答案 |

另有 `POST /composer-prefill/prefs` 供设置页那行开关读取「当前是否开启 + 本插件的 Loader entry id」；写入走 DSH 自己的 `configForms`（和插件管理页的表单是同一份配置）。

`Tab` 是受保护的增强：bubble 阶段监听，只在建议可见、焦点在 `[data-composer-card]` 内、非 IME、无修饰键、且没有被斜杠/`@` 菜单消费（`defaultPrevented`）时才 `preventDefault`。点击接受是主路径。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `showPredictions` | `true` | 总开关。关掉后零模型调用 |
| `provider` / `model` | `""` | 留空跟随当前会话；两个都填才生效 |
| `maxContextTurns` | `4` | 喂给预测的最近轮数 |
| `maxInputChars` | `4000` | 上下文总字符上限 |
| `maxOutputTokens` | `64` | 输出 token 上限 |
| `timeoutMs` | `8000` | 超时即放弃（超时=不显示） |
| `minIntervalMs` | `1500` | 两次请求的最小间隔 |
| `debug` | `false` | 往宿主日志打 `[composer-prefill]` 诊断 |

## 成本与隐私

- **只为你正在看的那个会话生成**：没打开的会话永远不花调用。
- 每轮多一次约 2–4k input tokens、几十 output tokens 的请求；**不进会话记录、不进 token meter、不占上下文窗口**，但 provider 照常计费。
- 上下文只取最近 N 轮的 `user`/`assistant` **纯文本**（剥掉工具结果、图片、附件、reasoning），跟随会话自己的 provider/model，不跨 provider。
- 输出不可信：只取首行、去引号、限长，且**只能由你显式接受**，绝不自动发送。

## 提示词

系统提示词在 [`prompt.txt`](prompt.txt)，每次调用按 mtime 现读——改完**下一轮立即生效，不需要重启**。文件缺失或为空时回退到内置提示。

## 开发

```
index.js            宿主：Config + 路由注册
lib/http.js         同源端点、围栏/owner/CSRF 校验、请求体读取
lib/predictions.js  缓存、请求合并、限流、RPC handler
lib/generate.js     一次性 ctx.llm 调用（路由解析、上下文、输出消毒）
lib/prompt.js       上下文裁剪、输出消毒、提示词热读
lib/config.js       配置读取（兼容 schemastery ref 与普通值）
client.js           浏览器半：建议条、触发状态机、Tab/Esc、接受
prompt.txt          系统提示词
test/               单元测试、宿主 smoke、浏览器半 DOM 行为测试
```

- `client.js` 改动：刷新页面即可。
- `index.js` / `lib/*.js` 改动：**退出并重新打开应用**。这套桌面构建没有宿主侧模块热替换，Node 的 ESM 缓存不会因文件变化而失效。

```bash
pnpm install
pnpm typecheck        # tsc --checkJs（index.js + lib/**）
pnpm test             # 单元测试（node:test，含宿主 lib 与浏览器半 DOM）
pnpm test:coverage    # 覆盖率门槛（lib/**，与 CI 同一套参数）
pnpm test:smoke       # 宿主端点端到端（真实 Cordis 装配，桩模型）
pnpm test:e2e         # 真实 dsh web + headless Chromium 的端到端（见下）
pnpm pack:check       # 核对 npm tarball 的文件清单
pnpm verify           # 以上全部；prepublishOnly 也跑这一条
```

## 工程基线

CI 在 GitHub Actions 上跑（[ci.yml](.github/workflows/ci.yml)），发版由标签触发（[release.yml](.github/workflows/release.yml)）。

| 检查 | 环境 |
|---|---|
| `tsc --checkJs`（`index.js` + `lib/**`） | Ubuntu Node 22 / 24 |
| 单元测试 + 宿主 smoke test | Ubuntu Node 22 / 24，Windows Node 22 |
| 覆盖率门槛（`lib/**`） | Ubuntu Node 22 |
| 打包内容（`npm pack` 文件清单） | Ubuntu Node 22 |
| 真实 Host + 浏览器 e2e（临时 `DSH_HOME` + pinned `dsh` runtime） | Ubuntu Node 22 |

`npm run test:coverage` 在 `lib/**` 上的门槛是行 95% / 分支 90% / 函数 95%；`test/run-unit.mjs` 自己枚举 `*.test.mjs`，不依赖 shell 展开 glob，所以 Windows 上跑的是同一批用例。

支持基线是 **Node 22.13+**：Node 20 已于 2026 年 4 月 EOL，锁定的 pnpm 11 在 Node < 22.13 上无法运行（`node:sqlite`），而本插件实际运行的 DSH 运行时自带 Node 24。`engines.node` 已相应收紧到 `>=22.13`。

## 端到端测试

两个真实宿主套件共用 [test/e2e/harness.mjs](test/e2e/harness.mjs)：它定位一个可运行的 Harness CLI（本机桌面 App，或 `DSH_E2E_DSH_BIN` 指向 npm 安装的 `@deepseek-ai/dsh`），在临时 `DSH_HOME` 里生成 `web` profile 并 `link:` 本仓库，启动真实的 `dsh web`，再用启动 token 换浏览器 cookie。

- [test/e2e-host.mjs](test/e2e-host.mjs)：走真实 HTTP 面——插件在真实 Host 里加载、`/composer-prefill/prefs` 返回配置与 entry id、设置文档里本插件的命名空间存在且开关双向落盘（写入 profile patch）、未打开会话的 predict 不产生模型调用、405/403/400 围栏与 16 KiB 体积上限。
- [test/e2e-browser.mjs](test/e2e-browser.mjs)：Playwright + headless Chromium 打开真实界面——建议条从 `cached` 回放出现、点击填入草稿、清空后本地恢复（不再发请求）、`↻` 发 `refresh` 换一条、`✕` 忽略后打字再清空也不回来，以及设置 → 通用的开关写穿到宿主（真实 `/composer-prefill/prefs` 读到 `enabled:false`）。

浏览器套件用 Playwright 路由拦截 `/composer-prefill/predict` 的返回，所以它验的是**客户端状态机 + 真实 DSH 外壳**，不消耗模型调用；真实端点由 host 套件覆盖。`pnpm test:e2e` 需要一次 `pnpm exec playwright install chromium`，没有可用的 Harness 时会打印跳过信息并以 0 退出。

`client.js` 是 DSH 的 module-loader 脚本（`window.__ModuleLoader__.load` + `factory(require)`），不能当 ESM 导入，因此**不参与 tsc 检查**；它的行为由 `test/client-dom.test.mjs` 在 jsdom 里覆盖。

## 发版（维护者）

1. 改 `package.json` 版本与 `CHANGELOG.md`：把 `[Unreleased]` 下的条目收进新的 `## [x.y.z] - YYYY-MM-DD`，并补上版本链接。
2. 提交推送后打标签：`git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`。
3. 标签会触发 [release.yml](.github/workflows/release.yml)：先跑 `pnpm release:check`（标签 = `package.json` = CHANGELOG 最新版本），再跑类型检查、测试、smoke、打包校验，最后 `npm publish --provenance` 并创建 GitHub Release。

发布用 npm Trusted Publishing（OIDC），不需要 `NPM_TOKEN`：在 npmjs.com 该包的 **Settings → Publishing access → Trusted publishers** 里加上仓库 `wangxiaocuo/dsh-composer-prefill` 和 workflow `release.yml` 即可。如果更想用自动化 token，把 release.yml 里注释掉的 `NODE_AUTH_TOKEN` 打开并配上 secret。

## 已知限制

- 建议在**输入框上方**，不是光标处的内联幽灵文本（那需要测量/克隆 Lexical 编辑器 DOM，主题/缩放会坏）。
- `Tab` 依赖 `[data-composer-card]` 这一内部 DOM 约定，DSH 升级需要回归。
- 延迟：请求到显示约 1–3 秒（一次真实模型调用）。
- 只面向 `0.2.2-rc.1` 这一代 API，升级需要回归。
- `client.js` 是宿主 loader 直接加载的脚本，不在 `tsc --checkJs` 的检查范围内；类型检查只覆盖宿主半（`index.js` + `lib/**`）。
- 浏览器 e2e 把预测请求的返回用路由拦截桩掉，因此不覆盖真实模型输出质量；模型调用的正确性仍由单测与 smoke 的桩模型覆盖。

## 路线

- 0.1.x：骨架 + 建议条（M0/M1）
- 0.2.0：真模型调用、缓存/合并/限流、切会话缓存回显、清空草稿恢复
- 0.3.0：`↻ 换一条`、设置 → 通用 一行开关
- **0.3.1**：设置开关真正落盘（`volatile`）；真实宿主 + 浏览器 e2e 进入 CI 与发版闸门
- 0.4.0（可选）：内联幽灵文本、建议条上的候选切换
