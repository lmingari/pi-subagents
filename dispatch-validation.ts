import type { DispatchContext } from "./types.ts";
import type { AgentIndex } from "./dispatcher.ts";
import type { DispatchToolInput } from "./dispatch-request-builder.ts";

function isDispatchContext(value: unknown): value is DispatchContext {
	return value === "fresh" || value === "fork";
}

export function validateDispatchToolInput(
	input: DispatchToolInput,
	agentIndex: AgentIndex,
	currentSessionId?: string,
	fallbackContext: DispatchContext = "fresh",
): string[] {
	const errors: string[] = [];

	if (!input.agent?.trim()) {
		errors.push("agent is required");
	} else if (!agentIndex.has(input.agent.toLowerCase())) {
		errors.push(`unknown agent: ${input.agent}`);
	}

	if (!input.task?.trim()) {
		errors.push("task is required");
	}

	if (input.context !== undefined && !isDispatchContext(input.context)) {
		errors.push(`invalid context: ${String(input.context)} (expected \"fresh\" or \"fork\")`);
	}

	if ((input.context ?? fallbackContext) === "fork" && !currentSessionId) {
		errors.push("context is \"fork\" but current session id is unavailable");
	}

	if (input.inputs && !Array.isArray(input.inputs)) {
		errors.push("inputs must be an array of file paths");
	}

	return errors;
}
