import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

process.env.PD_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), "pd-sendcap-"));
const ext = await import("../src/extensions.ts");

describe("sends respect the daily cap", () => {
	it("refuses while the cap is reached, with a way forward", () => {
		const refusal = ext.capRefusal({ capUsd: 10, daySpend: 16.9, exceeded: true });
		assert.match(refusal!, /daily cap is reached \(\$16\.90 of \$10 in 24h\)/);
		assert.match(refusal!, /pd ask/);
		assert.match(refusal!, /--force/);
		assert.equal(ext.capRefusal({ capUsd: 10, daySpend: 4, exceeded: false }), undefined);
	});

	it("measures the cap the way the loops do, from loop charges and session-total samples", async () => {
		writeFileSync(join(process.env.PD_CONFIG_DIR!, "policy.json"), JSON.stringify({ loops: { dailyBudgetUsd: 10 } }));
		const now = Date.now();
		const doc = { byId: { L1: { spendLog: [{ at: now - 60_000, usd: 3 }] } }, nextId: 2, factorySpend: [{ at: now - 25 * 60 * 60_000, total: 20 }, { at: now - 60_000, total: 31 }] };
		const reader = { snapshot: async () => doc } as never;
		const budget = await ext.currentBudget(reader, {} as never, now);
		assert.equal(budget.daySpend, 11, "outside-loop spend counts");
		assert.equal(budget.exceeded, true);
	});
});
