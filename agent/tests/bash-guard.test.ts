/**
 * Tests for the bash-guard extension's detection logic.
 *
 * The tests import the real extension file — no copy to drift. They run with
 * the jiti loader bundled with pi, so no dev dependencies are needed:
 *
 *   node --import ~/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs \
 *     agent/tests/bash-guard.test.ts
 *
 * (`import type` in the extension is erased by the loader, so the test never
 * resolves the pi package.)
 */

import assert from "node:assert/strict";
import { findRootScan, findSelfMatch, isFilesystemRoot } from "../extensions/bash-guard.ts";

const cases: Array<[command: string, want: "root" | "self" | undefined]> = [
	// --- rule 1: filesystem-root scans ---
	["find / -name foo", "root"],
	["find /", "root"],
	["sudo du -sh /", "root"],
	["ls -R /", "root"],
	["grep -r foo /", "root"],
	["rg foo /", "root"],
	["while find / -name x; do :; done", "root"],
	["cat /etc/hosts", undefined],
	["echo find /", undefined],
	["find . -name foo", undefined],
	["cat <<EOF\nfind /\nEOF", undefined],

	// --- rule 2: self-matching pgrep/pkill -f ---
	['while pgrep -f "my-server" > /dev/null; do sleep 1; done', "self"],
	['pgrep -f "my-server"', "self"],
	["pkill -f my-server", "self"],
	["pgrep my-server", undefined], // no -f: matches process names only
	["pkill -x my-server", undefined],
	["! pgrep -f foo || echo down", "self"],
	['sudo pgrep -f "python.*server.py"', "self"],
	["pgrep -l -f my-server", "self"],
	['pgrep -f -- "-[w]eird-flag"', undefined],
	["pgrep --full=my-server", "self"],
	["if pgrep -f x >/dev/null; then echo up; fi", "self"],
	['pgrep -f "^python"', undefined],
	["kill -0 1234 2>/dev/null", undefined],
	['while ! pgrep -f "my app"; do sleep 1; done', "self"],
	["until pgrep -f foo; do sleep 1; done", "self"],
	["pgrep -f foo; echo done", "self"],
	['pgrep -f "[m]y-server" > /dev/null && echo up', undefined], // bracket trick passes

	// --- rule 2 must not fire when rule 1 already matched ---
	["find /", "root"],
];

let failed = 0;
for (const [command, want] of cases) {
	const got = findRootScan(command) ? "root" : findSelfMatch(command) ? "self" : undefined;
	try {
		assert.equal(got, want, `command: ${JSON.stringify(command)}`);
		console.log(`ok   want=${want ?? "-"}  ${command.replaceAll("\n", "\\n")}`);
	} catch (error) {
		failed++;
		console.error(`FAIL want=${want ?? "-"} got=${got ?? "-"}  ${command.replaceAll("\n", "\\n")}`);
		console.error(String(error).split("\n").slice(0, 4).join("\n"));
	}
}

// --- built-in path tools ---
const pathCases: Array<[tool: string, path: unknown, want: boolean]> = [
	["find", "/", true],
	["ls", "//", true],
	["grep", "'/'", true],
	["find", ".", false],
	["find", "/etc", false],
	["find", undefined, false],
];
for (const [tool, path, want] of pathCases) {
	try {
		assert.equal(isFilesystemRoot(path), want, `tool: ${tool}`);
		console.log(`ok   ${tool} path=${String(path)} -> ${want}`);
	} catch (error) {
		failed++;
		console.error(`FAIL ${tool} path=${String(path)}: ${String(error).split("\n")[0]}`);
	}
}

if (failed > 0) {
	console.error(`\n${failed} test(s) failed`);
	process.exit(1);
}
console.log(`\nall ${cases.length + pathCases.length} tests passed`);
