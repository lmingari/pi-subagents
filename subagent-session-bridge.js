import { openSync, writeSync, closeSync } from "fs";

function sendIpc(msg) {
	const fifoPath = process.env.PI_IPC_FIFO;
	if (!fifoPath) return;
	try {
		const fd = openSync(fifoPath, "w");
		writeSync(fd, JSON.stringify(msg) + "\n", null, "utf-8");
		closeSync(fd);
	} catch {
		// Best-effort bridge only.
	}
}

function emitSessionUpdate(ctx, event) {
	const runId = process.env.PI_SUBAGENT_RUN_ID;
	if (!runId) return;
	const sessionFile = ctx.sessionManager.getSessionFile() || undefined;
	const sessionId = ctx.sessionManager.getSessionId?.() || undefined;
	sendIpc({
		type: "session_update",
		runId,
		sessionId,
		sessionFile,
		reason: event?.reason,
	});
}

function extractAssistantText(message) {
	if (!message || message.role !== "assistant") return "";
	const content = message.content;
	if (!Array.isArray(content)) return "";
	const text = content
		.map((block) => {
			if (!block || typeof block !== "object") return "";
			if (block.type === "text" && typeof block.text === "string") return block.text;
			return "";
		})
		.join("")
		.trim();
	return text;
}

export default function (pi) {
	pi.on("session_start", async (event, ctx) => {
		emitSessionUpdate(ctx, event);
	});

	// Some pi versions expose this directly; in others session_start(reason=resume/new/fork)
	// is the canonical post-switch event.
	pi.on("session_switch", async (event, ctx) => {
		emitSessionUpdate(ctx, event);
	});

	pi.on("message_end", async (event) => {
		const runId = process.env.PI_SUBAGENT_RUN_ID;
		if (!runId) return;
		const text = extractAssistantText(event?.message);
		if (!text) return;
		sendIpc({
			type: "reply_update",
			runId,
			text,
		});
	});
}
