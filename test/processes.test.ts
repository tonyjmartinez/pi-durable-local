// The Processes tab: pidfile reading, log tailing with redaction, and control through an injected runner.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { control, listProcesses, tailLog } from "../src/processes.ts";

let dir: string;
before(() => {
	dir = mkdtempSync(join(tmpdir(), "pd-proc-"));
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe("listProcesses", () => {
	it("reports a missing pidfile as not running, and always lists the ui", async () => {
		const report = await listProcesses({ dataDir: dir, socketPath: join(dir, "none.sock"), run: async () => "00:05 2048" });
		const byName = Object.fromEntries(report.processes.map((p) => [p.name, p]));
		assert.equal(byName.supervisor?.running, false);
		assert.equal(byName.daemon?.running, false);
		assert.equal(byName.ui?.running, true);
		assert.equal(byName.ui?.rssMb, 2);
		assert.equal(report.socketReachable, false);
	});

	it("finds the daemon as the supervisor's child", async () => {
		writeFileSync(join(dir, "pdd.pid"), `${process.pid}\n`);
		const calls: string[] = [];
		const report = await listProcesses({
			dataDir: dir,
			socketPath: join(dir, "none.sock"),
			run: async (file, args) => {
				calls.push(`${file} ${args.join(" ")}`);
				return file === "pgrep" ? `${process.pid}\n` : "01:00:00 1024";
			},
		});
		assert.ok(calls.some((c) => c.startsWith(`pgrep -P ${process.pid}`)));
		assert.equal(report.processes.find((p) => p.name === "daemon")?.uptime, "01:00:00");
	});

	it("treats a stale pid as not running", async () => {
		writeFileSync(join(dir, "pdd.pid"), "999999\n");
		const report = await listProcesses({ dataDir: dir, socketPath: join(dir, "none.sock"), run: async () => "" });
		assert.equal(report.processes.find((p) => p.name === "supervisor")?.running, false);
	});
});

describe("tailLog", () => {
	it("returns the last lines and masks secrets", () => {
		const file = join(dir, "pdd.log");
		const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
		lines.push("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
		writeFileSync(file, lines.join("\n"));
		const out = tailLog(file, 5);
		assert.equal(out.split("\n").length, 5);
		assert.ok(out.includes("line 49"));
		assert.ok(!out.includes("abcdefghijklmnop"));
	});

	it("returns an empty string when there is no log", () => assert.equal(tailLog(join(dir, "missing.log")), ""));
});

describe("control", () => {
	it("restart stops, then starts", async () => {
		const calls: string[][] = [];
		await control("restart", { pddUp: "/x/pdd-up", run: async (_f, args) => (calls.push(args), "ok") });
		assert.deepEqual(calls, [["stop"], []]);
	});

	it("stop only stops, start only starts", async () => {
		const calls: string[][] = [];
		const run = async (_f: string, args: string[]) => (calls.push(args), "");
		await control("stop", { pddUp: "/x", run });
		await control("start", { pddUp: "/x", run });
		assert.deepEqual(calls, [["stop"], []]);
	});
});
