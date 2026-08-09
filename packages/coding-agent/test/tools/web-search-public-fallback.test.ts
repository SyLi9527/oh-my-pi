import { describe, expect, it } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchBing } from "@oh-my-pi/pi-coding-agent/web/search/providers/bing";
import { searchDuckDuckGo } from "@oh-my-pi/pi-coding-agent/web/search/providers/duckduckgo";

const noAuthStorage = {
	hasAuth() {
		throw new Error("credential-free providers must not inspect auth");
	},
	getApiKey() {
		throw new Error("credential-free providers must not read keys");
	},
	resolver() {
		throw new Error("credential-free providers must not resolve keys");
	},
} as unknown as AuthStorage;

function params(fetch: FetchImpl): SearchParams {
	return {
		query: "runtime search",
		systemPrompt: "",
		authStorage: noAuthStorage,
		fetch,
	};
}

function duckDuckGoResult(url: string, title: string, snippet: string): string {
	return `<div class="result results_links web-result">
		<a class="result__a" href="${url}">${title}</a>
		<a class="result__snippet">${snippet}</a>
	</div>`;
}

describe("credential-free public search providers", () => {
	it("uses a transparent fixed HTTP request for DuckDuckGo and parses organic results", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const response = await searchDuckDuckGo(
			params(async (input, init) => {
				calls.push({ url: input.toString(), init });
				return new Response(
					duckDuckGoResult(
						"//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fddg-source",
						"Duck result",
						"Duck snippet",
					),
					{ status: 200 },
				);
			}),
		);

		expect(response).toEqual({
			provider: "duckduckgo",
			sources: [{ title: "Duck result", url: "https://example.com/ddg-source", snippet: "Duck snippet" }],
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://html.duckduckgo.com/html/");
		expect(new Headers(calls[0]?.init?.headers).get("user-agent")).toBe("ResearchBuddy-Search/1.0");
		expect(calls[0]?.init?.method).toBe("POST");
	});

	it("parses Bing organic results and unwraps redirect URLs", async () => {
		const target = "https://example.com/bing-source";
		const wrapped = Buffer.from(target).toString("base64url");
		const response = await searchBing(
			params(async input => {
				const url = new URL(input.toString());
				expect(url.origin + url.pathname).toBe("https://www.bing.com/search");
				expect(url.searchParams.get("q")).toBe("runtime search");
				return new Response(
					`<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1${wrapped}">Result</a></h2><div class="b_caption"><p>Snippet</p></div></li>`,
					{ status: 200 },
				);
			}),
		);

		expect(response).toEqual({
			provider: "bing",
			sources: [{ title: "Result", url: target, snippet: "Snippet" }],
		});
	});

	it.each([
		["duckduckgo", '<div class="anomaly-modal"></div>'],
		["bing", '<div id="b_captcha">Verify you are human</div>'],
	] as const)("classifies a %s challenge without exposing its body", async (provider, body) => {
		const result = (
			provider === "duckduckgo"
				? searchDuckDuckGo(params(async () => new Response(body, { status: 200 })))
				: searchBing(params(async () => new Response(body, { status: 200 })))
		).catch(value => value);
		const error = await result;

		expect(error).toMatchObject({ status: 429, category: "rate_limited" });
		expect(String(error)).not.toContain(body);
	});

	it("returns an empty bounded Bing response when organic results are absent", async () => {
		const response = await searchBing(params(async () => new Response("<main>No matches</main>", { status: 200 })));

		expect(response).toEqual({ provider: "bing", sources: [] });
	});
});
