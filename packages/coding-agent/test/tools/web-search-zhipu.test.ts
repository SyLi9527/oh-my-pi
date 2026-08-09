import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { getSearchProvider } from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchZhipu } from "@oh-my-pi/pi-coding-agent/web/search/providers/zhipu";
import { isSearchProviderId, SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";

const TEST_KEY = "test-zhipu-key";

function makeAuthStorage(apiKey: string | undefined): AuthStorage {
	return {
		resolver(provider: string, options?: { sessionId?: string }) {
			expect(provider).toBe("zhipu");
			expect(options?.sessionId).toBe("session-zhipu-test");
			return async () => apiKey;
		},
		hasAuth(provider: string) {
			return provider === "zhipu" && Boolean(apiKey);
		},
	} as unknown as AuthStorage;
}

function makeParams(query: string, authStorage: AuthStorage = makeAuthStorage(TEST_KEY)) {
	return {
		query,
		authStorage,
		systemPrompt: "",
		sessionId: "session-zhipu-test",
	} as const;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function requestBody(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("Zhipu web search provider", () => {
	it("registers zhipu as a lazy search provider", async () => {
		expect(isSearchProviderId("zhipu")).toBe(true);
		expect((await getSearchProvider("zhipu")).id).toBe("zhipu");
	});

	it("maps query constraints and structured results", async () => {
		const result = await searchZhipu({
			...makeParams("人工智能 site:gov.cn"),
			limit: 5,
			recency: "week",
			fetch: async (input, init) => {
				expect(String(input)).toBe("https://open.bigmodel.cn/api/paas/v4/web_search");
				expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${TEST_KEY}`);
				expect(requestBody(init)).toMatchObject({
					search_engine: "search_std",
					search_query: "人工智能",
					count: 5,
					search_domain_filter: "gov.cn",
					search_recency_filter: "oneWeek",
					content_size: "high",
				});
				return jsonResponse({
					request_id: "zp-1",
					search_result: [
						{
							title: "政策",
							link: "https://gov.cn/a",
							content: "摘要",
							media: "政府网",
							publish_date: "2026-08-09",
						},
					],
				});
			},
		});

		expect(result).toEqual({
			provider: "zhipu",
			sources: [
				{
					title: "政策",
					url: "https://gov.cn/a",
					snippet: "摘要",
					author: "政府网",
					publishedDate: "2026-08-09",
				},
			],
			requestId: "zp-1",
			authMode: "api_key",
		});
	});

	it("clamps query text to 70 Unicode code points", async () => {
		const engines: string[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			const body = requestBody(init);
			engines.push(String(body.search_engine));
			expect(body.search_query).toBe("😀".repeat(70));
			expect(Array.from(String(body.search_query))).toHaveLength(70);
			return jsonResponse({ search_result: [] });
		};

		const result = await searchZhipu({ ...makeParams("😀".repeat(71)), fetch: fetchMock });

		expect(result.sources).toEqual([]);
		expect(engines).toEqual(["search_std", "search_pro"]);
	});

	it.each([
		["day", "oneDay"],
		["month", "oneMonth"],
		["year", "oneYear"],
	] as const)("maps %s recency to %s", async (recency, expected) => {
		const fetchMock: FetchImpl = async (_input, init) => {
			expect(requestBody(init).search_recency_filter).toBe(expected);
			return jsonResponse({ search_result: [{ link: "https://example.com/result" }] });
		};

		await searchZhipu({ ...makeParams("recency query"), recency, fetch: fetchMock });
	});

	it("reports a missing Zhipu credential without making a request", async () => {
		await expect(
			searchZhipu({
				...makeParams("missing key", makeAuthStorage(undefined)),
				fetch: async () => {
					throw new Error("fetch must not be called without credentials");
				},
			}),
		).rejects.toThrow("Zhipu credentials not found.");
	});

	it.each([
		[401, "zhipu: 401 unauthorized"],
		[402, "zhipu: 402 credits exhausted"],
		[429, "Zhipu API error (429)."],
		[500, "Zhipu API error (500)."],
	] as const)("classifies HTTP %d without exposing the upstream body", async (status, message) => {
		const fetchMock: FetchImpl = async () => new Response("sensitive upstream detail", { status });

		try {
			await searchZhipu({ ...makeParams("HTTP failure"), fetch: fetchMock });
			expect.unreachable("expected searchZhipu to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "zhipu", status, message });
			expect((error as Error).message).not.toContain("sensitive upstream detail");
		}
	});

	it("rejects malformed successful payloads with a structured category", async () => {
		const fetchMock: FetchImpl = async () => jsonResponse({ request_id: "zp-malformed", search_result: {} });

		try {
			await searchZhipu({ ...makeParams("malformed response"), fetch: fetchMock });
			expect.unreachable("expected searchZhipu to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SearchProviderError);
			expect(error).toMatchObject({ provider: "zhipu", status: 200, category: "malformed_response" });
		}
	});

	it("omits search results without URLs", async () => {
		let callCount = 0;
		const fetchMock: FetchImpl = async () => {
			callCount += 1;
			return jsonResponse({ search_result: [{ title: "No URL", content: "not renderable" }] });
		};

		const result = await searchZhipu({ ...makeParams("missing URL"), fetch: fetchMock });

		expect(result.sources).toEqual([]);
		expect(callCount).toBe(2);
	});

	it("upgrades one successful empty standard search to pro exactly once", async () => {
		const engines: string[] = [];
		const fetchMock: FetchImpl = async (_input, init) => {
			const engine = String(requestBody(init).search_engine);
			engines.push(engine);
			return engine === "search_std"
				? jsonResponse({ request_id: "zp-standard", search_result: [] })
				: jsonResponse({
						request_id: "zp-pro",
						search_result: [{ title: "Found", link: "https://example.com/found" }],
					});
		};

		const result = await searchZhipu({ ...makeParams("fallback query"), fetch: fetchMock });

		expect(engines).toEqual(["search_std", "search_pro"]);
		expect(result).toMatchObject({ provider: "zhipu", requestId: "zp-pro" });
		expect(result.sources).toEqual([{ title: "Found", url: "https://example.com/found" }]);
	});
});
