// Test-harness preload (wired via bunfig.toml `[test] preload`).
//
// Registers the generated-policy-module shim (so `capability/fs.ts` can resolve
// `omp-policy-limits.generated` / `omp-policy-digest.generated` under `bun test`)
// and installs a valid PERMISSIVE empty-policy env. This keeps legacy tests that
// read context files through `fs.readFile` behaving as they did before the
// protected-path policy gate, while the fail-closed worker semantics remain in
// effect for anything that does NOT inject the four RB_RUNTIME env vars.
//
// The three security test files (read-deny-policy, read-deny-bypass-convergence,
// runtime-policy) override this default explicitly via setPolicyEnv /
// setPolicyEnvRaw / clearPolicyEnv — their env control wins over this default.
import os from "node:os";
import path from "node:path";
import { setPolicyEnv } from "./policy-virtual-modules";

setPolicyEnv({
	// A stable per-process test root; protectedPaths is empty so no context read
	// is denied. The value is computed at runtime (never a machine-specific path).
	workspaceRoot: path.join(os.tmpdir(), "rb-omp-test-harness"),
	protectedPaths: [],
	generation: "1",
});
