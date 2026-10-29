// Test helpers: a fake `gh` on PATH that answers from a scripted rule list and records every call, and an in-memory
// stand-in for the harness's document store. Import-safe: nothing here runs until a test calls it.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Response = string | { stdout?: string; stderr?: string; code?: number };
export type Rule = { match: string; responses: Response[] };

const SCRIPT = `#!/usr/bin/env node
const { readFileSync, writeFileSync, appendFileSync, existsSync } = require("node:fs");
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
appendFileSync(dir + "/calls.jsonl", JSON.stringify(args) + "\\n");
const rules = JSON.parse(readFileSync(dir + "/rules.json", "utf8"));
const statePath = dir + "/state.json";
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
const line = args.join(" ");
const index = rules.findIndex((rule) => new RegExp(rule.match).test(line));
if (index < 0) {
  process.stderr.write("fake gh: no rule for: " + line + "\\n");
  process.exitCode = 1;
} else {
  const n = state[index] ?? 0;
  state[index] = n + 1;
  writeFileSync(statePath, JSON.stringify(state));
  const responses = rules[index].responses;
  const picked = responses[Math.min(n, responses.length - 1)];
  const response = typeof picked === "string" ? { stdout: picked } : picked;
  if (response.stdout) process.stdout.write(response.stdout);
  if (response.stderr) process.stderr.write(response.stderr);
  // Never process.exit() here: it would cut off a large stdout that has not flushed to the pipe yet.
  process.exitCode = response.code ?? 0;
}
`;

export function makeFakeGh(dir: string) {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, "gh"), SCRIPT);
	chmodSync(join(bin, "gh"), 0o755);
	writeFileSync(join(dir, "calls.jsonl"), "");
	process.env.FAKE_GH_DIR = dir;
	process.env.PATH = `${bin}:${process.env.PATH}`;
	const api = {
		/** Replace the scripted answers (first matching rule wins) and forget earlier counters and calls. */
		script(rules: Rule[]): void {
			writeFileSync(join(dir, "rules.json"), JSON.stringify(rules));
			writeFileSync(join(dir, "state.json"), "{}");
			writeFileSync(join(dir, "calls.jsonl"), "");
		},
		calls(): string[] {
			return readFileSync(join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => (JSON.parse(line) as string[]).join(" "));
		},
		callsMatching(pattern: RegExp): string[] {
			return api.calls().filter((call) => pattern.test(call));
		},
	};
	return api;
}

type Definition = { definition: { initial: () => unknown } };

/** An in-memory harness: `snapshot` and `commit` over plain objects, enough for the daemon's document use. */
export function makeStore() {
	const docs = new Map<Definition, unknown>();
	const read = (doc: Definition) => {
		if (!docs.has(doc)) docs.set(doc, doc.definition.initial());
		return docs.get(doc);
	};
	const store = {
		seed<T>(doc: Definition, value: T): void {
			docs.set(doc, value);
		},
		peek<T>(doc: Definition): T {
			return read(doc) as T;
		},
		async snapshot(doc: Definition): Promise<unknown> {
			return read(doc);
		},
		async commit<T>(callback: (tx: { doc: (doc: Definition) => Promise<unknown> }) => Promise<T> | T): Promise<T> {
			return callback({ doc: async (doc) => read(doc) });
		},
	};
	return store;
}

/** Parse the audit log (JSON lines) at `file`. */
export function readAudit(file: string): { event: string; [key: string]: unknown }[] {
	try {
		return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { event: string });
	} catch {
		return [];
	}
}

export function clearAudit(file: string): void {
	writeFileSync(file, "");
	appendFileSync(file, "");
}
