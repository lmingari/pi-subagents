#!/usr/bin/env node

const fs = require("fs");
const { spawn } = require("child_process");
const readline = require("readline");

const DEBUG = ["1", "true", "yes"].includes(String(process.env.PI_SUBAGENT_DEBUG || "").toLowerCase());
const DEBUG_LOG_FILE = process.env.PI_SUBAGENT_LOG || "/tmp/pi-subagent.log";

function log(message, extra) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const line = `[${ts}] [child-runner] ${message}${extra ? " " + JSON.stringify(extra) : ""}\n`;
	try { fs.appendFileSync(DEBUG_LOG_FILE, line, "utf-8"); } catch {}
	try { process.stderr.write(line); } catch {}
}

function fail(message) {
	log("fatal", { message });
	try {
		process.stderr.write(`[child-runner] ${message}\n`);
	} catch {}
	process.exit(1);
}

process.on("uncaughtException", (err) => {
	log("uncaughtException", { message: err?.message, stack: err?.stack });
	finish(1, `child-runner uncaughtException: ${err?.message || String(err)}`);
	process.exit(1);
});

process.on("unhandledRejection", (reason) => {
	log("unhandledRejection", { reason: String(reason) });
	finish(1, `child-runner unhandledRejection: ${String(reason)}`);
	process.exit(1);
});

const encoded = process.argv[2];
if (!encoded) fail("Missing encoded payload argument");

let payload;
try {
	payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf-8"));
} catch (err) {
	fail(`Invalid payload: ${err.message}`);
}

const runId = payload?.runId;
const fifoPath = payload?.fifoPath;
const cwd = payload?.cwd;
const piArgs = Array.isArray(payload?.piArgs) ? payload.piArgs : null;

if (!runId || !fifoPath || !cwd || !piArgs) {
	fail("Payload missing required fields (runId, fifoPath, cwd, piArgs[])");
}

log("payload received", {
	runId,
	fifoPath,
	cwd,
	piArgsCount: piArgs.length,
});

let fifoFd;
try {
	// Blocks until parent opens the read end.
	fifoFd = fs.openSync(fifoPath, "w");
	log("fifo opened", { fifoPath });
} catch (err) {
	fail(`Failed to open FIFO at ${fifoPath}: ${err.message}`);
}

function send(msg) {
	if (!fifoFd) {
		log("send skipped (fifo closed)", { type: msg?.type });
		return;
	}
	try {
		fs.writeSync(fifoFd, JSON.stringify(msg) + "\n", null, "utf-8");
		log("sent", { type: msg?.type });
	} catch (err) {
		log("send failed", { type: msg?.type, message: err?.message });
	}
}

function closeFifo() {
	if (!fifoFd) return;
	try { fs.closeSync(fifoFd); } catch {}
	fifoFd = undefined;
}

function normalizeUsage(raw) {
	if (!raw || typeof raw !== "object") return null;
	const inputTokens =
		numberOr(raw.inputTokens) ??
		numberOr(raw.input_tokens) ??
		numberOr(raw.prompt_tokens) ??
		0;
	const outputTokens =
		numberOr(raw.outputTokens) ??
		numberOr(raw.output_tokens) ??
		numberOr(raw.completion_tokens) ??
		0;
	const usage = { inputTokens, outputTokens };

	const cacheRead = numberOr(raw.cacheReadTokens) ?? numberOr(raw.cache_read_tokens);
	const cacheWrite = numberOr(raw.cacheWriteTokens) ?? numberOr(raw.cache_write_tokens);
	if (cacheRead != null) usage.cacheReadTokens = cacheRead;
	if (cacheWrite != null) usage.cacheWriteTokens = cacheWrite;
	return usage;
}

function numberOr(v) {
	return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function extractUsage(event) {
	if (!event || typeof event !== "object") return null;
	if (event.usage) return normalizeUsage(event.usage);
	if (event.token_usage) return normalizeUsage(event.token_usage);
	if (event.tokens) return normalizeUsage(event.tokens);
	return null;
}

function extractText(value) {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return "";

	const direct =
		(typeof value.delta === "string" && value.delta) ||
		(typeof value.text === "string" && value.text) ||
		(typeof value.output_text === "string" && value.output_text) ||
		(typeof value.message === "string" && value.message) ||
		"";
	if (direct) return direct;

	if (Array.isArray(value.content)) {
		return value.content.map(extractText).filter(Boolean).join("");
	}

	if (value.message && typeof value.message === "object") {
		const t = extractText(value.message);
		if (t) return t;
	}

	if (value.delta && typeof value.delta === "object") {
		const t = extractText(value.delta);
		if (t) return t;
	}

	if (Array.isArray(value.output)) {
		return value.output.map(extractText).filter(Boolean).join("");
	}

	for (const key of Object.keys(value)) {
		const nested = value[key];
		if (nested && typeof nested === "object") {
			const t = extractText(nested);
			if (t) return t;
		}
	}

	return "";
}

function maybeSendToolStart(event) {
	if (!event || typeof event !== "object") return;
	const type = String(event.type || "").toLowerCase();
	if (!["tool_start", "tool_call_start"].includes(type)) return;
	const toolName =
		event.toolName || event.tool_name || event.name || event.tool || "tool";
	send({ type: "tool_start", runId, toolName: String(toolName) });
}

let finalUsage = { inputTokens: 0, outputTokens: 0 };
let finished = false;

function finish(exitCode, errMessage) {
	if (finished) return;
	finished = true;
	log("finish", { exitCode, hasError: Boolean(errMessage) });

	if (errMessage) {
		send({ type: "agent_error", runId, message: errMessage });
	}

	// Interactive mode does not parse structured output/tokens from pi.
	send({ type: "token_usage", runId, usage: finalUsage });
	send({ type: "agent_done", runId, exitCode, output: "", usage: finalUsage });
	closeFifo();
}

// Signal parent that FIFO is open so waitForOpen() can resolve promptly.
send({ type: "context_update", runId, usedTokens: 0, contextWindow: 1 });

const child = spawn("pi", piArgs, {
	cwd,
	env: {
		...process.env,
		PI_IPC_FIFO: fifoPath,
		PI_SUBAGENT_RUN_ID: runId,
	},
	stdio: "inherit",
});
log("pi spawn attempted", { command: "pi", args: piArgs, cwd, mode: "interactive" });

child.on("error", (spawnErr) => {
	log("pi spawn error", { message: spawnErr.message });
	finish(1, `Failed to start pi: ${spawnErr.message}`);
});

child.on("close", (code) => {
	const exitCode = typeof code === "number" ? code : 1;
	log("pi process closed", { exitCode });
	const errMsg = exitCode === 0 ? undefined : `pi exited with code ${exitCode}`;
	finish(exitCode, errMsg);
});
