/**
 * Brave Web Search Provider
 *
 * Calls Brave's web search REST API and maps results into the unified
 * SearchResponse shape used by the web search tool.
 */

import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { withAuth } from "../provider-auth";
import type { QuerySyntax, StructuredQuery } from "../query";
import { formatQuery, GOOGLE_QUERY_SYNTAX, parseSearchQuery } from "../query";
import { clampNumResults, dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, getSearchProviderEnvApiKey, withHardTimeout } from "./utils";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 20;

const RECENCY_MAP: Record<"day" | "week" | "month" | "year", "pd" | "pw" | "pm" | "py"> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

/**
 * Brave parses the classic operator set inline (site:, quotes, -, OR…) but
 * date bounds map onto the native `freshness` param, so `before:`/`after:`
 * tokens are stripped from the rebuilt query string.
 */
const BRAVE_QUERY_SYNTAX: QuerySyntax = { ...GOOGLE_QUERY_SYNTAX, dateRange: false };

/**
 * Freshness param: explicit `after:`/`before:` bounds win over the
 * recency-derived period, rendered as Brave's absolute range
 * `YYYY-MM-DDtoYYYY-MM-DD` with sensible open ends.
 */
function braveFreshness(parsed: StructuredQuery, recency?: keyof typeof RECENCY_MAP): string | undefined {
	if (parsed.after || parsed.before) {
		const start = parsed.after ?? "1970-01-01";
		const end = parsed.before ?? new Date().toISOString().slice(0, 10);
		return `${start}to${end}`;
	}
	return recency ? RECENCY_MAP[recency] : undefined;
}

export interface BraveSearchParams {
	query: string;
	num_results?: number;
	recency?: "day" | "week" | "month" | "year";
	parsedQuery?: StructuredQuery;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

interface BraveSearchResult {
	title?: string | null;
	url?: string | null;
	description?: string | null;
	age?: string | null;
	extra_snippets?: string[] | null;
}

interface BraveSearchResponse {
	web?: {
		results?: BraveSearchResult[];
	};
}

function buildSnippet(result: BraveSearchResult): string | undefined {
	const snippets: string[] = [];

	if (result.description?.trim()) {
		snippets.push(result.description.trim());
	}

	if (Array.isArray(result.extra_snippets)) {
		for (const snippet of result.extra_snippets) {
			if (!snippet?.trim()) continue;
			if (snippets.includes(snippet.trim())) continue;
			snippets.push(snippet.trim());
		}
	}

	return snippets.length > 0 ? snippets.join("\n") : undefined;
}

async function callBraveSearch(
	apiKey: string,
	params: BraveSearchParams,
): Promise<{ response: BraveSearchResponse; requestId?: string }> {
	const numResults = clampNumResults(params.num_results, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const url = new URL(BRAVE_SEARCH_URL);
	url.searchParams.set("q", parsed.hasDirectives ? formatQuery(parsed, BRAVE_QUERY_SYNTAX) : params.query);
	url.searchParams.set("count", String(numResults));
	url.searchParams.set("extra_snippets", "true");
	const freshness = braveFreshness(parsed, params.recency);
	if (freshness) {
		url.searchParams.set("freshness", freshness);
	}

	const fetchImpl = params.fetch ?? fetch;
	const response = await fetchImpl(url, {
		headers: {
			Accept: "application/json",
			"X-Subscription-Token": apiKey,
		},
		signal: withHardTimeout(params.signal),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const classified = classifyProviderHttpError("brave", response.status, errorText);
		if (classified) throw classified;
		throw new SearchProviderError("brave", `Brave API error (${response.status}): ${errorText}`, response.status);
	}

	const data = (await response.json()) as BraveSearchResponse;
	const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
	return { response: data, requestId };
}

function mapBraveResponse(
	result: { response: BraveSearchResponse; requestId?: string },
	numResults: number,
): SearchResponse {
	const { response, requestId } = result;
	const sources: SearchSource[] = [];

	for (const item of response.web?.results ?? []) {
		if (!item.url) continue;
		sources.push({
			title: item.title ?? item.url,
			url: item.url,
			snippet: buildSnippet(item),
			publishedDate: item.age ?? undefined,
			ageSeconds: dateToAgeSeconds(item.age),
		});
	}

	return {
		provider: "brave",
		sources: sources.slice(0, numResults),
		requestId,
	};
}

/** Execute Brave web search through the caller's AuthStorage. */
export async function searchBrave(params: SearchParams): Promise<SearchResponse> {
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const resolver = params.authStorage.resolver("brave", { sessionId: params.sessionId });
	const result = await withAuth(
		resolver,
		key =>
			callBraveSearch(key, {
				query: params.query,
				num_results: params.numSearchResults ?? params.limit,
				recency: params.recency,
				parsedQuery: params.parsedQuery,
				signal: params.signal,
				fetch: params.fetch,
			}),
		{
			signal: params.signal,
			missingKeyMessage: "Brave credentials not found.",
		},
	);
	return mapBraveResponse(result, numResults);
}

/** Search provider for Brave web search. */
export class BraveProvider extends SearchProvider {
	readonly id = "brave";
	readonly label = "Brave";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("brave") || Boolean(getSearchProviderEnvApiKey("brave"));
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchBrave(params);
	}
}
