/**
 * riddle-team.ts — Pi multi-agent extension: riddle-maker + riddle-solver.
 *
 * Usage:
 *   PI_TERMINAL=iterm pi -e extensions/groups/riddle-team.ts
 *
 * Each agent runs in its own terminal window. The master shows a compact
 * status panel (name / status / elapsed) but never echoes API replies —
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
import { applyExtensionDefaults } from "../themeMap.ts";
import type { AgentRun, AgentGroup, DispatchRequest } from "../types.ts";

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
	// Live run state — one entry per agent, keyed by agent name
	const runs = new Map<string, AgentRun>();
	let widgetCtx: any;
	let sessionDir = "";
	let cwd = "";
	let agentIndex: ReturnType<typeof buildAgentIndex>;

	// ── Status widget ─────────────────────────────────────────────────────────
	//
	// Shows name | status | elapsed for each agent.
	// Never displays API output — that stays in each agent's own terminal.

	function updateWidget(): void {
		if (!widgetCtx) return;

		widgetCtx.ui.setWidget("riddle-team", (_tui: any, theme: any) => {
			const text = new Text("", 0, 1);

			return {
				render(width: number): string[] {
					if (runs.size === 0) {
						text.setText(theme.fg("dim", "No agents dispatched yet."));
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

						const elapsedStr = run.elapsed > 0
							? ` ${Math.round(run.elapsed / 1_000)}s`
							: "";

						const name  = theme.fg("accent", run.def.name.padEnd(16));
						const badge = theme.fg(statusColor, `${icon} ${run.status}${elapsedStr}`);

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

	async function dispatch(
		agentName: string,
		task: string,
		inputs: string[] = [],
	): Promise<void> {
		const request: DispatchRequest = {
			agent: agentName,
			task,
			inputs,
			output: GROUP.overrides?.[agentName]?.output ?? GROUP.defaults.output,
			context: GROUP.overrides?.[agentName]?.context ?? GROUP.defaults.context,
			terminal: GROUP.defaults.terminal,
			ipc: { type: "fifo", path: "", openTimeoutMs: GROUP.defaults.ipc.openTimeoutMs },
			sessionDir,
			cwd,
		};

		widgetCtx?.ui.notify(`Dispatching ${agentName}…`, "info");

		try {
			// dispatchAgent streams updates via onUpdate — we use them only to
			// refresh the status widget, never to display API content in master.
			await dispatchAgent(request, agentIndex, (run) => {
				runs.set(agentName, run);
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

			const makerRun = runs.get("riddle-maker");
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
				const elapsed = r.elapsed > 0 ? ` (${Math.round(r.elapsed / 1_000)}s)` : "";
				return `${r.def.name}: ${r.status}${elapsed}`;
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
