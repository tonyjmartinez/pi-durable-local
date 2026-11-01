// A repo's map for an agent starting cold: every tracked file with its line count, the purpose its header comment
// states, and its symbols with line numbers. Loop iterations start from a fresh context and used to spend about
// five turns re-exploring the repo with ls/grep/cat before their first edit; one repo_map call replaces most of that.
// Deterministic and local: git ls-files plus regexes, no model call, so it is free and never stale.
import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Past this the whole-repo map folds files into per-directory lines. */
export const MAP_BUDGET_CHARS = 8_000;
/** Symbols listed per file in the whole-repo map; a single-file map lists them all. */
const SYMBOLS_PER_FILE = 10;
const MAX_FILE_BYTES = 1_000_000;

const SKIP = /(^|\/)(node_modules|dist|build|coverage|vendor|\.next|\.astro|\.wrangler)\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|Cargo\.lock|go\.sum)$|\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp3|wav|ogg|mp4|zip|gz|pdf|map|min\.js|lock)$/i;

type Rule = { re: RegExp; group: number };
const JS: Rule[] = [
	{ re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([\w$]+)/, group: 1 },
	{ re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/, group: 1 },
	{ re: /^\s*export\s+(?:declare\s+)?(?:type|interface|enum)\s+([\w$]+)/, group: 1 },
	{ re: /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/, group: 1 },
	{ re: /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?function/, group: 1 },
	{ re: /^export\s+(?:const|let|var)\s+([\w$]+)/, group: 1 },
	{ re: /^(?:const|let|var)\s+([A-Z][A-Z0-9_]{2,})\s*=/, group: 1 },
	{ re: /^\s{2,}(?:async\s+)?(?:static\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/, group: 1 },
];
const RULES: Record<string, Rule[]> = {
	".ts": JS, ".tsx": JS, ".js": JS, ".jsx": JS, ".mjs": JS, ".cjs": JS, ".astro": JS, ".vue": JS, ".svelte": JS,
	".py": [{ re: /^\s*(?:async\s+)?def\s+(\w+)/, group: 1 }, { re: /^\s*class\s+(\w+)/, group: 1 }],
	".go": [{ re: /^func\s+(?:\([^)]*\)\s*)?(\w+)/, group: 1 }, { re: /^type\s+(\w+)/, group: 1 }],
	".rs": [{ re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/, group: 1 }, { re: /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+(\w+)/, group: 1 }],
	".dart": [{ re: /^\s*(?:abstract\s+)?class\s+(\w+)/, group: 1 }, { re: /^\s*(?:[\w<>?,\s]+\s)?(\w+)\s*\([^)]*\)\s*(?:async\s*)?\{\s*$/, group: 1 }],
	".md": [{ re: /^(#{1,3})\s+(.+?)\s*#*$/, group: 2 }],
	".sh": [{ re: /^\s*(?:function\s+)?([\w-]+)\s*\(\)\s*\{/, group: 1 }],
};
const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "function", "return", "constructor", "else", "do", "try"]);

export type FileMap = { path: string; lines: number; purpose?: string; symbols: { name: string; line: number; top: boolean }[] };

/** The header comment's first sentence, or a Markdown file's title. */
export function purposeOf(text: string, ext: string): string | undefined {
	const lines = text.split("\n", 40);
	if (ext === ".md") {
		const title = lines.find((line) => /^#\s+\S/.test(line));
		return title?.replace(/^#\s+/, "").trim();
	}
	const comment: string[] = [];
	for (const raw of lines) {
		const line = raw.trim();
		if (comment.length === 0 && (line === "" || line.startsWith("#!") || line === "---" || /^["']use strict["'];?$/.test(line))) continue;
		const body = /^(?:\/\/+|#(?!include)|\/\*\*?|\*(?!\/)|--|<!--)\s?(.*?)(?:\*\/|-->)?$/.exec(line);
		if (body === null) break;
		const value = body[1]!.trim();
		if (value === "" && comment.length > 0) break;
		if (value !== "" && !/^(eslint|@ts-|prettier|biome|jshint)/.test(value)) comment.push(value);
		if (/\*\/|-->/.test(line)) break;
	}
	if (comment.length === 0) return undefined;
	const joined = comment.join(" ");
	const sentence = /^(.{20,220}?[.!?])(\s|$)/.exec(joined)?.[1] ?? joined;
	return sentence.length > 220 ? `${sentence.slice(0, 219)}…` : sentence;
}

/** Named definitions with 1-based line numbers; `top` marks those that start at column 0 (or headings up to ##). */
export function symbolsOf(text: string, ext: string): FileMap["symbols"] {
	const rules = RULES[ext];
	if (rules === undefined) return [];
	const out: FileMap["symbols"] = [];
	const lines = text.split("\n");
	let fence = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (ext === ".md" && /^\s*(```|~~~)/.test(line)) fence = !fence;
		if (fence) continue;
		for (const rule of rules) {
			const match = rule.re.exec(line);
			const name = match?.[rule.group];
			if (name === undefined || NOT_NAMES.has(name)) continue;
			const top = ext === ".md" ? (match![1]?.length ?? 3) <= 2 : !/^\s/.test(line);
			out.push({ name: name.length > 60 ? `${name.slice(0, 59)}…` : name, line: i + 1, top });
			break;
		}
	}
	return out;
}

export function mapFile(cwd: string, path: string): FileMap | undefined {
	const full = join(cwd, path);
	let text: string;
	try {
		if (statSync(full).size > MAX_FILE_BYTES) return { path, lines: 0, purpose: "(over 1 MB, not scanned)", symbols: [] };
		text = readFileSync(full, "utf8");
	} catch {
		return undefined;
	}
	if (text.includes("\u0000")) return undefined;
	const ext = extname(path).toLowerCase();
	const purpose = purposeOf(text, ext);
	return { path, lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), ...(purpose === undefined ? {} : { purpose }), symbols: symbolsOf(text, ext) };
}

export async function trackedFiles(cwd: string): Promise<string[]> {
	const { stdout } = await run("git", ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard"], { maxBuffer: 32 * 1024 * 1024 });
	return stdout.split("\n").filter((path) => path !== "" && !SKIP.test(path));
}

const symbolList = (symbols: FileMap["symbols"], limit: number) => {
	const shown = symbols.slice(0, limit).map((symbol) => `${symbol.name}:${symbol.line}`);
	return symbols.length > limit ? `${shown.join(" ")} +${symbols.length - limit} more` : shown.join(" ");
};

/** One file in full detail: purpose, then every symbol on its own line, indented ones marked as nested. */
export function formatFile(file: FileMap): string {
	const head = `${file.path} (${file.lines} lines)${file.purpose ? `: ${file.purpose}` : ""}`;
	if (file.symbols.length === 0) return `${head}\nNo symbols found; read it with sed -n.`;
	return [head, ...file.symbols.map((symbol) => `  ${String(symbol.line).padStart(5)}  ${symbol.top ? "" : "  "}${symbol.name}`)].join("\n");
}

/** Many files: one line each, top-level symbols only; folds to directories when over the budget. */
export function formatMap(files: FileMap[], budget = MAP_BUDGET_CHARS): string {
	const total = files.reduce((sum, file) => sum + file.lines, 0);
	const header = `${files.length} files, ${total.toLocaleString("en-US")} lines. path (lines): purpose | symbol:line …`;
	const lines = files.map((file) => {
		const top = file.symbols.filter((symbol) => symbol.top && symbol.name !== file.purpose);
		const symbols = symbolList(top.length > 0 ? top : file.symbols, SYMBOLS_PER_FILE);
		return `${file.path} (${file.lines})${file.purpose ? `: ${file.purpose}` : ""}${symbols ? ` | ${symbols}` : ""}`;
	});
	const full = [header, ...lines].join("\n");
	if (full.length <= budget) return full;
	// Too big: keep purposes, drop symbols.
	const lean = [header.replace(" | symbol:line …", ""), ...files.map((file) => `${file.path} (${file.lines})${file.purpose ? `: ${file.purpose.slice(0, 100)}` : ""}`)].join("\n");
	if (lean.length <= budget) return `${lean}\n(symbols left out to fit; pass path for a directory or file)`;
	const dirs = new Map<string, { files: number; lines: number }>();
	for (const file of files) {
		const parts = file.path.split("/");
		const dir = parts.length > 2 ? `${parts.slice(0, 2).join("/")}/` : parts.length === 2 ? `${parts[0]}/` : file.path;
		const sum = dirs.get(dir) ?? { files: 0, lines: 0 };
		sum.files++;
		sum.lines += file.lines;
		dirs.set(dir, sum);
	}
	const folded = [...dirs.entries()].map(([dir, sum]) => (dir.endsWith("/") ? `${dir} ${sum.files} files, ${sum.lines} lines` : `${dir} (${sum.lines})`));
	const out = [`${files.length} files, ${total.toLocaleString("en-US")} lines; too many to list, so by directory. Pass path to see one.`, ...folded].join("\n");
	return out.length <= budget ? out : `${out.slice(0, budget)}\n…(cut; pass path)`;
}

export type RepoMapArgs = { path?: string; query?: string };

/**
 * The map for `cwd`, narrowed by `path` (a file gives its full symbol list; a directory, the files under it) and
 * `query` (files whose path, purpose or symbol names contain it, case-insensitive).
 */
export async function repoMap(cwd: string, args: RepoMapArgs = {}): Promise<string> {
	const prefix = args.path?.replace(/^\.\//, "").replace(/\/+$/, "") ?? "";
	const all = await trackedFiles(cwd);
	if (prefix !== "" && all.includes(prefix)) {
		const file = mapFile(cwd, prefix);
		return file === undefined ? `${prefix}: not a readable text file.` : formatFile(file);
	}
	const scoped = prefix === "" ? all : all.filter((path) => path.startsWith(`${prefix}/`));
	if (scoped.length === 0) return `No tracked files under ${prefix || "the repo"}.`;
	let files = scoped.map((path) => mapFile(cwd, path)).filter((file): file is FileMap => file !== undefined);
	const query = args.query?.trim().toLowerCase();
	if (query) {
		files = files
			.map((file) => {
				if (file.path.toLowerCase().includes(query) || file.purpose?.toLowerCase().includes(query)) return file;
				const symbols = file.symbols.filter((symbol) => symbol.name.toLowerCase().includes(query));
				return symbols.length > 0 ? { ...file, symbols: symbols.map((symbol) => ({ ...symbol, top: true })) } : undefined;
			})
			.filter((file): file is FileMap => file !== undefined);
		if (files.length === 0) return `Nothing in ${prefix || "the repo"} matches "${args.query}". Try grep -rn for text inside function bodies.`;
		if (files.length === 1) return formatFile(files[0]!);
	}
	return formatMap(files);
}
