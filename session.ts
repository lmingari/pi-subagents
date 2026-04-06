/**
 * session.ts — AgentSession persistence.
 *
 * Session layout (per agent):
 *   <sessionDir>/<agentName>/meta.json
 *   <sessionDir>/<agentName>/<timestamp>_<uuid>.jsonl
 *
 * Pi owns session file creation/IDs. We only select per-agent session dirs and
 * inspect latest files for resume metadata.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentSession, TokenUsage } from "./types.ts";

// ── Path helpers ──────────────────────────────────────────────────────────────

function safeName(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

export function agentSessionDir(sessionDir: string, agentName: string): string {
	return join(sessionDir, safeName(agentName));
}

export function sessionMetaPath(sessionDir: string, agentName: string): string {
	return join(agentSessionDir(sessionDir, agentName), "meta.json");
}

export function listPiSessionFiles(
	sessionDir: string,
	agentName: string,
): string[] {
	const dir = agentSessionDir(sessionDir, agentName);
	if (!existsSync(dir)) return [];

	try {
		return readdirSync(dir)
			.filter(f => f.endsWith(".jsonl"))
			.sort()
			.map(f => join(dir, f));
	} catch {
		return [];
	}
}

export function latestPiSessionFilePath(
	sessionDir: string,
	agentName: string,
): string | null {
	const files = listPiSessionFiles(sessionDir, agentName);
	if (!files.length) return null;
	return files[files.length - 1];
}

export interface SessionHeaderSummary {
	id: string;
	timestamp: string;
	cwd?: string;
}

export interface ListedSession {
	path: string;
	id: string;
	timestamp: string;
	cwd?: string;
}

export function readSessionHeader(path: string): SessionHeaderSummary | null {
	if (!existsSync(path)) return null;
	try {
		const firstLine = readFileSync(path, "utf-8").split(/\r?\n/, 1)[0];
		const header = JSON.parse(firstLine);
		if (header?.type !== "session") return null;
		if (typeof header.id !== "string" || typeof header.timestamp !== "string") return null;
		return { id: header.id, timestamp: header.timestamp, cwd: header.cwd };
	} catch {
		return null;
	}
}

/**
 * List sessions for one agent using Pi SessionManager metadata when available.
 * Falls back to direct jsonl scan if listing fails.
 */
export async function listAgentSessions(
	cwd: string,
	sessionDir: string,
	agentName: string,
): Promise<ListedSession[]> {
	const dir = agentSessionDir(sessionDir, agentName);
	if (!existsSync(dir)) return [];

	try {
		const infos = await SessionManager.list(cwd, dir);
		const items: ListedSession[] = infos
			.map(info => {
				const header = readSessionHeader(info.path);
				if (!header) return null;
				return {
					path: info.path,
					id: header.id,
					timestamp: header.timestamp,
					cwd: header.cwd,
				} satisfies ListedSession;
			})
			.filter((v): v is ListedSession => Boolean(v));

		items.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
		return items;
	} catch {
		const files = listPiSessionFiles(sessionDir, agentName);
		const items = files
			.map(path => {
				const header = readSessionHeader(path);
				if (!header) return null;
				return { path, id: header.id, timestamp: header.timestamp, cwd: header.cwd };
			})
			.filter((v): v is ListedSession => Boolean(v));
		items.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
		return items;
	}
}

// ── Read / write ──────────────────────────────────────────────────────────────

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

export function saveSession(sessionDir: string, session: AgentSession): void {
	const dir = agentSessionDir(sessionDir, session.agentName);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(
		sessionMetaPath(sessionDir, session.agentName),
		JSON.stringify(session, null, 2),
		"utf-8",
	);
}

export function recordRun(
	sessionDir: string,
	agentName: string,
	usage: TokenUsage,
): void {
	const existing = loadSession(sessionDir, agentName);
	const resolvedSessionFile = latestPiSessionFilePath(sessionDir, agentName);
	if (!resolvedSessionFile) return;
	const now = Date.now();

	if (existing) {
		saveSession(sessionDir, {
			...existing,
			sessionFile: resolvedSessionFile,
			lastUsedAt: now,
			runCount: existing.runCount + 1,
			totalUsage: addUsage(existing.totalUsage, usage),
		});
	} else {
		saveSession(sessionDir, {
			agentName,
			sessionFile: resolvedSessionFile,
			createdAt: now,
			lastUsedAt: now,
			runCount: 1,
			totalUsage: usage,
		});
	}
}

// ── Session directory resolution ──────────────────────────────────────────────

export interface SessionResolution {
	/** Per-agent directory passed to pi via --session-dir */
	piSessionDir: string;
	/** Most recent existing session file in that directory, if any */
	latestSessionFile: string | null;
}

export function resolveSession(
	sessionDir: string,
	agentName: string,
): SessionResolution {
	const dir = agentSessionDir(sessionDir, agentName);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

	return {
		piSessionDir: dir,
		latestSessionFile: latestPiSessionFilePath(sessionDir, agentName),
	};
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
