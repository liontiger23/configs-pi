/**
 * pin — compaction-proof pinned context, per session
 *
 * Pin text, files, or skills into the system prompt so the model never
 * "forgets" them — even after compaction. The system prompt is rebuilt each
 * turn and is not part of the compacted conversation history, so pinned
 * content is immune to compaction by construction.
 *
 * State is stored in <session-file>.pin.md, next to the session file, so:
 *   - concurrent sessions have independent pins
 *   - restarting/resuming a session restores its pin
 *   - forked sessions start clean (session_start re-derives the path)
 *   - ephemeral sessions (no session file) fall back to in-memory state
 *
 * Commands:
 *   /pin <text>           append text to the pin
 *   /pin file <path>      append a file's contents (absolute or relative to cwd)
 *   /pin skill <name>     append a skill's SKILL.md contents by name
 *   /pin show             display pin, its file path, and size
 *   /pin edit             edit the whole pin (Ctrl+G inside the dialog opens nvim/$EDITOR)
 *   /pin refine [focus]   LLM reorganizes the pin; you review it in the editor
 *                         before anything is applied (Esc rejects)
 *   /pin clear            remove the pin
 *
 * Settings (optional, in ~/.pi/settings.json):
 *   { "pinExtension": { "refineModel": "provider/model-id" } }
 *   e.g. "google/gemini-2.5-flash". Defaults to the session's current model.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const WIDGET_ID = "pin";
const BLOAT_WARN_RATIO = 1.5; // warn when the refine proposal grows >50%
const MAX_REFINE_GROWTH_RATIO = 3.0; // hard-block proposals >3x original size

function uuidv7(): string {
	// RFC 9562-ish v7: timestamp-ordered UUID, good enough for routing session ids
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const ts = Date.now();
	bytes[0] = (ts / 2 ** 40) & 0xff;
	bytes[1] = (ts / 2 ** 32) & 0xff;
	bytes[2] = (ts / 2 ** 24) & 0xff;
	bytes[3] = (ts / 2 ** 16) & 0xff;
	bytes[4] = (ts / 2 ** 8) & 0xff;
	bytes[5] = ts & 0xff;
	bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
	bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let stateFile: string | undefined; // undefined => ephemeral, in-memory only
let ephemeralPin: string | null = null;
let cachedCwd = ""; // for argument completions, which receive no ctx

function loadPinned(): string | null {
	if (stateFile) {
		try {
			const text = fs.readFileSync(stateFile, "utf8").trim();
			return text || null;
		} catch {
			return ephemeralPin; // file missing/unreadable => fall back to memory
		}
	}
	return ephemeralPin;
}

function savePinned(text: string | null, ctx: ExtensionCommandContext): void {
	ephemeralPin = text;
	if (!stateFile) return;
	try {
		if (text === null || text === "") {
			fs.rmSync(stateFile, { force: true });
		} else {
			// atomic write: temp file + rename so a crash can't corrupt the pin
			const tmp = `${stateFile}.tmp`;
			fs.writeFileSync(tmp, text.endsWith("\n") ? text : `${text}\n`, "utf8");
			fs.renameSync(tmp, stateFile);
		}
	} catch (err) {
		ctx.ui.notify(`Pin write failed: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
	syncWidget(ctx);
}

function lineCount(text: string): number {
	return text.split("\n").length;
}

function sourceSummary(text: string): string {
	const lines = lineCount(text);
	return `${lines} line${lines === 1 ? "" : "s"}`;
}

function syncWidget(ctx: { ui: ExtensionCommandContext["ui"] }): void {
	const pinned = loadPinned();
	if (!pinned) {
		ctx.ui.setWidget(WIDGET_ID, undefined);
		return;
	}
	const scope = stateFile ? "session" : "ephemeral";
	ctx.ui.setWidget(WIDGET_ID, [`📌 pinned: ${sourceSummary(pinned)} (${scope})`]);
}

// ---------------------------------------------------------------------------
// Skill resolution (mirrors docs/skills.md discovery rules)
// ---------------------------------------------------------------------------

interface SkillMatch {
	name: string;
	file: string; // SKILL.md path (or the root .md file itself)
	location: string;
}

function readFrontmatterName(file: string): string | undefined {
	try {
		const head = fs.readFileSync(file, "utf8").slice(0, 2048);
		const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
		if (!m) return undefined;
		const nameLine = m[1].split("\n").find((l) => /^name:\s*/.test(l));
		if (!nameLine) return undefined;
		const name = nameLine.replace(/^name:\s*/, "").trim().replace(/^["']|["']$/g, "");
		return /^[a-z0-9][a-z0-9-]{0,63}$/.test(name) ? name : undefined;
	} catch {
		return undefined;
	}
}

