// git_push, git_sync and pr_create against a real local git remote and a fake `gh`: workflow files are refused,
// branches belong to one session, and nothing reaches the remote unless every check passes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, beforeEach, describe, it } from "node:test";
import { makeFakeGh, makeStore, readAudit } from "./fakegh.helper.ts";

const root = mkdtempSync(join(tmpdir(), "pd-push-"));
process.env.PD_DATA_DIR = join(root, "data");
process.env.PD_CONFIG_DIR = join(root, "cfg");
delete process.env.PD_NOTIFY_URL;
mkdirSync(process.env.PD_DATA_DIR, { recursive: true });
mkdirSync(process.env.PD_CONFIG_DIR, { recursive: true });
const AUDIT = join(process.env.PD_DATA_DIR, "audit.jsonl");

const REMOTE = join(root, "remote.git");
const AGENT = join(root, "agent");
const GITHUB_URL = "git@github.com:o/r.git";
// The daemon's git reads these, so its push to "GitHub" lands in the local bare repo.
Object.assign(process.env, {
	GIT_CONFIG_COUNT: "1",
	GIT_CONFIG_KEY_0: `url.${REMOTE}.insteadOf`,
	GIT_CONFIG_VALUE_0: GITHUB_URL,
	GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
});

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const remoteRef = (branch: string) => {
	try {
		return sh(REMOTE, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
	} catch {
		return undefined;
	}
};

/** Commit `files` on a new branch in the agent's repo, then return to main. */
function branch(name: string, files: Record<string, string>): string {
	sh(AGENT, "checkout", "-q", "-B", name, "origin/main");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(dirname(join(AGENT, path)), { recursive: true });
		writeFileSync(join(AGENT, path), content);
	}
	sh(AGENT, "add", "-A");
	sh(AGENT, "commit", "-q", "-m", `work on ${name}`);
	const sha = sh(AGENT, "rev-parse", "HEAD");
	sh(AGENT, "checkout", "-q", "main");
	return sha;
}

const gh = makeFakeGh(join(root, "fake"));
const ext = await import("../src/extensions.ts");
const { Branches, Sessions } = await import("../src/state.ts");

type Result = { output: { text: string }[]; isError?: boolean };
const store = makeStore();
const api = { conversationId: 1, snapshot: store.snapshot.bind(store), commit: store.commit.bind(store) };
const tool = (name: string) => (ext.Git_.tools!.find((entry) => entry.name === name)!.execute as (args: unknown, api: unknown, context: unknown) => Promise<Result>);
const run = (name: string, args: unknown, conversation = 1) => tool(name)(args, { ...api, conversationId: conversation }, {});
const textOf = (result: Result) => result.output.map((part) => part.text).join("\n");
const events = () => readAudit(AUDIT).map((entry) => entry.event);

before(() => {
	sh(root, "init", "-q", "--bare", "-b", "main", REMOTE);
	const seed = join(root, "seed");
	sh(root, "clone", "-q", REMOTE, seed);
	writeFileSync(join(seed, "README.md"), "hello\n");
	mkdirSync(join(seed, ".github"), { recursive: true });
	writeFileSync(join(seed, ".github", "CODEOWNERS"), "* @owner\n");
	sh(seed, "add", "-A");
	sh(seed, "commit", "-q", "-m", "init");
	sh(seed, "push", "-q", "origin", "HEAD:main");
	sh(root, "clone", "-q", REMOTE, AGENT);
	ext.setHarness(store as never);
});

beforeEach(() => {
	writeFileSync(AUDIT, "");
	store.seed(Sessions, {
		byName: {
			s1: { conversationId: 1, cwd: AGENT, purpose: "", createdAt: 0, remote: GITHUB_URL },
			s2: { conversationId: 2, cwd: AGENT, purpose: "", createdAt: 0, remote: GITHUB_URL },
			s3: { conversationId: 3, cwd: AGENT, purpose: "", createdAt: 0, remote: "https://example.com/r.git" },
		},
	});
	store.seed(Branches, { byRef: {} });
	gh.script([
		{ match: "^repo view o/r --json defaultBranchRef", responses: ["main\n"] },
		{ match: "^pr create ", responses: ["https://github.com/o/r/pull/9\n"] },
	]);
});

