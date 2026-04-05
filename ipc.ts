/**
 * ipc.ts — IPC channel management for pi subagents.
 *
 * Current transport: FIFO (named pipe), child → parent only.
 * One FIFO per agent, path: <sessionDir>/<agentName>.fifo
 *
 * Extending: implement IpcChannel and register it in createChannel().
 * Callers only ever deal with IpcChannel — the transport is an impl detail.
 *
 * Parent side:
 *   const channel = await createChannel(transport);
 *   channel.onMessage(msg => ...);
 *   await channel.waitForOpen();     // blocks until child connects or timeout
 *   // ... run completes ...
 *   await channel.close();
 *
 * Child side (the pi subprocess wrapper script):
 *   Writes newline-delimited JSON matching IpcMessage to the FIFO path,
 *   which it receives as an env var (PI_IPC_FIFO).
 */

import { open, unlink, constants as fsConstants } from "fs/promises";
import { createReadStream } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { createInterface } from "readline";
import type { IpcTransport, IpcMessage, FifoTransport } from "./types.ts";

const execFileAsync = promisify(execFile);

// ── IpcChannel interface ──────────────────────────────────────────────────────

/**
 * The only interface the dispatcher interacts with.
 * Transport-agnostic — add new transports by implementing this.
 */
export interface IpcChannel {
	/** The transport descriptor (for logging / diagnostics) */
	readonly transport: IpcTransport;

	/**
	 * Register a handler called for every IpcMessage received from the child.
	 * May be called multiple times — all handlers are invoked in registration order.
	 */
	onMessage(handler: (msg: IpcMessage) => void): void;

	/**
	 * Register a handler called when the channel is closed (normally or on error).
	 * Receives the error if the close was abnormal.
	 */
	onClose(handler: (err?: Error) => void): void;

	/**
	 * Wait until the child has connected (write-end opened) or the timeout elapses.
	 * Resolves when ready, rejects on timeout.
	 */
	waitForOpen(): Promise<void>;

	/**
	 * Gracefully close the channel and clean up resources (unlink FIFO, etc.).
	 * Safe to call multiple times.
	 */
	close(): Promise<void>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create and prepare an IpcChannel for the given transport.
 * For FIFO: creates the named pipe on disk. Call waitForOpen() after
 * the terminal process has been spawned.
 */
export async function createChannel(transport: IpcTransport): Promise<IpcChannel> {
	switch (transport.type) {
		case "fifo":
			return createFifoChannel(transport);
		// future:
		// case "unix-socket": return createUnixSocketChannel(transport);
		// case "tcp":         return createTcpChannel(transport);
		default:
			throw new Error(`Unknown IPC transport type: ${(transport as any).type}`);
	}
}

/**
 * Compute the canonical FIFO path for an agent within a session directory.
 * Called by the dispatcher to fill in FifoTransport.path before spawning.
 */
export function fifoPath(sessionDir: string, agentName: string): string {
	const safe = agentName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
	return `${sessionDir}/${safe}.fifo`;
}

// ── FIFO implementation ───────────────────────────────────────────────────────

async function createFifoChannel(transport: FifoTransport): Promise<IpcChannel> {
	const { path, openTimeoutMs = 10_000 } = transport;

	// Create the named pipe (mkfifo). Throws if it already exists or path is bad.
	await execFileAsync("mkfifo", [path]);

	const messageHandlers: Array<(msg: IpcMessage) => void> = [];
	const closeHandlers: Array<(err?: Error) => void> = [];

	let fd: Awaited<ReturnType<typeof open>> | null = null;
	let readlineInterface: ReturnType<typeof createInterface> | null = null;
	let startPromise: Promise<void> | null = null;
	let openResolve: (() => void) | null = null;
	let openReject: ((err: Error) => void) | null = null;
	let openTimer: ReturnType<typeof setTimeout> | null = null;
	let opened = false;
	let cleanedUp = false;
	let closeEmitted = false;

	function resolveOpenIfPending(): void {
		if (!openResolve) return;
		if (openTimer) clearTimeout(openTimer);
		const res = openResolve;
		openResolve = null;
		openReject = null;
		res();
	}

	function rejectOpenIfPending(err: Error): void {
		if (!openReject) return;
		if (openTimer) clearTimeout(openTimer);
		const rej = openReject;
		openResolve = null;
		openReject = null;
		rej(err);
	}

	function emitMessage(raw: string): void {
		if (!raw.trim()) return;
		let msg: IpcMessage;
		try {
			msg = JSON.parse(raw) as IpcMessage;
		} catch {
			return;
		}
		if (!opened) {
			opened = true;
			resolveOpenIfPending();
		}
		for (const h of messageHandlers) h(msg);
	}

	function emitClose(err?: Error): void {
		if (closeEmitted) return;
		closeEmitted = true;
		for (const h of closeHandlers) h(err);
	}

	async function cleanup(): Promise<void> {
		if (cleanedUp) return;
		cleanedUp = true;

		if (openTimer) clearTimeout(openTimer);
		try { readlineInterface?.close(); } catch {}
		try { await fd?.close(); } catch {}
		try { await unlink(path); } catch {}
	}

	async function startReading(): Promise<void> {
		if (startPromise) return startPromise;

		startPromise = (async () => {
			fd = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
			const stream = createReadStream("", { fd: fd.fd, autoClose: false });
			readlineInterface = createInterface({ input: stream, crlfDelay: Infinity });

			readlineInterface.on("line", emitMessage);

			readlineInterface.on("close", () => {
				cleanup()
					.then(() => emitClose())
					.catch((err) => emitClose(err as Error));
			});

			stream.on("error", (err) => {
				rejectOpenIfPending(err as Error);
				cleanup()
					.then(() => emitClose(err as Error))
					.catch((cleanupErr) => emitClose(cleanupErr as Error));
			});
		})();

		return startPromise;
	}

	return {
		transport,

		onMessage(handler) {
			messageHandlers.push(handler);
		},

		onClose(handler) {
			closeHandlers.push(handler);
		},

		async waitForOpen(): Promise<void> {
			await startReading();
			if (opened) return;

			return new Promise<void>((resolve, reject) => {
				openResolve = resolve;
				openReject = reject;
				openTimer = setTimeout(() => {
					const timeoutErr = new Error(
						`IPC FIFO open timeout after ${openTimeoutMs}ms — ` +
						`child process may have failed to start. Path: ${path}`
					);
					rejectOpenIfPending(timeoutErr);
				}, openTimeoutMs);
			});
		},

		async close(): Promise<void> {
			await cleanup();
			emitClose();
		},
	};
}

// ── Child-side helper ─────────────────────────────────────────────────────────

/**
 * Used by the wrapper script that runs inside the terminal.
 * Opens the FIFO for writing and returns a send function.
 *
 * The wrapper script reads PI_IPC_FIFO from its environment to get the path.
 *
 * Example wrapper usage:
 *   const send = await openChildChannel(process.env.PI_IPC_FIFO!);
 *   send({ type: "text_delta", runId, delta: "..." });
 */
export async function openChildChannel(
	fifoPath: string,
): Promise<(msg: IpcMessage) => void> {
	// O_WRONLY blocks until the read-end is open — the parent opens it first,
	// so this should return almost immediately.
	const fd = await open(fifoPath, fsConstants.O_WRONLY);

	return function send(msg: IpcMessage): void {
		const line = JSON.stringify(msg) + "\n";
		// writeSync keeps messages atomic — no interleaving on a single FIFO
		const buf = Buffer.from(line, "utf-8");
		fd.write(buf).catch(() => {
			// Parent closed the read-end — nothing useful to do
		});
	};
}
