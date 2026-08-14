import type { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import type { SearchResponse, SearchSource } from "../../../web/search/types";
import { SearchProviderError } from "../../../web/search/types";
import { type ApiKey, withAuth } from "../provider-auth";
import { formatQuery, parseSearchQuery, type StructuredQuery } from "../query";
import { dateToAgeSeconds } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { classifyProviderHttpError, getSearchProviderEnvApiKey, withHardTimeout } from "./utils";

const EXA_API_URL = "https://api.exa.ai/search";

interface ExaSearchResult {
	title?: string | null;
	url?: string | null;
	author?: string | null;
	publishedDate?: string | null;
	text?: string | null;
	highlights?: string[] | null;
	summary?: string | null;
}

interface ExaSearchResponse {
	requestId?: string;
	results?: ExaSearchResult[];
}

const hosts = (sites: readonly string[]): string[] => [
	...new Set(sites.map(site => site.split("/", 1)[0]).filter(Boolean)),
];

const requestParams = (parsed: StructuredQuery, params: SearchParams): Record<string, unknown> => ({
	query: parsed.hasDirectives ? formatQuery(parsed, { phrases: true }) : parsed.raw,
	numResults: params.numSearchResults ?? params.limit ?? 10,
	type: "auto",
	contents: { summary: { query: params.query } },
	...(parsed.sites.length > 0 ? { includeDomains: hosts(parsed.sites) } : {}),
	...(parsed.excludedSites.length > 0 ? { excludeDomains: hosts(parsed.excludedSites) } : {}),
	...(parsed.after ? { startPublishedDate: parsed.after } : {}),
	...(parsed.before ? { endPublishedDate: parsed.before } : {}),
});

const synthesizeAnswer = (results: readonly ExaSearchResult[]): string | undefined => {
	const summaries: string[] = [];
	for (const result of results) {
		if (summaries.length >= 3) break;
		const summary = result.summary?.trim();
		if (!result.url || !summary) continue;
		summaries.push(`**${result.title?.trim() || result.url}**: ${summary}`);
	}
	return summaries.length > 0 ? summaries.join("\n\n") : undefined;
};

const callExa = async (key: string, params: SearchParams): Promise<SearchResponse> => {
	const parsed = params.parsedQuery ?? parseSearchQuery(params.query);
	const response = await (params.fetch ?? fetch)(EXA_API_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": key },
		body: JSON.stringify(requestParams(parsed, params)),
		signal: withHardTimeout(params.signal),
	});
	if (!response.ok) {
		const body = await response.text();
		const classified = classifyProviderHttpError("exa", response.status, body);
		if (classified) throw classified;
		throw new SearchProviderError("exa", `Exa API error (${response.status}): ${body}`, response.status);
	}

	const payload = (await response.json()) as ExaSearchResponse;
	const resultLimit = params.numSearchResults ?? params.limit;
	const sources: SearchSource[] = [];
	for (const result of payload.results ?? []) {
		if (!result.url) continue;
		sources.push({
			title: result.title ?? result.url,
			url: result.url,
			snippet: result.summary || result.text || result.highlights?.join(" ") || undefined,
			publishedDate: result.publishedDate ?? undefined,
			ageSeconds: dateToAgeSeconds(result.publishedDate),
			author: result.author ?? undefined,
		});
	}
	return {
		provider: "exa",
		answer: synthesizeAnswer(payload.results ?? []),
		sources: resultLimit === undefined ? sources : sources.slice(0, resultLimit),
		requestId: payload.requestId,
	};
};

export class HeadlessExaProvider extends SearchProvider {
	readonly id = "exa";
	readonly label = "Exa";

	isAvailable(authStorage: AuthStorage): boolean {
		return authStorage.hasAuth("exa") || !!getSearchProviderEnvApiKey("exa");
	}

	override isExplicitlyAvailable(authStorage: AuthStorage): boolean {
		return this.isAvailable(authStorage);
	}

	async search(params: SearchParams): Promise<SearchResponse> {
		const storedKey = await params.authStorage.getApiKey("exa", params.sessionId, {
			signal: params.signal,
		});
		const key: ApiKey | undefined = storedKey
			? params.authStorage.resolver("exa", { sessionId: params.sessionId })
			: getSearchProviderEnvApiKey("exa");
		return withAuth(key, credential => callExa(credential, params), {
			signal: params.signal,
			missingKeyMessage: "Exa credentials not found.",
		});
	}
}
