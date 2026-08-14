import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// Importing the shim registers the Bun.plugin that maps the two generated
// policy module specifiers to fixtures. fs.ts must therefore be imported
// dynamically (after the shim), since Bun resolves a test file's static import
// graph before module evaluation runs.
import { clearPolicyEnv, setPolicyEnv } from "./policy-virtual-modules";

const { readFile, __setToctouHook } = await import("../src/capability/fs");

describe("fs.readFile deny", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "rb-omp-"));
	const privateDir = path.join(root, "private");
	const okPath = path.join(root, "ok.md");
	const secretPath = path.join(privateDir, "secret.md");
	const aliasPath = path.join(root, "alias.md");

	beforeAll(() => {
		mkdirSync(privateDir);
		writeFileSync(okPath, "ok");
		writeFileSync(secretPath, "secret");
		symlinkSync(secretPath, aliasPath); // leaf-file symlink into private/
		setPolicyEnv({
			workspaceRoot: root,
			protectedPaths: [privateDir],
			generation: "1",
		});
	});
	afterAll(() => {
		clearPolicyEnv();
		__setToctouHook(null);
		rmSync(root, { recursive: true, force: true });
	});

	it("命中清单 → 返回 null 不进缓存", async () => {
		expect(await readFile(secretPath)).toBeNull();
	});

	it("叶文件 symlink 跟随后命中 → 返回 null", async () => {
		// 词法上 alias.md 不在清单内，但 realpath 解析进 private/ → 拒绝。
		expect(await readFile(aliasPath)).toBeNull();
	});

	it("正常路径不受影响", async () => {
		expect(await readFile(okPath)).not.toBeNull();
	});

	it("deny 不进缓存：撤权后同一路径可重新读取", async () => {
		expect(await readFile(secretPath)).toBeNull(); // denied, not cached
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [], generation: "2" });
		try {
			expect(await readFile(secretPath)).not.toBeNull(); // no null cache poisoning
		} finally {
			setPolicyEnv({ workspaceRoot: root, protectedPaths: [privateDir], generation: "1" });
		}
	});

	it("TOCTOU 确定性 hook：check→I/O 窗口内替换 symlink（残余风险表征，spec §4.2①）", async () => {
		// Point alias at an ALLOWED target so the deny check passes, then swap it
		// to private/secret.md inside the check→I/O window.
		rmSync(aliasPath);
		symlinkSync(okPath, aliasPath);
		let hookFired = false;
		__setToctouHook(async () => {
			hookFired = true;
			rmSync(aliasPath);
			symlinkSync(secretPath, aliasPath);
		});
		try {
			const content = await readFile(aliasPath);
			expect(hookFired).toBe(true);
			// Residual-risk characterization (NOT a zero-leak guarantee): the
			// deny check ran against the original target (ok.md, allowed); the
			// hook swapped the symlink in the check→I/O window; the content read
			// then followed the new target. A zero-leak guarantee would require
			// fd/no-follow identity re-verification (spec §4.2① / §11).
			expect(content).toBe("secret");
		} finally {
			__setToctouHook(null);
			rmSync(aliasPath);
			symlinkSync(secretPath, aliasPath);
		}
	});
});
