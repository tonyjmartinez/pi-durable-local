import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DESIGN_POLISH_PROMPT, PRODUCT_GARDENER_PROMPT } from "../src/loopgate.ts";
describe("builders do not go dormant while ideas exist", () => {
	it("the product prompt reads ROADMAP then IDEAS, and idles only when both are empty", () => {
		assert.match(PRODUCT_GARDENER_PROMPT, /ROADMAP\.md/);
		assert.match(PRODUCT_GARDENER_PROMPT, /docs\/IDEAS\.md/);
		assert.match(PRODUCT_GARDENER_PROMPT, /wakes the product strategist/);
		assert.doesNotMatch(PRODUCT_GARDENER_PROMPT, /If no worthwhile small change is supported by evidence/);
	});
	it("the design prompt files ideas instead of idling when the checklist is clean", () => {
		assert.match(DESIGN_POLISH_PROMPT, /do not idle/);
		assert.match(DESIGN_POLISH_PROMPT, /last 24h and its status is still new/);
		assert.match(DESIGN_POLISH_PROMPT, /docs\/IDEAS\.md/);
	});
});
