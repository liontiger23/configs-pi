/**
 * Tests for the background-compaction extension's threshold helpers.
 *
 * The tests import the real threshold module — no copy to drift. They run
 * with the jiti loader bundled with pi, so no dev dependencies are needed:
 *
 *   node --import ~/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs \
 *     agent/tests/background-compaction.test.ts
 *
 * (threshold.ts only imports node builtins, so the test never resolves the
 * pi packages — see the note in bash-guard.test.ts.)
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	COMPACTION_THRESHOLD_DEFAULT,
	formatTokens,
	getCompactionThreshold,
	parseThresholdInput,
	saveGlobalThreshold,
} from "../extensions/background-compaction/threshold.ts";

// --- getCompactionThreshold: settings.json semantics ---

const dir = mkdtempSync(join(tmpdir(), "bgc-test-"));
try {
	// missing file → default
	assert.equal(getCompactionThreshold(join(dir, "missing.json")), COMPACTION_THRESHOLD_DEFAULT);

	// file without the key → default
	const emptyPath = join(dir, "empty.json");
	writeFileSync(emptyPath, JSON.stringify({ other: 1 }));
	assert.equal(getCompactionThreshold(emptyPath), COMPACTION_THRESHOLD_DEFAULT);

	// valid number → itself
	const numPath = join(dir, "num.json");
	writeFileSync(numPath, JSON.stringify({ compactionThreshold: 150000 }));
	assert.equal(getCompactionThreshold(numPath), 150000);

	// explicit null → off
	const nullPath = join(dir, "null.json");
	writeFileSync(nullPath, JSON.stringify({ compactionThreshold: null }));
	assert.equal(getCompactionThreshold(nullPath), null);

	// invalid values → default (not off)
	for (const bad of [999, "120k", true, {}]) {
		const badPath = join(dir, "bad.json");
		writeFileSync(badPath, JSON.stringify({ compactionThreshold: bad }));
		assert.equal(getCompactionThreshold(badPath), COMPACTION_THRESHOLD_DEFAULT, `bad: ${JSON.stringify(bad)}`);
	}

	// malformed JSON → default
	const brokenPath = join(dir, "broken.json");
	writeFileSync(brokenPath, "{not json");
	assert.equal(getCompactionThreshold(brokenPath), COMPACTION_THRESHOLD_DEFAULT);

	// --- saveGlobalThreshold round-trip ---
	const roundtrip = join(dir, "roundtrip.json");
	writeFileSync(roundtrip, JSON.stringify({ keep: "me" }));
	assert.equal(saveGlobalThreshold(150000, roundtrip), true);
	assert.equal(getCompactionThreshold(roundtrip), 150000);
	assert.equal(saveGlobalThreshold(null, roundtrip), true);
	assert.equal(getCompactionThreshold(roundtrip), null);
	// other keys survive the write
	assert.equal(JSON.parse(readFileSync(roundtrip, "utf-8")).keep, "me");

	// unwritable path → false, no throw
	assert.equal(saveGlobalThreshold(1000, join(dir, "nope", "deeper", "settings.json")), false);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

// --- parseThresholdInput ---

const parseCases: Array<[input: string, want: number | null]> = [
	["150000", 150000],
	["150k", 150000],
	["1.5k", 1500],
	["1.5m", 1_500_000],
	["1.5M", 1_500_000],
	[" 120K ", 120000],
	["0", 0],
	["", null],
	["abc", null],
	["12x", null],
	["off", null], // the command handles "off" before parsing
	["-5", null],
];
for (const [input, want] of parseCases) {
	assert.equal(parseThresholdInput(input), want, `parse: ${JSON.stringify(input)}`);
}

// --- formatTokens ---

const fmtCases: Array<[n: number, want: string]> = [
	[999, "999"],
	[1000, "1.0k"],
	[1500, "1.5k"],
	[120000, "120k"],
	[999999, "1000k"],
	[1500000, "1.5M"],
	[12000000, "12M"],
];
for (const [n, want] of fmtCases) {
	assert.equal(formatTokens(n), want, `format: ${n}`);
}

console.log("background-compaction: all tests passed");
