// The cost-related defaults: which model does what, fresh loop contexts, and how much a page fetch returns.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, it } from "node:test";

const root = mkdtempSync(join(tmpdir(), "pd-defaults-"));
process.env.PD_DATA_DIR = join(root, "data");
process.env.PD_CONFIG_DIR = join(root, "cfg");
mkdirSync(process.env.PD_DATA_DIR, { recursive: true });
mkdirSync(process.env.PD_CONFIG_DIR, { recursive: true });
const POLICY = join(process.env.PD_CONFIG_DIR, "policy.json");
const { DEFAULT_POLICY, loadPolicy } = await import("../src/config.ts");
const ext = await import("../src/extensions.ts");

describe("default models", () => {
	it("keeps the expensive model for the one job that needs it", () => {
		assert.equal(DEFAULT_POLICY.model, "anthropic/claude-sonnet-5-5", "sessions");
		assert.equal(DEFAULT_POLICY.reviewModel, "anthropic/claude-opus-5-5", "the last gate before a merge");
		assert.equal(DEFAULT_POLICY.deepModel, "anthropic/claude-opus-5-5", "audited big decisions");
	});

	it("runs research and bulk work on the cheap model", () => {
		assert.equal(DEFAULT_POLICY.searchModel, "anthropic/claude-haiku-5-5", "web_search: about a cent a call, not eleven");
		assert.equal(DEFAULT_POLICY.subagentModel, "anthropic/claude-haiku-5-5");
		assert.equal(DEFAULT_POLICY.planModel, "anthropic/claude-sonnet-5-5");
	});
});

describe("loops start from a fresh context by default", () => {
	beforeEach(() => writeFileSync(POLICY, "{}"));

	it("is on in the defaults", () => {
		assert.equal(DEFAULT_POLICY.loops.freshContext, true);
		assert.equal(loadPolicy().loops.freshContext, true);
	});

	it("stays on when the policy file sets other loop keys", () => {
		writeFileSync(POLICY, JSON.stringify({ loops: { defaultBudgetUsd: 2 } }));
		const loops = loadPolicy().loops;
		assert.equal(loops.freshContext, true);
		assert.equal(loops.defaultBudgetUsd, 2);
	});

	it("can be turned off in the policy file", () => {
		writeFileSync(POLICY, JSON.stringify({ loops: { freshContext: false } }));
		assert.equal(loadPolicy().loops.freshContext, false);
	});

	it("falls back to on when the policy file is unreadable", () => {
		writeFileSync(POLICY, "{ not json");
		assert.equal(loadPolicy().loops.freshContext, true);
	});
});

describe("web_fetch", () => {
	const tool = ext.Web_.tools!.find((entry) => entry.name === "web_fetch")!;
	const properties = (tool.parameters as unknown as { properties: Record<string, { default?: number; description?: string }> }).properties;

	it("returns at most 8,000 characters unless the agent asks for more", () => {
		assert.equal(properties.maxChars?.default, 8_000);
		assert.match(properties.maxChars?.description ?? "", /only when you need the whole page/i);
	});
});
