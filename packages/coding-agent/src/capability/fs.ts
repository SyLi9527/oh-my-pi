import * as fs from "node:fs";
import * as path from "node:path";
import {
	type DigestProtectedPaths,
	isContextReadAllowedAsync,
	type PolicyLimits,
	parseRuntimePolicy,
} from "../policy/runtime-policy";

// Single import location for the two generated policy modules (spec §4.2① /
// §12). Task 30 injects their real values into the bundle via a virtual-module
// plugin whose onResolve/onLoad count assertions rely on this import existing;
// the fork's `bun test` resolves them through `test/policy-virtual-modules.ts`.
//
// The import is a top-level dynamic import so modules that transitively import
// this file can still LOAD when the generated modules are unavailable (running
// outside the managed bundle without the test shim): in that case the worker
// FAILS CLOSED — every context read is denied (never degradation-to-allow).
const policyModules: { limits: PolicyLimits; digest: DigestProtectedPaths } | null = await (async () => {
	try {
		const limitsMod = await import("./omp-policy-limits.generated");
		const digestMod = await import("./omp-policy-digest.generated");
		return { limits: limitsMod.OMP_POLICY_LIMITS, digest: digestMod.ompDigestProtectedPaths };
	} catch {
		return null;
	}
})();

const contentCache = new Map<string, string | null>();
const dirCache = new Map<string, fs.Dirent[]>();

function resolvePath(filePath: string): string {
	return path.resolve(filePath);
}

// Test-only hook: lets a deterministic test inject a symlink swap between the
// deny check and the content I/O to characterize the residual TOCTOU window
// (spec §4.2① known limitation). Null (default) disables the hook.
let toctouHook: (() => Promise<void>) | null = null;
export function __setToctouHook(fn: (() => Promise<void>) | null): void {
	toctouHook = fn;
}

/**
 * Read a file's text through the single context-read choke point.
 *
 * Policy (spec §4.2①):
 * - The deny check runs BEFORE the content cache, so a cache hit can never
 *   bypass the policy, and a symlink redirect landing inside a protected path
 *   is denied even if a stale cache entry exists.
 * - The target is realpath-resolved first (following leaf-file symlinks); a
 *   lexical non-match that resolves into a protected path is still denied.
 * - Denied reads return `null` and are NOT cached.
 * - Fail-closed: missing/malformed/over-limit/digest-mismatched env denies ALL
 *   reads (`null`) and logs a warning — no degradation-to-allow.
 *
 * TOCTOU (spec §4.2① / §11 known limitation): the realpath check and the
 * content I/O are separate operations; the window between them cannot be fully
 * eliminated. Mitigations: per-call immediate validation + no explicit symlink
 * creation tool in the model toolset. A zero-leak guarantee would require
 * fd/no-follow identity re-verification, which is out of scope.
 */
export async function readFile(filePath: string): Promise<string | null> {
	const abs = resolvePath(filePath);

	// Generated policy modules unavailable → fail closed (no context reads).
	if (policyModules === null) {
		return null;
	}

	// Deny decision before the cache (and before any I/O).
	const policy = parseRuntimePolicy(process.env, policyModules.limits, policyModules.digest);
	if (!policy.enforced) {
		// Fail-closed deny-all: do not cache the result.
		return null;
	}

	// realpath follows leaf-file symlinks; a lexical non-match that resolves
	// into a protected path must still be denied.
	let real: string;
	try {
		real = await fs.promises.realpath(abs);
	} catch {
		// Unresolvable path (missing / broken symlink): nothing readable. Do
		// not serve a stale cache entry.
		return null;
	}

	if (!(await isContextReadAllowedAsync(policy, real))) {
		return null; // denied — do not cache.
	}

	if (contentCache.has(abs)) {
		return contentCache.get(abs) ?? null;
	}

	try {
		// Gate on the file type first: discovery scans foreign config dirs
		// (~/.claude, ~/.cursor, project trees), and reading a FIFO/socket/char
		// device with `.text()` blocks until EOF — i.e. forever — hanging
		// startup with zero output. `stat` follows symlinks, so symlinked
		// context files (CLAUDE.md -> AGENTS.md) still resolve.
		const stats = await fs.promises.stat(abs);
		if (!stats.isFile()) {
			contentCache.set(abs, null);
			return null;
		}
		await toctouHook?.();
		const content = await Bun.file(abs).text();
		contentCache.set(abs, content);
		return content;
	} catch {
		contentCache.set(abs, null);
		return null;
	}
}

export async function readDirEntries(dirPath: string): Promise<fs.Dirent[]> {
	const abs = resolvePath(dirPath);
	if (dirCache.has(abs)) {
		return dirCache.get(abs) ?? [];
	}

	try {
		const entries = await fs.promises.readdir(abs, { withFileTypes: true });
		dirCache.set(abs, entries);
		return entries;
	} catch {
		dirCache.set(abs, []);
		return [];
	}
}

export async function readDir(dirPath: string): Promise<string[]> {
	const entries = await readDirEntries(dirPath);
	return entries.map(entry => entry.name);
}

export async function walkUp(
	startDir: string,
	name: string,
	opts: { file?: boolean; dir?: boolean } = {},
): Promise<string | null> {
	const { file = true, dir = true } = opts;
	let current = resolvePath(startDir);

	while (true) {
		const entries = await readDirEntries(current);
		const entry = entries.find(e => e.name === name);
		if (entry) {
			if (file && entry.isFile()) return path.join(current, name);
			if (dir && entry.isDirectory()) return path.join(current, name);
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Walk up from startDir looking for a `.git` entry (file or directory).
 * Returns the directory containing `.git` (the repo root), or null if not in a git repo.
 * Results are based on the cached readDirEntries, so repeated calls are cheap.
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
	let current = resolvePath(startDir);
	while (true) {
		const entries = await readDirEntries(current);
		if (entries.some(e => e.name === ".git")) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function cacheStats(): { content: number; dir: number } {
	return {
		content: contentCache.size,
		dir: dirCache.size,
	};
}

export function clearCache(): void {
	contentCache.clear();
	dirCache.clear();
}

export function invalidate(filePath: string): void {
	const abs = resolvePath(filePath);
	contentCache.delete(abs);
	dirCache.delete(abs);
	const parent = path.dirname(abs);
	if (parent !== abs) {
		dirCache.delete(parent);
	}
}
