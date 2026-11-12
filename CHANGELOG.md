# Changelog

## 0.3.0 — 2026-11-12

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

## 0.2.0 — 2026-11-12

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

## 0.1.0 — 2026-11-12

### Added

- Bundle skeleton: Host row with a schemastery `Config`, Client module that
  registers a suggestion row in `conversation.input.dock`.
- Borderless suggestion strip matched to the composer's own material, typography
  and text inset.
- Guarded `Tab` accept (bubble phase, `[data-composer-card]`, IME and
  `defaultPrevented` checks), click-to-accept through `inputActions` with a
  `draftRev` CAS, `Esc`/`✕` dismissal.
