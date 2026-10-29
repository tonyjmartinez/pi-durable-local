// Safety policy for agent tool calls. Pure functions, so tests can cover every rule without a model.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import type { Policy } from "./config.ts";

const home = homedir();

/** Paths no agent may read or write, whatever the tool. */
const SECRET_PATHS = [
	`${home}/.ssh`,
	`${home}/.config/pi-durable`,
	`${home}/.config/gh`,
	`${home}/.pi/agent/auth.json`,
	`${home}/.aws`,
	`${home}/.gnupg`,
	`${home}/.npmrc`,
	`${home}/.netrc`,
	`${home}/.git-credentials`,
	`${home}/.local/share/pi-durable`,
	"/proc",
];

/**
 * Secret locations named by their directory names, so `cd ~/.config && cat pi-durable/env` is caught too.
 * Full-path matching alone misses relative paths after a `cd`.
 */
const SECRET_FRAGMENTS: Rule[] = [
	{ pattern: /\.config\b[^\s;&|]*\/(pi-durable|gh)\b|(^|[\s/'"=])(pi-durable|gh)\/(env|policy\.json|hosts\.yml|config\.yml|auth\.json)\b/, reason: "the daemon's and gh's config" },
	{ pattern: /(^|[\s/'"=~])\.ssh\b/, reason: "SSH keys" },
	{ pattern: /\.local\/share\/pi-durable\b|(^|[\s/'"])share\/pi-durable\b/, reason: "the daemon's store and logs" },
	{ pattern: /\/proc\/[^\s]*\/(environ|mem|cmdline)\b/, reason: "process memory and environments" },
];

type Rule = { pattern: RegExp; reason: string };

const BASH_RULES: Rule[] = [
	{ pattern: /(^|[;&|(\s])sudo\s/, reason: "sudo is not available to agents" },
	{ pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+|--recursive\s+)+(-[a-zA-Z]+\s+)*(\/|~|\$HOME|\/home\/?[^/\s]*)\/?(\s|$|\*)/, reason: "recursive delete of / or a home directory" },
	{ pattern: /\b(mkfs(\.\w+)?|fdisk|parted|wipefs)\b/, reason: "disk formatting tools" },
	{ pattern: /\bdd\s+[^|;&]*of=\/dev\//, reason: "writing to a block device" },
	{ pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, reason: "fork bomb" },
	{ pattern: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/, reason: "piping a download into a shell" },
	{ pattern: /\b(ba|z|da)?sh\s+<\(\s*(curl|wget)\b|\beval\s+["']?\$\(\s*(curl|wget)\b|\b(curl|wget)\b[^|;&]*\|\s*(python3?|node|perl|ruby)\b(?!\s+-[ce]\s)/, reason: "running downloaded code" },
	{ pattern: /\brm\b[^;&|]*\s(\/\*?|~\/?\*?)(\s|$)/, reason: "deleting / or a home directory" },
	{ pattern: /\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, reason: "chmod 777 on /" },
	{ pattern: /\bgit\s+push\b[^;&|]*(\s--force(?!-with-lease)\b|\s-f\b|\s\+\S)/, reason: "force push (use --force-with-lease on your own work branch if you must)" },
	{ pattern: /\bgit\s+push\b[^;&|]*\s--(mirror|all|delete|tags)\b/, reason: "bulk or destructive push" },
	{ pattern: /\bgit\s+push\b[^;&|]*\s:\S/, reason: "deleting a remote branch" },
	{ pattern: /\bgit\s+(commit|push|merge|rebase|am)\b[^;&|]*\s--no-verify\b/, reason: "skipping git hooks" },
	{ pattern: /\bgit\s+config\s+(--global|--system)\b/, reason: "changing global git config" },
	{ pattern: /\bgit\s+config\b[^;&|]*\balias\.|\bgit\s+-c\s*["']?alias\./, reason: "git aliases (they can hide a push)" },
	{ pattern: /\bgit\s+remote\s+(add|set-url|rename)\b/, reason: "changing git remotes; push only to origin" },
	{ pattern: /\bgh\b[^;&|\n]*\bpr\b[^;&|\n]*\b(merge|review|edit)\b/, reason: "merging, approving and retargeting PRs go through the gated pr tools" },
	{ pattern: /\bgh\s+(alias|config|extension|auth|secret|variable|ssh-key|gpg-key|ruleset|cache)\b/, reason: "gh configuration and credentials are human-only" },
	{ pattern: /\bgh\s+(repo\s+(delete|archive|rename|edit|create|fork|deploy-key)|release\s+(create|delete|edit)|workflow\s+(disable|enable|run))\b/, reason: "repository administration is human-only" },
	{ pattern: /\bgh\s+api\s+["']?graphql\b/, reason: "GraphQL mutations can merge or change protection; use the pr tools" },
	{ pattern: /\bgh\s+api\b[^;&|\n]*(\s(-X|--method)[=\s]*["']?(POST|PUT|PATCH|DELETE)\b|\s(-f|-F|--field|--raw-field|--input)[=\s])/i, reason: "agents may only read the GitHub API (GET); writes go through the pr tools" },
	{ pattern: /\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b/, reason: "publishing packages or images" },
	{ pattern: /\b(systemctl|launchctl)\b[^;&|]*\b(pi-durable|pdd)\b/, reason: "agents may not control their own daemon" },
	{ pattern: /\bpkill\b[^;&|]*\b(node|pdd)\b|\bkillall\s+node\b/, reason: "agents may not kill the daemon" },
	{ pattern: /\bcrontab\s+(-r|-e|\S+\.cron|-)\b/, reason: "editing crontab (use pd loops instead)" },
];

/** git push must name an explicit work branch, so nothing lands on main by a bare `git push`. */
function checkGitPush(command: string, policy: Policy): string | undefined {
	for (const match of command.matchAll(/\bgit\s+push\b([^;&|\n]*)/g)) {
		// Drop flags and shell redirections such as 2>&1.
		const args = match[1]!.trim().split(/\s+/).filter((arg) => arg !== "" && !arg.startsWith("-") && !/^\d*[<>]/.test(arg));
		// args: [remote, refspec...]
		if (args.length > 0 && args[0] !== "origin") return `push only to the origin remote (got "${args[0]}")`;
		const refspecs = args.slice(1);
		if (refspecs.length === 0) {
			return `git push must name a branch explicitly, e.g. \`git push -u origin ${policy.automerge.branchPrefix}my-change\``;
		}
		for (const refspec of refspecs) {
			const target = refspec.includes(":") ? refspec.slice(refspec.indexOf(":") + 1) : refspec;
			const branch = target.replace(/^refs\/heads\//, "");
			if (branch === "HEAD" || branch.includes("..") || !branch.startsWith(policy.automerge.branchPrefix)) {
				return `agents may only push branches starting with "${policy.automerge.branchPrefix}" (got "${branch}"); main is updated only by the gated pr_merge tool`;
			}
		}
	}
	return undefined;
}

function touchesSecret(text: string): string | undefined {
	const expanded = text.replaceAll("$HOME", home).replaceAll("${HOME}", home).replace(/(^|[\s"'=:])~(?=\/)/g, `$1${home}`);
	// The daemon's read-only bare mirrors are the one sanctioned path under its data dir (see the git_sync tool).
	const withoutMirrors = expanded.replace(new RegExp(`${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.local/share/pi-durable/mirrors/[\\w.-]+\\.git(?=[\\s'"]|$)`, "g"), "<mirror>");
	for (const path of SECRET_PATHS) if (withoutMirrors.includes(path)) return path;
	for (const fragment of SECRET_FRAGMENTS) if (fragment.pattern.test(withoutMirrors)) return fragment.reason;
	if (/\bgh\s+auth\s+token\b/.test(text)) return "gh auth token";
	if (/(^|[\s/"'])\.env(?!\.(example|sample|template)(\s|$|["']))(\.[\w.-]+)?(\s|$|["'])/.test(text) && /\b(cat|less|more|head|tail|grep|awk|sed|cp|scp|curl|base64|xxd|strings)\b/.test(text)) {
		return ".env file";
	}
	return undefined;
}

export function checkBash(raw: string, policy: Policy): string | undefined {
	// `git -C dir push`, `git -c k=v push` and `git --work-tree=. push` are still pushes: drop global options.
	const command = raw.replace(/\bgit((?:\s+(?:-[Cc]\s+(?!alias\.)\S+|--[a-z-]+(?:=\S+)?))+)(?=\s)/g, "git");
	for (const rule of BASH_RULES) if (rule.pattern.test(command)) return rule.reason;
	const secret = touchesSecret(command);
	if (secret !== undefined) return `access to ${secret} is blocked`;
	return checkGitPush(command, policy);
}

function within(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve symlinks through the nearest existing ancestor, so a link under ~/proj can't point into a secret. */
function realPath(path: string): string {
	let existing = path;
	const rest: string[] = [];
	while (!existsSync(existing) && dirname(existing) !== existing) {
		rest.unshift(basename(existing));
		existing = dirname(existing);
	}
	try {
		return join(realpathSync(existing), ...rest);
	} catch {
		return path;
	}
}

export function checkPath(tool: "read" | "write" | "edit", path: string, cwd: string, policy: Policy): string | undefined {
	const absolute = realPath(normalize(resolve(cwd, path.replace(/^~(?=\/|$)/, home))));
	for (const secret of SECRET_PATHS) if (within(absolute, secret)) return `access to ${secret} is blocked`;
	if (tool === "read") return undefined;
	if (/(^|\/)\.env(\.[\w-]+)?$/.test(absolute) && !/\.env\.(example|sample|template)$/.test(absolute)) {
		return "agents do not write .env files; put an .env.example in the repo instead";
	}
	if (/(^|\/)\.git(\/|$)/.test(absolute)) return "write git internals through git, not by editing .git";
	if (!policy.writableRoots.some((root) => within(absolute, resolve(root.replace(/^~(?=\/|$)/, home))))) {
		return `${absolute} is outside the writable roots (${policy.writableRoots.join(", ")})`;
	}
	return undefined;
}

/** The decision for one tool call: a block reason, or undefined to allow it. */
export function checkToolCall(name: string, args: Record<string, unknown>, cwd: string, policy: Policy): string | undefined {
	if (name === "bash" && typeof args.command === "string") return checkBash(args.command, policy);
	if ((name === "read" || name === "write" || name === "edit") && typeof args.path === "string") {
		return checkPath(name, args.path, cwd, policy);
	}
	return undefined;
}

/** Simple glob for protected paths: `**` spans directories, `*` stays within one. */
export function globToRegExp(glob: string): RegExp {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i]!;
		if (char === "*" && glob[i + 1] === "*") {
			const slash = glob[i + 2] === "/";
			source += slash ? "(?:.*/)?" : ".*";
			i += slash ? 2 : 1;
		} else if (char === "*") source += "[^/]*";
		else if (char === "?") source += "[^/]";
		else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

export function protectedMatches(files: readonly string[], globs: readonly string[]): string[] {
	const patterns = globs.map(globToRegExp);
	return files.filter((file) => patterns.some((pattern) => pattern.test(file)));
}
