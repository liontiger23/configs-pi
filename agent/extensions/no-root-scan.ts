/**
 * Block filesystem-root scans via `find /` (and similar patterns).
 *
 * Blocks bash commands whose command segment scans the filesystem root, e.g.:
 *   find /            find / -name foo       ls -R /
 *   du -sh /          grep -r foo /          rg foo /
 *   fd foo /          locate foo /           sudo find / -name x
 *
 * Only fires when the scan is at the start of a command segment, so things
 * like `echo find /` or `cat /etc/hosts` are allowed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// True if a path argument points at the filesystem root ("/", "//", or
// quoted/trimmed variants). Relative paths and real directories are allowed.
function isFilesystemRoot(value: unknown): boolean {
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

// Split on shell command separators: ; && || | (newlines too).
const SEGMENT_SPLIT = /\s*(?:;|&&|\|\||\||\n)\s*/;

// Drop heredoc bodies, which are literal data rather than commands.
const HEREDOC = /<<-?["']?(\w+)["']?[\s\S]*?\n\s*\1\b/g;

// Strip leading assignments and wrapper commands so `sudo find /` is checked
// the same as `find /`.
const WRAPPERS = /^(?:\w+=\S+\s+)*(?:sudo|command|nice|time|noglob)?\s*/;

function findRootScan(command: string): string | undefined {
	const stripped = command.replace(HEREDOC, "");
	for (const rawSegment of stripped.split(SEGMENT_SPLIT)) {
		const segment = rawSegment.replace(WRAPPERS, "").trimStart();
		for (const rule of rootScanRules) {
			if (rule.test(segment)) return rule.source;
		}
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
		const matched = findRootScan(command);
		if (!matched) return undefined;

		return {
			block: true,
			reason:
				`Blocked: this command scans the filesystem root ("${command.trim()}"). ` +
				`Search inside the project instead, e.g. \`find . -name <pattern>\`, ` +
				`or narrow the path to a specific directory.`,
		};
	});
}
