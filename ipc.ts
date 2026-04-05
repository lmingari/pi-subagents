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
import { createReadStream, existsSync } from "fs";
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
	let closed = false;

	// ── Open the read end (non-blocking) ──
	//
	// Opening a FIFO O_RDONLY blocks until the write-end is opened.
	// We use O_RDONLY | O_NONBLOCK so open() returns immediately, then we poll
	// via a readline stream. The stream will only emit data once the child opens
	// its write-end — which is fine; readline just waits.
	//
	// Note: On Linux, O_NONBLOCK on a FIFO affects open() but not subsequent
	// reads — readline will still block-read correctly once data arrives.

	let fd: Awaited<ReturnType<typeof open>> | null = null;

	// We open lazily inside waitForOpen so that if createChannel() is called
	// before the FIFO exists on disk (race), the delay is absorbed there.

	let readlineInterface: ReturnType<typeof createInterface> | null = null;
	let openResolve: (() => void) | null = null;
	let openReject: ((err: Error) => void) | null = null;
	let openTimer: ReturnType<typeof setTimeout> | null = null;

	function emitMessage(raw: string): void {
		if (!raw.trim()) return;
		let msg: IpcMessage;
		try {
			msg = JSON.parse(raw) as IpcMessage;
		} catch {
			// Malformed line — skip silently
			return;
		}
		for (const h of messageHandlers) h(msg);
	}

	function emitClose(err?: Error): void {
		if (closed) return;
		closed = true;
		for (const h of closeHandlers) h(err);
	}

	async function startReading(): Promise<void> {
		// Open with O_NONBLOCK to avoid blocking if child hasn't connected yet
		fd = await open(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);

		const stream = createReadStream("", { fd: fd.fd, autoClose: false });
		readlineInterface = createInterface({ input: stream, crlfDelay: Infinity });

		readlineInterface.on("line", (line) => {
			// First line signals the child has connected — resolve waitForOpen
			if (openResolve) {
				if (openTimer) clearTimeout(openTimer);
				const res = openResolve;
				openResolve = null;
				openReject = null;
				res();
			}
			emitMessage(line);
		});

		readlineInterface.on("close", () => {
			emitClose();
		});

		stream.on("error", (err) => {
			emitClose(err);
			if (openReject) {
				if (openTimer) clearTimeout(openTimer);
				const rej = openReject;
				openResolve = null;
				openReject = null;
				rej(err);
			}
		});
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
			// Start reading — this opens the fd and sets up readline
			await startReading();

			return new Promise<void>((resolve, reject) => {
				// If readline already fired before we set up the promise
				// (extremely unlikely but possible), resolve immediately.
				if (!openResolve && !closed) {
					resolve();
					return;
				}

				openResolve = resolve;
				openReject = reject;

				openTimer = setTimeout(() => {
					openResolve = null;
					openReject = null;
					reject(new Error(
						`IPC FIFO open timeout after ${openTimeoutMs}ms — ` +
						`child process may have failed to start. Path: ${path}`
					));
				}, openTimeoutMs);
			});
		},

		async close(): Promise<void> {
			if (closed) return;
			closed = true;

			if (openTimer) clearTimeout(openTimer);
			readlineInterface?.close();

			try { await fd?.close(); } catch {}

			// Unlink the FIFO — best effort, ignore if already gone
			try { await unlink(path); } catch {}

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
