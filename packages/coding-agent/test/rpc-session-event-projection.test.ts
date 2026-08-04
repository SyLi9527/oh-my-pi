import { describe, expect, it, mock } from "bun:test";
import {
	createRpcSessionEventOutput,
	forwardAllRpcSessionEvents,
	projectRpcSessionEvent,
	type RpcSessionEventProjection,
} from "../src/modes/rpc/rpc-mode";
import type { AgentSessionEvent } from "../src/session/agent-session-events";

const event = { type: "agent_start" } as const;

describe("RPC session event projection", () => {
	it("forwards an event through the explicit stock policy", () => {
		expect(projectRpcSessionEvent(event, forwardAllRpcSessionEvents)).toBe(event);
	});

	it("drops events before output receives them", () => {
		const output = mock((_value: unknown) => undefined);
		const projection = (): RpcSessionEventProjection => ({ action: "drop" });
		const projected = projectRpcSessionEvent(event, { projectSessionEvent: projection });
		if (projected !== undefined) output(projected);
		expect(output).not.toHaveBeenCalled();
	});

	it("returns a replacement event", () => {
		const replacement = { type: "turn_start" } as const;
		expect(
			projectRpcSessionEvent(event, {
				projectSessionEvent: () => ({ action: "replace", event: replacement }),
			}),
		).toBe(replacement);
	});

	it("terminates through the failure handler without forwarding", () => {
		const terminate = mock((): never => {
			throw new Error("terminated");
		});
		const output = mock((_value: unknown) => undefined);
		expect(() =>
			projectRpcSessionEvent(
				event,
				{
					projectSessionEvent: () => {
						throw new Error("projection failed");
					},
					terminateOnProjectionFailure: terminate,
				},
			),
		).toThrow("terminated");
		expect(terminate).toHaveBeenCalledTimes(1);
		expect(output).not.toHaveBeenCalled();
	});

	it("rejects an async-return impostor", () => {
		expect(() =>
			projectRpcSessionEvent(event, {
				projectSessionEvent: (() => Promise.resolve({ action: "drop" })) as never,
				terminateOnProjectionFailure: error => {
					throw error;
				},
			}),
		).toThrow("invalid RPC session event projection");
	});

	it("projects the session subscription before invoking output", () => {
		const output = mock((_value: AgentSessionEvent) => undefined);
		const listener = createRpcSessionEventOutput(output, {
			projectSessionEvent: current => ({ action: "replace", event: { type: "turn_start" } }),
		});
		listener(event);
		expect(output).toHaveBeenCalledWith({ type: "turn_start" });
	});
});
