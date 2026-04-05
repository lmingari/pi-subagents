/**
 * session.ts — AgentSession persistence.
 *
 * Tracks whether a prior pi session file exists for each agent so the
 * dispatcher knows whether to pass -c (continue) to pi.
 *
 * Session records live at: <sessionDir>/sessions/<agentName>.json
 * Pi session files live at: <sessionDir>/sessions/<agentName>.pi.json
 *
 * The distinction:
 *   *.json      — our AgentSession metadata (runCount, usage totals, etc.)
 *   *.pi.json   — the raw pi session file passed to pi via --session
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { AgentSession, DispatchContext, TokenUsage } from "./types.ts";

// ── Path helpers ──────────────────────────────────────────────────────────────

export function sessionsDir(sessionDir: string): string {
	return join(sessionDir, "sessions");
}

export function sessionMetaPath(sessionDir: string, agentName: string): string {
	const safe = safeName(agentName);
	return join(sessionsDir(sessionDir), `${safe}.json`);
}

export function piSessionFilePath(sessionDir: string, agentName: string): string {
	const safe = safeName(agentName);
	return join(sessionsDir(sessionDir), `${safe}.pi.json`);
}

function safeName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

// ── Read / write ──────────────────────────────────────────────────────────────

/**
 * Load an existing AgentSession from disk.
 * Returns null if no session has been recorded yet for this agent.
 */
export function loadSession(
	sessionDir: string,
	agentName: string,
): AgentSession | null {
	const path = sessionMetaPath(sessionDir, agentName);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as AgentSession;
	} catch {
		return null;
	}
}

/**
 * Persist an AgentSession to disk.
 * Creates the sessions directory if it doesn't exist.
 */
export function saveSession(sessionDir: string, session: AgentSession): void {
	const dir = sessionsDir(sessionDir);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(
		sessionMetaPath(sessionDir, session.agentName),
		JSON.stringify(session, null, 2),
		"utf-8",
	);
}

/**
 * Update an existing session after a run completes, or create a new one.
 * Accumulates token usage across runs.
 */
export function recordRun(
	sessionDir: string,
	agentName: string,
	usage: TokenUsage,
): void {
	const existing = loadSession(sessionDir, agentName);
	const piFile = piSessionFilePath(sessionDir, agentName);
	const now = Date.now();

	if (existing) {
		saveSession(sessionDir, {
			...existing,
			lastUsedAt: now,
			runCount: existing.runCount + 1,
			totalUsage: addUsage(existing.totalUsage, usage),
		});
	} else {
		saveSession(sessionDir, {
			agentName,
			sessionFile: piFile,
			createdAt: now,
			lastUsedAt: now,
			runCount: 1,
			totalUsage: usage,
		});
	}
}

// ── Fresh vs fork resolution ──────────────────────────────────────────────────

export interface SessionResolution {
	/**
	 * Absolute path to the pi session file to pass via --session.
	 * Always set — pi will create it on first run if it doesn't exist.
	 */
	piSessionFile: string;
	/**
	 * Whether to pass -c (continue) to pi.
	 * True only when context is "fork" AND a prior pi session file exists on disk.
	 */
	shouldContinue: boolean;
}

/**
 * Resolve session handling for a dispatch.
 *
 *   fresh → shouldContinue: false (always start clean)
 *   fork  → shouldContinue: true only if the pi session file exists on disk
 *            (if no prior session exists, behaves like fresh silently)
 */
export function resolveSession(
	sessionDir: string,
	agentName: string,
	context: DispatchContext,
): SessionResolution {
	const piSessionFile = piSessionFilePath(sessionDir, agentName);

	if (context === "fresh") {
		return { piSessionFile, shouldContinue: false };
	}

	// fork — only continue if the pi session file actually exists
	const shouldContinue = existsSync(piSessionFile);
	return { piSessionFile, shouldContinue };
}

// ── Utility ───────────────────────────────────────────────────────────────────

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
	return {
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
		cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
	};
}
