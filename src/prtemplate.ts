// The PR description agents fill in, a lenient parser for it, and the risk tier a diff earns on its own.
// The template's fields (Intent, Door, Cleanup, Why, Testing, System recap) follow Kent C. Dodds's autopilot
// PR template (https://github.com/kentcdodds/kcd-skills, MIT).
import { protectedMatches } from "./guard.ts";

export type Tier = "low" | "medium" | "high";
export type Door = "two-way" | "one-way";
export type TouchKind = "composes" | "extends" | "adds";

export type ParsedPr = {
	intent?: string;
	door?: Door;
	cleanup?: string;
	why?: string;
	testing?: { text: string; ranNothing: boolean };
	risk?: Tier;
	touches?: { area: string; kind: TouchKind }[];
	/** Required fields that are absent or still the template's placeholder: intent, door, why, testing, risk, touches. */
	missing: string[];
	/**
	 * One line per field that needs fixing, keyed by field name, each with an example. Every `missing` field has one,
	 * and so does a Testing section that says nothing was run (present, so not in `missing`). Empty when all is well.
	 */
	hints: Record<string, string>;
};

export const PR_TEMPLATE = `## Intent

<What the PR does, one or two sentences.>

Door: <two-way | one-way>
<!-- one-way: data, contracts, security, money, public API, store release -->

Cleanup: <none | needed (#issue) | done>

## Why

<Why now, and what it unblocks.>

## Testing

<Commands run and their result: tests and typecheck, then proof you ran the change itself. What data you used. Why any
test expectation changed. Say what you could not verify.>

## System recap

Risk: <low | medium | high>
Touches: <primitive or area> (<composes | extends | adds>)

<!-- composes = uses existing pieces as designed (low). extends = changes an existing piece's behavior or contract
(medium). adds = a new piece, data store, external service, or trust boundary (high). -->
`;

type Section = "intent" | "door" | "cleanup" | "why" | "testing" | "recap";

const SECTION_NAMES: Record<Section, string> = {
	intent: "intent|summary|what",
	door: "door",
	cleanup: "cleanup",
	why: "why|motivation|rationale",
	testing: "testing|tests?|test plan|how (?:it was )?tested|verification",
	recap: "system recap|recap",
};

const BOLD = "(?:\\*\\*|__)";
const ALL_NAMES = Object.values(SECTION_NAMES).join("|");
const HEADING = new RegExp(`^\\s{0,3}#{1,6}\\s*${BOLD}?(${ALL_NAMES})${BOLD}?\\b[ \\t]*:?[ \\t]*(.*)$`, "i");
// `Door: x`, `**Door:** x`, `**Door** x`, `- Door: x`; bare prose that merely starts with a name does not match.
const LABEL = new RegExp(`^\\s*(?:[-*+]\\s+)?${BOLD}?(${ALL_NAMES})(?:[ \\t]*:[ \\t]*${BOLD}?|${BOLD}[ \\t]*:?)[ \\t]*(.*)$`, "i");

function sectionOf(name: string): Section {
	const lower = name.toLowerCase();
	for (const [section, pattern] of Object.entries(SECTION_NAMES) as [Section, string][]) {
		if (new RegExp(`^(?:${pattern})$`, "i").test(lower)) return section;
	}
	return "intent";
}

/** Template placeholders are `<...>` spans; a value that is only placeholders is unfilled. */
const stripPlaceholders = (text: string) => text.replace(/<[^<>]*>/g, "").trim();

function firstLine(text: string): string {
	return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "";
}

function parseDoor(value: string): Door | undefined {
	const text = stripPlaceholders(value).toLowerCase();
	const one = /\bone[- ]?way\b/.test(text);
	const two = /\b(?:two|2)[- ]?way\b/.test(text);
	if (one === two) return undefined;
	return one ? "one-way" : "two-way";
}

function parseRisk(text: string): Tier | undefined {
	const match = /\brisk\b\**\s*:?\s*\**\s*(low|medium|high)\b/i.exec(stripPlaceholders(text));
	return match === null ? undefined : (match[1]!.toLowerCase() as Tier);
}

