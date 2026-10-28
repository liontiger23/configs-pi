import type {
  ExtensionAPI,
  ExtensionUIContext,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Run Timer Extension
 *
 * Measures the whole wall-clock time from the moment a prompt starts a run until
 * Pi settles (no more automatic work: model turns, tool calls, retries,
 * compaction, and queued messages all included).
 *
 * - Live elapsed time is shown in the footer while the run is active.
 * - When the run settles, the total is written inline in the transcript as a
 *   durable custom entry, together with the computed cost of the run (model
 *   turns, compactions, and any other session-attributed usage that accrued
 *   during the cycle) and the number of compactions, both derived by diffing
 *   session-entry totals against a baseline taken at run start. If the run
 *   was interrupted, the entry says so.
 *
 * Lifecycle reference: `before_agent_start` opens the run window,
 * `agent_settled` closes it. See docs/extensions.md and docs/json.md.
 */

interface RunTimingData {
  elapsedMs: number;
  turns: number;
  aborted: boolean;
  costUsd?: number;
  compactions?: number;
}

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

function formatCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

/** Session-attributed cost of a single entry, matching pi's own totals. */
function entryCostUsd(entry: SessionEntry): number {
  switch (entry.type) {
    case "message":
      return entry.message.role === "assistant"
        ? (entry.message.usage?.cost?.total ?? 0)
        : 0;
    case "compaction":
    case "usage":
      return entry.usage?.cost?.total ?? 0;
    default:
      return 0;
  }
}

function sessionCostUsd(entries: readonly SessionEntry[]): number {
  return entries.reduce((sum, entry) => sum + entryCostUsd(entry), 0);
}

function countCompactions(entries: readonly SessionEntry[]): number {
  return entries.filter((entry) => entry.type === "compaction").length;
}

export default function (pi: ExtensionAPI) {
  let runStart: number | undefined;
  let turns = 0;
  let baselineCostUsd = 0;
  let baselineCompactions = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let runUi: ExtensionUIContext | undefined;
  let runTheme: Theme | undefined;

  const stopTicker = () => {
    if (ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  const format = (start: number) => formatDuration(Date.now() - start);

  const setFooter = (text: string | undefined) => {
    try {
      runUi?.setStatus("run-timer", text);
    } catch {
      // The extension runtime can be torn down (reload, session replacement)
      // while the interval is still scheduled; ignore late calls.
      stopTicker();
    }
  };

  const renderFooter = () => {
    if (runStart === undefined || runTheme === undefined) return;
    setFooter(runTheme.fg("dim", `⏱ ${format(runStart)}`));
  };

  pi.registerEntryRenderer<RunTimingData>(
    "run-timer",
    (entry, _options, theme) => {
      const data = entry.data ?? { elapsedMs: 0, turns: 0, aborted: false };
      const icon = data.aborted ? "⏹" : "⏱";
      const turnLabel =
        data.turns === 1 ? "1 model turn" : `${data.turns} model turns`;
      const parts = [
        theme.fg("dim", `${icon} `),
        theme.fg("muted", formatDuration(data.elapsedMs)),
        theme.fg("dim", ` · ${turnLabel}`),
      ];
      if (data.costUsd && data.costUsd > 0) {
        parts.push(theme.fg("dim", " · "));
        parts.push(theme.fg("muted", formatCost(data.costUsd)));
      }
      if (data.compactions && data.compactions > 0) {
        const compactionLabel =
          data.compactions === 1 ? "1 compaction" : `${data.compactions} compactions`;
        parts.push(theme.fg("dim", ` · ${compactionLabel}`));
      }
      if (data.aborted) parts.push(theme.fg("warning", " · interrupted"));
      return new Text(parts.join(""), 0, 0);
    },
  );

  pi.on("before_agent_start", async (_event, ctx) => {
    runStart = Date.now();
    turns = 0;
    const baselineEntries = ctx.sessionManager.getEntries();
    baselineCostUsd = sessionCostUsd(baselineEntries);
    baselineCompactions = countCompactions(baselineEntries);
    runUi = ctx.ui;
    runTheme = ctx.ui.theme;
    stopTicker();

    renderFooter();
    // Refresh the footer about every second while the run is active.
    ticker = setInterval(renderFooter, 1000);
    ticker.unref?.();
  });

  pi.on("turn_end", async () => {
    if (runStart === undefined) return;
    turns += 1;
    renderFooter();
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (runStart === undefined) return;
    const elapsedMs = Date.now() - runStart;

    const entries = ctx.sessionManager.getEntries();

    pi.appendEntry<RunTimingData>("run-timer", {
      elapsedMs,
      turns,
      aborted: event.aborted,
      costUsd: sessionCostUsd(entries) - baselineCostUsd,
      compactions: countCompactions(entries) - baselineCompactions,
    });

    stopTicker();
    setFooter(undefined);
    ctx.ui.setStatus("run-timer", undefined);
    runStart = undefined;
    turns = 0;
    baselineCostUsd = 0;
    baselineCompactions = 0;
    runUi = undefined;
    runTheme = undefined;
  });

  pi.on("session_shutdown", async () => {
    stopTicker();
    runStart = undefined;
    turns = 0;
    baselineCostUsd = 0;
    baselineCompactions = 0;
    runUi = undefined;
    runTheme = undefined;
  });
}
