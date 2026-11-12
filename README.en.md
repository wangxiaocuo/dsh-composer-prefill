# Composer prefill

[简体中文](README.md) · **English**

Codex-style composer predictions for DeepSeek Harness: after an assistant turn ends, a suggestion for the **next message you would type** appears above the composer. `Tab` or a click fills the draft — it is **never sent automatically**.

`@wangxiaocuo/dsh-composer-prefill`

[![npm](https://img.shields.io/npm/v/@wangxiaocuo/dsh-composer-prefill?label=npm)](https://www.npmjs.com/package/@wangxiaocuo/dsh-composer-prefill)
[![license](https://img.shields.io/npm/l/@wangxiaocuo/dsh-composer-prefill)](LICENSE)
[![CI](https://github.com/wangxiaocuo/dsh-composer-prefill/actions/workflows/ci.yml/badge.svg)](https://github.com/wangxiaocuo/dsh-composer-prefill/actions/workflows/ci.yml)

[Repository](https://github.com/wangxiaocuo/dsh-composer-prefill) · [Issues](https://github.com/wangxiaocuo/dsh-composer-prefill/issues) · [CHANGELOG](CHANGELOG.md) · [MIT](LICENSE)

> The [Chinese README](README.md) is the primary version; this file is its English edition.

---

## Behaviour

| Moment | What happens |
|---|---|
| Assistant turn ended, composer empty | One suggestion appears (single line, conversation language, prompt asks for ≤100 characters) |
| `Tab` / click the text | Fills the draft; nothing is sent |
| `↻` | Another one: force a fresh generation (skips the cache and the interval, one model call) with an "Asking for another…" progress state; an empty result keeps the current text |
| `Esc` / `✕` | Hidden for this turn (typing and clearing will not bring it back until the next turn) |
| Start typing | Hides immediately and aborts the in-flight request (saves tokens) |
| Delete what you typed | The suggestion returns **instantly** from local state, no request |
| Switch away and back | Returns instantly from the Host cache — **zero model calls** |
| Submit | The next turn's suggestion arrives after that turn ends |
| Model sees no plausible next message | It answers `NONE`; nothing shows |

The UI is one muted row above the composer, with a `↵` lead on the left and a `Tab` keycap, `↻` reroll and `✕` dismiss on the right:

```
↵ Shall we wire the e2e suite into CI?          Tab   ↻   ✕
```

It is the order-15 row in `conversation.input.dock` and does not take space inside the composer.

## Install

Published on npm: <https://www.npmjs.com/package/@wangxiaocuo/dsh-composer-prefill>

**From npm (recommended)**

```
Settings → Plugins → Install  →  @wangxiaocuo/dsh-composer-prefill
```

**Local checkout (from source)**

```
Settings → Plugins → Install  →  absolute path to this repository
```

After installing:

- **Settings → General** carries a "Composer predictions" switch that applies immediately and persists the choice in the profile;
- **Settings → Plugins → Composer predictions → Configuration** holds the other eight tunables (the master switch is the General row).

Runtime: DeepSeek Harness `0.2.2-rc.1` (see `engines.dsh`). The plugin runs on the Node that DSH itself ships; local development and tests require Node 22.13+ (see [Engineering baseline](#engineering-baseline)).

## How it works

```
Browser client half                               Host half
┌────────────────────────────────┐                ┌──────────────────────────────────┐
│ conversation.input.dock row    │ ────────────▶  │ /composer-prefill/predict        │
│ useInput / useSessionStatus    │                │ Host/Origin fence + owner check  │
│ AbortController (typing)       │ ◀───────────   │ LRU cache by (session, seq)      │
│ inputActions.insertText(span)  │                │ deriveMessages() last N turns    │
                                                  │ one small ctx.llm call           │
└────────────────────────────────┘                └──────────────────────────────────┘
```

Three kinds of request:

| Request | Meaning |
|---|---|
| `{sessionId}` | Normal request after a turn; the model is called only on a cache miss |
| `{sessionId, mode:"cached"}` | Cache-only replay used when a session view remounts: instant on a hit, **never generates** |
| `{sessionId, mode:"refresh"}` | `↻ Another one`: bypasses the cache and the interval and replaces the cached entry; the Host counts `attempt` and, from the second one, asks the model for a different angle instead of repeating the obvious answer |

Both endpoints are registered as exact routes on `ctx.webServer` and pass the same-origin/owner/CSRF fence. A second endpoint, `POST /composer-prefill/prefs`, tells the General settings row whether predictions are on and which Loader entry id owns the config form; the write goes through DSH's settings document and lands in the profile's `cordis.patch.yml`, overriding the base plugin-manager configuration.

`Tab` is a guarded enhancement: a bubble-phase listener that claims the key only when the row is visible, focus is inside `[data-composer-card]`, there is no IME/modifier, and no slash/`@` menu consumed it (`defaultPrevented`). Clicking is the supported path.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `showPredictions` | `true` | Master switch; off means zero model calls |
| `provider` / `model` | `""` | Empty follows the current session; both must be set to pin |
| `maxContextTurns` | `4` | Recent turns sent as context |
| `maxInputChars` | `4000` | Character budget for that context |
| `maxOutputTokens` | `64` | Output token budget |
| `timeoutMs` | `8000` | Give up (and show nothing) after this |
| `minIntervalMs` | `1500` | Minimum gap between requests |
| `debug` | `false` | Emit `[composer-prefill]` diagnostics to the Host log |

`showPredictions` is the only field that drives the visible switch, so prefer the **Settings → General** row; the other eight live in the Plugin Manager's configuration form.

## Cost and privacy

- **Only the session you are looking at generates.** Sessions you never open cost nothing.
- Each turn adds one request of roughly 2–4k input tokens and a few dozen output tokens. It never enters the transcript, the token meter or the context window — but the provider bills it.
- Context is the last N `user`/`assistant` **plain-text** turns only (tool results, images, attachments and reasoning are stripped). The route follows the session's own provider/model and never crosses providers.
- Model output is untrusted: first line only, quotes stripped, length-capped, and inserted **only when you accept it**. It is never auto-sent.

## Prompt

The system prompt lives in [`prompt.txt`](prompt.txt) and is re-read when its modification time changes — edit it and the next turn uses it, **no restart**. A missing or empty file falls back to the built-in prompt. The prompt asks for one line, conversation language, ≤100 characters; the code still strips quotes, bullets and extra lines, and caps the result at 200 characters.

## Known limits

- The suggestion sits **above** the composer, not as inline ghost text at the caret (that would require measuring and cloning the Lexical editor DOM, which breaks under themes and zoom).
- `Tab` relies on the internal `[data-composer-card]` DOM contract; DSH upgrades need a regression pass.
- Latency is one real model call, roughly 1–3 seconds.
- Targets the `0.2.2-rc.1` API generation; upgrades need a regression pass.
- `client.js` is loaded directly by the Host loader and is outside `tsc --checkJs`; only the Host half (`index.js` + `lib/**`) is typechecked.
- The browser e2e stubs the prediction response through route interception, so it does not cover real model output quality, and it depends on the plugin's English accessible names plus DSH's settings/dialog DOM; DSH upgrades need a regression pass.

## Roadmap

- 0.1.x: skeleton + suggestion row (M0/M1)
- 0.2.0: real model call, cache/coalescing/throttling, cached replay on session switch, restore when the draft is cleared
- 0.3.0: `↻ another one`, a Settings → General switch
- **0.3.1**: the switch actually persists (`volatile`); real host + browser e2e join CI and the release gate
- 0.4.0 (optional): inline ghost text, candidate cycling on the row

## Development

```
index.js            Host: Config + route registration
lib/http.js         Same-origin endpoint, fence/owner/CSRF checks, body reading
lib/predictions.js  Cache, request coalescing, throttling, RPC handler
lib/generate.js     One ctx.llm call (route, context, output hygiene)
lib/prompt.js       Context trimming, output sanitising, hot-reloaded prompt
lib/config.js       Config readers (schemastery refs or plain values)
client.js           Browser half: the row, trigger state machine, Tab/Esc, accept
prompt.txt          System prompt
test/               Unit tests, Host smoke, browser-half DOM, real-host e2e
```

- `client.js` changes: reload the page.
- `index.js` / `lib/*.js` changes: **quit and reopen the app**. This desktop build ships no Host-side module replacement, and Node caches ES modules for the process lifetime.

```bash
pnpm install
pnpm typecheck        # tsc --checkJs (index.js + lib/**)
pnpm test             # unit tests (node:test, Host lib + browser-half DOM)
pnpm test:coverage    # coverage floor on lib/** (same flags as CI)
pnpm test:smoke       # endpoint end-to-end (real Cordis wiring, scripted model)
pnpm test:e2e         # real dsh web + headless Chromium end-to-end (below)
pnpm pack:check       # verify the npm tarball file list
pnpm verify           # typecheck + test + smoke + pack:check; also runs on prepublishOnly
```

## Engineering baseline

CI runs on GitHub Actions ([ci.yml](.github/workflows/ci.yml)) and releases are tag-triggered ([release.yml](.github/workflows/release.yml)).

| Check | Environment |
|---|---|
| `tsc --checkJs` (`index.js` + `lib/**`) | Ubuntu Node 22 / 24 |
| Unit tests + Host smoke test | Ubuntu Node 22 / 24, Windows Node 22 |
| Coverage floor (`lib/**`) | Ubuntu Node 22 |
| Package contents (`npm pack` file list) | Ubuntu Node 22 |
| Real Host + browser e2e (throwaway `DSH_HOME`, pinned `dsh` runtime) | Ubuntu Node 24 |

`npm run test:coverage` requires lines 95 / branches 90 / functions 95 on `lib/**`; `test/run-unit.mjs` enumerates `*.test.mjs` itself instead of relying on shell glob expansion, so Windows runs the same set of cases.

The supported baseline is **Node 22.13+**: Node 20 reached end of life in April 2026, the pinned pnpm 11 cannot run on Node < 22.13 (`node:sqlite`), and the DSH runtime this plugin loads into ships Node 24. `engines.node` is therefore `>=22.13`.

The settings namespace depends on `Config.showPredictions` being `.volatile()` — remove that marker and the settings switch silently stops persisting (the host e2e asserts this).

## End-to-end tests

Both real-host suites share [test/e2e/harness.mjs](test/e2e/harness.mjs): it locates a runnable Harness CLI (the local desktop app, or the npm-installed `@deepseek-ai/dsh` that `DSH_E2E_DSH_BIN` points at), generates a `web` profile in a throwaway `DSH_HOME` with this repository `link:`-installed, boots the real `dsh web`, and redeems the launch token for a browser cookie.

- [test/e2e-host.mjs](test/e2e-host.mjs): exercises the real HTTP surface — the bundle loads in a real Host, `/composer-prefill/prefs` returns the effective config and entry id, the plugin's settings namespace exists and the switch persists in both directions to the profile patch, predicting for an unopened session makes no model call, and the 405/403/400 fences plus the 16 KiB body cap hold.
- [test/e2e-browser.mjs](test/e2e-browser.mjs): Playwright + headless Chromium drives the real UI — the row appears from a `cached` replay, clicking fills the draft, clearing restores it locally without another request, `↻` sends `refresh` and swaps the text, `✕` suppresses it across typing/clearing, and the Settings → General switch writes through to the Host (the real `/composer-prefill/prefs` reports `enabled:false`).

The browser suite fulfils `/composer-prefill/predict` through Playwright routing, so it verifies the **client state machine inside the real DSH shell** without spending a model call; the real endpoint is covered by the host suite. `pnpm test:e2e` needs a one-time `pnpm exec playwright install chromium`; with no runnable Harness it prints a skip message and exits 0.

`client.js` is a DSH module-loader script (`window.__ModuleLoader__.load` + `factory(require)`) and cannot be imported as ESM, so it is **not typechecked**; its behaviour is covered by `test/client-dom.test.mjs` under jsdom.

## Releasing (maintainers)

1. Bump the version in `package.json` and fold the `[Unreleased]` entries into a new `## [x.y.z] - YYYY-MM-DD` section in `CHANGELOG.md`, with its version link.
2. Commit, push, then tag: `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`.
3. The tag runs [release.yml](.github/workflows/release.yml): `pnpm release:check` (tag = `package.json` = newest CHANGELOG version), then typecheck, unit tests, smoke, pack check and both real-host e2e suites, then `npm publish --provenance` and a GitHub Release.

Publishing uses npm Trusted Publishing (OIDC), so no `NPM_TOKEN` is required: add repository `wangxiaocuo/dsh-composer-prefill` and workflow `release.yml` under the package's **Settings → Publishing access → Trusted publishers** on npmjs.com. To use an automation token instead, uncomment the `NODE_AUTH_TOKEN` environment variable in release.yml and add the matching secret.

## License

MIT License © 2026 [wangxiaocuo](https://github.com/wangxiaocuo)
