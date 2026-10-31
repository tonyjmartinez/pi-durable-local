// Paths, secrets, and user-editable policy for the daemon and the `pd` client.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = homedir();
export const CONFIG_DIR = process.env.PD_CONFIG_DIR ?? join(home, ".config", "pi-durable");
export const DATA_DIR = process.env.PD_DATA_DIR ?? join(home, ".local", "share", "pi-durable");
export const SOCKET_PATH = process.env.PD_SOCKET ?? join(DATA_DIR, "pdd.sock");
export const DB_PATH = join(DATA_DIR, "state.sqlite");
export const ENV_FILE = join(CONFIG_DIR, "env");
export const POLICY_FILE = join(CONFIG_DIR, "policy.json");
export const AUDIT_LOG = join(DATA_DIR, "audit.jsonl");

export type Policy = {
	/** Default model for new sessions, as provider/modelId. */
	model: string;
	/** Model for the independent PR review gate. */
	reviewModel: string;
	/** Model that runs Anthropic server-side web search for the web_search tool. */
	searchModel: string;
	/** Default (cheapest) model for the subagent tool's delegated work. */
	subagentModel: string;
	/** Subagent model for product planning and decisions. */
	planModel: string;
	/** Subagent model reserved for big swings and design decisions; every use is audited with its reason. */
	deepModel: string;
	thinkingLevel: "off" | "minimal" | "low" | "medium" | "high";
	/** Directories agents may write to. Edits and writes elsewhere are blocked. */
	writableRoots: string[];
	automerge: {
		/** owner/repo entries that may be merged by `pr_merge`. Empty means auto-merge is off everywhere. */
		repos: string[];
		/** owner/repo → branch PRs target, for repos whose GitHub default branch is not the deploy branch. */
		baseBranches: Record<string, string>;
		/** Branches agents work on must start with this. */
		branchPrefix: string;
		maxChangedLines: number;
		maxChangedFiles: number;
		/** Globs no automated PR may touch; matching PRs stay open for a human. */
		protectedPaths: string[];
		/** Require at least one CI check to exist and pass (a repo with no CI is never auto-merged). */
		requireChecks: boolean;
		mergeMethod: "squash" | "merge" | "rebase";
	};
	loops: {
		/** Start every loop iteration from a short handoff instead of the whole history (the main cost saver). */
		freshContext: boolean;
		/** Cap on all loops' spend together in any 24 hours, in USD; loops wait for room when it is reached. 0 = no cap. */
		dailyBudgetUsd: number;
		/** Optional one-time budget start in epoch milliseconds; historical spend remains recorded. */
		dailyBudgetSince?: number;
		/** Hard cap on spend per loop, in USD; the loop pauses when crossed. */
		defaultBudgetUsd: number;
		defaultIntervalMinutes: number;
		defaultMaxIterations: number;
	};
};

export const DEFAULT_POLICY: Policy = {
	model: "anthropic/claude-haiku-5-5",
	reviewModel: "anthropic/claude-haiku-5-5",
	searchModel: "anthropic/claude-haiku-5-5",
	subagentModel: "anthropic/claude-haiku-5-5",
	planModel: "anthropic/claude-haiku-5-5",
	deepModel: "anthropic/claude-sonnet-5-5",
	thinkingLevel: "low",
	writableRoots: [join(home, "proj"), "/tmp"],
	automerge: {
		repos: [],
		baseBranches: {},
		branchPrefix: "pd/",
		maxChangedLines: 600,
		maxChangedFiles: 25,
		protectedPaths: [
			".github/**",
			"**/.env*",
			"**/*.pem",
			"**/*.key",
			"**/secrets/**",
			"**/migrations/**",
			"**/Dockerfile",
			"**/*.tf",
			// package.json is checked by key instead: scripts-only changes are reviewed; anything else needs a human.
			"package-lock.json",
			"**/Makefile",
			"**/.husky/**",
			"**/vitest.config.*",
			"**/jest.config.*",
			"**/playwright.config.*",
			".gitlab-ci.yml",
			".circleci/**",
			"**/wrangler.toml",
			"**/wrangler.json",
			"**/wrangler.jsonc",
			"pnpm-lock.yaml",
			"**/Cargo.toml",
			"**/Cargo.lock",
			"**/go.mod",
			"**/go.sum",
			"**/requirements*.txt",
			"**/pyproject.toml",
			"**/poetry.lock",
			"**/uv.lock",
			"**/Gemfile",
			"**/Gemfile.lock",
			"**/composer.json",
			"**/build.gradle*",
			"**/pom.xml",
			"**/bun.lockb",
			"yarn.lock",
			"CODEOWNERS",
			".pi/**",
			"AGENTS.md",
		],
		requireChecks: true,
		mergeMethod: "squash",
	},
	loops: { freshContext: true, dailyBudgetUsd: 1, defaultBudgetUsd: 100, defaultIntervalMinutes: 30, defaultMaxIterations: 17520 },
};

