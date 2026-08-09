import { afterEach, describe, expect, it } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { searchBrave } from "@oh-my-pi/pi-coding-agent/web/search/providers/brave";

const ambientBraveApiKey = process.env.BRAVE_API_KEY;

afterEach(() => {
	if (ambientBraveApiKey === undefined) delete process.env.BRAVE_API_KEY;
	else process.env.BRAVE_API_KEY = ambientBraveApiKey;
});

function makeAuthStorage(overrides: Record<string, string | undefined>): AuthStorage {
	return {
		resolver(provider: string) {
			return async () => overrides[provider];
		},
		hasAuth(provider: string) {
			return Boolean(overrides[provider]);
		},
	} as unknown as AuthStorage;
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

describe("Brave web search provider", () => {
	it("uses an AuthStorage runtime override without BRAVE_API_KEY", async () => {
		delete process.env.BRAVE_API_KEY;
		const authStorage = makeAuthStorage({ brave: "runtime-brave-key" });
		const response = await searchBrave({
			query: "runtime auth",
			systemPrompt: "",
			authStorage,
			fetch: async (_url, init) => {
				expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe("runtime-brave-key");
				return jsonResponse({ web: { results: [{ title: "A", url: "https://example.com/a" }] } });
			},
		});
		expect(response.provider).toBe("brave");
	});
});
