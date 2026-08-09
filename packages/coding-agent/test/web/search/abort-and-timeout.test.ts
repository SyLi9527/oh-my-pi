/**
 * Regression coverage for issue #1221: `web_search` froze when an upstream
 * provider stalled because Bun's WinHTTP fetch could ignore `AbortSignal`,
 * and `executeSearch` masked the eventual `AbortError` as a normal provider
 * failure.
 *
 * The fix has two halves: a hard-timeout safety net wrapped around every
 * provider's outbound fetch (via the shared `withHardTimeout` helper), and
 * an abort re-throw in the provider-fallback loop so the session sees a real
 * cancellation instead of "all providers failed". The provider wiring is
 * spot-checked on anthropic (LLM-backed) and brave (pure search API); the
 * helper itself is exercised directly.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { runSearchQuery, WebSearchTool } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchAnthropic } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchBrave } from "@oh-my-pi/pi-coding-agent/web/search/providers/brave";
import { classifyProviderHttpError, withHardTimeout } from "@oh-my-pi/pi-coding-agent/web/search/providers/utils";
import {
	SearchProviderError,
	type SearchProviderId,
	type SearchResponse,
} from "@oh-my-pi/pi-coding-agent/web/search/types";

const FAKE_SESSION = {} as ToolSession;
const ambientBraveApiKey = process.env.BRAVE_API_KEY;
const fakeStorage = {
	listAuthCredentials: () => [],
	updateAuthCredential: () => undefined,
	get authStore() {
		return null as never;
	},
} as unknown as AgentStorage;

describe("withHardTimeout", () => {
	it("returns a signal that aborts on the hard timeout when no caller signal is supplied", async () => {
		const signal = withHardTimeout(undefined, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
	});

	it("forwards a caller signal's abort to the composed signal", () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 60_000);
		ac.abort(new Error("user-cancel"));
		expect(signal.aborted).toBe(true);
	});

	it("fires the hard timeout even when the caller signal stays open", async () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
		expect(ac.signal.aborted).toBe(false);
	});
});

describe("Anthropic provider hard-timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.ANTHROPIC_SEARCH_API_KEY;
		delete process.env.ANTHROPIC_SEARCH_BASE_URL;
	});

	it("passes a composed signal to fetch even when the caller did not supply one", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-test";

		let capturedSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchAnthropic({ query: "ping", system_prompt: "", fetch: fetchMock }, fakeStorage);

		// Without the hard-timeout wrapper, init.signal would be undefined when
		// the caller didn't supply one — leaving fetch with no cancellation at
		// all on a stalled WinHTTP connection.
		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal?.aborted).toBe(false);
	});

	it("composes the caller signal with the hard timeout instead of forwarding it directly", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-test";

		const ac = new AbortController();
		let capturedSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchAnthropic({ query: "ping", system_prompt: "", signal: ac.signal, fetch: fetchMock }, fakeStorage);

		// The signal handed to fetch must be a *composed* one, not the raw
		// caller signal: that's what guarantees the hard timeout fires even
		// when Bun fails to honour the caller's abort.
		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal).not.toBe(ac.signal);
	});
	it("applies ANTHROPIC_SEARCH_BASE_URL to stored Anthropic credentials", async () => {
		process.env.ANTHROPIC_SEARCH_BASE_URL = "https://search.example.test/";

		let capturedUrl: string | undefined;
		const fetchMock: FetchImpl = async input => {
			capturedUrl = String(input);
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchAnthropic({
			query: "ping",
			systemPrompt: "",
			fetch: fetchMock,
			authStorage: {
				getApiKey: async () => "sk-fallback",
				resolver: vi.fn(() => async () => "sk-fallback"),
				getOAuthAccountId: () => undefined,
			} as unknown as AuthStorage,
		});

		expect(capturedUrl).toBe("https://search.example.test/v1/messages?beta=true");
	});
});

describe("Brave provider hard-timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		if (ambientBraveApiKey === undefined) delete process.env.BRAVE_API_KEY;
		else process.env.BRAVE_API_KEY = ambientBraveApiKey;
	});

	it("hands fetch a composed signal even with no caller signal — confirms the rollout reaches non-Anthropic providers", async () => {
		const authStorage = {
			resolver(provider: string) {
				expect(provider).toBe("brave");
				return async () => "brave-test-key";
			},
		} as unknown as AuthStorage;

		let capturedSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ web: { results: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchBrave({ query: "ping", systemPrompt: "", authStorage, fetch: fetchMock });

		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal?.aborted).toBe(false);
	});
});

describe("executeSearch abort propagation", () => {
	afterEach(() => vi.restoreAllMocks());

	function fakeProvider(
		id: SearchProviderId,
		behaviour: (params: SearchParams) => Promise<SearchResponse>,
	): provider.SearchProvider {
		return {
			id,
			label: id,
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: behaviour,
		};
	}

	function mockProviderChain(providers: provider.SearchProvider[], options?: { explicitFirst?: boolean }) {
		vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue(
			providers.map(({ id }, index) => ({ id, explicit: options?.explicitFirst === true && index === 0 })),
		);
		return vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
			const match = providers.find(candidate => candidate.id === id);
			if (!match) throw new Error(`Unexpected provider: ${id}`);
			return match;
		});
	}

	it("surfaces caller cancellation as ToolAbortError instead of falling through to the next provider", async () => {
		// Two providers: the first throws an AbortError after the caller aborted,
		// the second would happily return a value. Pre-fix, executeSearch would
		// fall through to provider B and report success; post-fix, the abort
		// re-throw stops the loop immediately.
		const secondProviderSearch = vi.fn();
		mockProviderChain([
			fakeProvider("anthropic", async () => {
				throw new DOMException("aborted", "AbortError");
			}),
			fakeProvider("brave", secondProviderSearch),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const ac = new AbortController();
		ac.abort();

		await expect(tool.execute("test-id", { query: "anything" }, ac.signal)).rejects.toBeInstanceOf(ToolAbortError);
		expect(secondProviderSearch).not.toHaveBeenCalled();
	});

	it("does not fall through when the caller aborts a bounded provider attempt", async () => {
		const ac = new AbortController();
		const fallbackSearch = vi.fn();
		mockProviderChain([
			fakeProvider("parallel", ({ signal }) => {
				const { promise, reject } = Promise.withResolvers<SearchResponse>();
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				ac.abort(new Error("caller cancelled"));
				return promise;
			}),
			fakeProvider("brave", fallbackSearch),
		]);

		await expect(
			runSearchQuery(
				{ query: "cancelled" },
				{ authStorage: {} as AuthStorage, signal: ac.signal, providerTimeoutMs: 60_000 },
			),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(fallbackSearch).not.toHaveBeenCalled();
	});

	it("falls back after an attempt timeout without treating it as caller cancellation", async () => {
		mockProviderChain([
			fakeProvider("parallel", async ({ signal }) => {
				if (!signal) {
					return {
						provider: "parallel",
						sources: [{ title: "Unbounded result", url: "https://example.com/unbounded" }],
					};
				}
				const { promise, reject } = Promise.withResolvers<SearchResponse>();
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				return promise;
			}),
			fakeProvider("brave", async () => ({
				provider: "brave",
				sources: [{ title: "Bounded fallback", url: "https://example.com/fallback" }],
			})),
		]);

		const result = await runSearchQuery(
			{ query: "fallback" },
			{ authStorage: {} as AuthStorage, providerTimeoutMs: 10 },
		);

		expect(result.details.response.provider).toBe("brave");
		expect(result.details.failures).toBeUndefined();
	});

	it("still reports provider failures as a tool result when the caller has not aborted", async () => {
		// Defensive: the abort re-throw must NOT alter normal provider-error
		// flow. A genuine provider error should still produce an error result
		// rather than throwing.
		mockProviderChain([
			fakeProvider("anthropic", async () => {
				throw new Error("upstream 500");
			}),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("test-id", { query: "anything" });
		const block = result.content[0];
		expect(block?.type).toBe("text");
		expect(block && "text" in block ? block.text : "").toContain("upstream 500");
		expect(result.details?.error).toContain("upstream 500");
	});

	it("records ordered failure categories when every provider fails", async () => {
		mockProviderChain([
			fakeProvider("parallel", async () => {
				throw new SearchProviderError("parallel", "Parallel authorization failed.", 401);
			}),
			fakeProvider("brave", async () => {
				throw new SearchProviderError("brave", "Brave rate limit reached.", 429);
			}),
		]);

		const result = await runSearchQuery({ query: "failures" }, { authStorage: {} as AuthStorage });

		expect(result.details.failures).toEqual([
			{
				provider: "parallel",
				category: "auth_failed",
				message: "provider authentication failed",
				status: 401,
			},
			{
				provider: "brave",
				category: "rate_limited",
				message: "provider rate limited",
				status: 429,
			},
		]);
	});

	it.each([
		["quota status", new SearchProviderError("parallel", "Payment required.", 402), "quota_exhausted"],
		["empty response", new SearchProviderError("parallel", "No content.", 204), "empty_result"],
		[
			"malformed response",
			new SearchProviderError("parallel", "Malformed payload.", 200, "malformed_response"),
			"malformed_response",
		],
		["unavailable provider", new Error("Connection refused."), "provider_unavailable"],
	] as const)("classifies a %s failure", async (_label, failure, expectedCategory) => {
		mockProviderChain([
			fakeProvider("parallel", async () => {
				throw failure;
			}),
		]);

		const result = await runSearchQuery({ query: "classified" }, { authStorage: {} as AuthStorage });

		expect(result.details.failures?.[0]?.category).toBe(expectedCategory);
	});

	it("records an attempt timeout with a stable sanitized message when every provider times out", async () => {
		mockProviderChain([
			fakeProvider("parallel", ({ signal }) => {
				const { promise, reject } = Promise.withResolvers<SearchResponse>();
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				return promise;
			}),
		]);

		const result = await runSearchQuery(
			{ query: "timeout" },
			{ authStorage: {} as AuthStorage, providerTimeoutMs: 10 },
		);

		expect(result.details.failures).toEqual([
			{ provider: "parallel", category: "timeout", message: "provider attempt timed out" },
		]);
	});

	it("uses the attempt signal to classify a wrapped timeout error", async () => {
		mockProviderChain([
			fakeProvider("parallel", ({ signal }) => {
				const { promise, reject } = Promise.withResolvers<SearchResponse>();
				signal?.addEventListener(
					"abort",
					() => reject(new DOMException("provider wrapped the timeout", "AbortError")),
					{ once: true },
				);
				return promise;
			}),
		]);

		const result = await runSearchQuery(
			{ query: "wrapped timeout" },
			{ authStorage: {} as AuthStorage, providerTimeoutMs: 10 },
		);

		expect(result.details.failures).toEqual([
			{ provider: "parallel", category: "timeout", message: "provider attempt timed out" },
		]);
	});

	it("keeps raw upstream response bodies out of structured failures", async () => {
		const sensitiveBody = '{"error":"upstream account secret api_key=sk-sensitive"}';
		mockProviderChain([
			fakeProvider("parallel", async () => {
				throw new SearchProviderError("parallel", `Parallel API error (500): ${sensitiveBody}`, 500);
			}),
		]);

		const result = await runSearchQuery({ query: "sensitive failure" }, { authStorage: {} as AuthStorage });

		expect(result.details.error).toContain(sensitiveBody);
		expect(result.details.failures).toEqual([
			{
				provider: "parallel",
				category: "provider_unavailable",
				message: "provider unavailable",
				status: 500,
			},
		]);
		expect(JSON.stringify(result.details.failures)).not.toContain("sk-sensitive");
	});

	it("returns a structured not-configured failure without changing the visible error", async () => {
		const unavailable = fakeProvider("parallel", async () => {
			throw new Error("search must not run");
		});
		unavailable.isAvailable = () => false;
		mockProviderChain([unavailable]);

		const result = await runSearchQuery({ query: "unconfigured" }, { authStorage: {} as AuthStorage });

		expect(result.content).toEqual([{ type: "text", text: "Error: No web search provider configured." }]);
		expect(result.details.error).toBe("No web search provider configured.");
		expect(result.details.failures).toEqual([
			{ provider: "none", category: "not_configured", message: "No web search provider configured." },
		]);
	});

	it("falls through when a provider returns no renderable search content", async () => {
		const emptyProviderSearch = vi.fn(
			async (): Promise<SearchResponse> => ({
				provider: "searxng",
				sources: [],
			}),
		);
		const sourceProviderSearch = vi.fn(
			async (): Promise<SearchResponse> => ({
				provider: "brave",
				sources: [{ title: "Fallback result", url: "https://example.com/fallback", snippet: "fallback body" }],
			}),
		);
		mockProviderChain([fakeProvider("searxng", emptyProviderSearch), fakeProvider("brave", sourceProviderSearch)]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("test-id", { query: "anything" });

		expect(emptyProviderSearch).toHaveBeenCalledTimes(1);
		expect(sourceProviderSearch).toHaveBeenCalledTimes(1);
		const block = result.content[0];
		expect(block?.type).toBe("text");
		expect(block && "text" in block ? block.text : "").toContain("Fallback result");
		expect(result.details?.response.provider).toBe("brave");
	});

	it("does not load fallback providers after the preferred provider succeeds", async () => {
		const fallbackSearch = vi.fn();
		const getProvider = mockProviderChain([
			fakeProvider("exa", async () => ({
				provider: "exa",
				sources: [{ title: "Preferred result", url: "https://example.com/preferred" }],
			})),
			fakeProvider("duckduckgo", fallbackSearch),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("test-id", { query: "anything" });

		expect(result.details?.response.provider).toBe("exa");
		expect(getProvider).toHaveBeenCalledTimes(1);
		expect(getProvider).toHaveBeenCalledWith("exa");
		expect(fallbackSearch).not.toHaveBeenCalled();
	});

	it("falls through after the preferred provider fails", async () => {
		const fallbackSearch = vi.fn(
			async (): Promise<SearchResponse> => ({
				provider: "brave",
				sources: [{ title: "Fallback result", url: "https://example.com/fallback" }],
			}),
		);
		const getProvider = mockProviderChain(
			[
				fakeProvider("exa", async () => {
					throw new SearchProviderError("exa", "Preferred provider failed.", 500);
				}),
				fakeProvider("brave", fallbackSearch),
			],
			{ explicitFirst: true },
		);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("test-id", { query: "anything" });

		expect(result.details?.response.provider).toBe("brave");
		expect(getProvider).toHaveBeenCalledTimes(2);
		expect(fallbackSearch).toHaveBeenCalledTimes(1);
	});

	it("does not fall through after an explicitly selected provider fails", async () => {
		const fallbackSearch = vi.fn(
			async (): Promise<SearchResponse> => ({
				provider: "brave",
				sources: [{ title: "Hidden fallback", url: "https://example.com/fallback" }],
			}),
		);
		const getProvider = mockProviderChain(
			[
				fakeProvider("codex", async () => {
					throw new SearchProviderError("codex", "Configured Codex endpoint does not support web_search.", 400);
				}),
				fakeProvider("brave", fallbackSearch),
			],
			{ explicitFirst: true },
		);

		const result = await runSearchQuery({ query: "anything", provider: "codex" }, { authStorage: {} as AuthStorage });

		expect(result.details?.error).toContain("Configured Codex endpoint does not support web_search.");
		expect(result.details?.response.provider).toBe("codex");
		expect(getProvider).toHaveBeenCalledTimes(1);
		expect(fallbackSearch).not.toHaveBeenCalled();
	});
});

describe("classifyProviderHttpError", () => {
	it.each([
		[402, "quota_exhausted", "sensitive payment response", "parallel: 402 credits exhausted"],
		[429, "quota_exhausted", "quota exceeded: secret account payload", "parallel: 429 credits exhausted"],
		[401, "auth_failed", "sensitive authentication response", "parallel: 401 unauthorized"],
		[403, "auth_failed", "sensitive authentication response", "parallel: 403 forbidden"],
	] as const)("classifies HTTP %d as %s without retaining the upstream body", (status, category, body, message) => {
		const error = classifyProviderHttpError("parallel", status, body);

		expect(error).toMatchObject({ provider: "parallel", status, category, message });
		expect(error?.message).not.toContain(body);
	});
});
