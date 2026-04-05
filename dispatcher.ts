/**
 * dispatcher.ts — Resolves a DispatchRequest and launches a subagent.
 *
 * Responsibilities:
 *   1. Resolve the AgentDef from the agent index
 *   2. Read input files and prepend their contents to the task string
 *   3. Resolve the output file path (string | true | false → string | null)
 *   4. Resolve session (fresh vs fork → pi --session + optional -c)
 *   5. Create the FIFO and IPC channel
 *   6. Build the pi CLI command string
 *   7. Launch the terminal via terminal.ts
 *   8. Listen on the FIFO, update AgentRun state, write output file on done
 *   9. Return AgentRunResult when the run completes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, join, dirname } from "path";
import { randomUUID } from "crypto";
import type {
	DispatchRequest,
	AgentDef,
	AgentRun,
	AgentRunResult,
	IpcMessage,
	TokenUsage,
	ResolvedOutputPath,
} from "./types.ts";
import { createChannel, fifoPath } from "./ipc.ts";
import { launchInTerminal } from "./terminal.ts";
import { resolveSession, recordRun } from "./session.ts";
import { requireAgent, type AgentIndex } from "./agent-loader.ts";

export type AgentIndex = Map<string, AgentDef>;

// ── Output resolution ─────────────────────────────────────────────────────────

function resolveOutputPath(
	request: DispatchRequest,
	def: AgentDef,
): ResolvedOutputPath {
	const { output, cwd, sessionDir } = request;

	if (output === false) return null;

	if (typeof output === "string") {
		// Explicit path — resolve relative to cwd
		return resolve(cwd, output);
	}

	// output === true
	if (def.outputFile) {
		return resolve(cwd, def.outputFile);
	}

	// Fallback: auto-generate inside session dir
	const safe = def.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	return join(sessionDir, `${safe}.out.md`);
}

// ── Input file injection ──────────────────────────────────────────────────────

/**
 * Read each input file (relative to cwd) and prepend its contents to the
 * task string. Missing files are warned about but do not throw.
 */
function buildTask(request: DispatchRequest): string {
	const { task, inputs, cwd } = request;

	if (!inputs.length) return task;

	const sections: string[] = [];

	for (const relPath of inputs) {
		const absPath = resolve(cwd, relPath);
		if (!existsSync(absPath)) {
			console.warn(`[dispatcher] Input file not found, skipping: ${absPath}`);
			continue;
		}
		try {
			const content = readFileSync(absPath, "utf-8").trim();
			sections.push(`### Input: ${relPath}\n\n${content}`);
		} catch (err) {
			console.warn(`[dispatcher] Could not read "${absPath}": ${(err as Error).message}`);
		}
	}

	if (!sections.length) return task;

	return `${sections.join("\n\n---\n\n")}\n\n---\n\n${task}`;
}

// ── CLI builder ───────────────────────────────────────────────────────────────

