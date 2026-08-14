import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// The shim registers the Bun.plugin that resolves the two generated policy
// module specifiers. Consumer modules that transitively import fs.ts must be
// imported dynamically (after the shim).
import { clearPolicyEnv, setPolicyEnv } from "./policy-virtual-modules";

const { loadPromptTemplates } = await import("../src/config/prompt-templates");
const { buildSkillPromptMessage } = await import("../src/extensibility/skills");
const { tryRunRpcSkillCommand } = await import("../src/modes/rpc/rpc-mode");
const { collectConfigCandidates } = await import("../src/advisor/watchdog");

describe("readFile bypass convergence — rejection semantics", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "rb-omp-bypass-"));

	// ① .omp/prompts fixtures
	const projRoot = path.join(root, "proj");
	const promptsDir = path.join(projRoot, ".omp", "prompts");
	const reviewTemplatePath = path.join(promptsDir, "review.md");
	const agentRoot = path.join(root, "agent");
	const agentPromptsDir = path.join(agentRoot, "prompts");

	// ② /skill:* fixture
	const skillDir = path.join(root, "skills", "denied-skill");
	const skillPath = path.join(skillDir, "SKILL.md");

	// ③ WATCHDOG fixture
	const wdCwd = path.join(root, "wd");
	const watchdogPath = path.join(wdCwd, "WATCHDOG.md");

	beforeAll(() => {
		mkdirSync(promptsDir, { recursive: true });
		mkdirSync(agentPromptsDir, { recursive: true });
		mkdirSync(skillDir, { recursive: true });
		mkdirSync(wdCwd, { recursive: true });
		writeFileSync(reviewTemplatePath, "---\ndescription: Review code\n---\n\nReview body.\n");
		writeFileSync(skillPath, "---\nname: denied-skill\ndescription: Denied\n---\n\nSecret skill body.\n");
		writeFileSync(watchdogPath, "WATCHDOG_SENTINEL_7f3a\n");
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [], generation: "1" });
	});
	afterAll(() => {
		clearPolicyEnv();
		rmSync(root, { recursive: true, force: true });
	});

	it("① .omp/prompts 命中 deny → 跳过候选、不解析、不进结果", async () => {
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [promptsDir], generation: "2" });
		try {
			const templates = await loadPromptTemplates({ cwd: projRoot, agentDir: agentRoot });
			expect(templates.find(t => t.name === "review")).toBeUndefined();
			expect(templates.find(t => t.source === "(project)")).toBeUndefined();
		} finally {
			setPolicyEnv({ workspaceRoot: root, protectedPaths: [], generation: "1" });
		}
	});

	it("①b .omp/prompts 未保护 → 候选进入结果（对照）", async () => {
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [], generation: "1" });
		const templates = await loadPromptTemplates({ cwd: projRoot, agentDir: agentRoot });
		const review = templates.find(t => t.name === "review");
		expect(review).toBeDefined();
		expect(review!.content).toContain("Review body.");
	});

	it("② /skill:* 命中 deny → 安全错误（不含路径内容）且不调用 promptCustomMessage", async () => {
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [skillDir], generation: "2" });
		try {
			await expect(
				buildSkillPromptMessage({ name: "denied-skill", filePath: skillPath, baseDir: skillDir }, "", "user"),
			).rejects.toThrow(/unavailable/);

			const promptCustomMessage = mock((_message: unknown, _options?: unknown) => {
				throw new Error("promptCustomMessage must not be called on deny");
			});
			const result = tryRunRpcSkillCommand(
				{
					skillsSettings: { enableSkillCommands: true },
					skills: [
						{
							name: "denied-skill",
							description: "Denied",
							filePath: skillPath,
							baseDir: skillDir,
							source: "project",
						},
					],
					promptCustomMessage,
				},
				"/skill:denied-skill",
			);
			const err = await result.catch(e => e);
			expect(err).toBeInstanceOf(Error);
			expect((err as Error).message).not.toContain(skillPath);
			expect((err as Error).message).not.toContain("Secret skill body");
			expect(promptCustomMessage).not.toHaveBeenCalled();
		} finally {
			setPolicyEnv({ workspaceRoot: root, protectedPaths: [], generation: "1" });
		}
	});

	it("③ WATCHDOG 命中 deny → 跳过候选", async () => {
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [watchdogPath], generation: "2" });
		try {
			const items = await collectConfigCandidates(wdCwd, agentRoot, ["WATCHDOG.md"]);
			expect(items.find(c => c.path === watchdogPath)).toBeUndefined();
		} finally {
			setPolicyEnv({ workspaceRoot: root, protectedPaths: [], generation: "1" });
		}
	});

	it("③b WATCHDOG 未保护 → 候选进入结果（对照）", async () => {
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [], generation: "1" });
		const items = await collectConfigCandidates(wdCwd, agentRoot, ["WATCHDOG.md"]);
		const candidate = items.find(c => c.path === watchdogPath);
		expect(candidate).toBeDefined();
		expect(candidate!.content).toContain("WATCHDOG_SENTINEL_7f3a");
	});

	it("④ 发现后撤权：执行阶段二次读取返回 null（skills 二次读取路径）", async () => {
		// Discovery phase: skill NOT protected → read succeeds and is cached.
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [], generation: "1" });
		const before = await buildSkillPromptMessage(
			{ name: "denied-skill", filePath: skillPath, baseDir: skillDir },
			"",
			"user",
		);
		expect(before.message).toContain("Secret skill body");

		// Execution phase: policy revoked (skill now protected) → the second read
		// must be denied even though the discovery-phase read is in the cache
		// (the deny decision runs before the cache).
		setPolicyEnv({ workspaceRoot: root, protectedPaths: [skillDir], generation: "2" });
		try {
			await expect(
				buildSkillPromptMessage({ name: "denied-skill", filePath: skillPath, baseDir: skillDir }, "", "user"),
			).rejects.toThrow(/unavailable/);
		} finally {
			setPolicyEnv({ workspaceRoot: root, protectedPaths: [], generation: "3" });
		}
	});
});
