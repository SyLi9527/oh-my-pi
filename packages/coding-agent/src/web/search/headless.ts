import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { ModelRegistry } from "../../config/model-registry";
import type { SearchProvider } from "./providers/base";
import { BingProvider } from "./providers/bing";
import { BraveProvider } from "./providers/brave";
import { DuckDuckGoProvider } from "./providers/duckduckgo";
import { HeadlessExaProvider } from "./providers/exa-headless";
import { FirecrawlProvider } from "./providers/firecrawl";
import { ParallelProvider } from "./providers/parallel";
import { TavilyProvider } from "./providers/tavily";
import { ZhipuProvider } from "./providers/zhipu";
import {
	executeSearchQuery,
	type ProviderTimeoutPolicy,
	type SearchProviderCandidate,
	type SearchProviderRuntime,
	type SearchQueryParams,
} from "./runtime-core";
import { SEARCH_PROVIDER_LABELS, SearchProviderError, type SearchProviderId } from "./types";

export const SEARCH_PROVIDER_ORDER = [
	"parallel",
	"brave",
	"exa",
	"zhipu",
	"tavily",
	"firecrawl",
	"duckduckgo",
	"bing",
] as const;
type HeadlessSearchProviderId = (typeof SEARCH_PROVIDER_ORDER)[number];

const isHeadlessProvider = (id: SearchProviderId): id is HeadlessSearchProviderId =>
	SEARCH_PROVIDER_ORDER.includes(id as HeadlessSearchProviderId);

const providerFactories: Record<HeadlessSearchProviderId, () => SearchProvider> = {
	parallel: () => new ParallelProvider(),
	brave: () => new BraveProvider(),
	exa: () => new HeadlessExaProvider(),
	zhipu: () => new ZhipuProvider(),
	tavily: () => new TavilyProvider(),
	firecrawl: () => new FirecrawlProvider(),
	duckduckgo: () => new DuckDuckGoProvider(),
	bing: () => new BingProvider(),
};
const providerInstances = new Map<HeadlessSearchProviderId, SearchProvider>();
let orderedProviders: readonly HeadlessSearchProviderId[] = SEARCH_PROVIDER_ORDER;
let explicitProviders = new Set<HeadlessSearchProviderId>();
let excludedProviders = new Set<HeadlessSearchProviderId>();

export function setSearchProviderOrder(providers: readonly SearchProviderId[]): void {
	const prioritized = new Set(providers.filter(isHeadlessProvider));
	explicitProviders = prioritized;
	orderedProviders =
		prioritized.size === 0
			? SEARCH_PROVIDER_ORDER
			: [...prioritized, ...SEARCH_PROVIDER_ORDER.filter(id => !prioritized.has(id))];
}

export function setExcludedSearchProviders(providers: readonly SearchProviderId[]): void {
	excludedProviders = new Set(providers.filter(isHeadlessProvider));
}

function resolveProviderCandidates(): SearchProviderCandidate[] {
	return orderedProviders.flatMap(id =>
		excludedProviders.has(id) ? [] : [{ id, explicit: explicitProviders.has(id) }],
	);
}

async function getSearchProvider(id: SearchProviderId): Promise<SearchProvider> {
	if (!isHeadlessProvider(id)) throw new Error(`Unsupported headless search provider: ${id}`);
	const cached = providerInstances.get(id);
	if (cached) return cached;
	const loaded = providerFactories[id]();
	providerInstances.set(id, loaded);
	return loaded;
}

function formatSearchProviderFailure(error: unknown, provider: Pick<SearchProvider, "id" | "label">): string {
	if (error instanceof SearchProviderError) {
		if (error.status === 401 || error.status === 403) {
			return `${SEARCH_PROVIDER_LABELS[error.provider]} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

const runtime: SearchProviderRuntime = {
	getSearchProvider,
	getSearchProviderLabel: id => SEARCH_PROVIDER_LABELS[id] ?? id,
	resolveProviderCandidates,
	formatSearchProviderFailure,
	formatSearchProviderFailures: failures =>
		failures
			.map(failure => `${failure.provider.id}: ${formatSearchProviderFailure(failure.error, failure.provider)}`)
			.join("; "),
};

export function runSearchQuery(
	params: SearchQueryParams,
	options: {
		authStorage: AuthStorage;
		modelRegistry?: ModelRegistry;
		sessionId?: string;
		signal?: AbortSignal;
		providerTimeoutMs?: ProviderTimeoutPolicy;
		requireHttpSources?: boolean;
	},
) {
	return executeSearchQuery(params, options, runtime);
}
