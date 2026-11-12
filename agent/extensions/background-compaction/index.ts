/**
 * Background Compaction
 *
 * Instead of pausing the session when the compaction threshold is hit, this
 * extension starts the summarization LLM call in the background while the main
 * session keeps working. When the summary lands, it is applied at the next
 * boundary (turn_end / agent_before_settle) via a CompactionEntryDraft, so the
 * session continues as if a compaction had just happened — with zero pause.
 *
 * How the retroactive splice works (pi's cut-point design):
 *   T0: freeze cut point C, start summarizing [prevBoundary .. C] in background
 *   T0..T1: main session keeps appending — everything lands AFTER C
 *   T1: append CompactionEntry{ summary, firstKeptEntryId: C }
 *   => next request context = summary + messages after C
 *      (includes everything appended during summarization, full fidelity)
 *
 * Threshold: `compactionThreshold` in ~/.pi/agent/settings.json — a number
 * ≥ 1000 (default 120k) at which background compaction starts; `null` turns
 * background compaction off (pi's native compaction remains as backstop).
 * This is the same key routerai-provider/gptplus5-provider used to read for
 * their context-window clamps; the clamps are gone and this extension owns
 * the setting now, so existing values keep working. Change it at runtime
 * with /compact-threshold.
 *
 * Indicators:
 *   - footer: `⏲ used/threshold (pct)` — when background compaction will fire
 *   - widget above the editor: live spinner while the job runs
 *     (tokens, messages, elapsed), then a ✓/⚠ result line for 8s
 *
 * Safety nets:
 *   - If the built-in threshold compaction fires while the job is in flight,
 *     `session_before_compact` hands over the ready result (or awaits the
 *     pending one — bounded, and strictly cheaper than a cold compaction).
 *     "overflow" recovery and manual /compact are never intercepted.
 *   - If the job fails, the built-in machinery remains untouched as backstop.
 *   - Jobs are discarded if the session was replaced or the branch moved
 *     (/tree navigation) before they could be applied.
 *
 * Caveats: the background summarization runs without pi's retry policy
 * (single attempt; failures fall back to the built-in path), and the deep
 * import of `prepareCompaction` is version-sensitive — if pi internals move,
 * the extension disables itself and leaves built-in compaction intact.
 * Compaction budgets come from the "compaction" settings section
 * (modelOverrides are not resolved here).
 *
 * Try it: /bg-compact starts a job immediately, ignoring the threshold.
 */

import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_COMPACTION_SETTINGS,
	compact as runSummarization,
	DynamicBorder,
	type CompactionResult,
} from "@earendil-works/pi-coding-agent";
import { Container, Input, Text } from "@earendil-works/pi-tui";
import {
	formatTokens,
	getCompactionThreshold,
	parseThresholdInput,
	saveGlobalThreshold,
} from "./threshold.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 120;
const DONE_STATUS_MS = 8_000;

/** Compact duration, same format as the turn-timer extension. */
function formatDuration(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	const hours = Math.floor(minutes / 60);
	if (hours > 0) return `${hours}h ${minutes % 60}m ${remainder}s`;
	return `${minutes}m ${remainder}s`;
}

/** Footer gauge (when will compaction fire). */
const STATUS_KEY = "bg-compact";
/** Editor widget (live job progress / result). */
const WIDGET_KEY = "bg-compact";

interface CompactionPreparationLike {
	firstKeptEntryId: string;
	tokensBefore: number;
	previousSummary?: string;
	messagesToSummarize: unknown[];
}

type PrepareCompactionFn = (
	entries: unknown[],
	settings: unknown,
) => CompactionPreparationLike | undefined;

interface BgJob {
	sessionId: string;
	snapshotTipId: string | null;
	prevCompactionId: string | null;
	tokensBefore: number;
	messageCount: number;
	promise: Promise<CompactionResult>;
	/** Set when the summarization call resolves successfully. */
	result?: CompactionResult;
	startedAt: number;
	abort: AbortController;
	applied: boolean;
}

