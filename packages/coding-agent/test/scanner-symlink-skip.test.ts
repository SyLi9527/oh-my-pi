/**
 * Scanner-layer symlink denoise (Task 29).
 *
 * The protected-path READ deny lives in `capability/fs.ts` (realpath-aware,
 * fail-closed — Task 28). This layer is the DISCOVERY SCANNER: the scanners
 * must not FOLLOW symlinks, so a symlinked skill/command dir or file pointing
 * into a protected area is never enumerated or metadata-read. Custom skill
 * directories whose realpath is inside a protected path are excluded at
 * assembly time. The final security decision stays with `readFile`.
 *
 * Test matrix:
 *   ① symlink directory PARAM → `scanSkillsFromDir` returns empty.
 *   ② symlinked skill subdir / command file is skipped and NOT read.
 *   ③ normal skills/commands are still discovered.
 *   ④ customDirectories passing a PARENT dir still discovers skills (V4-2
 *      regression guard — the entries ARE discovery parent roots).
 *   ⑤ fileCommandAllowlist: empty array → all commands pass (pin); a
 *      non-empty allowlist filters.
 *   + custom-dir realpath-deny: a protected custom directory is excluded at
 *     assembly (asserted via the dedicated skip warning).
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as fsCap from "../src/capability/fs";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { loadFilesFromDir, scanSkillsFromDir } from "../src/discovery/helpers";
import { loadSkills } from "../src/extensibility/skills";
import { loadSlashCommands } from "../src/extensibility/slash-commands";
import { setPolicyEnv } from "./policy-virtual-modules";

const skillMd = (name: string, description = "A test skill"): string =>
	`---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

/**
 * Disable every named built-in skill source so `loadSkills` custom-dir tests
 * don't leak the developer's real `$HOME` skills into the assertions.
 */
const DISABLE_ALL_BUILTIN_SKILLS = {
	enableCodexUser: false,
	enableClaudeUser: false,
	enableClaudeProject: false,
	enablePiUser: false,
	enablePiProject: false,
	enableAgentsUser: false,
	enableAgentsProject: false,
} as const;

const ctx = () => ({ cwd: process.cwd(), home: os.homedir(), repoRoot: null });

