/**
 * riddle-team.ts — Pi multi-agent extension: riddle-maker + riddle-solver.
 *
 * Usage:
 *   PI_TERMINAL=iterm pi -e extensions/groups/riddle-team.ts
 *
 * Each agent runs in its own terminal window. The master shows a compact
 * status panel (name / runId / status) but never echoes API replies —
 * those are visible only in each agent's own terminal and written to their
 * output files under outputs/.
 *
 * Commands:
 *   /riddle-make  <topic>   — dispatch riddle-maker with a topic
 *   /riddle-solve           — dispatch riddle-solver, feeding maker's output as input
 *   /riddle-status          — print current status of both agents
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { join } from "path";
import { scanAgentDirs, buildAgentIndex } from "../agent-loader.ts";
import { dispatchAgent } from "../dispatcher.ts";
import { listAgentSessions, latestPiSessionFilePath, readSessionHeader } from "../session.ts";
import { applyExtensionDefaults } from "../themeMap.ts";
import type { AgentRun, AgentGroup, DispatchRequest, AgentDef } from "../types.ts";

// ── Group definition ──────────────────────────────────────────────────────────

const GROUP: AgentGroup = {
	name: "riddle-team",
	description: "A maker and a solver walk into a terminal...",
	members: ["riddle-maker", "riddle-solver"],
	defaults: {
		context: "fresh",
		terminal: { type: "env" },       // reads PI_TERMINAL at dispatch time
		ipc: { type: "fifo", openTimeoutMs: 12_000 },
		output: true,                     // each agent writes to its outputFile
		inputs: [],
	},
	overrides: {
		// solver reads maker's output as input when dispatched via /riddle-solve
		"riddle-solver": { context: "fresh" },
	},
	gridCols: 2,
};

// ── Extension ─────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Live run state shown in widget, keyed by display identity (sessionId or runId)
	const runs = new Map<string, AgentRun>();
	// Current display key for each process runId.
	const currentKeyByRunId = new Map<string, string>();
	let widgetCtx: any;
	let sessionDir = "";
	let cwd = "";
	let agentIndex: ReturnType<typeof buildAgentIndex>;

	// ── Status widget ─────────────────────────────────────────────────────────
	//
	// Shows agent (runId) | status for each run.
	// Never displays API output — that stays in each agent's own terminal.

	function updateWidget(): void {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("riddle-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					if (runs.size === 0) {
						text.setText(theme.fg("dim", ""));
						return text.render(width);
					}

					const lines: string[] = [];

					for (const run of runs.values()) {
						const statusColor =
							run.status === "queued"   ? "dim"
							: run.status === "running"  ? "accent"
							: run.status === "complete" ? "success"
							: "error";

						const icon =
							run.status === "queued"   ? "○"
							: run.status === "running"  ? "●"
							: run.status === "complete" ? "✓"
							: "✗";

						const id = run.sessionId ?? run.runId;
						const reason = run.sessionReason ? ` [${run.sessionReason}]` : "";
						const name  = theme.fg("accent", `${run.def.name} (${shortId(id)})`.padEnd(28));
						const badge = theme.fg(statusColor, `${icon} ${run.status}${reason}`);

						const row = `  ${name}  ${badge}`;
						lines.push(row);
					}

					text.setText(lines.join("\n"));
					return text.render(width);
				},
				invalidate() { text.invalidate(); },
			};
		});
	}

	// ── Shared dispatch helper ────────────────────────────────────────────────

	function splitTools(tools: string): string[] {
		return tools.split(",").map(t => t.trim()).filter(Boolean);
	}

	function shortId(id: string): string {
		return id.slice(0, 8);
	}

	function latestRunForAgent(agentName: string): AgentRun | undefined {
		const candidates = [...runs.values()].filter(r => r.def.name === agentName);
		if (!candidates.length) return undefined;
		candidates.sort((a, b) => b.startedAt - a.startedAt);
		return candidates[0];
	}

	function upsertRunForDisplay(nextRun: AgentRun): void {
		const prevKey = currentKeyByRunId.get(nextRun.runId);
		const nextKey = nextRun.sessionId ?? nextRun.runId;

		if (prevKey && prevKey !== nextKey) {
			const prev = runs.get(prevKey);
			const wasRealSession = Boolean(prev?.sessionId && prev.sessionId === prevKey);
			if (prev && wasRealSession) {
				runs.set(prevKey, {
					...prev,
					status: "complete",
					endedAt: prev.endedAt ?? Date.now(),
					lastWork: `session switched to ${shortId(nextKey)}`,
				});
			} else if (prevKey) {
				runs.delete(prevKey);
			}
		}

		runs.set(nextKey, nextRun);
		currentKeyByRunId.set(nextRun.runId, nextKey);
	}

	async function seedRunsFromExistingSessions(): Promise<number> {
		let restored = 0;
		for (const member of GROUP.members) {
			const def = agentIndex.get(member.toLowerCase());
			if (!def) continue;
			const sessions = await listAgentSessions(cwd, sessionDir, member);
			for (const s of sessions) {
				if (runs.has(s.id)) continue;

				const ts = Date.parse(s.timestamp || "") || Date.now();
				const request: DispatchRequest = {
					agent: def.name,
					task: "[restored from existing session]",
					inputs: [],
					output: GROUP.overrides?.[def.name]?.output ?? GROUP.defaults.output,
					context: GROUP.overrides?.[def.name]?.context ?? GROUP.defaults.context,
					terminal: GROUP.defaults.terminal,
					ipc: { type: "fifo", path: "", openTimeoutMs: GROUP.defaults.ipc.openTimeoutMs },
					sessionDir,
					cwd,
				};

				runs.set(s.id, {
					runId: s.id,
					sessionId: s.id,
					sessionFile: s.path,
					def,
					request,
					resolvedOutputPath: null,
					status: "complete",
					startedAt: ts,
					endedAt: ts,
					output: "",
					lastWork: `restored from ${s.path.split("/").pop()}`,
					toolCount: 0,
					contextPct: 0,
					runCount: 1,
					elapsed: 0,
				});
				currentKeyByRunId.set(s.id, s.id);
				restored += 1;
			}
		}
		return restored;
	}

	function formatLaunchSummary(def: AgentDef, request: DispatchRequest): string {
		const model = request.model ?? def.model ?? "(pi default)";
		const provider = typeof model === "string" && model.includes("/")
			? model.split("/")[0]
			: "(default provider)";
		const toolsValue = request.tools ?? def.tools;
		const tools = splitTools(toolsValue || "");
		const thinking = request.thinking ?? def.thinking ?? "(pi default)";
		const description = def.description?.trim() || "(no description)";
		const output = typeof request.output === "string"
			? request.output
			: request.output === true
				? (def.outputFile ?? "<sessionDir>/<agent>.out.md")
				: "disabled";
		return [
			`Launching ${def.name}`,
			`provider/model: ${provider} / ${model}`,
			`tools: ${tools.length ? tools.join(", ") : "(pi default)"}`,
			`thinking: ${thinking}`,
			`context: ${request.context}${request.forkSessionId ? ` (${request.forkSessionId.slice(0, 8)})` : ""}`,
			`output: ${output}`,
			`description: ${description}`,
		].join("\n");
	}

	function validateAgentDef(def: AgentDef): string[] {
		const warnings: string[] = [];
		const tools = splitTools(def.tools || "");
		if (!tools.length) {
			warnings.push(`${def.name}: no tools configured in agent file (pi default will be used)`);
		}

		if (!def.systemPrompt?.trim()) {
			warnings.push(`${def.name}: empty system prompt`);
		}

		if (!def.description?.trim()) {
			warnings.push(`${def.name}: missing description`);
		}

		const model = def.model?.trim();
		if (model?.startsWith("openrouter/") && !process.env.OPENROUTER_API_KEY) {
			warnings.push(`${def.name}: uses openrouter model but OPENROUTER_API_KEY is not set (login may still work)`);
		}

		return warnings;
	}

	async function dispatch(
		agentName: string,
		task: string,
		inputs: string[] = [],
	): Promise<void> {
		const def = agentIndex.get(agentName.toLowerCase());
		if (!def) {
			widgetCtx?.ui.notify(`Agent not found: ${agentName}`, "error");
			return;
		}

		const contextMode = GROUP.overrides?.[agentName]?.context ?? GROUP.defaults.context;
		const request: DispatchRequest = {
			agent: agentName,
			task,
			inputs,
			output: GROUP.overrides?.[agentName]?.output ?? GROUP.defaults.output,
			context: contextMode,
			terminal: GROUP.defaults.terminal,
			ipc: { type: "fifo", path: "", openTimeoutMs: GROUP.defaults.ipc.openTimeoutMs },
			sessionDir,
			cwd,
			model: GROUP.overrides?.[agentName]?.model ?? GROUP.defaults.model,
			tools: GROUP.overrides?.[agentName]?.tools ?? GROUP.defaults.tools,
			thinking: GROUP.overrides?.[agentName]?.thinking ?? GROUP.defaults.thinking,
			forkSessionId: contextMode === "fork"
				? (GROUP.overrides?.[agentName]?.forkSessionId ?? widgetCtx?.sessionManager?.getSessionId?.())
				: undefined,
		};

		widgetCtx?.ui.notify(formatLaunchSummary(def, request), "info");

		try {
			// dispatchAgent streams updates via onUpdate — we use them only to
			// refresh the status widget, never to display API content in master.
			await dispatchAgent(request, agentIndex, (run) => {
				upsertRunForDisplay(run);
				updateWidget();
				// Update status bar
				const alive = [...runs.values()].filter(r => r.status === "running").length;
				widgetCtx?.ui.setStatus(
					"riddle-team",
					alive > 0 ? `${alive} agent(s) running` : "idle",
				);
			});

			widgetCtx?.ui.notify(`${agentName} finished ✓`, "success");
		} catch (err: any) {
			widgetCtx?.ui.notify(`${agentName} failed: ${err?.message ?? err}`, "error");
		}

		updateWidget();
	}

	// ── Commands ──────────────────────────────────────────────────────────────

	pi.registerCommand("riddle-make", {
		description: "Dispatch riddle-maker: /riddle-make <topic>",
		handler: async (args, ctx) => {
			widgetCtx = ctx;
			const topic = args?.trim();
			if (!topic) {
				ctx.ui.notify("Usage: /riddle-make <topic>", "error");
				return;
			}
			// Fire and forget — master does not await or display the output
			dispatch("riddle-maker", `Create a riddle about: ${topic}`).catch(() => {});
		},
	});

	pi.registerCommand("riddle-solve", {
		description: "Dispatch riddle-solver using riddle-maker's last output as input",
		handler: async (args, ctx) => {
			widgetCtx = ctx;

			const makerRun = latestRunForAgent("riddle-maker");
			if (!makerRun || makerRun.status !== "complete") {
				ctx.ui.notify(
					"riddle-maker has not completed yet. Run /riddle-make <topic> first.",
					"warning",
				);
				return;
			}

			// Pass maker's output file as input so solver reads it at launch time
			const makerOutputFile = makerRun.resolvedOutputPath
				?? join(cwd, "outputs/riddle-maker.md");

			const extraTask = args?.trim()
				? `Additional instruction: ${args.trim()}`
				: "";

			dispatch(
				"riddle-solver",
				["Solve the riddle in the input file.", extraTask].filter(Boolean).join("\n"),
				[makerOutputFile],
			).catch(() => {});
		},
	});

	pi.registerCommand("riddle-status", {
		description: "Print current status of both agents",
		handler: async (_args, ctx) => {
			widgetCtx = ctx;
			if (runs.size === 0) {
				ctx.ui.notify("No agents dispatched yet.", "info");
				return;
			}

			const lines = [...runs.values()].map(r => {
				const id = r.sessionId ?? r.runId;
				const reason = r.sessionReason ? ` [${r.sessionReason}]` : "";
				return `${r.def.name} (${shortId(id)}): ${r.status}${reason}`;
			});

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// ── Session start ─────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		applyExtensionDefaults(import.meta.url, ctx);
		widgetCtx = ctx;
		cwd = ctx.cwd;
		sessionDir = join(cwd, ".pi", "sessions", "riddle-team");

		// Load agent definitions
		const defs = scanAgentDirs(cwd);
		agentIndex = buildAgentIndex(defs);

		// Validate that both expected agents are present
		const missing = GROUP.members.filter(m => !agentIndex.has(m.toLowerCase()));
		if (missing.length) {
			ctx.ui.notify(
				`Warning: missing agent definitions: ${missing.join(", ")}\n` +
				`Add them to .pi/agents/`,
				"warning",
			);
		}

		// Startup validation + summary
		const startupWarnings: string[] = [];
		const startupSummary: string[] = [];
		for (const member of GROUP.members) {
			const def = agentIndex.get(member.toLowerCase());
			if (!def) continue;
			startupWarnings.push(...validateAgentDef(def));
			const model = def.model ?? "(pi default)";
			const provider = model.includes("/") ? model.split("/")[0] : "(default provider)";
			const tools = splitTools(def.tools || "");
			const thinking = def.thinking ?? "(pi default)";
			startupSummary.push(
				`${def.name} → ${provider}/${model} | tools: ${tools.length ? tools.join(",") : "(pi default)"} | thinking: ${thinking}`
			);
		}

		if (startupWarnings.length) {
			ctx.ui.notify(`Startup validation warnings:\n${startupWarnings.join("\n")}`, "warning");
		}
		if (startupSummary.length) {
			ctx.ui.notify(`Agent summary:\n${startupSummary.join("\n")}`, "info");
		}

		// Resume discovery: show latest known session IDs/files per agent
		const resumeLines: string[] = [];
		for (const member of GROUP.members) {
			const latest = latestPiSessionFilePath(sessionDir, member);
			if (!latest) continue;
			const header = readSessionHeader(latest);
			const id = header?.id ? header.id.slice(0, 8) : "unknown";
			resumeLines.push(`${member} -> ${id} (${latest.split("/").pop()})`);
		}
		if (resumeLines.length) {
			ctx.ui.notify(`Resume sessions found:\n${resumeLines.join("\n")}`, "info");
		}

		const restoredCount = await seedRunsFromExistingSessions();
		if (restoredCount > 0) {
			ctx.ui.notify(`Restored ${restoredCount} prior subagent run(s) from session files.`, "info");
		}

		// Master has no tools — it only dispatches via commands
		pi.setActiveTools([]);

		ctx.ui.setStatus("riddle-team", "idle");
		ctx.ui.notify(
			`riddle-team ready\n\n` +
			`/riddle-make <topic>   — generate a riddle\n` +
			`/riddle-solve          — solve the last riddle\n` +
			`/riddle-status         — check agent status`,
			"info",
		);

		updateWidget();
	});
}
