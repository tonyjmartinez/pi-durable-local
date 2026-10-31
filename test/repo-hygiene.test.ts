// The daemon runs from a checkout that pulls main, so a bad tracked path there stops every agent at once.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";

describe("repo hygiene", () => {
	it("tracks no symlinks: one committed node_modules link once replaced the real directory and stopped pdd", () => {
		const tracked = execFileSync("git", ["ls-files", "-s"], { encoding: "utf8" });
		const links = tracked.split("\n").filter((line) => line.startsWith("120000 ")).map((line) => line.split("\t")[1]);
		assert.deepEqual(links, []);
	});
});