describe("git_push", () => {
	it("pushes a work branch through the mirror and records who owns it", async () => {
		const sha = branch("pd/feature", { "src/a.ts": "export const a = 1;\n" });
		const result = await run("git_push", { branch: "pd/feature" });
		assert.equal(result.isError, undefined, textOf(result));
		assert.match(textOf(result), new RegExp(`Pushed pd/feature at ${sha.slice(0, 7)}`));
		assert.equal(remoteRef("pd/feature"), sha);
		const owned = store.peek<{ byRef: Record<string, { session: string; sha: string }> }>(Branches).byRef["o/r:pd/feature"];
		assert.equal(owned?.session, "s1");
		assert.equal(owned?.sha, sha);
		assert.ok(events().includes("pushed"));
	});

	it("refuses any change under .github/ and sends nothing to the remote", async () => {
		branch("pd/ci", { ".github/workflows/steal.yml": "on: push\njobs: {}\n", "src/ok.ts": "1\n" });
		const result = await run("git_push", { branch: "pd/ci" });
		assert.equal(result.isError, true);
		assert.match(textOf(result), /refusing to push changes under \.github\//);
		assert.match(textOf(result), /docs\/proposed-ci/);
		assert.equal(remoteRef("pd/ci"), undefined);
		const refused = readAudit(AUDIT).find((entry) => entry.event === "push_refused");
		assert.deepEqual(refused?.paths, [".github/workflows/steal.yml"]);
		assert.equal(store.peek<{ byRef: object }>(Branches).byRef["o/r:pd/ci" as never], undefined);
	});

	it("refuses an edit or deletion of an existing .github file too", async () => {
		branch("pd/edit", { ".github/CODEOWNERS": "* @attacker\n" });
		assert.equal((await run("git_push", { branch: "pd/edit" })).isError, true);
		sh(AGENT, "checkout", "-q", "-B", "pd/del", "origin/main");
		sh(AGENT, "rm", "-q", ".github/CODEOWNERS");
		sh(AGENT, "commit", "-q", "-m", "delete");
		sh(AGENT, "checkout", "-q", "main");
		assert.equal((await run("git_push", { branch: "pd/del" })).isError, true);
		assert.equal(remoteRef("pd/edit"), undefined);
		assert.equal(remoteRef("pd/del"), undefined);
	});

	it("allows a proposed workflow outside .github/", async () => {
		const sha = branch("pd/proposal", { "docs/proposed-ci/ci.yml": "on: pull_request\n" });
		const result = await run("git_push", { branch: "pd/proposal" });
		assert.equal(result.isError, undefined, textOf(result));
		assert.equal(remoteRef("pd/proposal"), sha);
	});

	it("lets a branch belong to one session only", async () => {
		branch("pd/shared", { "a.txt": "1\n" });
		assert.equal((await run("git_push", { branch: "pd/shared" }, 1)).isError, undefined);
		const taken = await run("git_push", { branch: "pd/shared", force: true }, 2);
		assert.equal(taken.isError, true);
		assert.match(textOf(taken), /belongs to session s1/);
		const before = remoteRef("pd/shared");
		sh(AGENT, "checkout", "-q", "-B", "pd/shared", "origin/main");
		writeFileSync(join(AGENT, "evil.txt"), "x\n");
		sh(AGENT, "add", "-A");
		sh(AGENT, "commit", "-q", "-m", "evil");
		sh(AGENT, "checkout", "-q", "main");
		assert.equal((await run("git_push", { branch: "pd/shared", force: true }, 2)).isError, true);
		assert.equal(remoteRef("pd/shared"), before, "the other session's PR head is untouched");
	});

	it("lets the owner push again, and force-push only when asked", async () => {
		branch("pd/redo", { "a.txt": "1\n" });
		assert.equal((await run("git_push", { branch: "pd/redo" })).isError, undefined);
		const first = remoteRef("pd/redo");
		const rewritten = branch("pd/redo", { "a.txt": "2\n" });
		const plain = await run("git_push", { branch: "pd/redo" });
		assert.equal(plain.isError, true, "a rewritten branch is not a fast-forward");
		assert.equal(remoteRef("pd/redo"), first);
		const forced = await run("git_push", { branch: "pd/redo", force: true });
		assert.equal(forced.isError, undefined, textOf(forced));
		assert.equal(remoteRef("pd/redo"), rewritten);
	});

	it("refuses branch names outside the work prefix or with tricks", async () => {
		for (const name of ["main", "feature/x", "pd/../main", "pd/a b", "pd/x;id", "pd/$(id)", "pd/-x y", "PD/x", "pd/"]) {
			const result = await run("git_push", { branch: name });
			assert.equal(result.isError, true, name);
			assert.match(textOf(result), /branch must look like pd\//, name);
		}
		assert.equal(remoteRef("main"), sh(REMOTE, "rev-parse", "refs/heads/main"));
	});

	it("only works for a named session with a GitHub origin", async () => {
		branch("pd/orphan", { "a.txt": "1\n" });
		const stranger = await run("git_push", { branch: "pd/orphan" }, 99);
		assert.equal(stranger.isError, true);
		assert.match(textOf(stranger), /not a named session/);
		const elsewhere = await run("git_push", { branch: "pd/orphan" }, 3);
		assert.equal(elsewhere.isError, true);
		assert.match(textOf(elsewhere), /not a GitHub repo/);
		assert.equal(remoteRef("pd/orphan"), undefined);
	});
});

describe("git_sync", () => {
	it("refreshes the mirror and lists GitHub's branches", async () => {
		branch("pd/listed", { "a.txt": "1\n" });
		await run("git_push", { branch: "pd/listed" });
		const result = await run("git_sync", {});
		assert.equal(result.isError, undefined, textOf(result));
		assert.match(textOf(result), /Mirror updated/);
		assert.match(textOf(result), /origin\/pd\/listed/);
		assert.match(textOf(result), /origin\/main/);
		assert.match(textOf(result), /git fetch --prune .*mirrors\/s1\.git/);
	});
});

describe("pr_create", () => {
	const BODY = "## Intent\n\nAdd z.\n\nDoor: two-way\n\nCleanup: none\n\n## Why\n\nNeeded.\n\n## Testing\n\nRan npm test: pass.\n\n## System recap\n\nRisk: low\nTouches: z (composes)\n";

	it("refuses an incomplete description before pushing or calling GitHub", async () => {
		branch("pd/nodesc", { "z.txt": "1\n" });
		const result = await run("pr_create", { branch: "pd/nodesc", title: "Add z", body: "just a sentence" });
		assert.equal(result.isError, true);
		assert.match(textOf(result), /missing: intent, door, why, testing, risk, touches/);
		assert.match(textOf(result), /## System recap/);
		assert.equal(remoteRef("pd/nodesc"), undefined);
		assert.equal(gh.callsMatching(/^pr create /).length, 0);
	});

	it("pushes, then opens the PR against the deploy branch", async () => {
		const sha = branch("pd/z", { "z.txt": "1\n" });
		const result = await run("pr_create", { branch: "pd/z", title: "Add z", body: BODY });
		assert.equal(result.isError, undefined, textOf(result));
		assert.match(textOf(result), /Opened https:\/\/github\.com\/o\/r\/pull\/9 \(pd\/z → main\)/);
		assert.equal(remoteRef("pd/z"), sha);
		const [call] = gh.callsMatching(/^pr create /);
		assert.match(call!, /--repo o\/r --base main --head pd\/z --title Add z --body /);
		assert.match(call!, /Opened by pi-durable session `s1`/);
		assert.ok(events().includes("pr_created"));
	});

	it("does not open a PR for a branch with workflow changes", async () => {
		branch("pd/wfpr", { ".github/workflows/x.yml": "on: push\n" });
		const result = await run("pr_create", { branch: "pd/wfpr", title: "CI", body: BODY });
		assert.equal(result.isError, true);
		assert.equal(remoteRef("pd/wfpr"), undefined);
		assert.equal(gh.callsMatching(/^pr create /).length, 0);
	});
});
