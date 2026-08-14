import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isContextReadAllowed, parseRuntimePolicy } from "../src/policy/runtime-policy";
// The shim registers the Bun.plugin for the generated policy modules and exports
// the golden fixture values. runtime-policy.ts itself never imports the
// generated modules (fs.ts passes them in), so it can be imported statically;
// fs.ts must be imported dynamically (after the shim).
import {
	clearPolicyEnv,
	OMP_POLICY_LIMITS,
	ompDigestProtectedPaths,
	RB_RUNTIME_POLICY_DIGEST,
	RB_RUNTIME_POLICY_GENERATION,
	RB_RUNTIME_PROTECTED_PATHS,
	RB_RUNTIME_WORKSPACE_ROOT,
	setPolicyEnv,
	setPolicyEnvRaw,
} from "./policy-virtual-modules";

const { readFile } = await import("../src/capability/fs");

const root = mkdtempSync(path.join(os.tmpdir(), "rb-omp-policy-"));
const privateDir = path.join(root, "private");
const okPath = path.join(root, "ok.md");
const secretPath = path.join(privateDir, "secret.md");

mkdirSync(privateDir);
writeFileSync(okPath, "ok");
writeFileSync(secretPath, "secret");

afterAll(() => {
	clearPolicyEnv();
	rmSync(root, { recursive: true, force: true });
});

describe("worker env fail-closed", () => {
	it("缺失 env → 拒一切上下文读取", async () => {
		clearPolicyEnv();
		expect(await readFile(okPath)).toBeNull();
		expect(await readFile(secretPath)).toBeNull();
	});

	it("畸形 JSON → 拒一切", async () => {
		setPolicyEnvRaw({
			[RB_RUNTIME_WORKSPACE_ROOT]: root,
			[RB_RUNTIME_PROTECTED_PATHS]: "[oops",
			[RB_RUNTIME_POLICY_GENERATION]: "1",
			[RB_RUNTIME_POLICY_DIGEST]: "deadbeef",
		});
		expect(await readFile(okPath)).toBeNull();
		expect(await readFile(secretPath)).toBeNull();
	});

	it("非字符串数组 → 拒一切", async () => {
		setPolicyEnvRaw({
			[RB_RUNTIME_WORKSPACE_ROOT]: root,
			[RB_RUNTIME_PROTECTED_PATHS]: JSON.stringify([1, 2, 3]),
			[RB_RUNTIME_POLICY_GENERATION]: "1",
			[RB_RUNTIME_POLICY_DIGEST]: "deadbeef",
		});
		expect(await readFile(okPath)).toBeNull();
	});

	it("路径数超 64 → 拒一切", async () => {
		const many = Array.from({ length: 65 }, (_, i) => path.join(root, `p${i}`));
		setPolicyEnvRaw({
			[RB_RUNTIME_WORKSPACE_ROOT]: root,
			[RB_RUNTIME_PROTECTED_PATHS]: JSON.stringify(many),
			[RB_RUNTIME_POLICY_GENERATION]: "1",
			[RB_RUNTIME_POLICY_DIGEST]: "deadbeef",
		});
		expect(await readFile(okPath)).toBeNull();
	});

	it("env 字节超 maxEnvJsonBytes → 拒一切", async () => {
		setPolicyEnvRaw({
			[RB_RUNTIME_WORKSPACE_ROOT]: root,
			[RB_RUNTIME_PROTECTED_PATHS]: `["${"a".repeat(9000)}"]`,
			[RB_RUNTIME_POLICY_GENERATION]: "1",
			[RB_RUNTIME_POLICY_DIGEST]: "deadbeef",
		});
		expect(await readFile(okPath)).toBeNull();
	});

	it("单路径超 maxPathChars → 拒一切", async () => {
		setPolicyEnvRaw({
			[RB_RUNTIME_WORKSPACE_ROOT]: root,
			[RB_RUNTIME_PROTECTED_PATHS]: JSON.stringify([path.join(root, "a".repeat(5000))]),
			[RB_RUNTIME_POLICY_GENERATION]: "1",
			[RB_RUNTIME_POLICY_DIGEST]: "deadbeef",
		});
		expect(await readFile(okPath)).toBeNull();
	});

	it("digest 与重算不符 → 拒一切", async () => {
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [privateDir], generation: "1" });
		process.env[RB_RUNTIME_POLICY_DIGEST] = "0000000000000000000000000000000000000000000000000000000000000000";
		expect(await readFile(okPath)).toBeNull();
		expect(await readFile(secretPath)).toBeNull();
	});

	it("workspace 落入受保护 → 拒一切", async () => {
		setPolicyEnvRaw({
			[RB_RUNTIME_WORKSPACE_ROOT]: privateDir,
			[RB_RUNTIME_PROTECTED_PATHS]: JSON.stringify([privateDir]),
			[RB_RUNTIME_POLICY_GENERATION]: "1",
			[RB_RUNTIME_POLICY_DIGEST]: ompDigestProtectedPaths([privateDir]),
		});
		expect(await readFile(okPath)).toBeNull();
	});
});

describe("enforced policy", () => {
	it("合法空清单 → 正常读取不受影响", async () => {
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [], generation: "1" });
		expect(await readFile(okPath)).not.toBeNull();
		expect(await readFile(secretPath)).not.toBeNull();
	});

	it("合法清单 → 仅受保护被拒", async () => {
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [privateDir], generation: "1" });
		expect(await readFile(okPath)).not.toBeNull();
		expect(await readFile(secretPath)).toBeNull();
	});

	it("parseRuntimePolicy：合法 env → enforced + 三方 digest 一致", () => {
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [privateDir], generation: "7" });
		const policy = parseRuntimePolicy(process.env, OMP_POLICY_LIMITS, ompDigestProtectedPaths);
		expect(policy.enforced).toBe(true);
		expect(policy.generation).toBe(7);
		expect(policy.workspaceRoot).toBe(root);
		expect(policy.digest).toBe(process.env[RB_RUNTIME_POLICY_DIGEST] as string);
		expect(isContextReadAllowed(policy, okPath)).toBe(true);
		expect(isContextReadAllowed(policy, secretPath)).toBe(false);
		// 三方一致性: the injected digest equals the recompute over the snapshot.
		expect(ompDigestProtectedPaths(policy.canonicalPaths)).toBe(policy.digest);
		expect(policy.serializedPaths).toBe(JSON.stringify([privateDir]));
	});

	it("parseRuntimePolicy：缺失 env → enforced=false（fail-closed）", () => {
		clearPolicyEnv();
		const policy = parseRuntimePolicy(process.env, OMP_POLICY_LIMITS, ompDigestProtectedPaths);
		expect(policy.enforced).toBe(false);
		expect(isContextReadAllowed(policy, okPath)).toBe(false);
	});

	it("isContextReadAllowed：前缀匹配（目标等于或位于受保护之下）", () => {
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [privateDir], generation: "1" });
		const policy = parseRuntimePolicy(process.env, OMP_POLICY_LIMITS, ompDigestProtectedPaths);
		expect(isContextReadAllowed(policy, path.join(privateDir))).toBe(false);
		expect(isContextReadAllowed(policy, path.join(privateDir, "secret.md"))).toBe(false);
		expect(isContextReadAllowed(policy, path.join(root, "ok.md"))).toBe(true);
		// sibling directory must NOT be denied by prefix matching
		expect(isContextReadAllowed(policy, path.join(root, "private-else"))).toBe(true);
	});
});
