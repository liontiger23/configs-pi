/**
 * Guard against dangerous bash commands before execution.
 *
 * Rule 1 — filesystem-root scans: blocks commands whose command segment scans
 * the filesystem root, e.g.:
 *   find /            find / -name foo       ls -R /
 *   du -sh /          grep -r foo /          rg foo /
 *   fd foo /          locate foo /           sudo find / -name x
 * Built-in find/grep/ls pointed at "/" are blocked too. Only fires when the
 * scan is at the start of a command segment, so `echo find /` or
 * `cat /etc/hosts` are allowed.
 *
 * Rule 2 — self-matching pgrep/pkill: `pgrep -f PATTERN` matches against full
 * command lines, so whenever PATTERN (as an ERE) occurs in the command itself,
 * it matches the shell running it — and its own invocation. The classic
 * mistake is a wait loop:
 *   while pgrep -f "my-server" > /dev/null; do sleep 1; done
 * which never ends, and the redirect hides the self-matched PID. `pkill -f`
 * is worse: it kills the shell running it. Such commands are blocked; the
 * bracket trick (`pgrep -f "[m]y-server"`) cannot self-match and passes
 * automatically, since the regex `[m]y-server` does not match its own literal
 * text.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/* ---------- shared command tokenization ---------- */

// Drop heredoc bodies, which are literal data rather than commands.
const HEREDOC = /<<-?["']?(\w+)["']?[\s\S]*?\n\s*\1\b/g;

// Split on shell command separators: ; && || | (newlines too).
const SEGMENT_SPLIT = /\s*(?:;|&&|\|\||\||\n)\s*/;

// Strip leading assignments, negation, shell keywords (`while pgrep …`,
// `if pgrep …`), and wrapper commands so those are checked the same as the
// bare commands.
const WRAPPERS = /^(?:(?:\w+=\S+|!|sudo|command|nice|time|noglob|while|until|if|then|else|elif|do)\s+)*/;

// A shell word: double-quoted, single-quoted, or a run of non-space chars.
const WORD = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g;

// Remove one layer of shell quoting from a word.
function unquote(word: string): string {
	if (word.startsWith('"')) {
		return word.slice(1, -1).replace(/\\(.)/g, "$1");
	}
	if (word.startsWith("'")) {
		return word.slice(1, -1);
	}
	return word;
}

/* ---------- rule 1: filesystem-root scans ---------- */

// True if a path argument points at the filesystem root ("/", "//", or
// quoted/trimmed variants). Relative paths and real directories are allowed.
// (Exported for tests.)
export function isFilesystemRoot(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const trimmed = value.trim().replace(/^["']|["']$/g, "");
	return /^\/{1,2}$/.test(trimmed);
}

// Built-in tools that accept a `path` argument.
const PATH_TOOLS = new Set(["find", "grep", "ls"]);

// Matches a root path argument: "/", "\"/\"", or "'/'".
const ROOT = String.raw`(?:["']?/["']?)`;

// One rule per root-scanning command. Each is applied at the start of a
// command segment (after shell separators and optional `sudo`/`command`).
const rootScanRules: RegExp[] = [
	// find / ...
	new RegExp(String.raw`^find\s+(?:-[A-Za-z]+\s+\S+\s+)*${ROOT}(?:\s|$)`),
	// ls / | ls -R /
	new RegExp(String.raw`^ls\s+(?:-[A-Za-z]+\s+)*${ROOT}(?:\s|$)`),
	// du -sh /
	new RegExp(String.raw`^du\s+(?:-[A-Za-z]+\s+)*${ROOT}(?:\s|$)`),
	// grep -r foo /  (pattern accepted before the root path)
	new RegExp(String.raw`^grep\s+(?:-[A-Za-z]+\s+)*\S+\s+${ROOT}(?:\s|$)`),
	// rg foo / | fd foo / | locate foo /
	new RegExp(String.raw`^(?:rg|fd|locate)\s+(?:-[A-Za-z]+\s+)*\S*\s*${ROOT}(?:\s|$)`),
];

// Returns the source of the first matching root-scan rule, if any.
// (Exported for tests.)
export function findRootScan(command: string): string | undefined {
	const stripped = command.replace(HEREDOC, "");
	for (const rawSegment of stripped.split(SEGMENT_SPLIT)) {
		const segment = rawSegment.replace(WRAPPERS, "").trimStart();
		for (const rule of rootScanRules) {
			if (rule.test(segment)) return rule.source;
		}
	}
	return undefined;
}

/* ---------- rule 2: self-matching pgrep/pkill -f ---------- */

const PROCS = new Set(["pgrep", "pkill"]);

interface SelfMatch {
	proc: string;
	pattern: string;
}

// Returns the first pgrep/pkill -f invocation whose pattern matches the
// command text itself, i.e. one that will self-match. (Exported for tests.)
export function findSelfMatch(command: string): SelfMatch | undefined {
	const stripped = command.replace(HEREDOC, "");
	for (const rawSegment of stripped.split(SEGMENT_SPLIT)) {
		const segment = rawSegment.replace(WRAPPERS, "").trimStart();
		const words = segment.match(WORD);
		if (!words || words.length === 0) continue;
		const proc = unquote(words[0]!).split("/").pop()!;
		if (!PROCS.has(proc)) continue;

		// Walk the remaining words to find whether -f/--full is set and what
		// the pattern argument is. Known limitation: an unquoted pattern
		// starting with `-` is treated as a flag (use `--` before it).
		let fullMatch = false;
		let pattern: string | undefined;
		for (let i = 1; i < words.length; i++) {
			const word = unquote(words[i]!);
			if (word === "--") {
				pattern = unquote(words[i + 1] ?? "");
				break;
			}
			if (word.startsWith("-")) {
				if (word === "--full") {
					fullMatch = true;
				} else if (word.startsWith("--full=")) {
					fullMatch = true;
					pattern = unquote(word.slice("--full=".length));
				} else if (word.includes("f")) {
					fullMatch = true;
				}
				continue;
			}
			pattern = word;
			break;
		}
		if (!fullMatch || !pattern) continue;

		// Does the pattern (as an ERE) match the command text that contains
		// it? Then pgrep/pkill will match the shell — and itself. JS RegExp
		// approximates POSIX ERE; if the pattern fails to compile, fall back
		// to a literal substring test.
		let matched: boolean;
		try {
			matched = new RegExp(pattern).test(stripped);
		} catch {
			matched = stripped.includes(pattern);
		}
		if (matched) return { proc, pattern };
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event) => {
		// Block built-in find/grep/ls pointed at the filesystem root.
		if (PATH_TOOLS.has(event.toolName) && isFilesystemRoot(event.input.path)) {
			return {
				block: true,
				reason:
					`Blocked: ${event.toolName} was pointed at the filesystem root. ` +
					`Search inside the project instead (default path or a specific directory).`,
			};
		}

		if (event.toolName !== "bash") return undefined;

		const command = (event.input.command as string) ?? "";

		const rootScan = findRootScan(command);
		if (rootScan) {
			return {
				block: true,
				reason:
					`Blocked: this command scans the filesystem root ("${command.trim()}"). ` +
					`Search inside the project instead, e.g. \`find . -name <pattern>\`, ` +
					`or narrow the path to a specific directory.`,
			};
		}

		const selfMatch = findSelfMatch(command);
		if (selfMatch) {
			return {
				block: true,
				reason:
					`Blocked: \`${selfMatch.proc} -f "${selfMatch.pattern}"\` matches its own ` +
					`command line — the pattern occurs (as a regex) in this very command, so ` +
					`it always self-matches. With output silenced you cannot even see the ` +
					`false positive; \`${selfMatch.proc === "pkill" ? "pkill" : "pgrep"}\` in a ` +
					`wait loop never ends${selfMatch.proc === "pkill" ? " (and pkill would kill the shell itself)" : ""}. ` +
					`Make the pattern self-immune with the bracket trick, e.g. ` +
					`\`${selfMatch.proc} -f "[m]y-server"\`, or wait on a PID instead: ` +
					`\`while kill -0 <pid> 2>/dev/null; do sleep 1; done\`.`,
			};
		}

		return undefined;
	});
}
