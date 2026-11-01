import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.PD_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), "pd-boost-"));
const boost = await import("../src/boost.ts");
const ops = await import("../src/ops.ts");
const ext = await import("../src/extensions.ts");
const { budgetLine } = await import("../src/brief.ts");

const HOUR = 60 * 60_000;
const now = Date.UTC(2026, 10, 1, 12, 0);
const make = (usd: number, untilHours: number) => ({ usd, at: now, until: now + untilHours * HOUR, by: "claude-general", reason: "curb-cut v1.1" });

describe("budget boosts", () => {
	it("adds active boosts to the base cap and ignores expired or malformed ones", () => {
		const boosts = [make(5, 2), make(3, -1), { usd: Number.NaN, until: now + HOUR }, { usd: -4, until: now + HOUR }];
		assert.equal(boost.effectiveCap(10, boosts, now), 15);
		assert.equal(boost.effectiveCap(10, undefined, now), 10);
		assert.equal(boost.effectiveCap(10, boosts, now + 3 * HOUR), 10, "a boost expires on its own");
	});

	it("never turns 'no cap' into a cap", () => {
		assert.equal(boost.effectiveCap(0, [make(5, 2)], now), 0);
	});

	it("requires who, why and a sane amount", () => {
		assert.throws(() => boost.parseBoost({ usd: 5, reason: "x" }, now), /--by/);
		assert.throws(() => boost.parseBoost({ usd: 5, by: "claude-general" }, now), /--reason/);
		assert.throws(() => boost.parseBoost({ usd: 0, by: "g", reason: "r" }, now), /more than \$0/);
		assert.throws(() => boost.parseBoost({ usd: 500, by: "g", reason: "r" }, now), /at most \$50/);
		assert.throws(() => boost.parseBoost({ usd: 5, hours: 100, by: "g", reason: "r" }, now), /at most 48/);
		const parsed = boost.parseBoost({ usd: "7.5", by: " claude-general ", reason: " v1.1 " }, now);
		assert.deepEqual(parsed, { usd: 7.5, at: now, until: now + 24 * HOUR, by: "claude-general", reason: "v1.1" });
	});

	it("writes the boost to policy.json, keeps other keys and drops expired boosts", () => {
		const file = join(mkdtempSync(join(tmpdir(), "pd-boost-file-")), "policy.json");
		writeFileSync(file, JSON.stringify({ automerge: { repos: ["a/b"] }, loops: { dailyBudgetUsd: 10, boosts: [make(3, -1)] } }));
		ops.boostPolicyFile(file, make(5, 24), now);
		const written = JSON.parse(readFileSync(file, "utf8"));
		assert.deepEqual(written.automerge, { repos: ["a/b"] });
		assert.equal(written.loops.dailyBudgetUsd, 10);
		assert.deepEqual(written.loops.boosts.map((b: { usd: number }) => b.usd), [5]);
	});

	it("raises the cap that sends and loops are measured against", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 10, boosts: [make(10, 24)] } }));
		const doc = { byId: { L1: { spendLog: [{ at: now - 60_000, usd: 12 }] } }, nextId: 2 };
		const budget = await ext.currentBudget({ snapshot: async () => doc } as never, {} as never, now);
		assert.equal(budget.capUsd, 20);
		assert.equal(budget.exceeded, false, "$12 of a boosted $20 leaves room");
	});

	it("tells a general how to go past the cap, and shows boosts in the brief", () => {
		const refusal = ext.capRefusal({ capUsd: 10, daySpend: 11, exceeded: true })!;
		assert.match(refusal, /pd budget boost/);
		assert.match(refusal, /generals are not limited by this cap/);
		const line = budgetLine({ capUsd: 15, daySpend: 11, exceeded: false, running: 0, waiting: 1, boosts: [make(5, 2)] });
		assert.match(line, /boosted: \$5 by claude-general until 14:00Z \(curb-cut v1\.1\)/);
	});
});