describe("scanner-level symlink skip", () => {
	let root: string;
	let originalHome: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(path.join(os.tmpdir(), "rb-omp-scan-"));
		originalHome = process.env.HOME;
		const fakeHome = path.join(root, "fake-home");
		mkdirSync(fakeHome);
		process.env.HOME = fakeHome;
		spyOn(os, "homedir").mockReturnValue(fakeHome);
		resetSettingsForTest();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		fsCap.clearCache();
		resetSettingsForTest();
		vi.restoreAllMocks();
		if (originalHome === undefined) delete process.env.HOME;
		else process.env.HOME = originalHome;
		// Restore the permissive empty-policy default for any later test.
		setPolicyEnv({
			workspaceRoot: path.join(os.tmpdir(), "rb-omp-test-harness"),
			protectedPaths: [],
			generation: "1",
		});
	});

	it("① symlinked directory param → scanSkillsFromDir returns empty", async () => {
		const realSkills = path.join(root, "real-skills");
		mkdirSync(path.join(realSkills, "skill-a"), { recursive: true });
		writeFileSync(path.join(realSkills, "skill-a", "SKILL.md"), skillMd("skill-a"));
		const link = path.join(root, "skills-link");
		symlinkSync(realSkills, link, "dir");

		const result = await scanSkillsFromDir(ctx(), {
			dir: link,
			providerId: "test",
			level: "user",
		});

		expect(result.items).toHaveLength(0);
		// Sanity: the real target is readable under the permissive harness, so the
		// empty result is caused by the symlink-root rejection, not a read failure.
		expect(await fsCap.readFile(path.join(realSkills, "skill-a", "SKILL.md"))).not.toBeNull();
	});

	it("② symlinked skill subdir is skipped and NOT read", async () => {
		const skillsRoot = path.join(root, "skills");
		const evilDir = path.join(root, "evil-dir");
		mkdirSync(path.join(skillsRoot, "ok-skill"), { recursive: true });
		mkdirSync(evilDir);
		writeFileSync(path.join(skillsRoot, "ok-skill", "SKILL.md"), skillMd("ok-skill"));
		writeFileSync(path.join(evilDir, "SKILL.md"), skillMd("evil-skill"));
		symlinkSync(evilDir, path.join(skillsRoot, "evil-dir"), "dir");

		const readSpy = spyOn(fsCap, "readFile");
		try {
			const result = await scanSkillsFromDir(ctx(), {
				dir: skillsRoot,
				providerId: "test",
				level: "user",
			});

			const names = result.items.map(i => i.name);
			expect(names).toContain("ok-skill");
			expect(names).not.toContain("evil-skill");
			// The symlinked target's SKILL.md must never be read.
			const evilRead = readSpy.mock.calls.some(([p]) => p === path.join(evilDir, "SKILL.md"));
			expect(evilRead).toBe(false);
		} finally {
			readSpy.mockRestore();
		}
	});

	it("②b symlinked command file is skipped and NOT read", async () => {
		const cmdsRoot = path.join(root, "cmds");
		const cmdEvil = path.join(root, "cmd-evil.md");
		mkdirSync(cmdsRoot);
		writeFileSync(path.join(cmdsRoot, "ok.md"), "---\ndescription: ok\n---\nok body");
		writeFileSync(cmdEvil, "---\ndescription: evil\n---\nevil body");
		symlinkSync(cmdEvil, path.join(cmdsRoot, "evil.md"));

		const readSpy = spyOn(fsCap, "readFile");
		try {
			const result = await loadFilesFromDir<{ name: string; content: string }>(
				ctx(),
				cmdsRoot,
				"test",
				"user",
				{
					extensions: ["md"],
					transform: (name, content) => ({ name, content }),
				},
			);

			const names = result.items.map(i => i.name);
			expect(names).toContain("ok.md");
			expect(names).not.toContain("evil.md");
			const evilRead = readSpy.mock.calls.some(([p]) => p === cmdEvil);
			expect(evilRead).toBe(false);
		} finally {
			readSpy.mockRestore();
		}
	});

	it("③ normal skills and commands are still discovered", async () => {
		const skillsRoot = path.join(root, "skills");
		const cmdsRoot = path.join(root, "cmds");
		mkdirSync(path.join(skillsRoot, "normal-skill"), { recursive: true });
		mkdirSync(cmdsRoot);
		writeFileSync(path.join(skillsRoot, "normal-skill", "SKILL.md"), skillMd("normal-skill"));
		writeFileSync(path.join(cmdsRoot, "normal.md"), "---\ndescription: normal\n---\nnormal body");

		const skillRes = await scanSkillsFromDir(ctx(), {
			dir: skillsRoot,
			providerId: "test",
			level: "user",
		});
		expect(skillRes.items.map(i => i.name)).toEqual(["normal-skill"]);

		const cmdRes = await loadFilesFromDir<{ name: string }>(ctx(), cmdsRoot, "test", "user", {
			extensions: ["md"],
			transform: name => ({ name }),
		});
		expect(cmdRes.items.map(i => i.name)).toEqual(["normal.md"]);
	});

	it("④ customDirectories passing a parent dir still discovers skills (V4-2 regression)", async () => {
		const parent = path.join(root, "custom-parent");
		mkdirSync(path.join(parent, "nested-skill"), { recursive: true });
		writeFileSync(path.join(parent, "nested-skill", "SKILL.md"), skillMd("nested-skill"));

		const { skills } = await loadSkills({
			...DISABLE_ALL_BUILTIN_SKILLS,
			cwd: root,
			customDirectories: [parent],
		});

		expect(skills.some(s => s.name === "nested-skill" && s.source === "custom:user")).toBe(true);
	});

	it("⑤ fileCommandAllowlist: empty array allows all; non-empty filters", async () => {
		const cmdDir = path.join(root, ".omp", "commands");
		mkdirSync(cmdDir, { recursive: true });
		writeFileSync(path.join(cmdDir, "foo.md"), "---\ndescription: foo command\n---\nfoo body");

		const settings = await Settings.init({ inMemory: true, cwd: root });
		const hasFoo = (cmds: Array<{ name: string }>): boolean => cmds.some(c => c.name === "foo");

		// Pin the production semantics: empty array → ALL file commands pass.
		settings.set("commands.fileCommandAllowlist", []);
		expect(hasFoo(await loadSlashCommands({ cwd: root }))).toBe(true);

		// Matching allowlist entry keeps the command.
		settings.set("commands.fileCommandAllowlist", ["native:project"]);
		expect(hasFoo(await loadSlashCommands({ cwd: root }))).toBe(true);

		// Non-matching allowlist entry filters it out.
		settings.set("commands.fileCommandAllowlist", ["native:user"]);
		expect(hasFoo(await loadSlashCommands({ cwd: root }))).toBe(false);
	});

	it("custom-directory realpath deny: protected custom dir excluded at assembly", async () => {
		const protectedDir = path.join(root, "protected");
		mkdirSync(path.join(protectedDir, "secret-skill"), { recursive: true });
		writeFileSync(path.join(protectedDir, "secret-skill", "SKILL.md"), skillMd("secret-skill"));

		setPolicyEnv({ workspaceRoot: root, protectedPaths: [protectedDir], generation: "1" });
		try {
			const { skills, warnings } = await loadSkills({
				...DISABLE_ALL_BUILTIN_SKILLS,
				cwd: root,
				customDirectories: [protectedDir],
			});

			expect(skills.some(s => s.name === "secret-skill")).toBe(false);
			// Distinguishes the ASSEMBLY-TIME exclusion (this task) from the
			// readFile deny (Task 28): only the assembly-time check emits this warning.
			expect(warnings.some(w => w.message.includes("custom directory skipped"))).toBe(true);
		} finally {
			setPolicyEnv({
				workspaceRoot: path.join(os.tmpdir(), "rb-omp-test-harness"),
				protectedPaths: [],
				generation: "2",
			});
		}
	});
});
