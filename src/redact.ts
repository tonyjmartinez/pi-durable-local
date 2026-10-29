// Scrub anything that looks like a credential from text that leaves the machine (issues, notifications).

const MASK = "[redacted]";

const PATTERNS: [RegExp, string | ((...match: string[]) => string)][] = [
	// Credentials embedded in a URL, and the secret path segment of chat webhooks.
	[/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
	[/(\/api\/webhooks\/\d+\/)[\w-]+/gi, `$1${MASK}`],
	[/(hooks\.slack\.com\/services\/)[\w/]+/gi, `$1${MASK}`],
	// Authorization headers and bearer tokens.
	[/\b(authorization\s*[:=]\s*)(?:bearer\s+|basic\s+|token\s+)?[^\s"',;]+/gi, `$1${MASK}`],
	[/\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`],
	// Well-known token shapes.
	[/\bsk-ant-[A-Za-z0-9_-]{8,}/g, MASK],
	[/\bsk-[A-Za-z0-9_-]{20,}/g, MASK],
	[/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, MASK],
	[/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
	[/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
	[/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
	// NAME=value where the name says it is a secret.
	[/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*)(?:"[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;]{6,})/gi, `$1${MASK}`],
	// Long hex (a 64-hex UI token, a sha256), but not a 40-hex commit id.
	[/\b[0-9a-f]{64,}\b/gi, MASK],
	// Any other long run mixing letters and digits.
	[/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, (match) => (/^[0-9a-f]{40}$/i.test(match) ? match : MASK)],
];

export function redact(text: string): string {
	let out = text;
	for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement as string);
	return out;
}
