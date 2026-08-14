// Test-only shim for the two generated policy modules.
//
// Production (Task 30) injects `omp-policy-limits.generated` and
// `omp-policy-digest.generated` into the bundle via a virtual-module plugin
// (with onResolve/onLoad count assertions). This file registers an equivalent
// Bun.plugin so `bun test` can resolve those two fixed specifiers to fixture
// exports and exercise the REAL deny logic in `capability/fs.ts`. Production
// never imports this file; it only serves the fork's tests.
//
// The fixture values are a faithful port of
// `packages/runtime-contracts/src/canonical-protected-paths.ts` (the golden
// semantics: limits 64/8192/4096 and digest = sha256(UTF8(serialize(canonicalize(paths)))))
// so the digest recompute in `policy/runtime-policy.ts` matches what the
// ResearchBuddy supervisor will inject (三方一致性).

import { createHash } from "node:crypto";

export const OMP_POLICY_LIMITS = {
	maxEntries: 64,
	maxEnvJsonBytes: 8192,
	maxPathChars: 4096,
} as const;

function normalizeSegment(p: string): string {
	let s = p.trim().replace(/\\/g, "/");
	if (/^[a-zA-Z]:\//.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1);
	while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
	return s;
}

export function canonicalizeProtectedPaths(input: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of input) {
		const n = normalizeSegment(raw);
		if (n.length === 0) {
			throw new Error("invalid protected path: empty after normalize");
		}
		if (n.length > OMP_POLICY_LIMITS.maxPathChars) {
			throw new Error(`invalid protected path: exceeds ${OMP_POLICY_LIMITS.maxPathChars} chars`);
		}
		if (seen.has(n)) continue;
		seen.add(n);
		out.push(n);
	}
	if (out.length > OMP_POLICY_LIMITS.maxEntries) {
		throw new Error(`invalid protected paths: exceeds ${OMP_POLICY_LIMITS.maxEntries} entries`);
	}
	out.sort();
	return out;
}

export function serializeProtectedPaths(canonical: readonly string[]): string {
	return JSON.stringify(canonical);
}

export function ompDigestProtectedPaths(input: readonly string[]): string {
	const canonical = canonicalizeProtectedPaths(input);
	return createHash("sha256").update(serializeProtectedPaths(canonical), "utf8").digest("hex");
}

// The virtual modules read their exports off this global so there is a single
// source of truth for the fixture values (no string-duplicated implementation).
const FIXTURES_KEY = "__OMP_POLICY_FIXTURES__";
(globalThis as Record<string, unknown>)[FIXTURES_KEY] = { OMP_POLICY_LIMITS, ompDigestProtectedPaths };

export const RB_RUNTIME_WORKSPACE_ROOT = "RB_RUNTIME_WORKSPACE_ROOT";
export const RB_RUNTIME_PROTECTED_PATHS = "RB_RUNTIME_PROTECTED_PATHS";
export const RB_RUNTIME_POLICY_GENERATION = "RB_RUNTIME_POLICY_GENERATION";
export const RB_RUNTIME_POLICY_DIGEST = "RB_RUNTIME_POLICY_DIGEST";

export interface PolicyEnvInput {
	workspaceRoot: string;
	protectedPaths: string[];
	generation: string;
}

/**
 * Build a self-consistent four-var env: workspace root + canonical protected
 * paths JSON + generation + sha256 digest. The digest is derived here (the
 * brief's sketch passes a placeholder `digest: "x"`; a valid digest is required
 * for the policy to be ENFORCED, so this helper always computes it).
 */
export function setPolicyEnv(input: PolicyEnvInput): void {
	const canonical = canonicalizeProtectedPaths(input.protectedPaths);
	const serialized = serializeProtectedPaths(canonical);
	const digest = ompDigestProtectedPaths(canonical);
	process.env[RB_RUNTIME_WORKSPACE_ROOT] = input.workspaceRoot;
	process.env[RB_RUNTIME_PROTECTED_PATHS] = serialized;
	process.env[RB_RUNTIME_POLICY_GENERATION] = input.generation;
	process.env[RB_RUNTIME_POLICY_DIGEST] = digest;
}

/**
 * Set the four env vars exactly as given (keys not present are cleared). Used to
 * build intentionally invalid states (malformed JSON / over-limit / wrong digest).
 */
export function setPolicyEnvRaw(values: Record<string, string>): void {
	for (const key of POLICY_ENV_KEYS) {
		if (key in values) process.env[key] = values[key];
		else delete process.env[key];
	}
}

export function clearPolicyEnv(): void {
	for (const key of POLICY_ENV_KEYS) {
		delete process.env[key];
	}
}

let shimRegistered = false;
export function registerPolicyVirtualModulesShim(): void {
	if (shimRegistered) return;
	shimRegistered = true;
	Bun.plugin({
		name: "omp-policy-virtual-modules",
		setup(build) {
			build.onResolve({ filter: /omp-policy-limits\.generated$/ }, () => ({
				path: "omp-policy-limits.generated",
				namespace: "omp-policy-limits",
			}));
			build.onLoad({ filter: /.*/, namespace: "omp-policy-limits" }, () => ({
				contents: `export const OMP_POLICY_LIMITS = globalThis[${JSON.stringify(FIXTURES_KEY)}].OMP_POLICY_LIMITS;`,
				loader: "js",
			}));

			build.onResolve({ filter: /omp-policy-digest\.generated$/ }, () => ({
				path: "omp-policy-digest.generated",
				namespace: "omp-policy-digest",
			}));
			build.onLoad({ filter: /.*/, namespace: "omp-policy-digest" }, () => ({
				contents: `export const ompDigestProtectedPaths = globalThis[${JSON.stringify(FIXTURES_KEY)}].ompDigestProtectedPaths;`,
				loader: "js",
			}));
		},
	});
}
registerPolicyVirtualModulesShim();

export const POLICY_ENV_KEYS = [
	RB_RUNTIME_WORKSPACE_ROOT,
	RB_RUNTIME_PROTECTED_PATHS,
	RB_RUNTIME_POLICY_GENERATION,
	RB_RUNTIME_POLICY_DIGEST,
] as const;
