/**
 * agent-loader.ts — Scans agent definition directories and parses AgentDef
 * objects from markdown files with YAML frontmatter.
 *
 * Recognised frontmatter fields:
 *   name        required — unique agent identifier
 *   description optional — one-line summary
 *   tools       optional — comma-separated pi tool names
 *   inputs      optional — comma-separated default input file paths
 *   thinking    optional — default thinking level
 *   model       optional — default model id for this agent
 *   output      optional — default output file path, relative to cwd
 *
 * Search order (first match for a given name wins):
 *   1. <cwd>/agents/
 *   2. <cwd>/.claude/agents/
 *   3. <cwd>/.pi/agents/
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, join } from "path";
import type { AgentDef } from "./types.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const AGENT_DIRS = [
	"agents",
	".claude/agents",
	".pi/agents",
] as const;


function normalizeFrontmatterValue(value: string): string {
	const trimmed = value.trim();
	const unquoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
			? trimmed.slice(1, -1)
			: trimmed;
	return unquoted.trim();
}

function normalizeTools(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = normalizeFrontmatterValue(value)
		.split(",")
		.map(t => t.trim())
		.filter(Boolean)
		.join(",");
	return normalized || undefined;
}

function normalizeOptionalValue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const normalized = normalizeFrontmatterValue(value);
	return normalized || undefined;
}

function normalizeInputs(value: string | undefined): string[] | undefined {
	if (!value) return undefined;
	const normalized = normalizeFrontmatterValue(value)
		.split(",")
		.map(v => v.trim())
		.filter(Boolean);
	return normalized.length ? normalized : undefined;
}

// ── Frontmatter parser ────────────────────────────────────────────────────────

/**
 * Parses a markdown file with YAML frontmatter.
 * Returns null if the file is missing the frontmatter block or the
 * required "name" field.
 */
export function parseAgentFile(filePath: string): AgentDef | null {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (err) {
		throw new Error(`Failed to read agent file "${filePath}": ${(err as Error).message}`);
	}

	// Match --- frontmatter --- body
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
	if (!match) return null;

	const [, frontmatterBlock, body] = match;

	// Parse simple key: value lines — no multiline or nested YAML support needed
	const frontmatter: Record<string, string> = {};
	for (const line of frontmatterBlock.split(/\r?\n/)) {
		const colonIdx = line.indexOf(":");
		if (colonIdx < 1) continue;
		const key = line.slice(0, colonIdx).trim();
		const value = line.slice(colonIdx + 1).trim();
		if (key) frontmatter[key] = normalizeFrontmatterValue(value);
	}

	if (!frontmatter.name) return null;

	return {
		name: frontmatter.name,
		description: frontmatter.description ?? "",
		tools: normalizeTools(frontmatter.tools),
		inputs: normalizeInputs(frontmatter.inputs),
		thinking: normalizeOptionalValue(frontmatter.thinking),
		model: normalizeOptionalValue(frontmatter.model),
		systemPrompt: body.trim(),
		file: filePath,
		outputFile: frontmatter.output || undefined,
	};
}

// ── Directory scanner ─────────────────────────────────────────────────────────

/**
 * Scans all agent directories under cwd and returns a deduplicated list of
 * AgentDef objects. First directory wins on name collision.
 *
 * Skips files that fail to parse (logs a warning) but does not throw.
 */
export function scanAgentDirs(cwd: string): AgentDef[] {
	const seen = new Set<string>();
	const agents: AgentDef[] = [];

	for (const rel of AGENT_DIRS) {
		const dir = join(cwd, rel);
		if (!existsSync(dir)) continue;

		let files: string[];
		try {
			files = readdirSync(dir).filter(f => f.endsWith(".md"));
		} catch {
			continue;
		}

		for (const file of files) {
			const fullPath = resolve(dir, file);
			let def: AgentDef | null;
			try {
				def = parseAgentFile(fullPath);
			} catch (err) {
				console.warn(`[agent-loader] Skipping "${fullPath}": ${(err as Error).message}`);
				continue;
			}

			if (!def) {
				console.warn(`[agent-loader] Skipping "${fullPath}": missing frontmatter or name field`);
				continue;
			}

			const key = def.name.toLowerCase();
			if (seen.has(key)) {
				// Earlier directory already claimed this name
				continue;
			}

			seen.add(key);
			agents.push(def);
		}
	}

	return agents;
}

// ── Lookup helpers ────────────────────────────────────────────────────────────

/**
 * Build a name → AgentDef map from a list (case-insensitive keys).
 * Useful for O(1) lookup in the dispatcher.
 */
export function buildAgentIndex(agents: AgentDef[]): Map<string, AgentDef> {
	const index = new Map<string, AgentDef>();
	for (const agent of agents) {
		index.set(agent.name.toLowerCase(), agent);
	}
	return index;
}

/**
 * Look up an agent by name (case-insensitive) from an index.
 * Throws with a helpful message if not found.
 */
export function requireAgent(
	index: Map<string, AgentDef>,
	name: string,
): AgentDef {
	const def = index.get(name.toLowerCase());
	if (!def) {
		const available = [...index.keys()].join(", ");
		throw new Error(
			`Agent "${name}" not found. Available agents: ${available || "(none)"}`
		);
	}
	return def;
}
