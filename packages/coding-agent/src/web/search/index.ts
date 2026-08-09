/**
 * Unified Web Search Tool
 *
 * Single tool supporting Anthropic, Perplexity, Exa, Brave, Jina, Kimi, Gemini, Codex, Tavily, Kagi, Z.AI, SearXNG, and Synthetic
 * providers with provider-specific parameters exposed conditionally.
 */
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { type } from "arktype";
import { ModelRegistry } from "../../config/model-registry";
import { settings } from "../../config/settings";
import type { CustomTool, CustomToolContext, RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../modes/theme/theme";
import webSearchDescription from "../../prompts/tools/web-search.md" with { type: "text" };
import { discoverAuthStorage } from "../../sdk";
import type { ToolSession } from "../../tools";
import {
	formatSearchProviderFailure,
	formatSearchProviderFailures,
	getSearchProvider,
	getSearchProviderLabel,
	resolveProviderCandidates,
} from "./provider";
import { renderSearchCall, renderSearchResult, type SearchRenderDetails } from "./render";
import { type ExecuteSearchQueryOptions, executeSearchQuery, type ProviderTimeoutPolicy } from "./runtime-core";
import type { SearchProviderId } from "./types";

/** Web search tool parameters schema */
export const webSearchSchema = type({
	query: "string",
	recency: "'day' | 'week' | 'month' | 'year'?",
	limit: "number?",
	max_tokens: "number?",
	temperature: "number?",
	num_search_results: "number?",
});

export type SearchToolParams = typeof webSearchSchema.infer;

export interface SearchQueryParams extends SearchToolParams {
	provider?: SearchProviderId | "auto";
}

/** Execute web search */
async function executeSearch(
	_toolCallId: string,
	params: SearchQueryParams,
	options: ExecuteSearchQueryOptions,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	// Invariant across providers; read once and tolerate an uninitialized
	// Settings singleton (e.g. `omp q ...` CLI path, unit tests) so the
	// provider-fallback loop never aborts before any provider runs.
	let antigravityEndpointMode: "auto" | "production" | "sandbox" | undefined;
	try {
		antigravityEndpointMode = settings.get("providers.antigravityEndpoint");
	} catch {
		antigravityEndpointMode = undefined;
	}

	let geminiModel: string | undefined;
	try {
		geminiModel = settings.get("providers.webSearchGeminiModel");
	} catch {
		geminiModel = undefined;
	}

	return executeSearchQuery(
		params,
		{ ...options, antigravityEndpointMode, geminiModel },
		{
			getSearchProvider: id => getSearchProvider(id),
			getSearchProviderLabel: id => getSearchProviderLabel(id),
			resolveProviderCandidates: () => resolveProviderCandidates(),
			formatSearchProviderFailure: (error, provider) => formatSearchProviderFailure(error, provider),
			formatSearchProviderFailures: failures => formatSearchProviderFailures(failures),
		},
	);
}

/**
 * Execute a web search query for CLI/testing workflows.
 *
 * `authStorage` may be omitted; in that case we discover one via the standard
 * factory (`discoverAuthStorage`), which honours `OMP_AUTH_BROKER_URL` and
 * otherwise opens the local SQLite credential store.
 */
export async function runSearchQuery(
	params: SearchQueryParams,
	options: {
		authStorage?: AuthStorage;
		modelRegistry?: ModelRegistry;
		sessionId?: string;
		signal?: AbortSignal;
		providerTimeoutMs?: ProviderTimeoutPolicy;
		requireHttpSources?: boolean;
	} = {},
): Promise<{ content: Array<{ type: "text"; text: string }>; details: SearchRenderDetails }> {
	const createdAuthStorage = options.authStorage || options.modelRegistry ? undefined : await discoverAuthStorage();
	const authStorage = options.authStorage ?? options.modelRegistry?.authStorage ?? createdAuthStorage;
	if (!authStorage) {
		throw new Error("Failed to initialize authentication storage");
	}
	const modelRegistry = options.modelRegistry ?? (createdAuthStorage ? new ModelRegistry(authStorage) : undefined);
	try {
		return await executeSearch("cli-web-search", params, {
			authStorage,
			modelRegistry,
			sessionId: options.sessionId,
			signal: options.signal,
			providerTimeoutMs: options.providerTimeoutMs,
			requireHttpSources: options.requireHttpSources,
		});
	} finally {
		createdAuthStorage?.close();
	}
}

/**
 * Web search tool implementation.
 *
 * Supports the configured web-search provider chain with automatic fallback.
 */
export class WebSearchTool implements AgentTool<typeof webSearchSchema, SearchRenderDetails> {
	readonly name = "web_search";
	readonly approval = "read" as const;
	readonly label = "Web Search";
	readonly description: string;
	readonly parameters = webSearchSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly summary = "Search the web for up-to-date information";

	#session: ToolSession;

	constructor(session: ToolSession) {
		this.#session = session;
		this.description = prompt.render(webSearchDescription);
	}

	async execute(
		_toolCallId: string,
		params: SearchToolParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<SearchRenderDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<SearchRenderDetails>> {
		const authStorage = this.#session.authStorage ?? (await discoverAuthStorage());
		const sessionId = this.#session.getSessionId?.() ?? undefined;
		return executeSearch(_toolCallId, params, {
			authStorage,
			modelRegistry: this.#session.modelRegistry,
			sessionId,
			signal,
		});
	}
}

/** Web search tool as CustomTool (for TUI rendering support) */
export const webSearchCustomTool: CustomTool<typeof webSearchSchema, SearchRenderDetails> = {
	name: "web_search",
	label: "Web Search",
	description: prompt.render(webSearchDescription),
	parameters: webSearchSchema,

	approval: "read",
	async execute(
		toolCallId: string,
		params: SearchToolParams,
		_onUpdate,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	) {
		const authStorage = ctx.modelRegistry?.authStorage ?? (await discoverAuthStorage());
		const sessionId = ctx.sessionManager.getSessionId();
		return executeSearch(toolCallId, params, {
			authStorage,
			modelRegistry: ctx.modelRegistry,
			sessionId,
			signal,
		});
	},

	renderCall(args: SearchToolParams, options: RenderResultOptions, theme: Theme) {
		return renderSearchCall(args, options, theme);
	},

	renderResult(result, options: RenderResultOptions, theme: Theme, args) {
		return renderSearchResult(result, options, theme, args);
	},
};

export function getSearchTools(): CustomTool<any, any>[] {
	return [webSearchCustomTool];
}

export { getSearchProvider, setExcludedSearchProviders, setSearchProviderOrder } from "./provider";
export type { SearchProviderId as SearchProvider, SearchResponse } from "./types";
export { isSearchProviderId, isSearchProviderPreference } from "./types";
