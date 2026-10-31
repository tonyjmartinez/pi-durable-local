// Find diffs that make tests weaker instead of making code right: a skipped or focused test, a retry, a disabled
// check, a lowered coverage threshold. The daemon parks such PRs for a human, whoever wrote them. Maintenance loops
// (code-quality, ci-health) also may not delete tests or assertions, or silence the type checker and linter.

export type PatchFile = { filename: string; patch?: string };

const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)\/|[._-](test|spec|e2e)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/i;
const COVERAGE_CONFIG = /(^|\/)(vitest|jest|vite|karma|playwright)\.config\.|(^|\/)\.?(nycrc|c8rc)|(^|\/)package\.json$|(^|\/)(pyproject\.toml|setup\.cfg|\.coveragerc|codecov\.ya?ml)$/i;

/** Added code that turns a test off or makes failures pass. Checked in test files and test configs. */
const WEAKENING_IN_TESTS: readonly { pattern: RegExp; what: string }[] = [
	{ pattern: /\b(it|test|describe|context|suite)\.(skip|only|todo|fixme)\b/, what: "skipped, focused or todo test" },
	{ pattern: /\b(xit|xtest|xdescribe|fit|fdescribe)\s*\(/, what: "skipped or focused test" },
	{ pattern: /[{,(]\s*(skip|only|todo)\s*:\s*true\b/, what: "skipped, focused or todo test" },
	{ pattern: /\bt\.(skip|todo)\s*\(/, what: "skipped test" },
	{ pattern: /@pytest\.mark\.(skip|skipif|xfail)\b|\bpytest\.skip\s*\(/, what: "skipped test" },
	{ pattern: /\bt\.Skip(Now|f)?\s*\(/, what: "skipped test" },
	// Test-runner retries only: a test of the code's own retry logic (retries: 3 in a fixture) is fine.
	{ pattern: /\.retries\s*\(\s*[1-9]|\bjest\.retryTimes\s*\(|\.configure\s*\(\s*\{[^}]*\bretries\s*:\s*[1-9]|@pytest\.mark\.flaky\b|@flaky\b/, what: "test retries" },
];

/** In a test-runner config, any retry setting is a retry. */
const CONFIG_RETRIES = /\bretr(y|ies)\s*:\s*[1-9]/;

/** Added anywhere: makes a run without tests count as green. */
const PASS_WITHOUT_TESTS = /--passWithNoTests|--pass-with-no-tests|\bpassWithNoTests\s*:\s*true/;

/** Stricter, for maintenance PRs: silencing the type checker or linter. */
const SILENCING = /@ts-(ignore|nocheck|expect-error)\b|eslint-disable|biome-ignore|#\s*type:\s*ignore|#\s*noqa\b|\/\/\s*nolint\b/;

const TEST_BLOCK = /\b(it|test)(\.each\b[^(]*)?\s*\(\s*["'`]|^\s*(async\s+)?def\s+test_|^\s*func\s+Test[A-Z_]/;
const ASSERTION = /\bexpect\s*\(|\bassert(\.\w+)?\s*\(|^\s*assert\s|\bt\.(Error|Fatal|Fail)/;
const THRESHOLD = /["']?\b(lines|branches|functions|statements|fail_under|minimum_coverage|threshold)["']?\s*[:=]\s*(\d+(?:\.\d+)?)/i;

function changedLines(patch: string): { added: string[]; removed: string[] } {
	const added: string[] = [];
	const removed: string[] = [];
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added.push(line.slice(1));
		else if (line.startsWith("-")) removed.push(line.slice(1));
	}
	return { added, removed };
}

/** Lines that only moved (removed and added unchanged) are not new: a reindent must not flag an old skip. */
function newOnly(added: readonly string[], removed: readonly string[]): string[] {
	const pool = new Map<string, number>();
	for (const line of removed) pool.set(line.trim(), (pool.get(line.trim()) ?? 0) + 1);
	return added.filter((line) => {
		const left = pool.get(line.trim()) ?? 0;
		if (left === 0) return true;
		pool.set(line.trim(), left - 1);
		return false;
	});
}

const count = (lines: readonly string[], pattern: RegExp) => lines.filter((line) => pattern.test(line)).length;

/**
 * Reasons the diff weakens tests; empty when it does not. `strict` adds the maintenance-loop rules: no net loss of
 * tests or assertions, no silenced checks, and a test file whose diff GitHub did not return counts as unverified.
 */
export function testWeakening(files: readonly PatchFile[], options: { strict?: boolean } = {}): string[] {
	const reasons: string[] = [];
	let testsRemoved = 0;
	let assertionsRemoved = 0;
	for (const file of files) {
		const isTest = TEST_FILE.test(file.filename);
		const isCoverage = COVERAGE_CONFIG.test(file.filename);
		if (file.patch === undefined) {
			if (options.strict === true && isTest) reasons.push(`${file.filename}: diff too large to check for weakened tests`);
			continue;
		}
		const { added, removed } = changedLines(file.patch);
		const fresh = newOnly(added, removed);
		const found = new Set<string>();
		if (isTest || isCoverage) for (const rule of WEAKENING_IN_TESTS) if (fresh.some((line) => rule.pattern.test(line))) found.add(rule.what);
		if (fresh.some((line) => PASS_WITHOUT_TESTS.test(line))) found.add("passes with no tests");
		if (isCoverage && !file.filename.endsWith("package.json") && fresh.some((line) => CONFIG_RETRIES.test(line))) found.add("test retries");
		if (isCoverage) {
			const before = new Map<string, number>();
			for (const line of removed) {
				const m = THRESHOLD.exec(line);
				if (m) before.set(m[1]!.toLowerCase(), Number(m[2]));
			}
			for (const line of added) {
				const m = THRESHOLD.exec(line);
				const old = m ? before.get(m[1]!.toLowerCase()) : undefined;
				if (m && old !== undefined && Number(m[2]) < old) found.add(`coverage threshold ${m[1]} lowered from ${old} to ${m[2]}`);
			}
		}
		if (options.strict === true) {
			if (fresh.some((line) => SILENCING.test(line))) found.add("silences the type checker or linter");
			if (isTest) {
				testsRemoved += count(removed, TEST_BLOCK) - count(added, TEST_BLOCK);
				assertionsRemoved += count(removed, ASSERTION) - count(added, ASSERTION);
			}
		}
		for (const what of found) reasons.push(`${file.filename}: ${what}`);
	}
	if (testsRemoved > 0) reasons.push(`removes ${testsRemoved} test${testsRemoved === 1 ? "" : "s"} (maintenance PRs may not delete tests)`);
	else if (assertionsRemoved > 0) reasons.push(`removes ${assertionsRemoved} assertion${assertionsRemoved === 1 ? "" : "s"} (maintenance PRs may not weaken tests)`);
	return reasons;
}