function collectSkills(root: string, allowRootMd: boolean, depth: number, out: SkillMatch[]): void {
	if (depth > 6) return;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) {
			const skillMd = path.join(full, "SKILL.md");
			if (fs.existsSync(skillMd)) {
				out.push({
					name: readFrontmatterName(skillMd) ?? entry.name,
					file: skillMd,
					location: root,
				});
			} else {
				collectSkills(full, allowRootMd, depth + 1, out);
			}
		} else if (allowRootMd && entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
			// root .md files count as skills only in ~/.pi/agent/skills and .pi/skills
			const name = readFrontmatterName(full);
			if (name) out.push({ name, file: full, location: root });
		}
	}
}

function findSkills(cwd: string): SkillMatch[] {
	const home = os.homedir();
	const roots: Array<{ dir: string; allowRootMd: boolean }> = [
		{ dir: path.join(home, CONFIG_DIR_NAME, "agent", "skills"), allowRootMd: true },
		{ dir: path.join(cwd, CONFIG_DIR_NAME, "skills"), allowRootMd: true },
		{ dir: path.join(home, ".agents", "skills"), allowRootMd: false },
		{ dir: path.join(cwd, ".agents", "skills"), allowRootMd: false },
	];

	// .agents/skills in ancestor directories up to git repo root (or fs root)
	let dir = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(dir, ".agents", "skills");
		if (candidate !== roots[3].dir) roots.push({ dir: candidate, allowRootMd: false });
		if (fs.existsSync(path.join(dir, ".git")) || dir === path.parse(dir).root) break;
		dir = path.dirname(dir);
	}

	const seen = new Set<string>();
	const out: SkillMatch[] = [];
	for (const { dir: root, allowRootMd } of roots) {
		const found: SkillMatch[] = [];
		collectSkills(root, allowRootMd, 0, found);
		for (const skill of found) {
			const key = `${skill.name}@${skill.file}`;
			if (!seen.has(key)) {
				seen.add(key);
				out.push(skill);
			}
		}
	}
	return out;
}

async function resolveSkillByName(
	name: string,
	cwd: string,
	ctx: ExtensionCommandContext,
): Promise<SkillMatch | undefined> {
	const all = findSkills(cwd);
	const matches = all.filter((s) => s.name === name);
	if (matches.length === 0) return undefined;
	if (matches.length === 1) return matches[0];
	// ambiguous (same name in multiple locations) — let the user pick
	const choice = await ctx.ui.select(
		`Multiple skills named "${name}":`,
		matches.map((m) => `${m.file}  (${m.location})`),
	);
	if (!choice) return undefined;
	const idx = matches.findIndex((m) => `${m.file}  (${m.location})` === choice);
	return idx >= 0 ? matches[idx] : undefined;
}

// ---------------------------------------------------------------------------
// Refine: LLM reorganization with editor approval gate
// ---------------------------------------------------------------------------

const REFINE_SYSTEM_PROMPT = `You reorganize a "pinned context" block that is appended to an AI coding assistant's system prompt every turn. The user accumulates pinned text/files/skills over time and they become disorganized.

Your job: produce a better-organized version of the pin.

Rules:
- Reorganize into logical sections with clear markdown headings.
- Deduplicate overlapping content and resolve contradictions (prefer the most recent/restrictive instruction when genuinely conflicting, otherwise note the conflict).
- Add MINIMAL bridging context only where the user explicitly asks for it in the refinement focus. Do not invent new constraints, facts, or instructions.
- Preserve every factual constraint and hard requirement verbatim.
- Do not grow the total length by more than ~30%. When in doubt, be more concise.
- Keep the same language as the source material.
- Output ONLY the new pin content in markdown. No preamble, no explanation, no code fences around the whole output.`;

