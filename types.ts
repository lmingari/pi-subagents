/**
 * types.ts — Core type definitions for the pi multi-agent extension system.
 *
 * Design decisions:
 *   - Terminal   : one per agent, app from PI_TERMINAL env var (throws if unset)
 *   - IPC        : one FIFO per agent, child → parent only, lives in session dir
 *   - AgentGroup : declared in .ts extension files (pi -e my-group.ts)
 *   - Inputs     : file paths read at dispatch time, injected into task string
 *   - Output     : false | true | path string — controls response file writing
 *   - Context    : "fresh" (clean start) | "fork" (resume own prior session)
 *   - Autonomy   : subagents are fully independent after launch; no live parent
 *                  channel. New context = new dispatch.
 */

// ── Token accounting ──────────────────────────────────────────────────────────

export interface TokenUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

// ── Agent definition (parsed from .pi/agents/*.md frontmatter) ────────────────

/**
 * Frontmatter fields recognised in agent .md files:
 *
 *   ---
 *   name: code-reviewer
 *   description: Reviews code for bugs and style issues
 *   tools: read,grep,find,ls
 *   thinking: medium
 *   model: openrouter/google/gemini-2.5-flash-preview
 *   output: outputs/code-reviewer.md   # relative to cwd, optional
 *   ---
 *   <system prompt body>
 *
 * outputFile is the default output path used when a dispatch sets output: true
 * and does not supply an explicit path. If neither is present, the dispatcher
 * auto-generates <sessionDir>/<agentName>.out.md.
 */
export interface AgentDef {
	/** Unique identifier, matches filename stem (e.g. "code-reviewer") */
	name: string;
	/** One-line description shown in dashboards and system prompts */
	description: string;
	/** Optional comma-separated pi tool names this agent is allowed to use */
	tools?: string;
	/** Optional default thinking level for this agent */
	thinking?: string;
	/** Optional default model for this agent (overridden by DispatchRequest.model) */
	model?: string;
	/** Full system prompt body (everything after the frontmatter block) */
	systemPrompt: string;
	/** Absolute path to the source .md file */
	file: string;
	/**
	 * Default output file path, relative to cwd at dispatch time.
	 * Used when a dispatch sets output: true without providing an explicit path.
	 * If absent and output: true, falls back to <sessionDir>/<agentName>.out.md.
	 */
	outputFile?: string;
}

// ── Dispatch context ──────────────────────────────────────────────────────────

/**
 * fresh — start in the per-agent session directory without forking.
 * fork  — launch with --fork <sessionId> (source session provided in DispatchRequest.forkSessionId).
 */
export type DispatchContext = "fresh" | "fork";

// ── Output resolution ─────────────────────────────────────────────────────────

/**
 * Controls whether and where the agent's last LLM response is written to disk.
 * The file is overwritten (not appended) after each answer.
 *
 * Resolution order at dispatch time:
 *   1. string  → use this path (relative to cwd)
 *   2. true    → use AgentDef.outputFile if defined,
 *                otherwise auto-generate <sessionDir>/<agentName>.out.md
 *   3. false   → no file written
 */
export type OutputTarget = string | boolean;

// ── Inputs ────────────────────────────────────────────────────────────────────

/**
 * File paths (relative to cwd) read at dispatch time.
 * Their contents are injected into the task string before the agent is launched.
 * This is the only mechanism for passing runtime context into a subagent —
 * there is no live channel after launch.
 *
 * Example: read the last response of another agent and pass it as context:
 *   inputs: ["outputs/refactor-bot.md", "src/auth.ts"]
 */
export type InputFiles = string[];

// ── Terminal target ───────────────────────────────────────────────────────────

/**
 * env    — reads PI_TERMINAL at dispatch time; throws if the variable is unset.
 * hidden — no terminal opened; stdout/stderr piped to parent (for tests / CI).
 *
 * Supported PI_TERMINAL values (add new launchers in terminal.ts):
 *   "terminal"        macOS Terminal.app
 *   "iterm"           macOS iTerm2
 *   "gnome-terminal"  GNOME Terminal (Linux)
 *   "wt"              Windows Terminal
 *   "xterm"           xterm (widely available fallback)
 *   <any string>      forwarded to the launcher registry in terminal.ts
 */
export type TerminalApp =
	| "terminal"
	| "iterm"
	| "gnome-terminal"
	| "wt"
	| "xterm"
	| string;

