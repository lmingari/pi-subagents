/**
 * terminal.ts — Terminal launcher for pi subagents.
 *
 * Reads PI_TERMINAL at dispatch time and delegates to the matching launcher.
 * To add a new terminal: implement TerminalLauncher and register it at the
 * bottom of this file with registerLauncher().
 *
 * Each launcher receives a fully-formed command string and a title, and is
 * responsible for spawning the terminal process. It returns the PID of the
 * terminal process (not the pi process inside it).
 *
 * Hidden mode (TerminalTarget { type: "hidden" }) bypasses all of this and
 * pipes stdout/stderr directly to the parent — used for tests and CI.
 */

import { spawn, type ChildProcess } from "child_process";
import type { TerminalTarget, TerminalApp } from "./types.ts";

// ── Launcher interface ────────────────────────────────────────────────────────

export interface LaunchOptions {
	/** The full shell command to run inside the terminal (e.g. "pi --mode json ...") */
	command: string;
	/** Window/tab title shown in the terminal app */
	title: string;
	/** Working directory for the terminal process */
	cwd: string;
	/** Environment variables forwarded to the terminal */
	env: NodeJS.ProcessEnv;
}

export interface LaunchResult {
	/** PID of the terminal process (not the inner pi process) */
	pid: number;
	/** The spawned ChildProcess — only populated in hidden mode */
	process?: ChildProcess;
}

/**
 * A TerminalLauncher knows how to open one specific terminal application.
 * Register new launchers with registerLauncher().
 */
export interface TerminalLauncher {
	/** Must match the PI_TERMINAL value exactly (lowercase) */
	readonly app: TerminalApp;
	/** Human-readable name for error messages */
	readonly displayName: string;
	launch(options: LaunchOptions): Promise<LaunchResult>;
}

// ── Launcher registry ─────────────────────────────────────────────────────────

const launchers = new Map<string, TerminalLauncher>();

export function registerLauncher(launcher: TerminalLauncher): void {
	launchers.set(launcher.app.toLowerCase(), launcher);
}

export function getLauncher(app: string): TerminalLauncher | undefined {
	return launchers.get(app.toLowerCase());
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Launch a subagent in a terminal window (or pipe it, in hidden mode).
 *
 * Throws if:
 *   - target is { type: "env" } and PI_TERMINAL is not set
 *   - PI_TERMINAL names an unregistered launcher
 */
export async function launchInTerminal(
	target: TerminalTarget,
	options: LaunchOptions,
): Promise<LaunchResult> {
	if (target.type === "hidden") {
		return launchHidden(options);
	}

	// target.type === "env"
	const app = process.env.PI_TERMINAL?.trim();
	if (!app) {
		throw new Error(
			"PI_TERMINAL environment variable is not set. " +
			`Set it to one of: ${[...launchers.keys()].join(", ")}`
		);
	}

	const holdOpen = isTruthy(process.env.PI_SUBAGENT_HOLD_OPEN);
	const effectiveOptions = holdOpen
		? { ...options, command: wrapCommandKeepingWindowOpen(options.command) }
		: options;

	const launcher = getLauncher(app) ?? genericLauncher(app);
	return launcher.launch(effectiveOptions);
}

function isTruthy(v: string | undefined): boolean {
	if (!v) return false;
	const n = v.trim().toLowerCase();
	return n === "1" || n === "true" || n === "yes" || n === "on";
}

function wrapCommandKeepingWindowOpen(command: string): string {
	return [
		`(${command})`,
		"__pi_exit=$?",
		"echo",
		"echo '[pi-subagent] process finished.'",
		"echo '[pi-subagent] Press Enter to close this terminal.'",
		"read -r _",
		"exit $__pi_exit",
	].join("; ");
}

// ── Hidden launcher (test / CI) ───────────────────────────────────────────────

/**
 * Runs the command as a plain child process with stdio piped to the parent.
 * The LaunchResult.process field is populated so the caller can read stdout.
 */
function launchHidden(options: LaunchOptions): Promise<LaunchResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn("sh", ["-c", options.command], {
			cwd: options.cwd,
			env: options.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		proc.on("spawn", () => {
			resolve({ pid: proc.pid!, process: proc });
		});

		proc.on("error", reject);
	});
}

// ── Concrete launchers ────────────────────────────────────────────────────────

// ── macOS Terminal.app ──

