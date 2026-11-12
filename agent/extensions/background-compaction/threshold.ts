/**
 * Background compaction threshold — settings helpers.
 *
 * Pure module (node builtins only) so tests can import it directly via the
 * jiti test loader without resolving the pi packages.
 *
 * The threshold is read from `compactionThreshold` in ~/.pi/agent/settings.json:
 *   - number ≥ 1000  → background compaction starts when estimated context
 *     tokens reach this value
 *   - null           → background compaction off (pi's native compaction
 *     remains as backstop)
 *   - missing/invalid → default (120k)
 *
 * The same key was previously read by routerai-provider/gptplus5-provider to
 * clamp context windows; the clamp is gone and this extension owns the key
 * now, so existing settings keep working unchanged.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Fallback threshold when settings.json has no valid `compactionThreshold`. */
export const COMPACTION_THRESHOLD_DEFAULT = 120_000;

/** Effective compaction threshold, or null ("off") when explicitly disabled. */
export function getCompactionThreshold(path: string = SETTINGS_PATH): number | null {
	try {
		if (!existsSync(path)) return COMPACTION_THRESHOLD_DEFAULT;
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		const value = parsed["compactionThreshold"];
		if (value === null) return null;
		return typeof value === "number" && value >= 1000 ? value : COMPACTION_THRESHOLD_DEFAULT;
	} catch {
		return COMPACTION_THRESHOLD_DEFAULT;
	}
}

/** Save threshold to global settings.json (null = off). */
export function saveGlobalThreshold(n: number | null, path: string = SETTINGS_PATH): boolean {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		parsed["compactionThreshold"] = n;
		writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

/** Parse "150000", "150k", "1.5m" (case-insensitive) → tokens; null if invalid. */
export function parseThresholdInput(input: string): number | null {
	const s = input.trim().toLowerCase();
	if (!s) return null;
	const match = s.match(/^(\d+(?:\.\d+)?)([km]?)$/);
	if (!match) return null;
	let val = parseFloat(match[1]);
	const suffix = match[2];
	if (suffix === "k") val *= 1000;
	else if (suffix === "m") val *= 1_000_000;
	return Math.round(val);
}

/** Compact token count for UI: 999 → "999", 1500 → "1.5k", 120000 → "120k", 1500000 → "1.5M". */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}
