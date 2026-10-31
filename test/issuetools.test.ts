// issue_list, issue_view and issue_close: the read tools the friction sweep needs, and a close limited to friction.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";
import { makeFakeGh, makeStore } from "./fakegh.helper.ts";

const root = mkdtempSync(join(tmpdir(), "pd-issues-"));
process.env.PD_DATA_DIR = join(root, "data");
process.env.PD_CONFIG_DIR = join(root, "cfg");
delete process.env.PD_NOTIFY_URL;
mkdirSync(process.env.PD_DATA_DIR, { recursive: true });
mkdirSync(process.env.PD_CONFIG_DIR, { recursive: true });
writeFileSync(join(process.env.PD_CONFIG_DIR, "policy.json"), "{}");
const gh = makeFakeGh(join(root, "fake"));
const ext = await import("../src/extensions.ts");
const { Sessions } = await import("../src/state.ts");

type Result = { output: { text: string }[]; isError?: boolean };
const text = (result: Result) => result.output.map((part) => part.text).join("\n");
let store: ReturnType<typeof makeStore>;

function call(name: string, args: unknown): Promise<Result> {
	const tool = ext.Git_.tools!.find((entry) => entry.name === name)!.execute as (args: unknown, api: unknown, context: unknown) => Promise<Result>;
	return tool(args, { conversationId: 1, snapshot: store.snapshot.bind(store), commit: store.commit.bind(store) }, {});
}

beforeEach(() => {
	store = makeStore();
	store.seed(Sessions, { byName: { s1: { conversationId: 1, cwd: "/work/r", purpose: "", createdAt: 0, remote: "git@github.com:o/r.git" } } });
	ext.setHarness(store as never);
});

describe("issue_list", () => {
	it("passes the label and search through to gh", async () => {
		gh.script([{ match: "^issue list", responses: ["#3 Flaky test [friction, P1] opened 2026-10-30\n"] }]);
		const result = await call("issue_list", { label: "friction", search: "-label:needs-decision" });
		assert.match(text(result), /o\/r\n#3 Flaky test/);
		assert.match(gh.calls()[0] ?? "", /--repo o\/r --state open --limit 50 --label friction --search -label:needs-decision/);
	});

	it("says so when nothing matches", async () => {
		gh.script([{ match: "^issue list", responses: [""] }]);
		assert.match(text(await call("issue_list", {})), /No matching open issues/);
	});
});

describe("issue_view", () => {
	it("shows the body and the latest comments", async () => {
		const issue = { number: 3, title: "Flaky test", state: "OPEN", labels: [{ name: "friction" }], body: "It flakes.", comments: [{ author: { login: "a" }, createdAt: "2026-10-30T00:00:00Z", body: "Hit again" }] };
		gh.script([{ match: "^issue view 3", responses: [JSON.stringify(issue)] }]);
		const out = text(await call("issue_view", { number: 3 }));
		assert.match(out, /o\/r#3 \(OPEN\) Flaky test/);
		assert.match(out, /Labels: friction/);
		assert.match(out, /It flakes\.[\s\S]*--- a 2026-10-30\nHit again/);
	});
});

describe("issue_close", () => {
	const view = (labels: string[], state = "OPEN") => JSON.stringify({ state, labels: labels.map((name) => ({ name })) });

	it("closes a friction issue with the comment", async () => {
		gh.script([
			{ match: "^issue view 3", responses: [view(["friction"])] },
			{ match: "^issue close 3", responses: [""] },
		]);
		const result = await call("issue_close", { number: 3, comment: "Fixed by #9." });
		assert.equal(result.isError, undefined);
		assert.deepEqual(gh.callsMatching(/^issue close/), ["issue close 3 --repo o/r --comment Fixed by #9."]);
	});

	it("refuses an issue that is not friction", async () => {
		gh.script([{ match: "^issue view 4", responses: [view(["bug"])] }]);
		const result = await call("issue_close", { number: 4, comment: "nope" });
		assert.equal(result.isError, true);
		assert.equal(gh.callsMatching(/^issue close/).length, 0);
	});

	it("refuses an issue that is already closed", async () => {
		gh.script([{ match: "^issue view 5", responses: [view(["friction"], "CLOSED")] }]);
		assert.equal((await call("issue_close", { number: 5, comment: "x" })).isError, true);
		assert.equal(gh.callsMatching(/^issue close/).length, 0);
	});
});
