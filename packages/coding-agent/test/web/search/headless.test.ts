import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import {
	runSearchQuery,
	SEARCH_PROVIDER_ORDER,
	setExcludedSearchProviders,
	setSearchProviderOrder,
} from "@oh-my-pi/pi-coding-agent/web/search/headless";

const authStorage = {
	hasAuth: (provider: string) => provider === "zhipu",
	resolver: (provider: string) => async () => (provider === "zhipu" ? "zhipu-test-key" : undefined),
} as unknown as AuthStorage;

afterEach(() => {
	setSearchProviderOrder([]);
	setExcludedSearchProviders([]);
	vi.restoreAllMocks();
});

describe("headless search runtime", () => {
	it("exports only the approved provider runtime surface", () => {
		expect(SEARCH_PROVIDER_ORDER).toEqual(["parallel", "brave", "exa", "zhipu", "tavily", "firecrawl"]);
		expect(typeof runSearchQuery).toBe("function");
		expect(typeof setSearchProviderOrder).toBe("function");
		expect(typeof setExcludedSearchProviders).toBe("function");
	});

	it("runs a configured provider without the CLI or SDK composition layer", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					request_id: "headless-request",
					search_result: [
						{
							title: "Headless result",
							link: "https://example.com/headless",
							content: "Search-only runtime",
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);

		const result = await runSearchQuery(
			{ query: "headless runtime", provider: "zhipu" },
			{ authStorage, providerTimeoutMs: 1_000 },
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.details.response).toMatchObject({
			provider: "zhipu",
			requestId: "headless-request",
			sources: [{ title: "Headless result", url: "https://example.com/headless" }],
		});
	});
});