async function refinePin(focus: string, ctx: ExtensionCommandContext): Promise<void> {
	const current = loadPinned();
	if (!current) {
		ctx.ui.notify("Nothing pinned to refine", "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("/pin refine needs interactive UI", "error");
		return;
	}

	// Resolve model: optional "provider/model-id" setting, else session model
	let model = ctx.model;
	const configured = readRefineModelSetting();
	if (configured) {
		const [provider, ...rest] = configured.split("/");
		const found = ctx.modelRegistry.find(provider, rest.join("/"));
		if (!found) {
			ctx.ui.notify(`pin.refineModel "${configured}" not found, using session model`, "warning");
		} else {
			model = found;
		}
	}
	if (!model) {
		ctx.ui.notify("No model available for refine", "error");
		return;
	}

	ctx.ui.notify(`Refining pin with ${model.id}...`, "info");

	const focusText = focus.trim()
		? `\n\nRefinement focus from the user:\n${focus.trim()}`
		: "";
	const messages = [
		{
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: `<current-pin>\n${current}\n</current-pin>${focusText}`,
				},
			],
			timestamp: Date.now(),
		},
	];

	let proposal: string;
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{ messages },
			{ maxTokens: 8192, cacheRetention: "none", sessionId: uuidv7() },
		);
		proposal = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
	} catch (err) {
		ctx.ui.notify(`Refine failed: ${err instanceof Error ? err.message : String(err)}`, "error");
		return;
	}

	if (!proposal) {
		ctx.ui.notify("Refine produced empty output — pin unchanged", "warning");
		return;
	}

	// Anti-bloat guards
	const ratio = proposal.length / Math.max(current.length, 1);
	if (ratio > MAX_REFINE_GROWTH_RATIO) {
		ctx.ui.notify(
			`Refine proposal is ${Math.round(ratio * 100)}% of original size (way over limit) — discarded. Pin unchanged.`,
			"error",
		);
		return;
	}
	if (ratio > BLOAT_WARN_RATIO) {
		ctx.ui.notify(
			`⚠ Proposal grew ${Math.round((ratio - 1) * 100)}% — review carefully and trim what you don't need.`,
			"warning",
		);
	}

	// Approval gate: the editor IS the approval mechanism.
	// - Enter: apply (possibly after trimming)
	// - Esc: reject entirely
	// - Ctrl+G inside the dialog opens nvim/$EDITOR for comfortable review
	const reviewed = await ctx.ui.editor(
		"Refined pin — Enter applies, Esc rejects (Ctrl+G for full editor):",
		proposal,
	);
	if (reviewed === undefined) {
		ctx.ui.notify("Refine rejected — pin unchanged", "info");
		return;
	}
	const approved = reviewed.trim();
	if (!approved) {
		ctx.ui.notify("Refined pin is empty — pin unchanged", "warning");
		return;
	}
	savePinned(approved, ctx);
	ctx.ui.notify(`Pin refined: ${sourceSummary(current)} → ${sourceSummary(approved)}`, "info");
}

