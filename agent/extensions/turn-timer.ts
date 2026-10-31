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
 * - Live elapsed time is shown in the footer while the run is active, plus
 *   live token generation throughput (output tokens / second of streaming)
 *   while the model is producing tokens. OpenAI-compatible providers such as
 *   RouterAI only report usage on the final chunk, so the live rate is an
 *   estimate from streamed characters (~4 chars/token); the settled summary
 *   uses exact final usage instead.
 * - When the run settles, the total is written inline in the transcript as a
 *   durable custom entry, together with the computed cost of the run (model
 *   turns, compactions, and any other session-attributed usage that accrued
 *   during the cycle), the number of compactions, and the average generation
 *   rate over time actually spent streaming, all derived by diffing
 *   session-entry totals against a baseline taken at run start. If the run
 *   was interrupted, the entry says so.
 *
 * Lifecycle reference: `before_agent_start` opens the run window,
 * `agent_settled` closes it. See docs/extensions.md and docs/json.md.
 */

interface CostBreakdown {
  total: number;
  input: number;
  output: number;
  /** cacheRead + cacheWrite */
  cache: number;
}

interface RunTimingData {
  elapsedMs: number;
  turns: number;
  aborted: boolean;
  /** Total cost only (entries written before the breakdown existed). */
  costUsd?: number;
  cost?: CostBreakdown;
  compactions?: number;
  /** Output tokens generated across all streamed assistant messages. */
  genTokens?: number;
  /** Time spent streaming those tokens (excludes tool execution and network gaps between messages). */
  genMs?: number;
  /** Average generation rate over genMs. */
  tokPerSec?: number;
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

function formatCostNum(usd: number): string {
  if (usd >= 1) return usd.toFixed(2);
  return usd.toFixed(4);
}

function formatCost(usd: number): string {
  return `$${formatCostNum(usd)}`;
}

/** Session-attributed cost of a single entry, matching pi's own totals. */
function entryCost(entry: SessionEntry): CostBreakdown | undefined {
  let cost:
    | {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        total?: number;
      }
    | undefined;
  switch (entry.type) {
    case "message":
      if (entry.message.role === "assistant") cost = entry.message.usage?.cost;
      break;
    case "compaction":
    case "usage":
      cost = entry.usage?.cost;
      break;
    default:
      return undefined;
  }
  if (!cost) return undefined;
  return {
    total: cost.total ?? 0,
    input: cost.input ?? 0,
    output: cost.output ?? 0,
    cache: (cost.cacheRead ?? 0) + (cost.cacheWrite ?? 0),
  };
}

function sessionCost(entries: readonly SessionEntry[]): CostBreakdown {
  const sum: CostBreakdown = { total: 0, input: 0, output: 0, cache: 0 };
  for (const entry of entries) {
    const cost = entryCost(entry);
    if (!cost) continue;
    sum.total += cost.total;
    sum.input += cost.input;
    sum.output += cost.output;
    sum.cache += cost.cache;
  }
  return sum;
}

function countCompactions(entries: readonly SessionEntry[]): number {
  return entries.filter((entry) => entry.type === "compaction").length;
}

function formatTokPerSec(tokPerSec: number): string {
  return `${Math.round(tokPerSec)} tok/s`;
}

export default function (pi: ExtensionAPI) {
  let runStart: number | undefined;
  let turns = 0;
  let baselineCost: CostBreakdown | undefined;
  let baselineCompactions = 0;
  // Live generation-rate tracking for the currently streaming message.
  // Estimated from streamed chars (~4 chars/token): OpenAI-compatible
  // providers report usage only on the final chunk, so nothing exact is
  // available mid-stream. Chars/4 is the standard rough approximation.
  let streamingSince: number | undefined;
  let streamChars = 0;
  /** Last computed live rate, kept displayed while tools run (like cost). */
  let lastRate: number | undefined;
  // Cumulative generation stats for the whole run (final summary).
  let genTokens = 0;
  let genMs = 0;
  /** Session entries accessor for the active run, for footer cost updates. */
  let runEntries: (() => readonly SessionEntry[]) | undefined;
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
    let text = `⏱ ${format(runStart)}`;
    if (runEntries && baselineCost) {
      // Accrued cost for this turn cycle, same baseline-diff as the summary;
      // recomputed per tick so compactions and usage entries are included.
      const accrued = sessionCost(runEntries()).total - baselineCost.total;
      if (accrued > 0) text += ` ${formatCost(accrued)}`;
    }
    if (streamingSince !== undefined && streamChars > 0) {
      // Current generation rate (estimated): streamed chars / 4 divided by
      // time since the first delta of this message. Denominator keeps
      // growing during a stall, so the displayed rate decays accordingly.
      const seconds = Math.max(0.1, (Date.now() - streamingSince) / 1000);
      lastRate = streamChars / 4 / seconds;
    }
    if (lastRate !== undefined) {
      // Frozen at its last value while tools run; refreshed as soon as the
      // next message streams.
      text += ` ~${formatTokPerSec(lastRate)}`;
    }
    setFooter(runTheme.fg("dim", text));
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
      const cost = data.cost;
      if (cost && cost.total > 0) {
        let costText = formatCost(cost.total);
        // Parenthesized input/output/cache split, in fixed positions. Shown
        // whenever any component is nonzero; a provider that reports a total
        // without a breakdown gets total only.
        if (cost.input > 0 || cost.output > 0 || cost.cache > 0) {
          costText += ` (${formatCostNum(cost.input)}/${formatCostNum(cost.output)}/${formatCostNum(cost.cache)})`;
        }
        parts.push(theme.fg("dim", " · "));
        parts.push(theme.fg("muted", costText));
      } else if (data.costUsd && data.costUsd > 0) {
        parts.push(theme.fg("dim", " · "));
        parts.push(theme.fg("muted", formatCost(data.costUsd)));
      }
      if (data.compactions && data.compactions > 0) {
        const compactionLabel =
          data.compactions === 1 ? "1 compaction" : `${data.compactions} compactions`;
        parts.push(theme.fg("dim", ` · ${compactionLabel}`));
      }
      if (data.tokPerSec && data.tokPerSec > 0) {
        parts.push(theme.fg("dim", " · "));
        parts.push(theme.fg("muted", formatTokPerSec(data.tokPerSec)));
      }
      if (data.aborted) parts.push(theme.fg("warning", " · interrupted"));
      return new Text(parts.join(""), 0, 0);
    },
  );

  pi.on("before_agent_start", async (_event, ctx) => {
    runStart = Date.now();
    turns = 0;
    const baselineEntries = ctx.sessionManager.getEntries();
    baselineCost = sessionCost(baselineEntries);
    baselineCompactions = countCompactions(baselineEntries);
    runEntries = () => ctx.sessionManager.getEntries();
    runUi = ctx.ui;
    runTheme = ctx.ui.theme;
    streamingSince = undefined;
    streamChars = 0;
    lastRate = undefined;
    genTokens = 0;
    genMs = 0;
    stopTicker();

    renderFooter();
    // Refresh the footer about every second while the run is active.
    ticker = setInterval(renderFooter, 1000);
    ticker.unref?.();
  });

  // Streaming deltas: estimate the live generation rate by counting streamed
  // characters. The 1s footer ticker reads this; no per-delta rendering.
  pi.on("message_update", async (event) => {
    if (runStart === undefined) return;
    const e = event.assistantMessageEvent;
    if (e.type === "text_delta" || e.type === "thinking_delta" || e.type === "toolcall_delta") {
      if (streamingSince === undefined) streamingSince = Date.now();
      streamChars += e.delta.length;
    }
  });

  // A message finished streaming: fold its stats into the run totals.
  pi.on("message_end", async (event) => {
    if (runStart === undefined) return;
    if (streamingSince !== undefined) {
      genMs += Math.max(0, Date.now() - streamingSince);
      streamingSince = undefined;
      streamChars = 0;
    }
    if (event.message.role === "assistant") genTokens += event.message.usage?.output ?? 0;
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
    const cost = sessionCost(entries);

    // Final generation stats: exact output tokens from message usage, time
    // spent streaming (first delta → message end, tool execution excluded),
    // and the average rate over that streaming time. An in-flight message is
    // folded in with its elapsed streaming time (token count unknown mid-stream).
    const totalGenTokens = genTokens;
    const totalGenMs = genMs + (streamingSince !== undefined ? Math.max(0, Date.now() - streamingSince) : 0);
    const tokPerSec = totalGenMs > 0 ? totalGenTokens / (totalGenMs / 1000) : 0;

    pi.appendEntry<RunTimingData>("run-timer", {
      elapsedMs,
      turns,
      aborted: event.aborted,
      cost: {
        total: cost.total - (baselineCost?.total ?? 0),
        input: cost.input - (baselineCost?.input ?? 0),
        output: cost.output - (baselineCost?.output ?? 0),
        cache: cost.cache - (baselineCost?.cache ?? 0),
      },
      compactions: countCompactions(entries) - baselineCompactions,
      genTokens: totalGenTokens,
      genMs: totalGenMs,
      tokPerSec,
    });

    stopTicker();
    setFooter(undefined);
    ctx.ui.setStatus("run-timer", undefined);
    runStart = undefined;
    turns = 0;
    baselineCost = undefined;
    baselineCompactions = 0;
    streamingSince = undefined;
    streamChars = 0;
    lastRate = undefined;
    genTokens = 0;
    genMs = 0;
    runEntries = undefined;
    runUi = undefined;
    runTheme = undefined;
  });

  pi.on("session_shutdown", async () => {
    stopTicker();
    runStart = undefined;
    turns = 0;
    baselineCost = undefined;
    baselineCompactions = 0;
    streamingSince = undefined;
    streamChars = 0;
    lastRate = undefined;
    genTokens = 0;
    genMs = 0;
    runEntries = undefined;
    runUi = undefined;
    runTheme = undefined;
  });
}
