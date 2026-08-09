import { describe, expect, it } from "bun:test";
import { type ApiKeyResolveContext, withAuth } from "@oh-my-pi/pi-coding-agent/web/search/provider-auth";

const statusError = (status: number): Error & { status: number } =>
	Object.assign(new Error(`provider returned ${status}`), { status });

describe("headless search provider auth", () => {
	it("bounds ordinary 401 failures to one refresh and one sibling switch", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		let resolveIndex = 0;
		const failure = statusError(401);

		await expect(
			withAuth(
				context => {
					contexts.push(context);
					return `key-${resolveIndex++}`;
				},
				async key => {
					keys.push(key);
					throw failure;
				},
			),
		).rejects.toBe(failure);

		expect(keys).toEqual(["key-0", "key-1", "key-2"]);
		expect(contexts.map(context => context.lastChance)).toEqual([false, false, true]);
	});

	it("continues direct sibling rotation for quota failures", async () => {
		const keys: string[] = [];
		const contexts: ApiKeyResolveContext[] = [];
		let resolveIndex = 0;

		const result = await withAuth(
			context => {
				contexts.push(context);
				return `key-${resolveIndex++}`;
			},
			async key => {
				keys.push(key);
				if (key === "key-3") return "success";
				throw statusError(429);
			},
		);

		expect(result).toBe("success");
		expect(keys).toEqual(["key-0", "key-1", "key-2", "key-3"]);
		expect(contexts.map(context => context.lastChance)).toEqual([false, true, true, true]);
	});
});
