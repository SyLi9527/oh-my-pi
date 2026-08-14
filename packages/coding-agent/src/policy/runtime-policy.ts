import * as fs from "node:fs";
import { logger } from "@oh-my-pi/pi-utils";

export const RB_RUNTIME_WORKSPACE_ROOT = "RB_RUNTIME_WORKSPACE_ROOT";
export const RB_RUNTIME_PROTECTED_PATHS = "RB_RUNTIME_PROTECTED_PATHS";
export const RB_RUNTIME_POLICY_GENERATION = "RB_RUNTIME_POLICY_GENERATION";
export const RB_RUNTIME_POLICY_DIGEST = "RB_RUNTIME_POLICY_DIGEST";

export const POLICY_ENV_KEYS = [
	RB_RUNTIME_WORKSPACE_ROOT,
	RB_RUNTIME_PROTECTED_PATHS,
	RB_RUNTIME_POLICY_GENERATION,
	RB_RUNTIME_POLICY_DIGEST,
] as const;

/**
 * Shared limits (spec §4.2②). The production values come from the generated
 * `omp-policy-limits.generated` module (injected at build time by Task 30);
 * `capability/fs.ts` is the single import location and passes them in here, so
 * this module never imports the generated modules directly.
 */
export interface PolicyLimits {
	readonly maxEntries: number;
	readonly maxEnvJsonBytes: number;
	readonly maxPathChars: number;
}

export type DigestProtectedPaths = (paths: readonly string[]) => string;

/**
 * Immutable runtime policy snapshot. `enforced: false` is the fail-closed
 * deny-all state: every context read must be refused.
 */
export interface RuntimePolicy {
	readonly enforced: boolean;
	readonly workspaceRoot: string;
	readonly canonicalPaths: readonly string[];
	readonly serializedPaths: string;
	readonly generation: number;
	readonly digest: string;
	/** Non-empty only when the policy is fail-closed (for diagnostics). */
	readonly warn?: string;
}

function normalizeSegment(p: string): string {
	// trim + unify separators (Windows backslash -> forward slash) so the
	// canonical form is platform-stable.
	let s = p.trim().replace(/\\/g, "/");
	// uppercase the drive letter (C:\ -> C:/).
	if (/^[a-zA-Z]:\//.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
	// strip trailing slashes (root "/" is preserved).
	while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
	return s;
}

/**
 * Canonicalize a protected-path list: trim, unify separators, uppercase drive,
 * dedupe and sort. Lexical only — realpath resolution happens at enforcement
 * (spec §4.2①). Sorting makes the digest stable regardless of input order.
 */
function canonicalizeProtectedPaths(input: readonly string[], limits: PolicyLimits): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of input) {
		const n = normalizeSegment(raw);
		if (n.length === 0) {
			throw new Error("invalid protected path: empty after normalize");
		}
		if (n.length > limits.maxPathChars) {
			throw new Error(`invalid protected path: exceeds ${limits.maxPathChars} chars`);
		}
		if (seen.has(n)) continue;
		seen.add(n);
		out.push(n);
	}
	if (out.length > limits.maxEntries) {
		throw new Error(`invalid protected paths: exceeds ${limits.maxEntries} entries`);
	}
	out.sort();
	return out;
}

/** Canonical serialization — the exact input to the digest. */
function serializeProtectedPaths(canonical: readonly string[]): string {
	return JSON.stringify(canonical);
}

let lastDenyWarn = "";
function warnDenyAll(reason: string): void {
	if (lastDenyWarn === reason) return;
	lastDenyWarn = reason;
	logger.warn("runtime policy fail-closed: denying all context reads", { reason });
}

function denyAll(reason: string): RuntimePolicy {
	warnDenyAll(reason);
	return {
		enforced: false,
		workspaceRoot: "",
		canonicalPaths: [],
		serializedPaths: "[]",
		generation: 0,
		digest: "",
		warn: reason,
	};
}

/**
 * Parse the four injected env vars into an immutable policy snapshot
 * (spec §4.2① worker fail-closed + §12 三方校验). ANY missing / malformed JSON /
 * path-count over `maxEntries` / env byte-length over `maxEnvJsonBytes` /
 * digest mismatch yields an `enforced: false` snapshot that denies ALL context
 * reads — no degradation-to-allow — and logs a warning.
 */