registerLauncher({
	app: "terminal",
	displayName: "macOS Terminal.app",
	launch({ command, title, cwd, env }): Promise<LaunchResult> {
		// AppleScript: open a new window, set title, run command
		const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const script = [
			`tell application "Terminal"`,
			`  activate`,
			`  set w to do script "cd ${cwd} && ${escaped}"`,
			`  set custom title of w to "${title}"`,
			`end tell`,
		].join("\n");

		return new Promise((resolve, reject) => {
			const proc = spawn("osascript", ["-e", script], {
				env,
				stdio: "ignore",
				detached: true,
			});
			proc.unref();
			proc.on("spawn", () => resolve({ pid: proc.pid! }));
			proc.on("error", reject);
		});
	},
});

// ── macOS iTerm2 ──

registerLauncher({
	app: "iterm",
	displayName: "macOS iTerm2",
	launch({ command, title, cwd, env }): Promise<LaunchResult> {
		const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const script = [
			`tell application "iTerm"`,
			`  activate`,
			`  set w to (create window with default profile)`,
			`  tell current session of w`,
			`    set name to "${title}"`,
			`    write text "cd ${cwd} && ${escaped}"`,
			`  end tell`,
			`end tell`,
		].join("\n");

		return new Promise((resolve, reject) => {
			const proc = spawn("osascript", ["-e", script], {
				env,
				stdio: "ignore",
				detached: true,
			});
			proc.unref();
			proc.on("spawn", () => resolve({ pid: proc.pid! }));
			proc.on("error", reject);
		});
	},
});

// ── GNOME Terminal (Linux) ──

registerLauncher({
	app: "gnome-terminal",
	displayName: "GNOME Terminal",
	launch({ command, title, cwd, env }): Promise<LaunchResult> {
		return new Promise((resolve, reject) => {
			const proc = spawn(
				"gnome-terminal",
				["--title", title, "--working-directory", cwd, "--", "sh", "-c", command],
				{ env, stdio: "ignore", detached: true },
			);
			proc.unref();
			proc.on("spawn", () => resolve({ pid: proc.pid! }));
			proc.on("error", reject);
		});
	},
});

// ── Windows Terminal (wt) ──

registerLauncher({
	app: "wt",
	displayName: "Windows Terminal",
	launch({ command, title, cwd, env }): Promise<LaunchResult> {
		return new Promise((resolve, reject) => {
			const proc = spawn(
				"wt",
				["--title", title, "--startingDirectory", cwd, "cmd", "/c", command],
				{ env, stdio: "ignore", detached: true, shell: true },
			);
			proc.unref();
			proc.on("spawn", () => resolve({ pid: proc.pid! }));
			proc.on("error", reject);
		});
	},
});

// ── xterm ──

registerLauncher({
	app: "xterm",
	displayName: "xterm",
	launch({ command, title, cwd, env }): Promise<LaunchResult> {
		return new Promise((resolve, reject) => {
			const proc = spawn(
				"xterm",
				["-title", title, "-e", "sh", "-c", command],
				{ cwd, env, stdio: "ignore", detached: true },
			);
			proc.unref();
			proc.on("spawn", () => resolve({ pid: proc.pid! }));
			proc.on("error", reject);
		});
	},
});

// ── foot ──

registerLauncher({
	app: "foot",
	displayName: "foot",
	launch({ command, title, cwd, env }): Promise<LaunchResult> {
		return new Promise((resolve, reject) => {
			const proc = spawn(
				"foot",
				["--title", title, "sh", "-c", command],
				{ cwd, env, stdio: "ignore", detached: true },
			);
			proc.unref();
			proc.on("spawn", () => resolve({ pid: proc.pid! }));
			proc.on("error", reject);
		});
	},
});

// ── Generic fallback ──────────────────────────────────────────────────────────
//
// For any unregistered terminal binary (alacritty, kitty, wezterm, etc.).
// Assumes the binary accepts:  <app> -e sh -c <command>
// which covers the vast majority of Linux terminals.
//
// If your terminal uses a different flag convention, register a specific
// launcher above and it will take precedence.

export function genericLauncher(app: string): TerminalLauncher {
	return {
		app,
		displayName: app,
		launch({ command, cwd, env }): Promise<LaunchResult> {
			return new Promise((resolve, reject) => {
				const proc = spawn(
					app,
					["-e", "sh", "-c", command],
					{ cwd, env, stdio: "ignore", detached: true },
				);
				proc.unref();
				proc.on("spawn", () => resolve({ pid: proc.pid! }));
				proc.on("error", (err) => reject(
					new Error(`Failed to launch terminal "${app}": ${err.message}. ` +
						`If "${app}" uses different flags, register a custom launcher.`)
				));
			});
		},
	};
}
