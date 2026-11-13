# Changelog

本文件记录这个插件的所有重要变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.4.0] - 2026-11-13

### Added

- 切回会话时的补预测（`view` 模式）：浏览器半在打开 / 切回会话时不再用 `cached`，改为发 `{sessionId, mode:"view"}`；宿主按会话记住上次被询问时的 seq，缓存命中当前 offset 就直接回显，检测到会话在你上次询问之后有了新记录（通常是那一轮在你查看别的会话时跑完）才补生成一条建议（只生成一次）。这次补生成只在有明确结果后才记为已询问：中途被中止（切走或开始打字）或被最小间隔拦下的那次不算，下次切回会重试。没询问过、没变化的会话仍然零模型调用；回合结束时的默认请求、`↻ 换一条`（`refresh`）和只读回放的 `cached` 模式不变。

### Tests

- 宿主单元测试、宿主 smoke、浏览器半 DOM 与 e2e 覆盖 `view`：缓存回显不走模型、有新记录才补一条、没前进不补、没询问过不补；被中止或被最小间隔拦下的补生成不算已询问，下次 `view` 会重试；浏览器 e2e 的挂载断言从 `cached` 改为 `view`。

## [0.3.2] - 2026-11-12

### Changed

- 文档（仅 README，无运行时代码变更）：中英文 README 顶部互加语言切换和仓库 / Issues / CHANGELOG / 许可链接；修正不准确描述——建议长度是提示词要求 ≤100 字符（代码硬上限 200）而不是 120，设置开关写入的是 DSH 的 settings 文档并落到 profile patch、覆盖插件管理器里的基础配置，e2e job 实际运行在 Node 24；架构图按中日韩字符的双列显示宽度重新对齐；用户向章节前置、维护者章节后置；补充运行环境、界面示意、已知限制和 MIT 许可段。

## [0.3.1] - 2026-11-12

### Added

- GitHub Actions CI（`.github/workflows/ci.yml`）：Ubuntu Node 22/24 与 Windows Node 22 上跑 `tsc --checkJs`、单元测试和宿主 smoke test；另有单独的覆盖率门槛（`lib/**`）与打包内容校验。Windows 覆盖是为了证明测试入口不依赖 shell glob。
- 标签触发的发版流水线（`.github/workflows/release.yml`）：推送 `vX.Y.Z` 标签后校验标签与 `package.json` 版本一致、重跑全部检查，再用 npm Trusted Publishing（OIDC，无需 `NPM_TOKEN`）`npm publish --provenance`，最后创建 GitHub Release。
- 工程校验脚本：`scripts/check-release.mjs` 校验 `package.json`、`CHANGELOG.md` 与 git 标签三方一致；`scripts/check-pack.mjs` 校验 npm tarball 的文件清单（运行所需文件都在、测试/CI/开发文件都不在）。
- 宿主侧单元测试：`lib/config.js`、`lib/generate.js`、`lib/http.js`、`lib/predictions.js` 现在有独立的 `node:test` 用例，覆盖率门槛落在 CI 里；`test/run-unit.mjs` 自己枚举测试文件，Windows 与 POSIX shell 行为一致。
- Dependabot：每周检查 npm 依赖与 GitHub Actions 版本；minor/patch 自动开 PR，测试工具链（TypeScript / jsdom / React / `@types/node`）的 major 走手动升级。
- 真实宿主端到端（`test/e2e-host.mjs`）：在临时 `DSH_HOME` 里用生成的 `web` profile `link:` 本仓库、启动真实 `dsh web`，验证插件确实被宿主加载、`/composer-prefill/prefs` 返回配置与 entry id、未打开会话的 predict 不触发模型调用，以及 405/403/400/16 KiB 围栏。
- 浏览器端到端（`test/e2e-browser.mjs`，Playwright + headless Chromium）：在真实 DSH 界面里验证建议条从 `cached` 回放出现、点击填入草稿、清空后本地恢复且不再发请求、`↻` 发 `refresh` 换一条、`✕` 后打字再清空也不回来，以及设置 → 通用开关写穿到真实宿主。
- `test:e2e` / `test:e2e:host` / `test:e2e:browser` 脚本；CI 与 release 流水线各加一个 e2e job（真实 Host 套件 + 浏览器套件），发版前多一道真机闸门。

### Fixed

- 设置 → 通用里的「输入预测」开关在真实 DSH 里其实**没有落盘**：`showPredictions` 没有标记 `volatile`，`@deepseek-ai/dsh-settings` 因此不会为本插件暴露设置命名空间，开关只停留在客户端乐观状态，写入被宿主拒绝。现在该字段改为 `.volatile()`，开关会写进 profile patch，宿主 `/composer-prefill/prefs` 即时反映（由浏览器 e2e 发现并回归）。其余 8 个调优字段仍走插件管理器的普通配置。

