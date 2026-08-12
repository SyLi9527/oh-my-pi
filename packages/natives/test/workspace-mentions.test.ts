import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readWorkspaceMentionRootIdentity, StrictWorkspaceMentionReader } from "../native/index.js";

const tempDirs: string[] = [];

afterEach(async () => {
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function tempDir(label: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-workspace-mention-${label}-`));
	tempDirs.push(dir);
	return dir;
}

async function createReader(root: string): Promise<StrictWorkspaceMentionReader> {
	return new StrictWorkspaceMentionReader(root, readWorkspaceMentionRootIdentity(root));
}

async function symlinkFile(target: string, link: string): Promise<void> {
	await fs.symlink(target, link, process.platform === "win32" ? "file" : undefined);
}

async function symlinkDirectory(target: string, link: string): Promise<void> {
	await fs.symlink(target, link, process.platform === "win32" ? "junction" : undefined);
}

describe("StrictWorkspaceMentionReader", () => {
	test("reads regular nested files and bounded direct directory entries", async () => {
		const root = await tempDir("regular");
		await fs.mkdir(path.join(root, "docs", "deep"), { recursive: true });
		await fs.writeFile(path.join(root, "docs", "a.txt"), "safe text");
		await Promise.all(
			Array.from({ length: 500 }, (_, index) =>
				fs.writeFile(path.join(root, "docs", `bounded-${index.toString().padStart(3, "0")}.txt`), "x"),
			),
		);

		const reader = await createReader(root);
		try {
			const file = reader.read("docs/a.txt");
			expect(file.kind).toBe("file");
			expect(file.data?.toString("utf8")).toBe("safe text");

			const directory = reader.read("docs");
			expect(directory.kind).toBe("directory");
			expect(directory.entries).toHaveLength(500);
			expect(directory.entryLimitReached).toBe(true);
		} finally {
			reader.dispose();
		}
	});

	test("rejects traversal and final-component symlink replacement without outside bytes", async () => {
		const root = await tempDir("final-swap-root");
		const outside = await tempDir("final-swap-outside");
		await fs.writeFile(path.join(root, "note.txt"), "inside");
		await fs.writeFile(path.join(outside, "secret.txt"), "OUTSIDE-FINAL-SECRET");
		const reader = await createReader(root);
		await fs.unlink(path.join(root, "note.txt"));
		await symlinkFile(path.join(outside, "secret.txt"), path.join(root, "note.txt"));

		try {
			expect(reader.read("../secret.txt")).toMatchObject({ kind: "skipped", reason: "invalidPath" });
			const result = reader.read("note.txt");
			expect(result).toMatchObject({ kind: "skipped", reason: "unsafeSymlink" });
			expect(JSON.stringify(result)).not.toContain("OUTSIDE-FINAL-SECRET");
		} finally {
			reader.dispose();
		}
	});

	test("rejects parent-component symlink replacement without outside bytes or names", async () => {
		const root = await tempDir("parent-swap-root");
		const outside = await tempDir("parent-swap-outside");
		await fs.mkdir(path.join(root, "docs"));
		await fs.writeFile(path.join(root, "docs", "safe.txt"), "inside");
		await fs.writeFile(path.join(outside, "secret.txt"), "OUTSIDE-PARENT-SECRET");
		const reader = await createReader(root);
		await fs.rename(path.join(root, "docs"), path.join(root, "docs-original"));
		await symlinkDirectory(outside, path.join(root, "docs"));

		try {
			const result = reader.read("docs/secret.txt");
			expect(result).toMatchObject({ kind: "skipped", reason: "unsafeSymlink" });
			expect(JSON.stringify(result)).not.toContain("OUTSIDE-PARENT-SECRET");
			expect(JSON.stringify(result)).not.toContain("secret.txt");
		} finally {
			reader.dispose();
		}
	});

	test("retains the verified root when the workspace path is replaced", async () => {
		const parent = await tempDir("root-swap-parent");
		const root = path.join(parent, "workspace");
		const movedRoot = path.join(parent, "workspace-original");
		const outside = await tempDir("root-swap-outside");
		await fs.mkdir(root);
		await fs.writeFile(path.join(root, "note.txt"), "ORIGINAL-SAFE");
		await fs.writeFile(path.join(outside, "note.txt"), "OUTSIDE-ROOT-SECRET");
		const reader = await createReader(root);
		await fs.rename(root, movedRoot);
		await symlinkDirectory(outside, root);

		try {
			const result = reader.read("note.txt");
			expect(result.kind).toBe("file");
			expect(result.data?.toString("utf8")).toBe("ORIGINAL-SAFE");
			expect(result.data?.toString("utf8")).not.toContain("OUTSIDE-ROOT-SECRET");
		} finally {
			reader.dispose();
		}
	});

	test("omits symlink directory entries", async () => {
		const root = await tempDir("listing-root");
		const outside = await tempDir("listing-outside");
		await fs.mkdir(path.join(root, "docs"));
		await fs.writeFile(path.join(root, "docs", "safe.txt"), "inside");
		await fs.writeFile(path.join(outside, "secret.txt"), "outside");
		await symlinkFile(path.join(outside, "secret.txt"), path.join(root, "docs", "leak.txt"));
		const reader = await createReader(root);
		try {
			const result = reader.read(".");
			expect(result).toMatchObject({ kind: "skipped", reason: "invalidPath" });
			const listing = reader.read("docs");
			expect(listing.kind).toBe("directory");
			expect(listing.entries?.map(entry => entry.name)).toEqual(["safe.txt"]);
		} finally {
			reader.dispose();
		}
	});

	test("fails initialization on identity mismatch and disposes idempotently", async () => {
		const root = await tempDir("identity");
		const identity = readWorkspaceMentionRootIdentity(root);
		expect(() => new StrictWorkspaceMentionReader(root, { ...identity, fileId: `${identity.fileId}0` })).toThrow(
			"workspace root identity mismatch",
		);

		const reader = new StrictWorkspaceMentionReader(root, identity);
		expect(reader.dispose()).toBe(true);
		expect(reader.dispose()).toBe(false);
		expect(reader.read("anything")).toMatchObject({ kind: "skipped", reason: "disposed" });
	});
});
