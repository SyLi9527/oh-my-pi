import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

export interface LoadedPublicSearchPage {
	html: string;
	status: number;
	url: string;
}

export interface PublicSearchFetchOptions {
	fetch?: FetchImpl;
	signal: AbortSignal;
	referer?: string;
	init?: Omit<RequestInit, "headers" | "signal">;
	headers?: Readonly<Record<string, string>>;
}

const PUBLIC_SEARCH_HEADERS = {
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.8",
	"User-Agent": "ResearchBuddy-Search/1.0",
} as const;

/** Fetch a public HTML result page without browser automation or fingerprint spoofing. */
export async function fetchPublicSearchPage(
	url: string,
	options: PublicSearchFetchOptions,
): Promise<LoadedPublicSearchPage> {
	const response = await (options.fetch ?? fetch)(url, {
		...options.init,
		headers: {
			...PUBLIC_SEARCH_HEADERS,
			...(options.referer === undefined ? {} : { Referer: options.referer }),
			...options.headers,
		},
		signal: options.signal,
	});
	return {
		html: await response.text(),
		status: response.status,
		url: response.url || url,
	};
}