### Changed

- `npm test` 改由 `test/run-unit.mjs` 驱动；新增 `typecheck`、`test:coverage`、`pack:check`、`release:check`、`verify` 脚本，`prepublishOnly` 会在本地发布前跑完整 `verify`。
- 宿主代码（`index.js` + `lib/**`）纳入 `tsc --checkJs`：新增 `tsconfig.json` 与 `types/dsh-context.d.ts`，JSDoc 类型与 DSH 服务契约对齐。浏览器半 `client.js` 不在检查范围内。
- `.gitignore` 补齐覆盖率、tarball、临时目录与本地 DSH 数据。
- 支持基线收紧到 **Node 22.13+**（原 `>=20`）：Node 20 已 EOL，pnpm 11 在 Node < 22.13 上无法运行，DSH 运行时本身是 Node 24；`engines.node`、CI 矩阵（Ubuntu 22/24 + Windows 22）与 `@types/node` 同步调整。
- README 中英文补上 CI 徽章、工程基线、发版流程与新的开发命令。

## [0.3.0] - 2026-11-12

### Added

- **`↻ 换一条`** on the suggestion row. A reroll skips the Host cache and the
  minimum interval, supersedes any generation already running for the session,
  and replaces the cached entry. The row shows `换一条中…` while the request is
  in flight, and an empty result keeps the current suggestion instead of
  blanking the row.
- **Settings → General switch.** A "输入预测 / Composer predictions" row mirrors
  and writes `showPredictions`. It reads the effective value and the Loader
  entry id from a new `POST /composer-prefill/prefs` endpoint, then writes
  through DSH's shared `configForms` document — the same one the Plugin
  Manager's form edits — so the choice persists in the profile.
- **Attempt-aware rerolls.** The Host counts how many times a suggestion was
  requested for one turn and sends `attempt` with the conversation payload.
  From attempt 2 the model is asked for a different angle rather than the same
  obvious message; the counter resets with each new turn.

### Changed

- The HTTP surface is split into two exact routes: `/composer-prefill/predict`
  and `/composer-prefill/prefs`.
- Accepting is disabled while a reroll is in flight, so the stale text cannot
  be inserted by a stray Tab.

### Tests

- Host smoke test covers refresh (cache bypass, interval bypass, cache
  replacement), prefs (switch value, entry id, missing entry id), attempt
  counting and both endpoints' guards.
- Browser-half DOM test covers the reroll progress state, the empty-reroll
  fallback and the settings row's read/write path.

## [0.2.0] - 2026-11-12

### Added

- Real prediction generation: one bounded `ctx.llm` call on the session's own
  route, context taken from `session.deriveMessages()` (last N turns, plain
  text only), sanitized to one line, never written to the session log.
- Per-`(session, log offset)` LRU cache, request coalescing and a minimum
  interval between generations.
- `mode: "cached"` replay: re-opening a session shows the suggestion again
  without any model call.
- Clearing the composer restores the last suggestion locally, without a
  request.
- `prompt.txt`: the system prompt is re-read when its mtime changes, so tuning
  it never needs a restart.

### Fixed

- The prepared LLM call no longer rejects its own dispatch: every request
  control is chosen in `prepareCall`, and `stream()` receives only the
  non-config fields.
- `max-tokens` finishes still yield their first line instead of being dropped;
  `timeoutMs` raised to 8s and `maxOutputTokens` to 64.

## [0.1.0] - 2026-11-12

### Added

- Bundle skeleton: Host row with a schemastery `Config`, Client module that
  registers a suggestion row in `conversation.input.dock`.
- Borderless suggestion strip matched to the composer's own material, typography
  and text inset.
- Guarded `Tab` accept (bubble phase, `[data-composer-card]`, IME and
  `defaultPrevented` checks), click-to-accept through `inputActions` with a
  `draftRev` CAS, `Esc`/`✕` dismissal.

[Unreleased]: https://github.com/wangxiaocuo/dsh-composer-prefill/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/wangxiaocuo/dsh-composer-prefill/compare/v0.3.2...v0.4.0
[0.3.2]: https://github.com/wangxiaocuo/dsh-composer-prefill/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/wangxiaocuo/dsh-composer-prefill/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/wangxiaocuo/dsh-composer-prefill/releases/tag/v0.3.0

<!-- v0.1.0 and v0.2.0 predate the repository's first tag and have no link targets. -->
