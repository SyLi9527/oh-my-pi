import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { formatAge } from "@oh-my-pi/pi-utils/format";
import type { ModelRegistry } from "../../config/model-registry";
import webSearchSystemPrompt from "../../prompts/system/web-search.md" with { type: "text" };
import { throwIfAborted } from "../../tools/tool-errors";
import type { SearchProvider } from "./providers/base";
import { applyQueryConstraints, parseSearchQuery } from "./query";
import type { SearchFailureAttempt, SearchProviderId, SearchRenderDetails, SearchResponse } from "./types";
import { SearchProviderError } from "./types";

export interface SearchQueryParams {
	query: string;
	recency?: "day" | "week" | "month" | "year";
	limit?: number;
	max_tokens?: number;
	temperature?: number;
	num_search_results?: number;
	provider?: SearchProviderId | "auto";
}

export interface SearchProviderCandidate {
	id: SearchProviderId;
	explicit: boolean;
}

export interface SearchProviderRuntime {
	getSearchProvider(id: SearchProviderId): Promise<SearchProvider>;
	getSearchProviderLabel(id: SearchProviderId): string;
	resolveProviderCandidates(): SearchProviderCandidate[];
	formatSearchProviderFailure(error: unknown, provider: Pick<SearchProvider, "id" | "label">): string;
	formatSearchProviderFailures(
		failures: readonly { provider: Pick<SearchProvider, "id" | "label">; error: unknown }[],
	): string;
}

export type ProviderTimeoutPolicy = number | ((providerId: SearchProviderId) => number | undefined);

export interface ExecuteSearchQueryOptions {
	authStorage: AuthStorage;
	modelRegistry?: ModelRegistry;
	sessionId?: string;
	signal?: AbortSignal;
	providerTimeoutMs?: ProviderTimeoutPolicy;
	requireHttpSources?: boolean;
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
	geminiModel?: string;
}

