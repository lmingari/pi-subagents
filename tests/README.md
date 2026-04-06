# Tests

This project uses three test levels:

- `tests/unit/` — fast pure-function tests (no terminal spawn, no FIFO subprocess tree)
- `tests/integration/` — multi-module behavior (dispatcher + IPC + child runner)
- `tests/smoke/` — manual checks for GUI terminal launch behavior

## Fixtures

Agent markdown fixtures live under `tests/fixtures/agents/`.
(Previously they were under a top-level `assets/` folder; moved to keep test data co-located with tests.)

## Automated unit tests

Implemented:

- `tests/unit/agent-loader.test.ts`
  - frontmatter parsing
  - empty tools fallback
  - provider/modelID parsing (`provider/modelID` convention)
  - directory scan precedence
- `tests/unit/session-files.test.ts`
  - validates session filename `<timestamp>_<uuid>.jsonl` against JSONL header

Run with Node + tsx loader:

```bash
node --import tsx --test tests/unit/agent-loader.test.ts tests/unit/session-files.test.ts
```

Or without installing globally:

```bash
npx -y tsx --test tests/unit/agent-loader.test.ts tests/unit/session-files.test.ts
```

If your environment cannot import `@mariozechner/pi-coding-agent` in tests,
install it as a local dev dependency in this project so Node/tsx can resolve package exports consistently.

## Manual smoke test

### Terminal launcher smoke test

Script: `tests/smoke/terminal-launcher.sh`

Run:

```bash
PI_TERMINAL=foot bash tests/smoke/terminal-launcher.sh
```

Replace `foot` with your terminal (`xterm`, `gnome-terminal`, `iterm`, `terminal`, `wt`, etc.).

Success criteria:

1. A terminal window opens
2. It prints `"[launcher-test] started"`
3. It stays open ~6 seconds
4. It prints `"[launcher-test] done"` and exits

## Suggested next automated tests

- Unit:
  - `agent-loader.ts` frontmatter parsing edge-cases
  - `session.ts` fresh/fork session resolution
  - `dispatcher.ts` output-path resolution
- Integration:
  - `ipc.ts` FIFO open timeout and close behavior
  - `dispatcher.ts` run lifecycle in hidden terminal mode

When you choose a framework/runtime (Deno test, Vitest, Node test runner), place test files under the folders above and expose them through one command (e.g. `npm test` or `deno test`).
