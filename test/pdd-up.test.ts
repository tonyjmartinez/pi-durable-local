// bin/pdd-up: one supervisor per data dir, found by process; stop ends the loop and its daemon. Uses a fake node.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

it("pdd-up refuses a second supervisor and stop ends every one", () => {
	const tmp = mkdtempSync(join(tmpdir(), "pdd-up-"));
	mkdirSync(join(tmp, "bin"));
	writeFileSync(join(tmp, "bin", "node"), "#!/bin/sh\nexec sleep 300\n");
	chmodSync(join(tmp, "bin", "node"), 0o755);
	const env = { ...process.env, PD_DATA_DIR: join(tmp, "data"), PATH: `${join(tmp, "bin")}:${process.env.PATH}` };
	const pddUp = (...args: string[]) => spawnSync(resolve("bin/pdd-up"), args, { env, encoding: "utf8" }).stdout;
	const alive = () => spawnSync("pgrep", ["-f", `pdd-up-supervisor .*${tmp}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
	try {
		assert.match(pddUp(), /started/);
		execFileSync("rm", ["-f", join(tmp, "data", "pdd.pid")]); // the old bug: a lost pidfile
		assert.match(pddUp(), /already running/);
		assert.equal(alive().length, 1);
		assert.match(pddUp("stop"), /stopped/);
		spawnSync("sleep", ["0.5"]);
		assert.equal(alive().length, 0);
	} finally {
		pddUp("stop");
		rmSync(tmp, { recursive: true, force: true });
	}
});
