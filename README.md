# my_extension

A Pi extension package for launching and coordinating **subagents** in separate terminals, with per-agent sessions, live status tracking, and IPC-based updates.

## What it does

- Loads agent definitions from markdown files (`agents/`, `.claude/agents/`, `.pi/agents/`)
- Launches subagents in their own terminal windows
- Tracks each run with FIFO IPC (one FIFO per run)
- Tracks Pi session changes (`session_start` / `session_switch`) from child processes
- Updates output files on each assistant reply (not only at process end)
- Restores previous subagent sessions on parent startup

## Main extension

- `groups/riddle-team.ts`

Provides:
- Commands:
  - `/riddle-make <topic>`
  - `/riddle-solve`
  - `/riddle-status`
- Tool:
  - `dispatch_subagent`

## Agent file format

Define agents as markdown with frontmatter, e.g. `.pi/agents/riddle-maker.md`:

```md
---
name: riddle-maker
description: Creates riddles
tools: read,grep,find
inputs: outputs/context.md,src/topic.txt
thinking: medium
model: openrouter/anthropic/claude-3.7-sonnet
output: outputs/riddle-maker.md
---
You are a riddle-making assistant...
```

Supported frontmatter fields:
- `name` (required)
- `description`
- `tools`
- `inputs` (comma-separated file paths)
- `thinking`
- `model`
- `output`

## Running

From your project directory:

```bash
PI_TERMINAL=iterm pi -e groups/riddle-team.ts
```

Use any terminal launcher supported by your platform (`iterm`, `terminal`, `gnome-terminal`, `xterm`, etc.).

## Tool usage (`dispatch_subagent`)

Example call:

```json
{
  "agent": "riddle-maker",
  "task": "Write 3 riddles about recursion",
  "context": "fresh",
  "output": "outputs/riddle.md"
}
```

Optional fields:
- `context`: `fresh` or `fork`
- `inputs`: overrides agent/default inputs
- `output`: `false`, `true`, or file path
- `model`, `tools`, `thinking`: runtime overrides

### Fork behavior

If `context: "fork"`, the extension automatically forks from the **current master session id** (`ctx.sessionManager.getSessionId()`).

## Inputs and output behavior

### Inputs
Input files are read before launch and prepended to the task. Precedence:
1. invocation `inputs`
2. agent `.md` `inputs`
3. group override/default inputs

### Output
If output is enabled, the parent writes the **latest assistant reply** to the output file whenever a new reply arrives.

## Sessions and status

- Sessions are stored per agent under:
  - `.pi/sessions/riddle-team/<agent>/...jsonl`
- Parent status panel shows:
  - agent name
  - session/run id
  - status
  - session reason (when available)
  - number of messages received

## Notes

- `runId` (process identity) and session UUID (Pi session identity) are different by design.
- The child bridge extension (`subagent-session-bridge.js`) forwards child Pi events to parent via FIFO.
