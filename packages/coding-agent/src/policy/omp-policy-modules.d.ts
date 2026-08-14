// Ambient type declarations for the two generated policy modules.
//
// The specifiers `omp-policy-limits.generated` / `omp-policy-digest.generated`
// have no real module in the source tree: they are injected into the bundle by
// Task 30's build-time virtual-module plugin and resolved under `bun test` by
// the Bun.plugin shim in `test/policy-virtual-modules.ts`. Without these
// declarations TypeScript reports TS2307 for the dynamic imports in
// `capability/fs.ts` (Task 28) and `extensibility/skills.ts` (Task 29).
//
// Wildcard (`*omp-policy-…`) because the imports are RELATIVE specifiers
// (`./omp-policy-limits.generated`) — TypeScript only consults ambient module
// declarations for non-relative specifiers, so a bare `declare module
// "omp-policy-limits.generated"` would not match. The wildcard matches both the
// relative and the bare form while remaining specific to these two modules.
//
// Type-only: never loaded at runtime or test time. Bun.build does not treat
// `.d.ts` files as runtime modules, so Task 30's onResolve/onLoad count
// assertions are unaffected. The fixture values mirror
// `packages/runtime-contracts/src/canonical-protected-paths.ts` (64/8192/4096).

declare module "*omp-policy-limits.generated" {
	export const OMP_POLICY_LIMITS: {
		readonly maxEntries: 64;
		readonly maxEnvJsonBytes: 8192;
		readonly maxPathChars: 4096;
	};
}

declare module "*omp-policy-digest.generated" {
	export function ompDigestProtectedPaths(canonicalPaths: readonly string[]): string;
}
