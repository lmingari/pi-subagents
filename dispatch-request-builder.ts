import type { AgentGroup, DispatchContext, DispatchRequest, InputFiles, OutputTarget } from "./types.ts";

export interface DispatchToolInput {
	agent: string;
	task: string;
	context?: DispatchContext;
	inputs?: InputFiles;
	output?: OutputTarget;
	model?: string;
	tools?: string;
	thinking?: string;
}

interface BuildDispatchRequestOptions {
	input: DispatchToolInput;
	group: AgentGroup;
	agentDefaultInputs?: InputFiles;
	sessionDir: string;
	cwd: string;
	currentSessionId?: string;
}

export function buildDispatchRequest({
	input,
	group,
	agentDefaultInputs,
	sessionDir,
	cwd,
	currentSessionId,
}: BuildDispatchRequestOptions): DispatchRequest {
	const agentName = input.agent;
	const overrideKey = Object.keys(group.overrides ?? {}).find(k => k.toLowerCase() === agentName.toLowerCase());
	const override = overrideKey ? group.overrides?.[overrideKey] : undefined;
	const context = input.context ?? override?.context ?? group.defaults.context;

	return {
		agent: agentName,
		task: input.task,
		inputs: input.inputs ?? agentDefaultInputs ?? override?.inputs ?? group.defaults.inputs,
		output: input.output ?? override?.output ?? group.defaults.output,
		context,
		terminal: override?.terminal ?? group.defaults.terminal,
		ipc: {
			type: "fifo",
			path: "",
			openTimeoutMs: override?.openTimeoutMs ?? group.defaults.ipc.openTimeoutMs,
		},
		sessionDir,
		cwd,
		model: input.model ?? override?.model ?? group.defaults.model,
		tools: input.tools ?? override?.tools ?? group.defaults.tools,
		thinking: input.thinking ?? override?.thinking ?? group.defaults.thinking,
		forkSessionId: context === "fork"
			? (override?.forkSessionId ?? currentSessionId)
			: undefined,
	};
}
