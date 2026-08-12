import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession, type WorkspaceRootIdentity } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { readWorkspaceMentionRootIdentity } from "@oh-my-pi/pi-natives";

const tempDirs: string[] = [];
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	authStorage = await AuthStorage.create(":memory:");
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	modelRegistry = new ModelRegistry(authStorage);
});

afterAll(() => authStorage.close());

afterEach(async () => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function tempDir(label: string): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), `omp-sdk-mention-${label}-`));
	tempDirs.push(dir);
	return dir;
}

function sessionOptions(cwd: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("expected bundled test model");
	return {
		cwd,
		agentDir: path.join(cwd, ".agent-test"),
		model,
		modelRegistry,
		settings: Settings.isolated({ "autolearn.enabled": false }),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		toolNames: [],
		enableMCP: false,
		enableLsp: false,
		getApiKey: () => "test-key",
	};
}

function rootIdentity(workspaceRoot: string): WorkspaceRootIdentity {
	const identity = readWorkspaceMentionRootIdentity(workspaceRoot);
	if (identity.platform !== "posix" && identity.platform !== "windows") {
		throw new Error(`unsupported workspace identity platform: ${identity.platform}`);
	}
	return { ...identity, platform: identity.platform };
}

describe("createAgentSession fileMentionReadPolicy", () => {
	test("keeps strict auto-read bound to the verified root handle for the session lifetime", async () => {
		const parent = await tempDir("strict-parent");
		const root = path.join(parent, "workspace");
		const original = path.join(parent, "workspace-original");
		const outside = await tempDir("strict-outside");
		await fs.mkdir(root);
		await fs.writeFile(path.join(root, "note.txt"), "ORIGINAL-SDK-SAFE");
		await fs.writeFile(path.join(outside, "note.txt"), "OUTSIDE-SDK-SECRET");

		const created = await createAgentSession({
			...sessionOptions(root),
			fileMentionReadPolicy: {
				mode: "workspace-strict",
				workspaceRoot: root,
				expectedRootIdentity: rootIdentity(root),
			},
		});
		try {
			await fs.rename(root, original);
			await fs.symlink(outside, root, process.platform === "win32" ? "junction" : undefined);
			const mock = createMockModel({ responses: [{ content: ["done"] }] });
			vi.spyOn(created.session.agent, "streamFn").mockImplementation(mock.stream);

			await created.session.prompt('@"note.txt"');

			const mention = created.session.messages.find(message => message.role === "fileMention");
			expect(JSON.stringify(mention)).toContain("ORIGINAL-SDK-SAFE");
			expect(JSON.stringify(mention)).not.toContain("OUTSIDE-SDK-SECRET");
		} finally {
			await created.session.dispose();
		}
	});

	test("fails closed before session creation when the expected root identity is wrong", async () => {
		const root = await tempDir("identity");
		const identity = rootIdentity(root);
		await expect(
			createAgentSession({
				...sessionOptions(root),
				fileMentionReadPolicy: {
					mode: "workspace-strict",
					workspaceRoot: root,
					expectedRootIdentity: { ...identity, volumeId: `${identity.volumeId}0` },
				},
			}),
		).rejects.toThrow("workspace root identity mismatch");
	});
});
