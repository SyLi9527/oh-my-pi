/** Zhipu's structured web search API provider. */
import { type ApiKey, type AuthStorage, getEnvApiKey, withAuth } from "@oh-my-pi/pi-ai";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { formatQuery, parseSearchQuery } from "../query";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, withHardTimeout } from "./utils";

const ZHIPU_SEARCH_URL = "https://open.bigmodel.cn/api/paas/v4/web_search";
const RECENCY = { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" } as const;

type ZhipuSearchEngine = "search_std" | "search_pro";

function clampCodePoints(value: string, max: number): string {
	return Array.from(value).slice(0, max).join("");
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function malformedResponse(status: number): SearchProviderError {
	return new SearchProviderError(
		"zhipu",
		"Zhipu API returned a malformed search response.",
		status,
		"malformed_response",
	);
}

function toSearchResponse(payload: unknown, status: number, limit: number): SearchResponse {
	const record = asRecord(payload);
	if (!record || !Array.isArray(record.search_result)) throw malformedResponse(status);

	const sources: SearchSource[] = [];
	for (const result of record.search_result) {
		const item = asRecord(result);
		if (!item) continue;
		const url = asNonEmptyString(item.link);
		if (!url) continue;
		sources.push({
			title: asNonEmptyString(item.title) ?? url,
			url,
			snippet: asNonEmptyString(item.content),
			author: asNonEmptyString(item.media),
			publishedDate: asNonEmptyString(item.publish_date),
		});
	}

	return {
		provider: "zhipu",
		sources: sources.slice(0, limit),
		requestId: asNonEmptyString(record.request_id),
		authMode: "api_key",
	};
}

async function requestZhipu(engine: ZhipuSearchEngine, key: string, params: SearchParams): Promise<SearchResponse> {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const cleanQuery = clampCodePoints(formatQuery(parsed, { phrases: true, negation: true }), 70);
	const limit = clampNumResults(params.numSearchResults ?? params.limit, 10, 20);
	const body = {
		search_engine: engine,
		search_query: cleanQuery,
		count: limit,
		content_size: "high",
		...(parsed.sites.length === 1 ? { search_domain_filter: parsed.sites[0]!.split("/", 1)[0] } : {}),
		...(params.recency ? { search_recency_filter: RECENCY[params.recency] } : {}),
	};
	const response = await (params.fetch ?? fetch)(ZHIPU_SEARCH_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${key}`,
		},
		body: JSON.stringify(body),
		signal: withHardTimeout(params.signal),
	});

	if (!response.ok) {
		const classified = classifyProviderHttpError("zhipu", response.status, await response.text());
		if (classified) throw classified;
		throw new SearchProviderError("zhipu", `Zhipu API error (${response.status}).`, response.status);
	}

	try {
		return toSearchResponse(await response.json(), response.status, limit);
	} catch (error) {
		if (error instanceof SearchProviderError) throw error;
		throw malformedResponse(response.status);
	}
}

/** Execute Zhipu structured web search with a single empty-result upgrade. */
export async function searchZhipu(params: SearchParams): Promise<SearchResponse> {
	const resolver: ApiKey = params.authStorage.resolver("zhipu", { sessionId: params.sessionId });
	return withAuth(
		resolver,
		async key => {
			const standard = await requestZhipu("search_std", key, params);
			return standard.sources.length > 0 ? standard : requestZhipu("search_pro", key, params);
		},
		{ signal: params.signal, missingKeyMessage: "Zhipu credentials not found." },
	);
}

/** Search provider for Zhipu structured web search. */
export class ZhipuProvider extends SearchProvider {
	readonly id = "zhipu";
	readonly label = "Zhipu Web Search";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("zhipu") || !!getEnvApiKey("zhipu");
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchZhipu(params);
	}
}
