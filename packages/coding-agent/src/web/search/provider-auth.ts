export interface ApiKeyResolveContext {
	lastChance: boolean;
	error: unknown;
	previousKey?: string;
	signal?: AbortSignal;
}

export type ApiKeyResolver = (context: ApiKeyResolveContext) => Promise<string | undefined> | string | undefined;

export type ApiKey = string | ApiKeyResolver;

const statusOf = (error: unknown): number | undefined => {
	if (typeof error === "object" && error !== null) {
		for (const field of ["status", "statusCode"] as const) {
			const value = (error as Record<string, unknown>)[field];
			if (typeof value === "number") return value;
		}
	}
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const matched = message.match(/(?:^|\D)(401|402|403|429)(?:\D|$)/);
	return matched ? Number(matched[1]) : undefined;
};

const isAuthRetryable = (error: unknown): boolean => {
	const status = statusOf(error);
	return status === 401 || status === 402 || status === 403 || status === 429;
};

const AUTH_RETRY_MAX_ATTEMPTS = 64;

const isDirectCredentialRotationError = (error: unknown): boolean => {
	const status = statusOf(error);
	return status === 402 || status === 403 || status === 429;
};

interface AuthRetryState {
	attemptedKeys: Set<string>;
	lastKey: string;
	refreshedCurrent: boolean;
	legacyAuthSwitchUsed: boolean;
	attempts: number;
}

const resolveRetryKey = async (
	resolver: ApiKeyResolver,
	lastChance: boolean,
	error: unknown,
	signal: AbortSignal | undefined,
	previousKey?: string,
): Promise<string | undefined> => {
	try {
		const rotateSibling = lastChance || (!lastChance && isDirectCredentialRotationError(error));
		return (await resolver({ lastChance: rotateSibling, error, previousKey, signal })) || undefined;
	} catch {
		return undefined;
	}
};

const acceptRetryKey = (state: AuthRetryState, key: string, refreshedCurrent: boolean): string | undefined => {
	if (state.attemptedKeys.has(key) || state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	state.attemptedKeys.add(key);
	state.attempts++;
	state.lastKey = key;
	state.refreshedCurrent = refreshedCurrent;
	return key;
};

const resolveNextAuthRetryKey = async (
	state: AuthRetryState,
	resolver: ApiKeyResolver,
	error: unknown,
	signal?: AbortSignal,
): Promise<string | undefined> => {
	if (signal?.aborted || state.attempts >= AUTH_RETRY_MAX_ATTEMPTS) return undefined;
	const directRotation = isDirectCredentialRotationError(error);
	if (!directRotation) {
		if (state.legacyAuthSwitchUsed) return undefined;
		if (!state.refreshedCurrent) {
			const refreshed = await resolveRetryKey(resolver, false, error, signal, state.lastKey);
			state.refreshedCurrent = true;
			if (signal?.aborted) return undefined;
			if (refreshed !== undefined) {
				const accepted = acceptRetryKey(state, refreshed, true);
				if (accepted !== undefined) return accepted;
			}
		}
	}

	if (signal?.aborted) return undefined;
	const rotated = await resolveRetryKey(resolver, true, error, signal, state.lastKey);
	if (signal?.aborted || rotated === undefined) return undefined;
	const accepted = acceptRetryKey(state, rotated, !directRotation);
	if (accepted !== undefined && !directRotation) state.legacyAuthSwitchUsed = true;
	return accepted;
};

export async function resolveApiKeyOnce(key: ApiKey | undefined, signal?: AbortSignal): Promise<string | undefined> {
	if (key === undefined) return undefined;
	if (typeof key !== "function") return key;
	return (await key({ lastChance: false, error: undefined, signal })) || undefined;
}

export function seedApiKeyResolver(seed: string | undefined, resolver: ApiKeyResolver): ApiKeyResolver {
	let seedPending = seed !== undefined;
	return context => {
		if (seedPending && context.error === undefined) {
			seedPending = false;
			return seed;
		}
		return resolver(context);
	};
}

export async function withAuth<T>(
	key: ApiKey | undefined,
	attempt: (key: string) => Promise<T>,
	options?: {
		isAuthError?: (error: unknown) => boolean;
		signal?: AbortSignal;
		missingKeyMessage?: string;
	},
): Promise<T> {
	const missingKey = () => new Error(options?.missingKeyMessage ?? "Missing API key");
	if (typeof key !== "function") {
		if (key === undefined) throw missingKey();
		return attempt(key);
	}

	const resolver = key;
	const initialKey = await resolveRetryKey(resolver, false, undefined, options?.signal);
	if (initialKey === undefined) throw missingKey();
	const state: AuthRetryState = {
		attemptedKeys: new Set([initialKey]),
		lastKey: initialKey,
		refreshedCurrent: false,
		legacyAuthSwitchUsed: false,
		attempts: 1,
	};
	let lastError: unknown;
	let currentKey = initialKey;
	while (true) {
		try {
			return await attempt(currentKey);
		} catch (error) {
			if (!(options?.isAuthError ?? isAuthRetryable)(error)) throw error;
			lastError = error;
		}
		const nextKey = await resolveNextAuthRetryKey(state, resolver, lastError, options?.signal);
		if (nextKey === undefined) break;
		currentKey = nextKey;
	}

	throw lastError;
}
