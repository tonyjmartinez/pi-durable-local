// Process management for pd-ui: what is running, its log, and start/stop/restart.
// This deliberately does not go through the daemon: the panel must work when the daemon is down or wedged.
import { execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DATA_DIR, SOCKET_PATH } from "./config.ts";
import { redact } from "./redact.ts";

export type ProcessInfo = {
	name: "supervisor" | "daemon" | "ui";
	pid: number | null;
	running: boolean;
	/** Elapsed time as `ps` prints it, for example `02:13:05` or `1-04:00:00`. */
	uptime: string | null;
	rssMb: number | null;
};

export type ProcessReport = { processes: ProcessInfo[]; socketReachable: boolean; logFile: string };
export type Action = "start" | "stop" | "restart";

export type ProcessOptions = {
	dataDir?: string;
	socketPath?: string;
	/** The supervisor script; defaults to this checkout's `bin/pdd-up`. */
	pddUp?: string;
	/** Runs a command and returns its output; replaced in tests. */
	run?: (file: string, args: string[]) => Promise<string>;
	/** The UI's own pid, replaceable in tests. */
	selfPid?: number;
};

const defaultPddUp = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "pdd-up");

function defaultRun(file: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { timeout: 30_000, env: { ...process.env, PD_DATA_DIR: process.env.PD_DATA_DIR ?? DATA_DIR } }, (error, stdout, stderr) => {
			if (error) reject(new Error(`${stderr.trim() || stdout.trim() || error.message}`.slice(0, 500)));
			else resolve(stdout);
		});
	});
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readPid(file: string): number | null {
	try {
		const pid = Number(readFileSync(file, "utf8").trim());
		return Number.isInteger(pid) && pid > 1 ? pid : null;
	} catch {
		return null;
	}
}

async function describe(name: ProcessInfo["name"], pid: number | null, run: NonNullable<ProcessOptions["run"]>): Promise<ProcessInfo> {
	if (pid === null || !alive(pid)) return { name, pid, running: false, uptime: null, rssMb: null };
	try {
		const [etime = "", rss = ""] = (await run("ps", ["-o", "etime=,rss=", "-p", String(pid)])).trim().split(/\s+/);
		return { name, pid, running: true, uptime: etime || null, rssMb: rss ? Math.round(Number(rss) / 1024) : null };
	} catch {
		return { name, pid, running: true, uptime: null, rssMb: null };
	}
}

function socketAnswers(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		const done = (ok: boolean) => {
			socket.destroy();
			resolve(ok);
		};
		socket.setTimeout(1000, () => done(false));
		socket.on("connect", () => done(true));
		socket.on("error", () => done(false));
	});
}

export async function listProcesses(options: ProcessOptions = {}): Promise<ProcessReport> {
	const dataDir = options.dataDir ?? DATA_DIR;
	const run = options.run ?? defaultRun;
	// The pidfile holds the supervisor loop; the daemon is its child.
	const supervisorPid = readPid(join(dataDir, "pdd.pid"));
	let daemonPid: number | null = null;
	if (supervisorPid !== null && alive(supervisorPid)) {
		try {
			daemonPid = Number((await run("pgrep", ["-P", String(supervisorPid)])).trim().split("\n")[0]) || null;
		} catch {
			daemonPid = null;
		}
	}
	const [supervisor, daemon, ui] = await Promise.all([
		describe("supervisor", supervisorPid, run),
		describe("daemon", daemonPid, run),
		describe("ui", options.selfPid ?? process.pid, run),
	]);
	return { processes: [supervisor, daemon, ui], socketReachable: await socketAnswers(options.socketPath ?? SOCKET_PATH), logFile: join(dataDir, "pdd.log") };
}

/** The last `lines` lines of the daemon log, with secrets masked. Reads only the file's tail. */
export function tailLog(file: string, lines = 200): string {
	if (!existsSync(file)) return "";
	const limit = Math.min(Math.max(Math.trunc(lines) || 200, 1), 2000);
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, 256 * 1024);
		const buffer = Buffer.alloc(length);
		readSync(fd, buffer, 0, length, size - length);
		const text = buffer.toString("utf8");
		const all = (length < size ? text.slice(text.indexOf("\n") + 1) : text).split("\n");
		return redact(all.slice(-limit).join("\n"));
	} finally {
		closeSync(fd);
	}
}

/** Start, stop or restart the daemon through the same supervisor script `pd` uses. */
export async function control(action: Action, options: ProcessOptions = {}): Promise<string> {
	const run = options.run ?? defaultRun;
	const script = options.pddUp ?? defaultPddUp;
	const out: string[] = [];
	if (action === "stop" || action === "restart") out.push((await run(script, ["stop"])).trim());
	if (action === "start" || action === "restart") out.push((await run(script, [])).trim());
	return out.filter(Boolean).join("; ");
}
