#!/usr/bin/env bash
# Install pi-durable on a Linux or WSL box. Safe to re-run.
#   scripts/install.sh              install dependencies, link pd and pdd-up, create the config template
#   scripts/install.sh --autostart  also start the daemon from ~/.profile at login (added once)
set -euo pipefail

ROOT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
BIN_DIR="${PD_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${PD_CONFIG_DIR:-$HOME/.config/pi-durable}"
ENV_FILE="$CONFIG_DIR/env"
AUTOSTART=0

for arg in "$@"; do
	case "$arg" in
		--autostart) AUTOSTART=1 ;;
		-h | --help)
			sed -n '2,4p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "unknown option: $arg (try --help)" >&2
			exit 2
			;;
	esac
done

step() { printf '\n==> %s\n' "$*"; }
ok() { printf '  ok    %s\n' "$*"; }
warn() { printf '  warn  %s\n' "$*" >&2; }
die() {
	printf '  FAIL  %s\n' "$*" >&2
	exit 1
}

step "Checking requirements"
[[ "$(uname -s)" == "Linux" ]] || die "Linux or WSL is required (found $(uname -s))."

command -v node >/dev/null 2>&1 || die "node is not installed. Install Node 24 or newer (https://nodejs.org, or: nvm install 24)."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
((node_major >= 24)) || die "node $(node -v) is too old; Node 24 or newer is required (nvm install 24)."
ok "node $(node -v)"

command -v npm >/dev/null 2>&1 || die "npm is not installed; it normally ships with node."
ok "npm $(npm -v)"

command -v git >/dev/null 2>&1 || die "git is not installed (sudo apt install git)."
ok "$(git --version)"

if command -v gh >/dev/null 2>&1; then
	ok "$(gh --version | head -n1)"
else
	warn "gh (GitHub CLI) is not installed. Agents cannot open or merge PRs without it. See https://cli.github.com"
fi

if command -v bwrap >/dev/null 2>&1; then
	if bwrap --ro-bind / / true >/dev/null 2>&1; then
		ok "bwrap works (agent shells can be sandboxed)"
	else
		warn "bwrap is installed but cannot create a sandbox here (user namespaces may be disabled)."
		warn "Agent shells would run without isolation. On Ubuntu 24.04+ check: sysctl kernel.apparmor_restrict_unprivileged_userns"
	fi
else
	warn "bwrap (bubblewrap) is not installed. Without it agent shells run unsandboxed and rely only on the regex guard,"
	warn "which is best effort: an agent could read ~/.ssh or ~/.config/gh. Install it: sudo apt install bubblewrap"
fi

step "Installing dependencies"
PIDFILE="${PD_DATA_DIR:-$HOME/.local/share/pi-durable}/pdd.pid"
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null && [[ -d "$ROOT/node_modules" ]]; then
	# npm ci deletes node_modules, which would pull modules out from under the running daemon.
	warn "the daemon is running; skipping npm ci. Run 'pdd-up stop', re-run this script, then 'pdd-up' to refresh dependencies."
else
	(cd "$ROOT" && npm ci --no-audit --no-fund)
	ok "npm ci"
fi

step "Linking commands into $BIN_DIR"
mkdir -p "$BIN_DIR"
for name in pd pdd-up; do
	source_file="$ROOT/bin/$name"
	[[ -f "$source_file" ]] || die "$source_file is missing."
	chmod +x "$source_file"
	ln -sfn "$source_file" "$BIN_DIR/$name"
	ok "$BIN_DIR/$name -> $source_file"
done
case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) warn "$BIN_DIR is not on your PATH. Add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

step "Creating the config template"
mkdir -p "$CONFIG_DIR"
chmod 700 "$CONFIG_DIR"
if [[ -e "$ENV_FILE" ]]; then
	ok "$ENV_FILE already exists; left untouched"
else
	(
		umask 077
		printf '# Secrets for the pi-durable daemon. Agents'"'"' shells never see these.\nANTHROPIC_API_KEY=\n' >"$ENV_FILE"
	)
	chmod 600 "$ENV_FILE"
	ok "created $ENV_FILE (mode 600, key left blank)"
fi

if ((AUTOSTART)); then
	step "Enabling autostart"
	profile="$HOME/.profile"
	marker="# pi-durable autostart"
	if [[ -f "$profile" ]] && grep -qF "$marker" "$profile"; then
		ok "$profile already starts the daemon"
	else
		printf '\n%s\n"%s/pdd-up" >/dev/null 2>&1 || true\n' "$marker" "$BIN_DIR" >>"$profile"
		ok "added pdd-up to $profile"
	fi
fi

cat <<NEXT

Done. Next steps:
  1. Add your Anthropic API key (do not paste it into a chat or a command line that is logged):
       \$EDITOR $ENV_FILE        # set ANTHROPIC_API_KEY=...
  2. Log in to GitHub:
       gh auth login
  3. Start the daemon and check the setup:
       pdd-up
       pd doctor
NEXT
if ((!AUTOSTART)); then
	echo "  Optional: re-run with --autostart to start the daemon at login."
fi
