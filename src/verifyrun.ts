// Verification evidence for a PR: which command proves a change, and what to write in the Testing section about
// having run it. Pure: running the command is the caller's job.
import { redact } from "./redact.ts";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";
export type Argv = readonly string[];

/** One script name tried before the rest, in this order. Each is a repo's own "does everything" entry point. */
export const SINGLE_SCRIPTS = ["verify", "check", "ci", "validate"] as const;
/** Otherwise run whichever of these exist, cheapest first. */
export const PARTS = [
	["typecheck", "type-check", "tsc", "types"],
	["lint"],
	["test"],
	["build"],
] as const;

const NO_TEST_PLACEHOLDER = /no test specified/i;

/** The package manager named by package.json's `packageManager` field ("pnpm@9.1.0"), defaulting to npm. */
export function packageManagerOf(field: string | undefined): PackageManager {
	const name = field?.split("@")[0]?.trim();
	return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm";
}

const run = (manager: PackageManager, script: string): Argv => [manager, "run", script];

function usable(scripts: Readonly<Record<string, string>>, name: string): boolean {
	const body = scripts[name];
	return typeof body === "string" && body.trim() !== "" && !NO_TEST_PLACEHOLDER.test(body);
}

function fromOverride(override: unknown): Argv[] | undefined {
	if (!Array.isArray(override) || override.length === 0) return undefined;
	const isArgv = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string" && part !== "");
	if (isArgv(override)) return [override];
	return override.every(isArgv) ? (override as string[][]) : undefined;
}

/**
 * The commands that prove a change, each as an argv (never a shell string). A policy override wins when it is a
 * non-empty argv or a list of argvs. Otherwise: the first of verify, check, ci, validate; failing those, typecheck,
 * lint, test and build, whichever exist. Returns [] when the repo has nothing to run.
 */
export function pickVerifyCommand(
	scripts: Readonly<Record<string, string>> | undefined,
	policyOverride?: unknown,
	options: { packageManager?: string } = {},
): Argv[] {
	const override = fromOverride(policyOverride);
	if (override !== undefined) return override;
	if (scripts === undefined || scripts === null || typeof scripts !== "object" || Array.isArray(scripts)) return [];
	const manager = packageManagerOf(options.packageManager);
	for (const name of SINGLE_SCRIPTS) if (usable(scripts, name)) return [run(manager, name)];
	const commands: Argv[] = [];
	for (const alternatives of PARTS) {
		const found = alternatives.find((name) => usable(scripts, name));
		if (found !== undefined) commands.push(run(manager, found));
	}
	return commands;
}

/** An argv as one readable command, quoting only what needs it. */
export function argvToString(argv: Argv): string {
	return argv.map((part) => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, "'\\''")}'`)).join(" ");
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const FAILURE = /\b(?:fail(?:ed|ing|ure|ures)?|errors?|assertion|exception|panic|not ok)\b|✖|✗|✘|\bTS\d{4}\b|^\s*(?:x|×)\s/i;
const ZERO_FAILURES = /\b(?:fail(?:ed|ures?)?|errors?)\s*[:=]?\s*0\b|\b0\s+(?:fail(?:ed|ures?)?|errors?)\b|\bno errors\b/i;
const SUMMARY = /\b\d+\s+(?:passed|passing|pass|failed|failing|tests?|suites?|specs?|files?)\b|\b(?:tests?|pass|passed|fail|failed|suites?|duration|time)\b\s*[:=]?\s*\d|\ball (?:checks|tests) passed\b|\bfound 0 errors\b|✓|✔/i;

export type SummaryOptions = {
	/** The text this returns is capped at this many characters. Default 1500. */
	maxChars?: number;
	/** At most this many output lines are quoted. Default 12. */
	maxLines?: number;
	/** The command was killed for running too long. */
	timedOut?: boolean;
};

const clean = (line: string) => redact(line.replace(ANSI, "")).replace(/\s+$/, "");

function keyLines(lines: readonly string[], passed: boolean, max: number): string[] {
	const tail = lines.slice(-400);
	const wanted = passed
		? tail.filter((line) => SUMMARY.test(line))
		: tail.filter((line) => FAILURE.test(line) && !ZERO_FAILURES.test(line));
	let chosen = wanted.slice(-max);
	if (chosen.length === 0) chosen = tail.slice(-Math.min(3, max));
	// A failure's last line is usually the verdict (an exit message, a summary), so keep it.
	const last = tail.at(-1);
	if (!passed && last !== undefined && !chosen.includes(last)) chosen = [...chosen.slice(-(max - 1)), last];
	return chosen;
}

/** The Testing-section text for one command: what ran, whether it passed, and the few lines that matter. */
export function summarizeVerify(argv: Argv, exitCode: number | null | undefined, outputTail: string, options: SummaryOptions = {}): string {
	const maxChars = options.maxChars ?? 1500;
	const maxLines = options.maxLines ?? 12;
	const command = redact(argvToString(argv));
	const passed = exitCode === 0 && options.timedOut !== true;
	const verdict =
		options.timedOut === true ? "timed out"
		: exitCode === undefined || exitCode === null ? "did not finish (no exit code)"
		: passed ? "passed (exit 0)"
		: `FAILED (exit ${exitCode})`;
	const lines = outputTail.split(/\r?\n/).map(clean).filter((line) => line.trim() !== "");
	const picked = keyLines(lines, passed, maxLines).map((line) => (line.length > 200 ? `${line.slice(0, 199)}…` : line.trimStart()));
	const head = `\`${command}\`: ${verdict}`;
	if (picked.length === 0) return head.slice(0, maxChars);

	const fence = (body: string[]) => `${head}\n\`\`\`\n${body.join("\n")}\n\`\`\``;
	let text = fence(picked);
	// Over the cap: drop the oldest quoted lines first, then cut what is left.
	for (let drop = 1; text.length > maxChars && drop < picked.length; drop++) text = fence(picked.slice(drop));
	if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 5))}\n\`\`\``.slice(0, maxChars);
	return text;
}

export type VerifyRun = { argv: Argv; exitCode: number | null | undefined; outputTail: string; timedOut?: boolean };

/** Several commands as one Testing paragraph, with an overall verdict. */
export function summarizeVerifyRuns(runs: readonly VerifyRun[], options: SummaryOptions = {}): { passed: boolean; text: string } {
	if (runs.length === 0) return { passed: false, text: "No verify command was run: the repo defines none." };
	const passed = runs.every((r) => r.exitCode === 0 && r.timedOut !== true);
	const perRun = Math.max(300, Math.floor((options.maxChars ?? 1500) / runs.length));
	const parts = runs.map((r) => summarizeVerify(r.argv, r.exitCode, r.outputTail, { ...options, maxChars: perRun, timedOut: r.timedOut }));
	const overall = passed ? `All ${runs.length} verify command${runs.length === 1 ? "" : "s"} passed.` : `${runs.filter((r) => r.exitCode !== 0 || r.timedOut === true).length} of ${runs.length} verify commands failed.`;
	return { passed, text: [overall, ...parts].join("\n\n") };
}
