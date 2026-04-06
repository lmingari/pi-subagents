import test from "node:test";
import assert from "node:assert/strict";
import { basename, join } from "node:path";
import { readFileSync } from "node:fs";


function fixture(name: string): string {
	return join(process.cwd(), "tests", "fixtures", "sessions", name);
}

function timestampToFilenamePrefix(isoTs: string): string {
	return isoTs.replace(/[:.]/g, "-");
}

function parseFilename(name: string): { prefix: string; uuid: string } {
	const m = name.match(/^(.+)_([0-9a-f-]{36})\.jsonl$/i);
	assert.ok(m, `invalid session filename format: ${name}`);
	return { prefix: m[1], uuid: m[2] };
}

test("fixture session filename matches header timestamp and id", () => {
	const path = fixture("2026-04-05T00-56-08-971Z_c5cff76f-84f5-462e-ac2c-5cad16f25030.jsonl");
	const firstLine = readFileSync(path, "utf-8").split(/\r?\n/)[0];
	const header = JSON.parse(firstLine);

	assert.equal(header.type, "session");
	const { prefix, uuid } = parseFilename(basename(path));
	assert.equal(uuid, header.id);
	assert.equal(prefix, timestampToFilenamePrefix(header.timestamp));
});