export function parseRuntimePolicy(
	env: NodeJS.ProcessEnv,
	limits: PolicyLimits,
	digestFn: DigestProtectedPaths,
): RuntimePolicy {
	const root = env[RB_RUNTIME_WORKSPACE_ROOT];
	const pathsRaw = env[RB_RUNTIME_PROTECTED_PATHS];
	const generationRaw = env[RB_RUNTIME_POLICY_GENERATION];
	const digestRaw = env[RB_RUNTIME_POLICY_DIGEST];

	const missing = POLICY_ENV_KEYS.filter(key => env[key] === undefined);
	if (missing.length > 0) {
		return denyAll(`missing policy env: ${missing.join(", ")}`);
	}

	// maxEnvJsonBytes applies to the raw injected env string (spec §4.2②).
	if (Buffer.byteLength(pathsRaw!, "utf8") > limits.maxEnvJsonBytes) {
		return denyAll(`RB_RUNTIME_PROTECTED_PATHS exceeds ${limits.maxEnvJsonBytes} bytes`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(pathsRaw!);
	} catch {
		return denyAll("RB_RUNTIME_PROTECTED_PATHS is not valid JSON");
	}
	if (!Array.isArray(parsed) || parsed.some(v => typeof v !== "string")) {
		return denyAll("RB_RUNTIME_PROTECTED_PATHS is not a JSON string array");
	}
	if (parsed.length > limits.maxEntries) {
		return denyAll(`protected paths exceed ${limits.maxEntries} entries`);
	}

	let canonical: string[];
	try {
		canonical = canonicalizeProtectedPaths(parsed as string[], limits);
	} catch (err) {
		return denyAll(`invalid protected paths: ${err instanceof Error ? err.message : String(err)}`);
	}

	const generation = Number(generationRaw);
	if (!Number.isInteger(generation) || generation < 1) {
		return denyAll(`invalid ${RB_RUNTIME_POLICY_GENERATION}`);
	}

	const serializedPaths = serializeProtectedPaths(canonical);
	if (Buffer.byteLength(serializedPaths, "utf8") > limits.maxEnvJsonBytes) {
		return denyAll(`serialized protected paths exceed ${limits.maxEnvJsonBytes} bytes`);
	}

	// 三方一致性: recompute the digest over the canonical serialization and
	// compare to the injected env digest (spec §12).
	const recomputed = digestFn(canonical);
	if (recomputed !== digestRaw) {
		return denyAll("policy digest mismatch");
	}

	const canonicalRoot = root!.replace(/\\/g, "/");
	const insideProtected = canonical.some(p => canonicalRoot === p || canonicalRoot.startsWith(`${p}/`));
	if (insideProtected) {
		return denyAll("workspace root inside protected");
	}

	return {
		enforced: true,
		workspaceRoot: canonicalRoot,
		canonicalPaths: canonical,
		serializedPaths,
		generation,
		digest: digestRaw!,
	};
}

/**
 * Protected-path prefix match against a realpath-normalized target
 * (spec §4.2①). This is the lexical prefix primitive (both sides already
 * canonical/realpath normalized). A fail-closed snapshot returns false for
 * everything. Prefer {@link isContextReadAllowedAsync} in read paths so
 * protected paths are realpath-resolved before the comparison.
 */
export function isContextReadAllowed(policy: RuntimePolicy, targetRealpath: string): boolean {
	if (!policy.enforced) return false;
	const target = targetRealpath.replace(/\\/g, "/");
	return !policy.canonicalPaths.some(p => target === p || target.startsWith(`${p}/`));
}

/**
 * Realpath-aware protected-path prefix match (spec §4.2① "与受保护目录的 realpath
 * 前缀比较"). The caller realpath-resolves the TARGET; each protected path is
 * ALSO realpath-resolved here (best-effort — falls back to its lexical
 * canonical form when it cannot be resolved) so lexical-vs-realpath aliasing
 * (e.g. macOS `/var` -> `/private/var`) cannot bypass the deny.
 */
export async function isContextReadAllowedAsync(policy: RuntimePolicy, targetRealpath: string): Promise<boolean> {
	if (!policy.enforced) return false;
	const target = targetRealpath.replace(/\\/g, "/");
	for (const p of policy.canonicalPaths) {
		let rp = p;
		try {
			rp = await fs.promises.realpath(p);
		} catch {
			// Unresolvable protected path → use its lexical canonical form.
		}
		rp = rp.replace(/\\/g, "/");
		if (target === rp || target.startsWith(`${rp}/`)) return false;
	}
	return true;
}