function parseTouches(text: string): { area: string; kind: TouchKind }[] {
	const out: { area: string; kind: TouchKind }[] = [];
	const clean = stripPlaceholders(text);
	const start = /\btouches\b\**\s*:?\s*\**/i.exec(clean);
	if (start === null) return out;
	// Everything after "Touches:" up to the next labelled line, so wrapped and bulleted lists both work.
	const rest = clean.slice(start.index + start[0].length).split(/\n\s*\n|\n\s*(?:risk|door|cleanup)\b/i)[0]!;
	for (const match of rest.matchAll(/([^;()\n]+?)\s*[([]\s*(composes|extends|adds)\s*[)\]]/gi)) {
		const area = match[1]!.replace(/^[\s,;\-*+•]+|^and\s+/gi, "").replace(/[\s*_`]+$/g, "").trim();
		if (area !== "") out.push({ area, kind: match[2]!.toLowerCase() as TouchKind });
	}
	if (out.length === 0) {
		for (const line of rest.split("\n")) {
			const match = /^[\s\-*+•]*(.+?)\s*(?:[-–—:])\s*(composes|extends|adds)\b/i.exec(line);
			if (match !== null && match[1]!.trim() !== "") out.push({ area: match[1]!.trim(), kind: match[2]!.toLowerCase() as TouchKind });
		}
	}
	return out;
}

const NOTHING_RAN = /^(?:none|n\/a|na|nothing|untested|not (?:run|tested|yet)|did(?: not|n'?t) (?:run|test)|no tests?(?: (?:run|added))?|tbd|todo|-+)\.?$/i;

export function parsePrBody(body: string): ParsedPr {
	const text = body.replace(/\r\n?/g, "\n").replace(/<!--[\s\S]*?-->/g, "");
	const sections: Partial<Record<Section, string[]>> = {};
	let current: Section | undefined;
	let fenced = false;
	for (const line of text.split("\n")) {
		if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced;
		const start = fenced ? null : (HEADING.exec(line) ?? LABEL.exec(line));
		if (start !== null) {
			current = sectionOf(start[1]!);
			const initial = start[2]!.replace(/^\s*\(.*$/, "");
			sections[current] = [...(sections[current] ?? []), initial];
			continue;
		}
		if (current !== undefined) sections[current]!.push(line);
	}
	const get = (section: Section): string => (sections[section] ?? []).join("\n").trim();

	const intentText = stripPlaceholders(get("intent"));
	const whyText = stripPlaceholders(get("why"));
	const testingRaw = get("testing");
	const testingText = stripPlaceholders(testingRaw);
	const cleanupText = stripPlaceholders(firstLine(get("cleanup")));
	const recap = get("recap");
	// Risk and Touches normally sit in the recap, but accept them anywhere in the body.
	const riskSource = parseRisk(recap) !== undefined ? recap : text;
	const touchSource = parseTouches(recap).length > 0 ? recap : text;

	const parsed: ParsedPr = { missing: [], hints: {} };
	if (intentText !== "") parsed.intent = intentText;
	const door = parseDoor(firstLine(get("door")));
	if (door !== undefined) parsed.door = door;
	if (cleanupText !== "") parsed.cleanup = cleanupText;
	if (whyText !== "") parsed.why = whyText;
	if (testingText !== "") {
		parsed.testing = { text: testingText, ranNothing: NOTHING_RAN.test(firstLine(testingText)) && testingText.split("\n").filter((l) => l.trim()).length === 1 };
	}
	const risk = parseRisk(riskSource);
	if (risk !== undefined) parsed.risk = risk;
	const touches = parseTouches(touchSource);
	if (touches.length > 0) parsed.touches = touches;

	for (const [field, present] of [
		["intent", parsed.intent],
		["door", parsed.door],
		["why", parsed.why],
		["testing", parsed.testing],
		["risk", parsed.risk],
		["touches", parsed.touches],
	] as const) {
		if (present === undefined) parsed.missing.push(field);
	}

	const clean = stripPlaceholders(text);
	const hints = parsed.hints;
	if (parsed.intent === undefined) hints.intent = "Add a `## Intent` section: one or two sentences on what this PR does.";
	if (parsed.why === undefined) hints.why = "Add a `## Why` section: why now, and what it unblocks.";
	if (parsed.door === undefined) hints.door = doorHint(stripPlaceholders(firstLine(get("door"))));
	if (parsed.testing === undefined) {
		hints.testing = "Add a `## Testing` section listing the commands you ran and their results, e.g. `npm test: 125 passing`, and what you could not verify.";
	} else if (parsed.testing.ranNothing) {
		hints.testing = "Testing says nothing was run. List the commands you actually ran and their results, e.g. `npm test: 125 passing`.";
	}
	if (parsed.risk === undefined) hints.risk = riskHint(labelValue(clean, "risk"));
	if (parsed.touches === undefined) hints.touches = touchesHint(labelValue(clean, "touches"));
	return parsed;
}

/** What follows `Label:` on its line, or undefined when the label is absent. */
function labelValue(text: string, label: string): string | undefined {
	// Same line only: a label with nothing after it must not pick up the next line.
	const match = new RegExp(`\\b${label}\\b\\**[ \\t]*:[ \\t]*\\**[ \\t]*([^\\n]*)`, "i").exec(text);
	// Template placeholders leave empty parentheses behind; they say nothing.
	return match === null ? undefined : match[1]!.replace(/\(\s*\)/g, "").replace(/[*_`]+$/g, "").replace(/\s+/g, " ").trim();
}

const excerpt = (value: string, max = 50) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/** The area as the agent wrote it, without its commentary, backticks or the rest of the sentence. */
function areaOf(given: string): string {
	const plain = given.replace(/[`*_]/g, "");
	const cut = (plain.split(/\s*\(|\.\s|\s[-\u2013\u2014]\s|;/)[0] ?? plain).trim().replace(/[.,]+$/, "");
	return excerpt(cut === "" ? plain.trim() : cut, 40);
}

function doorHint(given: string): string {
	if (given === "") return "Add a line `Door: two-way` (easy to revert) or `Door: one-way` (data, contracts, security, money, public API, release).";
	const lower = given.toLowerCase();
	if (/\bone[- ]?way\b/.test(lower) && /\b(?:two|2)[- ]?way\b/.test(lower)) return "Door names both values; write exactly one, e.g. `Door: two-way`.";
	return `Door must say two-way or one-way, not "${excerpt(given, 40)}". Example: \`Door: two-way\`.`;
}

function riskHint(given: string | undefined): string {
	if (given === undefined || given === "") {
		return "Add `Risk: low` (or medium or high) under `## System recap`: low uses existing pieces, medium changes one, high adds a new piece or trust boundary.";
	}
	return `Risk must be low, medium or high, not "${excerpt(given, 30)}". Example: \`Risk: low\`.`;
}

function touchesHint(given: string | undefined): string {
	if (given === undefined || given === "") {
		return "Add `Touches: <area> (composes|extends|adds)` under `## System recap`, e.g. `Touches: parser (composes)`.";
	}
	const area = areaOf(given);
	const kind = /\(\s*([A-Za-z-]+)\s*\)\s*[.;]?\s*$/.exec(given)?.[1];
	if (kind !== undefined) return `Touches kind must be composes, extends or adds, not "(${kind})". Example: \`Touches: ${area} (composes)\`.`;
	return `Touches needs a kind in parentheses after the area: composes (uses existing pieces), extends (changes one) or adds (a new piece). Example: \`Touches: ${area} (composes)\`.`;
}

/** The hints as lines for an error message, in field order: `- touches: ...`. Empty when there are none. */
export function formatHints(parsed: Pick<ParsedPr, "hints">): string {
	const order = ["intent", "door", "why", "testing", "risk", "touches"];
	return order.filter((field) => parsed.hints[field] !== undefined).map((field) => `- ${field}: ${parsed.hints[field]}`).join("\n");
}

export type RiskFile = { filename: string; previous_filename?: string };

export type RiskInput = {
	files: readonly RiskFile[];
	additions: number;
	deletions: number;
	protectedPaths: readonly string[];
	/** The diff adds or changes a dependency (a manifest dependency section or a lockfile). */
	newDependencies: boolean;
};

export type RiskThresholds = {
	/** More changed lines than this is high. */
	highLines: number;
	/** More changed lines than this is medium. */
	mediumLines: number;
};

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = { highLines: 400, mediumLines: 100 };

const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py|rb)$/i;
const CONFIG_FILE = /(?:^|\/)(?:tsconfig[^/]*\.json|[^/]*\.config\.[cm]?[jt]s|\.eslintrc[^/]*|\.oxlintrc[^/]*|\.prettierrc[^/]*|\.editorconfig|\.gitignore|\.npmrc|\.nvmrc|[^/]*\.ya?ml|[^/]*\.toml)$/i;

/** `src/web.ts`, `test/web.test.ts`, and `web_test.go` all share the stem `web`. */
function stemOf(path: string): string {
	const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
	return base
		.replace(/\.[^.]+$/, "")
		.replace(/\.(?:test|spec)$/, "")
		.replace(/^test_/, "")
		.replace(/_test$/, "");
}

const TIER_ORDER: Record<Tier, number> = { low: 0, medium: 1, high: 2 };
export const maxTier = (...tiers: Tier[]): Tier => tiers.reduce((a, b) => (TIER_ORDER[b] > TIER_ORDER[a] ? b : a), "low");

/** The tier a diff earns by itself. An agent's declared risk may only raise it (see effectiveRisk). */
export function riskFloor(input: RiskInput, thresholds: Partial<RiskThresholds> = {}): { tier: Tier; reasons: string[] } {
	const { highLines, mediumLines } = { ...DEFAULT_RISK_THRESHOLDS, ...thresholds };
	const high: string[] = [];
	const medium: string[] = [];

	// A rename out of a protected path still touches it, so both names count.
	const names = input.files.flatMap((file) => (file.previous_filename === undefined ? [file.filename] : [file.filename, file.previous_filename]));
	const protectedHits = [...new Set(protectedMatches(names, input.protectedPaths))];
	if (protectedHits.length > 0) high.push(`touches protected paths: ${protectedHits.join(", ")}`);
	if (input.newDependencies) high.push("adds or changes a dependency");
	const lines = input.additions + input.deletions;
	if (lines > highLines) high.push(`${lines} changed lines > ${highLines}`);
	else if (lines > mediumLines) medium.push(`${lines} changed lines > ${mediumLines}`);

	const tests = input.files.filter((file) => TEST_FILE.test(file.filename));
	const subjects = new Set(input.files.filter((file) => !TEST_FILE.test(file.filename) && !/\.(?:md|txt|json)$/i.test(file.filename)).map((file) => stemOf(file.filename)));
	const paired = tests.filter((file) => subjects.has(stemOf(file.filename)));
	if (paired.length > 0) medium.push(`test expectations changed alongside the code they test: ${paired.map((file) => file.filename).join(", ")}`);

	const configs = input.files.filter((file) => CONFIG_FILE.test(file.filename) && !protectedHits.includes(file.filename));
	if (configs.length > 0) medium.push(`config files changed: ${configs.map((file) => file.filename).join(", ")}`);

	if (high.length > 0) return { tier: "high", reasons: [...high, ...medium] };
	if (medium.length > 0) return { tier: "medium", reasons: medium };
	return { tier: "low", reasons: [] };
}

/** The tier a PR is handled at: the diff's own floor, raised (never lowered) by what the author declared. */
export function effectiveRisk(floor: Tier | { tier: Tier }, declared?: Tier): Tier {
	const base = typeof floor === "string" ? floor : floor.tier;
	return declared === undefined ? base : maxTier(base, declared);
}
