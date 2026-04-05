# Tests

This project uses three test levels:

- `tests/unit/` — fast pure-function tests (no terminal spawn, no FIFO subprocess tree)
- `tests/integration/` — multi-module behavior (dispatcher + IPC + child runner)
- `tests/smoke/` — manual checks for GUI terminal launch behavior

## Current manual smoke test

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
