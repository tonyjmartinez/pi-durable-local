import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redact } from "../src/redact.ts";

const SECRETS: [string, string][] = [
	["anthropic key", "key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv_wxyz"],
	["openai-style key", "sk-proj1234567890abcdefghijklmnop"],
	["github token", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
	["fine-grained github token", "github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz"],
	["slack token", "xoxb-1234567890-abcdefghij"],
	["aws key id", "AKIAIOSFODNN7EXAMPLE"],
	["google key", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
	["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"],
	["bearer header", "Authorization: Bearer abcdef1234567890"],
	["bare bearer", "curl -H 'Bearer abcdefgh12345678'"],
	["env assignment", "ANTHROPIC_API_KEY=abc12345xyz"],
	["quoted assignment", 'PASSWORD="hunter2hunter2"'],
	["64-hex ui token", "token a".padEnd(0) + "ab".repeat(32)],
	["long mixed token", "id Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWprbG1ub3A"],
	["private key block", "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----"],
];

describe("redact", () => {
	for (const [name, text] of SECRETS) {
		it(`masks a ${name}`, () => {
			const out = redact(text);
			assert.match(out, /\[redacted\]/, out);
		});
	}

	it("keeps no part of a secret", () => {
		const out = redact("here sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv and ghp_abcdefghijklmnopqrstuvwxyz0123456789 done");
		assert.equal(out, "here [redacted] and [redacted] done");
	});

	it("masks credentials in URLs and webhook paths", () => {
		assert.equal(redact("https://user:p4ss@example.com/x"), "https://[redacted]@example.com/x");
		assert.match(redact("https://discord.com/api/webhooks/123456/abcDEF_ghi-JKL"), /webhooks\/123456\/\[redacted\]$/);
		assert.match(redact("https://hooks.slack.com/services/T000/B000/XXXXXXXX"), /services\/\[redacted\]/);
	});

	it("leaves ordinary text, short ids, and commit ids alone", () => {
		for (const text of [
			"Merged PR #42 into main",
			"commit 4d903e1 and 9108c9c",
			"sha 4d903e1a2b3c4d5e6f708192a3b4c5d6e7f80912",
			"src/guard.ts:123 blocked `git push origin main`",
			"budget $5.00 hit after 6 iterations",
			"https://github.com/tonyjmartinez/pi-durable-local/pull/12",
			"the quick brown fox",
			"token budget exceeded",
		]) {
			assert.equal(redact(text), text);
		}
	});

	it("is idempotent", () => {
		const once = redact("ANTHROPIC_API_KEY=abc12345xyz and sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv");
		assert.equal(redact(once), once);
	});

	it("handles empty and large input", () => {
		assert.equal(redact(""), "");
		assert.doesNotThrow(() => redact("a".repeat(200_000)));
	});
});