export type TerminalTarget =
	| { type: "env" }     // normal mode — reads PI_TERMINAL
	| { type: "hidden" }; // test / CI mode — pipes to parent

// ── IPC — FIFO (child → parent only) ─────────────────────────────────────────

/**
 * One FIFO per run: <sessionDir>/<agentName>-<runId>.fifo
 *
 * Lifecycle:
 *   1. Parent creates the FIFO (mkfifo) before launching the terminal.
 *   2. Parent opens the FIFO and waits until child connects or openTimeoutMs elapses.
 *   3. Child opens O_WRONLY, writes newline-delimited JSON (IpcMessage).
 *   4. Parent reads until agent_done / agent_error, then unlinks the FIFO.
 *
 * Kept as a single-variant discriminated union so unix-socket / tcp can be
 * added in ipc.ts without touching any call sites.
 */
export type IpcTransport = FifoTransport;
// future: | UnixSocketTransport | TcpTransport

export interface FifoTransport {
	type: "fifo";
	/** Absolute path: <sessionDir>/<agentName>-<runId>.fifo — filled in by dispatcher */
	path: string;
	/** Max ms to wait for child to open the write-end. Default: 10_000 */
	openTimeoutMs?: number;
}

// ── IPC message envelope (child → parent, newline-delimited JSON) ─────────────

export type IpcMessage =
	| { type: "text_delta";     runId: string; delta: string }
	| { type: "tool_start";     runId: string; toolName: string }
	| { type: "tool_end";       runId: string; toolName: string; durationMs: number }
	| { type: "context_update"; runId: string; usedTokens: number; contextWindow: number }
	| { type: "token_usage";    runId: string; usage: TokenUsage }
	| { type: "session_update"; runId: string; sessionId?: string; sessionFile?: string; timestamp?: string; reason?: string }
	| { type: "agent_done";     runId: string; exitCode: number; output: string; usage: TokenUsage }
	| { type: "agent_error";    runId: string; message: string };

// ── Dispatch request ──────────────────────────────────────────────────────────

/**
 * Everything needed to launch a single subagent.
 *
 * Example:
 *   {
 *     agent: "worker",
 *     task: "continue this thread",
 *     inputs: ["outputs/planner.md"],
 *     output: "outputs/worker.md",
 *     context: "fork",
 *     terminal: { type: "env" },
 *     ipc: { type: "fifo", path: "" },  // path filled by dispatcher
 *     sessionDir: "/project/.pi/sessions/run-abc123",
 *     cwd: "/project",
 *   }
 */
export interface DispatchRequest {
	/** Agent name, matched case-insensitively against AgentDef.name */
	agent: string;
	/** Base task / prompt. Input file contents are prepended before launch. */
	task: string;
	/**
	 * File paths (relative to cwd) to read and inject into the task at launch.
	 * This is the only way to pass runtime context — there is no live channel.
	 */
	inputs: InputFiles;
	/**
	 * Output file behaviour (see OutputTarget for resolution order).
	 * Defaults to false if omitted.
	 */
	output: OutputTarget;
	/** Session handling */
	context: DispatchContext;
	/** Terminal mode — normally { type: "env" } */
	terminal: TerminalTarget;
	/**
	 * IPC descriptor. The dispatcher sets path = <sessionDir>/<agentName>-<runId>.fifo
	 * before spawning. Callers can leave path empty.
	 */
	ipc: IpcTransport;
	/** Absolute path to the session directory for this run */
	sessionDir: string;
	/** Working directory for the subprocess */
	cwd: string;
	/** Override the model for this specific dispatch */
	model?: string;
	/** Override tools for this specific dispatch */
	tools?: string;
	/** Override thinking level for this specific dispatch */
	thinking?: string;
	/** For context:"fork", source session UUID to fork from */
	forkSessionId?: string;
	/** Extra pi CLI flags forwarded verbatim */
	extraArgs?: string[];
}

// ── Resolved output path (computed by dispatcher) ─────────────────────────────

/**
 * After resolving OutputTarget against AgentDef, the dispatcher always works
 * with a concrete optional path.
 */
export type ResolvedOutputPath = string | null;

// ── Live agent run ────────────────────────────────────────────────────────────

export type RunStatus = "queued" | "running" | "complete" | "failed" | "cancelled";

