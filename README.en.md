# Composer prefill

Codex-style composer predictions for DeepSeek Harness: after an assistant turn ends, a suggestion for the **next message you would type** appears above the composer. `Tab` or a click fills the draft — it is **never sent automatically**.

`@wangxiaocuo/dsh-composer-prefill`

[![npm](https://img.shields.io/npm/v/@wangxiaocuo/dsh-composer-prefill?label=npm)](https://www.npmjs.com/package/@wangxiaocuo/dsh-composer-prefill)
[![license](https://img.shields.io/npm/l/@wangxiaocuo/dsh-composer-prefill)](LICENSE)

---

## Behaviour

| Moment | What happens |
|---|---|
| Assistant turn ended, composer empty | One suggestion appears (single line, conversation language, ≤120 chars) |
| `Tab` / click the text | Fills the draft; nothing is sent |
| `↻` | Another one: force a fresh generation (skips the cache and the interval, one model call) with a "Asking for another…" progress state; an empty result keeps the current text |
| `Esc` / `✕` | Hidden for this turn (typing and clearing will not bring it back until the next turn) |
| Start typing | Hides immediately and aborts the in-flight request (saves tokens) |
| Delete what you typed | The suggestion returns **instantly** from local state, no request |
| Switch away and back | Returns instantly from the Host cache — **zero model calls** |
| Submit | The next turn's suggestion arrives after that turn ends |
| Model sees no plausible next message | It answers `NONE`; nothing shows |

The UI is one muted row above the composer card (`conversation.input.dock`, order 15) with a `↵` lead, a `Tab` keycap and `✕`.

## Install

Published on npm: <https://www.npmjs.com/package/@wangxiaocuo/dsh-composer-prefill>

**From npm (for everyone else)**

```
Settings → Plugins → Install  →  @wangxiaocuo/dsh-composer-prefill
```

**Local checkout (how this machine runs it)**

```
Settings → Plugins → Install  →  absolute path to this repository
```

**Settings → General** then carries a "Composer predictions" switch (applies immediately), and the nine tunables appear under **Settings → Plugins → Composer predictions → Configuration**.

## How it works

```
Browser client half                                  Host half
┌──────────────────────────────┐  same-origin POST ┌─────────────────────────────┐
│ conversation.input.dock row   │ ────────────────▶ │ /composer-prefill/predict    │
│ useInput / useSessionStatus   │                  │ host/origin fence + owner    │
│ AbortController (typing)      │ ◀──────────────── │ LRU cache by (session, seq)  │
│ inputActions.insertText(span) │   {enabled,text} │ deriveMessages() tail        │
└──────────────────────────────┘                  │ one small ctx.llm call       │
                                                  └─────────────────────────────┘
```

Two request modes:

| Request | Meaning |
|---|---|
| `{sessionId}` | Normal request after a turn; the model is called only on a cache miss |
| `{sessionId, mode:"cached"}` | Cache-only replay used when a session view remounts: instant on a hit, **never generates** |
| `{sessionId, mode:"refresh"}` | `↻ Another one`: bypasses the cache and the interval and replaces the cached entry; the Host counts `attempt` and, from the second one, asks the model for a different angle instead of repeating the obvious answer |

A second endpoint, `POST /composer-prefill/prefs`, tells the General settings row whether predictions are on and which Loader entry id owns the config form; the write goes through DSH's own `configForms`, the same document the Plugin Manager's form edits.

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

## Cost and privacy

- **Only the session you are looking at generates.** Sessions you never open cost nothing.
- Each turn adds one request of roughly 2–4k input tokens and a few dozen output tokens. It never enters the transcript, the token meter or the context window — but the provider bills it.
- Context is the last N `user`/`assistant` **plain-text** turns only (tool results, images, attachments and reasoning are stripped). The route follows the session's own provider/model and never crosses providers.
- Model output is untrusted: first line only, quotes stripped, length-capped, and inserted **only when you accept it**. It is never auto-sent.

## Prompt

The system prompt lives in [`prompt.txt`](prompt.txt) and is re-read when its modification time changes — edit it and the next turn uses it, **no restart**. A missing or empty file falls back to the built-in prompt.

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
test/               Host smoke, prompt units, browser-half DOM behaviour
```

- `client.js` changes: reload the page.
- `index.js` / `lib/*.js` changes: **quit and reopen the app**. This desktop build ships no Host-side module replacement, and Node caches ES modules for the process lifetime.
- Tests: `npm test` (prompt units + browser-half DOM behaviour) · `npm run test:smoke` (endpoint end-to-end with a scripted model)

## Known limits

- The suggestion sits **above** the composer, not as inline ghost text at the caret (that would require measuring and cloning the Lexical editor DOM, which breaks under themes and zoom).
- `Tab` relies on the internal `[data-composer-card]` DOM contract; DSH upgrades need a regression pass.
- Latency is one real model call, roughly 1–3 seconds.
- Targets the `0.2.2-rc.1` API generation; upgrades need a regression pass.

## Roadmap

- 0.1.x: skeleton + suggestion row (M0/M1)
- 0.2.0: real model call, cache/coalescing/throttling, cached replay on session switch, restore when the draft is cleared
- **0.3.0**: `↻ another one`, a Settings → General switch
- 0.4.0 (optional): inline ghost text, candidate cycling on the row