export function ensureDirs(): void {
	mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
	mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
	if (!existsSync(POLICY_FILE)) writeFileSync(POLICY_FILE, `${JSON.stringify(DEFAULT_POLICY, null, "\t")}\n`);
	if (!existsSync(ENV_FILE)) {
		writeFileSync(
			ENV_FILE,
			"# Secrets for the pi-durable daemon. Agents' shells never see these.\nANTHROPIC_API_KEY=\n",
			{ mode: 0o600 },
		);
	}
}

/** Read live: the policy file can be edited while the daemon runs. */
export function loadPolicy(): Policy {
	try {
		const raw = JSON.parse(readFileSync(POLICY_FILE, "utf8")) as Partial<Policy>;
		return {
			...DEFAULT_POLICY,
			...raw,
			automerge: { ...DEFAULT_POLICY.automerge, ...raw.automerge },
			loops: { ...DEFAULT_POLICY.loops, ...raw.loops },
		};
	} catch {
		return DEFAULT_POLICY;
	}
}

/** KEY=value lines; blank values are skipped so an empty template does not shadow the real environment. */
export function loadSecrets(): Record<string, string> {
	const secrets: Record<string, string> = {};
	if (!existsSync(ENV_FILE)) return secrets;
	for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
		if (!match || line.trimStart().startsWith("#")) continue;
		const value = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
		if (value !== "") secrets[match[1]!] = value;
	}
	return secrets;
}

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

/** The environment agent shells get: the daemon's, minus anything that looks like a secret. `gh` keeps its own login. */
export function scrubbedEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(process.env)) if (!SECRET_NAME.test(name)) env[name] = value;
	env.PD_AGENT = "1";
	env.PD_WRITABLE_ROOTS = loadPolicy().writableRoots.map((root) => root.replace(/^~(?=\/|$)/, home)).join(":");
	env.GIT_TERMINAL_PROMPT = "0";
	// Agents get no GitHub API credentials: gh in their shells sees an empty config. PRs are opened, inspected,
	// and merged by the daemon's own gh through the pr_* tools. git push still works over the SSH key.
	const agentGh = join(DATA_DIR, "agent-gh");
	mkdirSync(agentGh, { recursive: true, mode: 0o700 });
	env.GH_CONFIG_DIR = agentGh;
	env.GH_PROMPT_DISABLED = "1";
 // Optional local test runtime; keep game repositories free of browser dependencies.
 const browser = join(home, ".cache", "pi-durable-browser", "chromium");
 if (existsSync(browser)) {
  env.CHROMIUM ??= browser;
  env.PW_CHROMIUM ??= browser;
  const modules = join(home, ".cache", "pi-durable-browser", "node_modules");
  if (existsSync(modules)) env.NODE_PATH = [modules, env.NODE_PATH].filter(Boolean).join(":");
 }
	return env;
}

export function splitModel(ref: string): { provider: string; modelId: string } {
	const slash = ref.indexOf("/");
	return slash < 0 ? { provider: "anthropic", modelId: ref } : { provider: ref.slice(0, slash), modelId: ref.slice(slash + 1) };
}