export interface AgentRun {
	runId: string;
	def: AgentDef;
	request: DispatchRequest;
	/** Resolved output path (null if output: false) */
	resolvedOutputPath: ResolvedOutputPath;
	status: RunStatus;
	startedAt: number;
	endedAt?: number;
	/** Full accumulated text output */
	output: string;
	/** Last non-empty line of output (dashboard card preview) */
	lastWork: string;
	toolCount: number;
	/** Context window usage 0–100 % */
	contextPct: number;
	/** How many times this agent has been dispatched in the current session */
	runCount: number;
	/** Elapsed ms, updated every second while running */
	elapsed: number;
	usage?: TokenUsage;
	/** Active pi session UUID reported by child extension events */
	sessionId?: string;
	/** Active pi session file reported by child extension events */
	sessionFile?: string;
	/** Last session event reason from child (startup/new/resume/fork/reload/...) */
	sessionReason?: string;
	/** PID of the spawned terminal process */
	pid?: number;
}

// ── Final result ──────────────────────────────────────────────────────────────

/** Resolved value of the Promise returned by dispatchAgent(). */
export interface AgentRunResult {
	runId: string;
	agentName: string;
	output: string;
	exitCode: number;
	elapsed: number;
	usage: TokenUsage;
	/** Path written to, if any */
	outputPath: ResolvedOutputPath;
}

// ── Agent group (exported as default from each .ts extension file) ────────────

/**
 * One group = one extension file = one `pi -e my-group.ts` invocation.
 *
 * Example:
 *
 *   import type { AgentGroup } from "./types.ts";
 *
 *   export default {
 *     name: "backend-team",
 *     description: "Agents for backend development tasks",
 *     members: ["planner", "worker", "reviewer"],
 *     defaults: {
 *       context: "fork",
 *       terminal: { type: "env" },
 *       ipc: { type: "fifo", path: "", openTimeoutMs: 10_000 },
 *       output: true,
 *       inputs: [],
 *     },
 *     overrides: {
 *       "worker": { context: "fresh", output: "outputs/worker-latest.md" },
 *     },
 *   } satisfies AgentGroup;
 */
export interface AgentGroup {
	name: string;
	description?: string;
	/** Must match AgentDef.name values found in .pi/agents/*.md */
	members: string[];
	/** Applied to every dispatch in this group */
	defaults: {
		context: DispatchContext;
		terminal: TerminalTarget;
		/** path is left empty; dispatcher fills it in per run */
		ipc: Pick<FifoTransport, "type" | "openTimeoutMs">;
		output: OutputTarget;
		inputs: InputFiles;
		model?: string;
		tools?: string;
		thinking?: string;
	};
	/**
	 * Per-agent overrides (key = agent name, case-insensitive).
	 * Wins over defaults for that specific agent.
	 */
	overrides?: Record<string, Partial<{
		context: DispatchContext;
		terminal: TerminalTarget;
		output: OutputTarget;
		inputs: InputFiles;
		model: string;
		tools: string;
		thinking: string;
		forkSessionId: string;
		openTimeoutMs: number;
	}>>;
	/** Dashboard grid columns (auto-computed from member count if omitted) */
	gridCols?: number;
}

// ── Session persistence ───────────────────────────────────────────────────────

/**
 * Written to <sessionDir>/<agentName>/meta.json.
 * Session transcript files live next to it as:
 *   <sessionDir>/<agentName>/<timestamp>_<uuid>.jsonl
 *
 * Tracks per-agent recent session metadata for status and resume visibility.
 */
export interface AgentSession {
	agentName: string;
	/** Absolute path to the active/recent pi session .jsonl file */
	sessionFile: string;
	createdAt: number;
	lastUsedAt: number;
	runCount: number;
	totalUsage: TokenUsage;
}

// ── Async / background job types ──────────────────────────────────────────────

export interface AsyncStatus {
	runId: string;
	mode: "single" | "chain";
	state: "queued" | "running" | "complete" | "failed";
	startedAt: number;
	endedAt?: number;
	lastUpdate?: number;
	cwd?: string;
	currentStep?: number;
	steps?: Array<{
		agent: string;
		status: RunStatus;
		durationMs?: number;
		usage?: TokenUsage;
		skills?: string[];
	}>;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}

/** Persisted to disk so the parent can recover state after a restart. */
export interface AsyncJobState {
	asyncId: string;
	asyncDir: string;
	status: "queued" | "running" | "complete" | "failed";
	mode?: "single" | "chain";
	agents?: string[];
	currentStep?: number;
	stepsTotal?: number;
	startedAt?: number;
	updatedAt?: number;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	sessionFile?: string;
}
