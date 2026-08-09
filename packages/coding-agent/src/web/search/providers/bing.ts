import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { parseHTML } from "linkedom";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { fetchPublicSearchPage } from "./public-http";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const BING_HOME_URL = "https://www.bing.com/";
const BING_SEARCH_URL = "https://www.bing.com/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;
const MS_PER_DAY = 86_400_000;

const RECENCY_TO_BING_EZ: Record<Exclude<NonNullable<SearchParams["recency"]>, "year">, string> = {
	day: "ez1",
	week: "ez2",
	month: "ez3",
};

const BING_SNIPPET_SELECTORS: readonly string[] = [".b_caption p", "p[class*='b_lineclamp']", ".b_algoSlug"];

interface ParsedResult {
	title: string;
	url: string;
	snippet?: string;
}

function recencyToFilters(recency: NonNullable<SearchParams["recency"]>): string {
	if (recency === "year") {
		const epochDay = Math.floor(Date.now() / MS_PER_DAY);
		return `ex1:"ez5_${epochDay - 365}_${epochDay}"`;
	}
	return `ex1:"${RECENCY_TO_BING_EZ[recency]}"`;
}

function unwrapResultUrl(href: string): string | undefined {
	let url: URL;
	try {
		url = new URL(href, BING_HOME_URL);
	} catch {
		return undefined;
	}

	if (url.hostname === "bing.com" || url.hostname.endsWith(".bing.com")) {
		if (url.pathname !== "/ck/a") return undefined;
		const wrapped = url.searchParams.get("u");
		if (!wrapped?.startsWith("a1")) return undefined;
		try {
			url = new URL(Buffer.from(wrapped.slice(2), "base64url").toString("utf-8"));
		} catch {
			return undefined;
		}
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	return url.href;
}

function findSnippet(item: Element): string | undefined {
	for (const selector of BING_SNIPPET_SELECTORS) {
		const text = (item.querySelector(selector)?.textContent ?? "").replace(/\s+/g, " ").trim();
		if (text) return text;
	}
	return undefined;
}

function parseHtmlResults(html: string): ParsedResult[] {
	const { document } = parseHTML(html);
	const results: ParsedResult[] = [];
	for (const item of document.querySelectorAll("li.b_algo")) {
		const anchor = item.querySelector("h2 a[href]");
		const href = anchor?.getAttribute("href");
		if (!href) continue;
		const url = unwrapResultUrl(href);
		if (!url) continue;
		const title = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
		if (!title) continue;
		results.push({ title, url, snippet: findSnippet(item) });
	}
	return results;
}

function isChallengeResponse(html: string, finalUrl: string): boolean {
	if (finalUrl.includes("/turing/captcha")) return true;
	if (html.includes('class="b_algo"')) return false;
	return /turing\/captcha|b_captcha|px-captcha|verify (?:that )?you are (?:a )?human/i.test(html);
}

function buildSearchUrl(params: SearchParams, numResults: number): string {
	const url = new URL(BING_SEARCH_URL);
	url.searchParams.set("q", params.query);
	url.searchParams.set("count", String(numResults));
	url.searchParams.set("mkt", "en-US");
	url.searchParams.set("setlang", "en");
	if (params.recency) url.searchParams.set("filters", recencyToFilters(params.recency));
	return url.href;
}

async function callBingHtml(params: SearchParams, numResults: number): Promise<string> {
	const url = buildSearchUrl(params, numResults);
	const page = await fetchPublicSearchPage(url, {
		fetch: params.fetch,
		signal: withHardTimeout(params.signal),
		referer: BING_HOME_URL,
	});

	if (isChallengeResponse(page.html, page.url)) {
		throw new SearchProviderError("bing", "Bing returned a bot-detection challenge.", 429, "rate_limited");
	}
	if (page.status < 200 || page.status >= 300) {
		const classified = classifyProviderHttpError("bing", page.status, page.html);
		if (classified) throw classified;
		throw new SearchProviderError("bing", `Bing HTML error (${page.status})`, page.status);
	}

	return page.html;
}

/** Execute a Bing web search through its server-rendered HTML result page. */
export async function searchBing(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const parsed = parseHtmlResults(await callBingHtml(params, numResults));
	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	for (const result of parsed) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		sources.push({ title: result.title, url: result.url, snippet: result.snippet });
		if (sources.length >= numResults) break;
	}
	return { provider: "bing", sources };
}

/** Explicit-only Bing provider for the full OMP runtime. */
export class BingProvider extends SearchProvider {
	readonly id = "bing";
	readonly label = "Bing";

	isAvailable(_authStorage: AuthStorage): boolean {
		return false;
	}

	isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchBing(params);
	}
}