function readRefineModelSetting(): string | undefined {
	try {
		const settingsPath = path.join(os.homedir(), CONFIG_DIR_NAME, "settings.json");
		const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
		const value = settings?.pinExtension?.refineModel;
		return typeof value === "string" && value.trim() ? value.trim() : undefined;
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const SUBCOMMANDS = ["file", "skill", "show", "edit", "refine", "clear"] as const;

export default function pinExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		stateFile = sessionFile ? `${sessionFile}.pin.md` : undefined;
		// Reset ephemeral state per session instance — pi reloads extensions on
		// fork/clone, so this also gives forks a clean slate.
		ephemeralPin = null;
		cachedCwd = ctx.cwd;
		syncWidget(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		const pinned = loadPinned();
		if (!pinned) return undefined;
		return {
			systemPrompt: `${event.systemPrompt}\n\n<pinned-context>\nThe following context is pinned by the user and must never be forgotten or dropped, regardless of conversation summarization:\n\n${pinned}\n</pinned-context>`,
		};
	});

	pi.registerCommand("pin", {
		description:
			"Pin compaction-proof context (/pin <text>|file <path>|skill <name>|show|edit|refine [focus]|clear)",
		getArgumentCompletions: (prefix: string) => {
			// pi replaces the ENTIRE argument text (this `prefix`) with the chosen
			// item's `value` and does NOT submit on Enter for argument completions.
			// So: only return items whose `value` is a safe full replacement, and
			// return null whenever the user has already typed something complete,
			// so Enter submits instead of mangling the line.
			if (!prefix.includes(" ")) {
				// Still typing the subcommand word (or nothing after "/pin ")
				if (prefix === "") return null; // Enter should show usage, not open a menu
				const items = SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((value) => ({
					value,
					label: value,
				}));
				return items.length > 0 ? items : null;
			}
			const first = prefix.split(/\s+/)[0];
			if (first === "skill") {
				const rest = prefix.slice("skill".length).trimStart();
				if (rest === "") return null; // let the user start typing a name
				// Exact match → no menu, Enter submits directly.
				const skills = findSkills(cachedCwd);
				if (skills.some((s) => s.name === rest)) return null;
				const matches = skills.filter((s) => s.name.startsWith(rest));
				if (matches.length === 0) return null; // typo → submit → "not found" error
				// value must be the full replacement of the argument text
				return matches.map((s) => ({ value: `skill ${s.name}`, label: s.name, description: s.file }));
			}
			// file/show/edit/refine/clear: no argument completion
			return null;
		},
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();

			if (!trimmedArgs) {
				ctx.ui.notify(
					"Usage: /pin <text> | file <path> | skill <name> | show | edit | refine [focus] | clear",
					"warning",
				);
				return;
			}

			const first = trimmedArgs.split(/\s+/)[0] ?? "";
			if (!(SUBCOMMANDS as readonly string[]).includes(first)) {
				// Not a subcommand — treat the whole input as pin text
				const existing = loadPinned();
				const combined = existing ? `${existing}\n${trimmedArgs}` : trimmedArgs;
				savePinned(combined, ctx);
				ctx.ui.notify(`Pinned (${sourceSummary(combined)})`, "info");
				return;
			}

			const [sub, ...rest] = trimmedArgs.split(/\s+/);
			const restText = rest.join(" ");

			switch (sub) {
				case "file": {
					if (!restText) {
						ctx.ui.notify("Usage: /pin file <path>", "warning");
						return;
					}
					const file = path.resolve(ctx.cwd, restText);
					try {
						const content = fs.readFileSync(file, "utf8").trim();
						const existing = loadPinned();
						const combined = existing
							? `${existing}\n\n# From file: ${restText}\n${content}`
							: `# From file: ${restText}\n${content}`;
						savePinned(combined, ctx);
						ctx.ui.notify(`Pinned ${file} (${sourceSummary(content)})`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Cannot read ${file}: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					return;
				}

				case "skill": {
					if (!restText) {
						ctx.ui.notify("Usage: /pin skill <name>", "warning");
						return;
					}
					const skill = await resolveSkillByName(restText, ctx.cwd, ctx);
					if (!skill) {
						ctx.ui.notify(
							`Skill "${restText}" not found. Searched: ~/.${CONFIG_DIR_NAME}/agent/skills, .${CONFIG_DIR_NAME}/skills, ~/.agents/skills, .agents/skills (and ancestors)`,
							"error",
						);
						return;
					}
					try {
						const content = fs.readFileSync(skill.file, "utf8").trim();
						const existing = loadPinned();
						const combined = existing
							? `${existing}\n\n# From skill: ${skill.name} (${skill.file})\n${content}`
							: `# From skill: ${skill.name} (${skill.file})\n${content}`;
						savePinned(combined, ctx);
						ctx.ui.notify(`Pinned skill "${skill.name}" (${sourceSummary(content)})`, "info");
					} catch (err) {
						ctx.ui.notify(
							`Cannot read ${skill.file}: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
					return;
				}

				case "show": {
					const pinned = loadPinned();
					if (!pinned) {
						ctx.ui.notify(
							stateFile
								? `Nothing pinned.\nState file: ${stateFile}`
								: "Nothing pinned (ephemeral session — no persistence).",
							"info",
						);
						return;
					}
					ctx.ui.notify(
						`Pin state file: ${stateFile ?? "(ephemeral, in-memory)"}\nSize: ${sourceSummary(pinned)}, ${pinned.length} chars\n\n${pinned}`,
						"info",
					);
					return;
				}

				case "edit": {
					if (!ctx.hasUI) {
						ctx.ui.notify("/pin edit needs interactive UI", "error");
						return;
					}
					const current = loadPinned() ?? "";
					const edited = await ctx.ui.editor("Edit pin (Ctrl+G for nvim/$EDITOR):", current);
					if (edited === undefined) {
						ctx.ui.notify("Edit cancelled — pin unchanged", "info");
						return;
					}
					const cleaned = edited.trim();
					savePinned(cleaned || null, ctx);
					ctx.ui.notify(cleaned ? `Pin saved (${sourceSummary(cleaned)})` : "Pin cleared", "info");
					return;
				}

				case "refine": {
					await refinePin(restText, ctx);
					return;
				}

				case "clear": {
					savePinned(null, ctx);
					ctx.ui.notify("Pin cleared", "info");
					return;
				}

				default: {
					// Unreachable given the outer dispatch, kept for type safety.
					return;
				}
			}
		},
	});

	pi.on("session_shutdown", async () => {
		// Nothing to clean up — file state is independent of the extension
		// lifecycle; widget is torn down with the session.
	});
}