function truncateText(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatCount(label: string, count: number): string {
	return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function formatForLLM(response: SearchResponse, notes: readonly string[] = []): string {
	const parts: string[] = [];
	for (const note of notes) parts.push(`Note: ${note}`);

	if (response.answer) {
		parts.push(response.answer);
		if (response.sources.length > 0) {
			parts.push("\n## Sources");
			parts.push(formatCount("source", response.sources.length));
		}
	}

	for (const [i, source] of response.sources.entries()) {
		const age = formatAge(source.ageSeconds) || source.publishedDate;
		parts.push(`[${i + 1}] ${source.title}${age ? ` (${age})` : ""}\n    ${source.url}`);
		if (source.snippet) parts.push(`    ${truncateText(source.snippet, 240)}`);
	}

	if (response.citations && response.citations.length > 0) {
		parts.push("\n## Citations");
		parts.push(formatCount("citation", response.citations.length));
		for (const [i, citation] of response.citations.entries()) {
			parts.push(`[${i + 1}] ${citation.title || citation.url}\n    ${citation.url}`);
			if (citation.citedText) parts.push(`    ${truncateText(citation.citedText, 240)}`);
		}
	}

	if (response.relatedQuestions && response.relatedQuestions.length > 0) {
		parts.push("\n## Related");
		parts.push(formatCount("question", response.relatedQuestions.length));
		for (const question of response.relatedQuestions) parts.push(`- ${question}`);
	}

	if (response.searchQueries && response.searchQueries.length > 0) {
		parts.push(`Search queries: ${response.searchQueries.length}`);
		for (const query of response.searchQueries.slice(0, 3)) parts.push(`- ${truncateText(query, 120)}`);
	}

	return parts.join("\n");
}

function hasRenderableSearchContent(response: SearchResponse): boolean {
	if (response.answer?.trim()) return true;
	if (response.sources.length > 0) return true;
	if (response.citations?.length) return true;
	if (response.relatedQuestions?.some(question => question.trim())) return true;
	if (response.searchQueries?.some(query => query.trim())) return true;
	return false;
}

function isHttpSourceUrl(url: string): boolean {
	try {
		const protocol = new URL(url).protocol;
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

function failureMessage(category: SearchFailureAttempt["category"]): string {
	switch (category) {
		case "not_configured":
			return "No web search provider configured.";
		case "auth_failed":
			return "provider authentication failed";
		case "quota_exhausted":
			return "provider quota exhausted";
		case "rate_limited":
			return "provider rate limited";
		case "timeout":
			return "provider attempt timed out";
		case "empty_result":
			return "provider returned an empty result";
		case "malformed_response":
			return "provider returned a malformed response";
		case "provider_unavailable":
			return "provider unavailable";
		case "budget_exhausted":
			return "provider skipped because the shared search budget was exhausted";
	}
}

function classifyFailure(
	provider: SearchProviderId | "none",
	error: unknown,
	attemptTimedOut = false,
): SearchFailureAttempt {
	if (attemptTimedOut || (error instanceof Error && error.name === "TimeoutError")) {
		return { provider, category: "timeout", message: failureMessage("timeout") };
	}
	if (error instanceof SearchProviderError) {
		const category =
			error.category ??
			(error.status === 401 || error.status === 403
				? "auth_failed"
				: error.status === 402
					? "quota_exhausted"
					: error.status === 429
						? "rate_limited"
						: error.status === 204
							? "empty_result"
							: "provider_unavailable");
		return {
			provider,
			category,
			message: failureMessage(category),
			...(error.status === undefined ? {} : { status: error.status }),
		};
	}
	return { provider, category: "provider_unavailable", message: failureMessage("provider_unavailable") };
}

export async function executeSearchQuery(
	params: SearchQueryParams,
	options: ExecuteSearchQueryOptions,
	runtime: SearchProviderRuntime,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const { authStorage, modelRegistry, sessionId, signal, providerTimeoutMs, requireHttpSources } = options;
	const explicitProvider = params.provider;
	const candidates =
		explicitProvider && explicitProvider !== "auto"
			? [{ id: explicitProvider, explicit: true }]
			: runtime.resolveProviderCandidates();
	const parsedQuery = parseSearchQuery(params.query);
	const failures: Array<{
		provider: Pick<SearchProvider, "id" | "label">;
		error: unknown;
		attempt: SearchFailureAttempt;
	}> = [];
	let availableProviderCount = 0;
	let lastProvider: Pick<SearchProvider, "id" | "label"> | undefined;

	for (const candidate of candidates) {
		let provider: SearchProvider | undefined;
		let attemptSignal: AbortSignal | undefined;
		const providerMeta = { id: candidate.id, label: runtime.getSearchProviderLabel(candidate.id) };
		lastProvider = providerMeta;
		const attemptTimeoutMs =
			typeof providerTimeoutMs === "function" ? providerTimeoutMs(candidate.id) : providerTimeoutMs;
		if (attemptTimeoutMs !== undefined && attemptTimeoutMs <= 0) {
			const error = new SearchProviderError(
				candidate.id,
				failureMessage("budget_exhausted"),
				undefined,
				"budget_exhausted",
			);
			failures.push({
				provider: providerMeta,
				error,
				attempt: classifyFailure(candidate.id, error),
			});
			continue;
		}
		try {
			provider = await runtime.getSearchProvider(candidate.id);
			const available = candidate.explicit
				? await provider.isExplicitlyAvailable(authStorage)
				: await provider.isAvailable(authStorage);
			if (!available && !candidate.explicit) continue;
			if (!available) {
				throw new SearchProviderError(
					provider.id,
					`${provider.label} web search is unavailable. Configure its credentials or select the automatic provider chain.`,
				);
			}
			availableProviderCount++;
			lastProvider = provider;
			attemptSignal =
				attemptTimeoutMs === undefined
					? signal
					: signal
						? AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)])
						: AbortSignal.timeout(attemptTimeoutMs);

			const response = await provider.search({
				query: params.query,
				parsedQuery,
				limit: params.limit,
				recency: params.recency,
				systemPrompt: webSearchSystemPrompt,
				maxOutputTokens: params.max_tokens,
				numSearchResults: params.num_search_results,
				temperature: params.temperature,
				signal: attemptSignal,
				authStorage,
				modelRegistry,
				sessionId,
				antigravityEndpointMode: options.antigravityEndpointMode,
				geminiModel: options.geminiModel,
			});

			let finalResponse = response;
			const constraintNotes: string[] = [];
			if (parsedQuery.hasConstraints && response.sources.length > 0) {
				const filtered = applyQueryConstraints(response.sources, parsedQuery);
				if (filtered.sources.length !== response.sources.length) {
					finalResponse = { ...response, sources: filtered.sources };
				}
				for (const label of filtered.dropped) {
					constraintNotes.push(`no results matched \`${label}\`; the constraint was relaxed`);
				}
			}
			if (requireHttpSources) {
				const sources = finalResponse.sources.filter(source => isHttpSourceUrl(source.url));
				if (sources.length !== finalResponse.sources.length) {
					finalResponse = { ...finalResponse, sources };
				}
				if (sources.length === 0) {
					throw new SearchProviderError(
						provider.id,
						`${provider.label} returned no HTTP(S) search sources.`,
						204,
						"empty_result",
					);
				}
			}

			if (!hasRenderableSearchContent(finalResponse)) {
				throw new SearchProviderError(provider.id, `${provider.label} returned no renderable search content.`, 204);
			}

			return {
				content: [{ type: "text", text: formatForLLM(finalResponse, constraintNotes) }],
				details: {
					response: finalResponse,
					...(failures.length === 0 ? {} : { failures: failures.map(failure => failure.attempt) }),
				},
			};
		} catch (error) {
			throwIfAborted(signal);
			const failedProvider = provider ?? providerMeta;
			failures.push({
				provider: failedProvider,
				error,
				attempt: classifyFailure(
					failedProvider.id,
					error,
					attemptTimeoutMs !== undefined && attemptSignal?.aborted === true,
				),
			});
		}
	}

	if (availableProviderCount === 0 && failures.length === 0) {
		const message = "No web search provider configured.";
		return {
			content: [{ type: "text", text: `Error: ${message}` }],
			details: {
				response: { provider: "none", sources: [] },
				error: message,
				failures: [{ provider: "none", category: "not_configured", message }],
			},
		};
	}

	const lastFailure = failures.at(-1);
	const baseMessage = lastFailure
		? runtime.formatSearchProviderFailure(lastFailure.error, lastFailure.provider)
		: `Unknown error from ${lastProvider?.label ?? "web search provider"}`;
	const message =
		failures.length > 1
			? `All web search providers failed: ${runtime.formatSearchProviderFailures(failures)}`
			: baseMessage;
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		details: {
			response: { provider: lastFailure?.provider.id ?? lastProvider?.id ?? "none", sources: [] },
			error: message,
			failures: failures.map(failure => failure.attempt),
		},
	};
}
