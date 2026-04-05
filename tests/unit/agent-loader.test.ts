import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAgentFile, scanAgentDirs, buildAgentIndex, requireAgent } from "../../agent-loader.ts";

function fixture(name: string): string {
	return join(process.cwd(), "tests", "fixtures", "agents", name);
}

test("parseAgentFile parses standard frontmatter fields", () => {
	const def = parseAgentFile(fixture("riddle-maker.md"));
	assert.ok(def);
	assert.equal(def.name, "riddle-maker");
	assert.equal(def.description, "Creates clever riddles on any topic");
	assert.equal(def.tools, "read");
	assert.equal(def.outputFile, "riddle-maker.md");
	assert.equal(def.model, undefined);
	assert.match(def.systemPrompt, /creative riddle maker/i);
});

test("parseAgentFile defaults empty tools to built-in defaults", () => {
	const def = parseAgentFile(fixture("riddle-solver.md"));
	assert.ok(def);
	assert.equal(def.tools, "read,grep,find,ls");
});

test("parseAgentFile supports provider/modelID convention and quoted values", () => {
	const def = parseAgentFile(fixture("researcher.md"));
	assert.ok(def);
	assert.equal(def.model, "openrouter/anthropic/claude-3.7-sonnet");
	assert.equal(def.tools, "read,grep,find");
	assert.equal(def.outputFile, "outputs/research.md");
});

test("parseAgentFile returns null when frontmatter is missing", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-loader-test-"));
	const file = join(dir, "invalid.md");
	writeFileSync(file, "# no frontmatter\nhello\n", "utf-8");
	assert.equal(parseAgentFile(file), null);
});

test("scanAgentDirs respects search precedence (agents > .claude/agents > .pi/agents)", () => {
	const root = mkdtempSync(join(tmpdir(), "agent-loader-scan-"));
	mkdirSync(join(root, "agents"), { recursive: true });
	mkdirSync(join(root, ".claude", "agents"), { recursive: true });
	mkdirSync(join(root, ".pi", "agents"), { recursive: true });

	// Same name in all locations; highest-precedence directory should win.
	writeFileSync(
		join(root, ".pi", "agents", "dup.md"),
		`---\nname: dup\ndescription: from-pi\ntools: read\n---\npi\n`,
		"utf-8",
	);
	writeFileSync(
		join(root, ".claude", "agents", "dup.md"),
		`---\nname: dup\ndescription: from-claude\ntools: read\n---\nclaude\n`,
		"utf-8",
	);
	writeFileSync(
		join(root, "agents", "dup.md"),
		`---\nname: dup\ndescription: from-agents\ntools: read\n---\nagents\n`,
		"utf-8",
	);

	// Additional valid agent from fixtures.
	writeFileSync(join(root, ".pi", "agents", "riddle-maker.md"), readFileSync(fixture("riddle-maker.md"), "utf-8"));

	const defs = scanAgentDirs(root);
	const index = buildAgentIndex(defs);

	const dup = requireAgent(index, "dup");
	assert.equal(dup.description, "from-agents");

	const maker = requireAgent(index, "riddle-maker");
	assert.equal(maker.name, "riddle-maker");
});