function buildPiCommand(options: {
	model: string;
	tools: string;
	systemPrompt: string;
	piSessionFile: string;
	shouldContinue: boolean;
	fifoPath: string;
	task: string;
	extraArgs: string[];
}): string {
	const {
		model, tools, systemPrompt, piSessionFile,
		shouldContinue, fifoPath, task, extraArgs,
	} = options;

	// Escape single quotes in task and system prompt for shell embedding
	const escapeShell = (s: string) => s.replace(/'/g, `'\\''`);

	const args: string[] = [
		"pi",
		"--mode", "json",
		"-p",
		"--no-extensions",
		"--model", model,
		"--tools", tools,
		"--thinking", "off",
		"--append-system-prompt", `'${escapeShell(systemPrompt)}'`,
		"--session", piSessionFile,
	];

	if (shouldContinue) args.push("-c");
	if (extraArgs.length) args.push(...extraArgs);

	// Inject the FIFO path as an env var so the child wrapper can open it
	// PI_IPC_FIFO is read by openChildChannel() in ipc.ts
	args.push(`'${escapeShell(task)}'`);

	// Wrap in env var injection
	return `PI_IPC_FIFO='${fifoPath}' ${args.join(" ")}`;
}

// ── AgentRun factory ──────────────────────────────────────────────────────────

function makeRun(
	runId: string,
	def: AgentDef,
	request: DispatchRequest,
	resolvedOutputPath: ResolvedOutputPath,
): AgentRun {
	return {
		runId,
		def,
		request,
		resolvedOutputPath,
		status: "queued",
		startedAt: Date.now(),
		output: "",
		lastWork: "",
		toolCount: 0,
		contextPct: 0,
		runCount: 0,
		elapsed: 0,
	};
}

// ── Main dispatch function ────────────────────────────────────────────────────

/**
 * Dispatch a subagent and return a promise that resolves when it completes.
 *
 * @param request   Fully populated DispatchRequest (sessionDir and cwd required)
 * @param agentIndex  Map built by buildAgentIndex() in agent-loader.ts
 * @param onUpdate  Optional callback receiving live AgentRun snapshots
 */
export async function dispatchAgent(
	request: DispatchRequest,
	agentIndex: AgentIndex,
	onUpdate?: (run: AgentRun) => void,
): Promise<AgentRunResult> {
	const { agent, context, terminal, sessionDir, cwd } = request;

	// 1. Resolve agent definition
	const def = requireAgent(agentIndex, agent);

	// 2. Validate terminal *before* touching the filesystem or spawning anything.
	//    launchInTerminal reads PI_TERMINAL here via a dry-run check so we fail
	//    fast with a clear error rather than leaving a dangling FIFO behind.
	if (terminal.type === "env") {
		const app = process.env.PI_TERMINAL?.trim();
		if (!app) {
			throw new Error(
				"PI_TERMINAL environment variable is not set. " +
				"Set it to the name of your terminal binary (e.g. foot, kitty, xterm)."
			);
		}
		// Unknown terminals are handled by the generic launcher — no error here.
	}

	// 3. Resolve output path
	const resolvedOutputPath = resolveOutputPath(request, def);

	// 4. Build the task string with injected input file contents
	const task = buildTask(request);

	// 5. Resolve session (fresh vs fork)
	const { piSessionFile, shouldContinue } = resolveSession(sessionDir, def.name, context);

	// 6. Ensure session dir exists
	if (!existsSync(sessionDir)) mkdirSync(sessionDir, { recursive: true });

	// 7. Create FIFO and IPC channel
	const ipcPath = fifoPath(sessionDir, def.name);
	const transport = { type: "fifo" as const, path: ipcPath, openTimeoutMs: request.ipc.openTimeoutMs };
	const channel = await createChannel(transport);

	// 8. Build pi command
	const model = request.model ?? process.env.PI_MODEL ?? "openrouter/google/gemini-2.5-flash-preview";
	const command = buildPiCommand({
		model,
		tools: def.tools,
		systemPrompt: def.systemPrompt,
		piSessionFile,
		shouldContinue,
		fifoPath: ipcPath,
		task,
		extraArgs: request.extraArgs ?? [],
	});

	// 9. Create run record
	const runId = randomUUID();
	const run = makeRun(runId, def, request, resolvedOutputPath);

	// Elapsed timer
	const elapsedTimer = setInterval(() => {
		run.elapsed = Date.now() - run.startedAt;
		onUpdate?.(snapshot(run));
	}, 1_000);

	// 10. Wire up IPC message handlers
	const textChunks: string[] = [];
	let finalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

	channel.onMessage((msg: IpcMessage) => {
		switch (msg.type) {
			case "text_delta":
				textChunks.push(msg.delta);
				run.output = textChunks.join("");
				run.lastWork = lastNonEmptyLine(run.output);
				break;

			case "tool_start":
				run.toolCount++;
				break;

			case "context_update": {
				const pct = msg.contextWindow > 0
					? (msg.usedTokens / msg.contextWindow) * 100
					: 0;
				run.contextPct = Math.min(100, pct);
				break;
			}

			case "token_usage":
				finalUsage = msg.usage;
				run.usage = msg.usage;
				break;

			case "agent_done":
				// handled in the promise below
				break;

			case "agent_error":
				// handled in the promise below
				break;
		}

		run.status = "running";
		onUpdate?.(snapshot(run));
	});

	// 11. Launch terminal — only reached if all validation above passed
	run.status = "running";
	const launchResult = await launchInTerminal(terminal, {
		command,
		title: `pi — ${def.name}`,
		cwd,
		env: { ...process.env },
	});
	run.pid = launchResult.pid;
	onUpdate?.(snapshot(run));

	// 12. Wait for child to open FIFO, then wait for completion
	return new Promise<AgentRunResult>((resolve, reject) => {
		channel.waitForOpen().catch((err: Error) => {
			clearInterval(elapsedTimer);
			run.status = "failed";
			run.endedAt = Date.now();
			channel.close();
			reject(err);
		});

		channel.onClose(async (err?: Error) => {
			clearInterval(elapsedTimer);
			run.endedAt = Date.now();
			run.elapsed = run.endedAt - run.startedAt;

			// Determine final status from last agent_done / agent_error message
			// (the FIFO close is the signal the child process has exited)
			const lastMsg = [...textChunks]; // already accumulated
			const succeeded = !err && run.status !== "failed";
			run.status = succeeded ? "complete" : "failed";

			// Record session metadata
			try {
				recordRun(sessionDir, def.name, finalUsage);
			} catch {
				// Non-fatal
			}

			// Write output file if configured
			if (resolvedOutputPath && run.output) {
				try {
					const outDir = dirname(resolvedOutputPath);
					if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
					writeFileSync(resolvedOutputPath, run.output, "utf-8");
				} catch (writeErr) {
					console.warn(`[dispatcher] Could not write output file "${resolvedOutputPath}": ${(writeErr as Error).message}`);
				}
			}

			onUpdate?.(snapshot(run));

			const result: AgentRunResult = {
				runId,
				agentName: def.name,
				output: run.output,
				exitCode: succeeded ? 0 : 1,
				elapsed: run.elapsed,
				usage: finalUsage,
				outputPath: resolvedOutputPath,
			};

			if (err) {
				reject(err);
			} else {
				resolve(result);
			}
		});
	});
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function lastNonEmptyLine(text: string): string {
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].trim()) return lines[i].trim();
	}
	return "";
}

/** Shallow snapshot of AgentRun for onUpdate callbacks (avoids mutation surprises) */
function snapshot(run: AgentRun): AgentRun {
	return { ...run };
}
