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

export default function (pi) {
	pi.on("session_start", async (event, ctx) => {
		emitSessionUpdate(ctx, event);
	});

	// Some pi versions expose this directly; in others session_start(reason=resume/new/fork)
	// is the canonical post-switch event.
	pi.on("session_switch", async (event, ctx) => {
		emitSessionUpdate(ctx, event);
	});
}