export default function (pi: ExtensionAPI) {
	/** The single in-flight (or ready-to-apply) background job. */
	let job: BgJob | null = null;
	/** Cached deep-imported compaction module ({ prepareCompaction }). */
	let prepareCompaction: PrepareCompactionFn | null = null;
	let deepImportBroken = false;

	let spinnerTimer: ReturnType<typeof setInterval> | null = null;
	let doneTimer: ReturnType<typeof setTimeout> | null = null;
	let latestCtx: ExtensionContext | undefined;
	/** Synchronous guard against double-starts while the async start is awaiting. */
	let startInFlight = false;

	// ---------- small helpers ----------

	const getEffectiveCompactionSettings = () => {
		const fromSettings = pi.getSettings()?.compaction as
			| Partial<typeof DEFAULT_COMPACTION_SETTINGS>
			| undefined;
		return { ...DEFAULT_COMPACTION_SETTINGS, ...fromSettings };
	};

	const latestCompactionId = (ctx: ExtensionContext): string | null => {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			if (branch[i].type === "compaction") return branch[i].id;
		}
		return null;
	};

	// ---------- indicators ----------

	// Widget above the editor: live job progress / result line.
	const setWidgetText = (ctx: ExtensionContext, lines: string[]) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, lines);
	};

	const clearWidget = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	const stopSpinner = () => {
		if (spinnerTimer) {
			clearInterval(spinnerTimer);
			spinnerTimer = null;
		}
	};

	const startSpinner = (ctx: ExtensionContext, j: BgJob) => {
		if (!ctx.hasUI) return;
		let frame = 0;
		const render = () => {
			const elapsed = formatDuration(Date.now() - j.startedAt);
			const spin = SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length];
			setWidgetText(ctx, [
				`${spin} compaction in background · ~${formatTokens(j.tokensBefore)} tokens · ${j.messageCount} msgs · ${elapsed}`,
			]);
		};
		render();
		spinnerTimer = setInterval(render, SPINNER_INTERVAL_MS);
	};

	const showDoneWidget = (ctx: ExtensionContext, text: string) => {
		stopSpinner();
		if (doneTimer) clearTimeout(doneTimer);
		setWidgetText(ctx, [text]);
		doneTimer = setTimeout(() => {
			clearWidget(ctx);
			doneTimer = null;
		}, DONE_STATUS_MS);
	};

	// Footer gauge: when will background compaction fire. Color bands mirror
	// pi's built-in footer context display (>90 error, >70 warning), but the
	// percentage is measured against the compaction threshold — 100% here is
	// when background compaction fires. While a job is in flight the live
	// estimate keeps creeping (the session keeps appending until the summary
	// lands), so mark the gauge to make that self-explanatory.
	const updateGauge = (ctx: ExtensionContext) => {
		latestCtx = ctx;
		if (!ctx.hasUI) return;
		const threshold = getCompactionThreshold();
		if (threshold === null) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const tokens = ctx.getContextUsage()?.tokens;
		const suffix = job && !job.applied ? " · ⟳ compacting" : "";
		if (tokens == null) {
			// Unknown right after a compaction until the next LLM response —
			// same '?' convention as pi's built-in footer.
			ctx.ui.setStatus(
				STATUS_KEY,
				ctx.ui.theme.fg("dim", `⏲ ?/${formatTokens(threshold)}${suffix}`),
			);
			return;
		}
		const pct = Math.min(999, Math.round((tokens / threshold) * 100));
		const body = `⏲ ${formatTokens(tokens)}/${formatTokens(threshold)} (${pct}%)${suffix}`;
		ctx.ui.setStatus(
			STATUS_KEY,
			pct > 90
				? ctx.ui.theme.fg("error", body)
				: pct > 70
					? ctx.ui.theme.fg("warning", body)
					: ctx.ui.theme.fg("dim", body),
		);
	};

	const resetState = () => {
		if (job && !job.applied) job.abort.abort();
		job = null;
		stopSpinner();
		if (doneTimer) {
			clearTimeout(doneTimer);
			doneTimer = null;
		}
		if (latestCtx) clearWidget(latestCtx);
	};

	// ---------- job lifecycle ----------

	/**
	 * Load pi's internal prepareCompaction (not exported from the package root).
	 * pi maps the bare specifier to its own dist via a jiti alias, so plain CJS
	 * resolution from the extension file cannot see the package. Candidate
	 * strategies, best first:
	 *   1. bare deep dynamic import (resolves under jiti when its resolver
			  ignores the package "exports" map)
	 *   2. import.meta.resolve (real Node ESM)
	 *   3. the running pi entry (process.argv[1], e.g. .../dist/bundle/cli.js)
			  walked up to the package root — exact for the node CLI runtime
	 *   4. CJS lookup paths + module.globalPaths + NODE_PATH
	 */
	const loadPrepareCompaction = async (ctx: ExtensionContext) => {
		if (prepareCompaction) return prepareCompaction;
		if (deepImportBroken) return null;

		// 1+2: bare deep import and import.meta.resolve
		try {
			// Non-literal specifier: TS skips subpath resolution; jiti's resolver may honor it.
			const deepSpecifier = "@earendil-works/pi-coding-agent/dist/core/compaction/index.js";
			const mod = (await import(deepSpecifier)) as {
				prepareCompaction?: PrepareCompactionFn;
			};
			if (typeof mod.prepareCompaction === "function") {
				prepareCompaction = mod.prepareCompaction;
				return prepareCompaction;
			}
		} catch {
			/* exports map / resolver restrictions: try file-path candidates */
		}

		const files: string[] = [];
		try {
			const resolved = (import.meta as { resolve?: (specifier: string) => string }).resolve?.(
				"@earendil-works/pi-coding-agent",
			);
			if (resolved) {
				files.push(path.join(path.dirname(fileURLToPath(resolved)), "core", "compaction", "index.js"));
			}
		} catch {
			/* not available under jiti */
		}

		// 3: derive the package root from the running pi entry script
		// (argv[1] may be an extension-less bin launcher; realpath resolves the symlink)
		try {
			const entry = process.argv[1];
			if (entry) {
				let dir = path.dirname(realpathSync(entry));
				for (let i = 0; i < 8 && dir !== path.dirname(dir); i++) {
					// dir may be the package root (…/dist) or a node_modules dir
					files.push(path.join(dir, "core", "compaction", "index.js"));
					files.push(path.join(dir, "dist", "core", "compaction", "index.js"));
					files.push(path.join(dir, "@earendil-works", "pi-coding-agent", "dist", "core", "compaction", "index.js"));
					files.push(path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "compaction", "index.js"));
					dir = path.dirname(dir);
				}
			}
		} catch {
			/* ignore */
		}

		// 4: plain lookup paths and globals
		try {
			const req = createRequire(import.meta.url);
			const bases = [...(req.resolve.paths("@earendil-works/pi-coding-agent") ?? [])];
			const moduleApi = req("node:module") as { globalPaths?: string[] };
			bases.push(...(moduleApi.globalPaths ?? []));
			for (const base of bases) {
				files.push(path.join(base, "@earendil-works", "pi-coding-agent", "dist", "core", "compaction", "index.js"));
			}
		} catch {
			/* ignore */
		}

		for (const file of [...new Set(files)]) {
			if (!existsSync(file)) continue;
			try {
				const mod = (await import(pathToFileURL(file).href)) as {
					prepareCompaction?: PrepareCompactionFn;
				};
				if (typeof mod.prepareCompaction === "function") {
					prepareCompaction = mod.prepareCompaction;
					return prepareCompaction;
				}
			} catch {
				/* try next candidate */
			}
		}
		deepImportBroken = true;
		if (ctx.hasUI) {
			ctx.ui.notify(
				"Background compaction disabled: cannot load prepareCompaction (pi internals moved)",
				"warning",
			);
		}
		return null;
	};

	const maybeStartJob = (ctx: ExtensionContext, force = false) => {
		latestCtx = ctx;
		if (job || startInFlight || deepImportBroken) return;
		if (!force) {
			if (getEffectiveCompactionSettings().enabled === false) return; // auto-compaction off: only /bg-compact forces
			const threshold = getCompactionThreshold();
			if (threshold === null) return; // background compaction off
			const usage = ctx.getContextUsage();
			if (!usage?.tokens || usage.tokens < threshold) return;
		}
		if (!ctx.model) return;

		startInFlight = true;
		void (async () => {
			try {
				const prepare = await loadPrepareCompaction(ctx);
				if (!prepare || job) return;
				const model = ctx.model;
				if (!model) return;

				const settings = getEffectiveCompactionSettings();
				const branch = ctx.sessionManager.getBranch();
				// Exact production semantics: iterative boundary, split turns, token estimation.
				const preparation = prepare(branch, settings);
				if (!preparation) return; // nothing to compact (session too small / already compacted)

				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) {
					if (ctx.hasUI) ctx.ui.notify(`Background compaction skipped: ${auth.error}`, "warning");
					return;
				}
				// compact() takes plain string headers; drop null entries from ProviderHeaders.
				const headers = Object.fromEntries(
					Object.entries(auth.headers ?? {}).filter((entry): entry is [string, string] => entry[1] != null),
				);

				const abort = new AbortController();
				const startedAt = Date.now();
				const promise = (runSummarization as unknown as (
					preparation: unknown,
					model: unknown,
					apiKey: string | undefined,
					headers: Record<string, string> | undefined,
					customInstructions: undefined,
					signal: AbortSignal,
					thinkingLevel: typeof ctx.thinkingLevel,
					streamFn: undefined,
					env: Record<string, string> | undefined,
				) => Promise<CompactionResult>)(
					preparation,
					model,
					auth.apiKey,
					headers,
					undefined,
					abort.signal,
					ctx.thinkingLevel,
					undefined,
					auth.env,
				);

				const pendingJob: BgJob = {
					sessionId: ctx.sessionManager.getSessionId(),
					snapshotTipId: branch.at(-1)?.id ?? null,
					prevCompactionId: latestCompactionId(ctx),
					tokensBefore: preparation.tokensBefore,
					messageCount: preparation.messagesToSummarize.length,
					promise,
					startedAt,
					abort,
					applied: false,
				};
				pendingJob.promise.then(
					(result) => {
						pendingJob.result = result;
					},
					(error) => {
						if (job !== pendingJob || pendingJob.applied) return;
						job = null;
						if (!abort.signal.aborted) {
							if (ctx.hasUI) {
								ctx.ui.notify(
									`Background compaction failed: ${error instanceof Error ? error.message : String(error)}`,
									"error",
								);
							}
							showDoneWidget(ctx, "⚠ background compaction failed — built-in compaction stays active");
						}
					},
				);
				job = pendingJob;

				if (ctx.hasUI) {
					ctx.ui.notify(
						`Background compaction started (~${formatTokens(preparation.tokensBefore)} tokens) — session keeps running`,
						"info",
					);
				}
				startSpinner(ctx, pendingJob);
			} catch (error) {
				if (ctx.hasUI) {
					ctx.ui.notify(
						`Background compaction failed to start: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			} finally {
				startInFlight = false;
			}
		})();
	};

	/**
	 * True when a finished result can still be applied to this session/branch:
	 * same session, cut point and snapshot tip still on the branch (a /tree
	 * navigation away from them invalidates the job), and no built-in compaction
	 * landed meanwhile.
	 */
	const isApplicable = (ctx: ExtensionContext, j: BgJob, result: CompactionResult): boolean => {
		if (j.applied) return false;
		if (ctx.sessionManager.getSessionId() !== j.sessionId) return false;
		const branch = ctx.sessionManager.getBranch();
		const ids = new Set(branch.map((e) => e.id));
		if (j.snapshotTipId !== null && !ids.has(j.snapshotTipId)) return false;
		if (!ids.has(result.firstKeptEntryId)) return false;
		if (latestCompactionId(ctx) !== j.prevCompactionId) return false;
		return true;
	};

	const doneWidget = (ctx: ExtensionContext, j: BgJob) => {
		const duration = formatDuration(Date.now() - j.startedAt);
		showDoneWidget(ctx, `✓ compacted ~${formatTokens(j.tokensBefore)} tokens in background · ${duration}`);
	};

	const draftFrom = (result: CompactionResult): SessionBoundaryDraft => ({
		type: "compaction",
		summary: result.summary,
		firstKeptEntryId: result.firstKeptEntryId,
		details: result.details,
		usage: result.usage,
	});

	/** Apply the finished job at a boundary. Returns the boundary result or undefined. */
	const tryApply = (ctx: ExtensionContext): { entries: SessionBoundaryDraft[] } | undefined => {
		latestCtx = ctx;
		const j = job;
		if (!j?.result || !isApplicable(ctx, j, j.result)) return undefined;
		j.applied = true;
		job = null;
		doneWidget(ctx, j);
		return { entries: [draftFrom(j.result)] };
	};

	// ---------- wiring ----------

	pi.on("session_before_compact", async (event, ctx) => {
		latestCtx = ctx;
		// Only optimize the ordinary threshold path; overflow recovery and manual
		// /compact keep their built-in semantics.
		if (event.reason !== "threshold" || !job || job.applied) return undefined;
		const j = job;
		let result: CompactionResult;
		try {
			result = await j.promise; // bounded wait; strictly cheaper than a cold compaction
		} catch {
			return undefined; // failed: let the built-in path run cold
		}
		if (event.signal?.aborted || !isApplicable(ctx, j, result)) return undefined;
		j.applied = true;
		job = null;
		doneWidget(ctx, j);
		return {
			compaction: {
				summary: result.summary,
				firstKeptEntryId: result.firstKeptEntryId,
				tokensBefore: result.tokensBefore,
				usage: result.usage,
				details: result.details,
			},
		};
	});

	pi.on("turn_end", async (_event, ctx) => {
		maybeStartJob(ctx);
		updateGauge(ctx);
		return tryApply(ctx);
	});

	pi.on("agent_before_settle", async (_event, ctx) => {
		return tryApply(ctx);
	});

	// Cover runs that settle without the turn_end check seeing the threshold.
	pi.on("agent_settled", async (_event, ctx) => {
		maybeStartJob(ctx);
		updateGauge(ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		resetState();
		updateGauge(ctx);
	});

	pi.on("session_shutdown", async () => {
		resetState();
	});

	// ── /compact-threshold: interactive menu (ported from the old
	// compaction-threshold extension via routerai-provider) ──

	pi.registerCommand("compact-threshold", {
		description: "Show/set background compaction threshold (tokens). Supports k/M suffixes.",
		handler: async (_args, rawCtx) => {
			const ctx = rawCtx as ExtensionContext;
			const threshold = getCompactionThreshold();
			const currentVal = threshold === null ? "off" : formatTokens(threshold);

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const container = new Container();

					container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
					container.addChild(new Text(theme.fg("accent", theme.bold("Background Compaction Threshold")), 1, 0));
					container.addChild(new Text("", 0, 0));
					container.addChild(new Text(theme.fg("dim", `Current: ${theme.fg("text", currentVal)}`), 1, 0));
					container.addChild(new Text("", 0, 0));

					const input = new Input({ prompt: theme.fg("accent", "New threshold: ") });
					input.onSubmit = (value) => {
						const trimmed = value.trim();
						if (!trimmed) {
							done(undefined);
							return;
						}
						if (trimmed.toLowerCase() === "off" || trimmed.toLowerCase() === "disable") {
							if (!saveGlobalThreshold(null)) {
								ctx.ui.notify("Failed to write settings.json", "error");
								done(undefined);
								return;
							}
							ctx.ui.notify("Background compaction off — native compaction remains as backstop", "warning");
							if (latestCtx) updateGauge(latestCtx);
							done(undefined);
							return;
						}
						const parsed = parseThresholdInput(trimmed);
						if (parsed !== null && parsed >= 1000) {
							if (!saveGlobalThreshold(parsed)) {
								ctx.ui.notify("Failed to write settings.json", "error");
								done(undefined);
								return;
							}
							ctx.ui.notify(
								`Background compaction threshold set to ${formatTokens(parsed)} — applies from the next turn`,
								"info",
							);
							if (latestCtx) updateGauge(latestCtx);
							done(undefined);
						} else {
							ctx.ui.notify("Invalid threshold. Use a number ≥ 1000, or 'off'.", "error");
						}
					};
					input.onEscape = () => done(undefined);
					container.addChild(input);

					const previewText = new Text("", 1, 0);
					container.addChild(previewText);
					container.addChild(new Text(theme.fg("dim", "Enter: confirm · Esc: cancel · saved to ~/.pi/agent/settings.json"), 1, 0));
					container.addChild(new Text(theme.fg("dim", "Supports k/M suffixes · 'off' to disable"), 1, 0));
					container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

					return {
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							input.handleInput(data);
							const val = input.getValue();
							if (val.trim()) {
								const lower = val.trim().toLowerCase();
								if (lower === "off" || lower === "disable") {
									previewText.setText(theme.fg("dim", "  → background compaction off"));
								} else {
									const parsed = parseThresholdInput(val);
									if (parsed !== null) {
										previewText.setText(theme.fg("dim", `  → ${formatTokens(parsed)}`));
									} else {
										previewText.setText(theme.fg("warning", "  (invalid)"));
									}
								}
							} else {
								previewText.setText("");
							}
							tui.requestRender();
						},
					};
				},
			);
		},
	});

	pi.registerCommand("bg-compact", {
		description: "Start a background compaction now (ignores the token threshold)",
		handler: async (_args, ctx) => {
			latestCtx = ctx as ExtensionContext;
			if (job) {
				ctx.ui.notify("Background compaction already in flight", "warning");
				return;
			}
			maybeStartJob(ctx as ExtensionContext, true);
			if (!job && !startInFlight) {
				ctx.ui.notify("Nothing to compact (session too small or already compacted)", "warning");
			}
		},
	});
}
