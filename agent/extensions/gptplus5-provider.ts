/**
 * GPTPlus5 Custom Provider Extension
 *
 * Provides access to models available at https://az.gptplus5.com — a
 * "new-api" (one-api successor) aggregator exposing OpenAI-compatible
 * chat completions at /v1/chat/completions (plus Anthropic/Gemini
 * endpoints, which we don't use).
 *
 * Unlike RouterAI, there is no multi-provider routing: every model has a
 * single upstream price, so the whole per-provider endpoint pricing /
 * routed-provider cost-correction machinery from routerai-provider.ts has
 * no equivalent here. What remains:
 *
 *   - Catalog + prices come from the PUBLIC `GET /api/pricing` endpoint
 *     (no API key needed). Pricing is ratio-based:
 *       $/Mtok input  = model_ratio × group_ratio × 2   (quota_per_unit = 500k)
 *       $/Mtok output = input × completion_ratio
 *       cache read    = input × cache_ratio
 *       cache write   = input × cache_ratio × create_cache_ratio (default 1)
 *     The billed price depends on the token's group — set it via
 *     settings.json `gptplus5.group` (default "default"); models not
 *     enabled for that group are filtered out.
 *   - 9 models use new-api's `tiered_expr` billing (a billing expression
 *     whose coefficients ARE real $/1M prices — `Prices are real prices`,
 *     pkg/billingexpr/expr.md in the new-api docs). For those the flat
 *     ratio math is meaningless (~45× off), so the FIRST tier of the
 *     expression is parsed and used as the estimate (marked ≈ in the
 *     footer; time-of-day tiers are estimated at the first/peak tier).
 *   - The API exposes NO context lengths and NO modality/parameter
 *     metadata, so context windows come from a hardcoded per-family table
 *     (fallback 128k) and all models are declared text-only, non-reasoning.
 *   - Context windows are clamped to `compactionThreshold +
 *     compaction.reserveTokens` from settings.json (shared with
 *     routerai-provider and its /compact-threshold command), so pi's
 *     native auto-compaction fires at an absolute token threshold.
 *   - Remaining key budget: new-api exposes OpenAI-compatible billing
 *     endpoints for the token itself:
 *       GET /v1/dashboard/billing/subscription → hard_limit_usd =
 *           (remainQuota + usedQuota) / quota_per_unit (1e8 = unlimited
 *           token; per-token when the site enables DisplayTokenStatEnabled,
 *           otherwise the user's total quota)
 *       GET /v1/dashboard/billing/usage → total_usage = usedQuota in
 *           dollars × 100 (cents)
 *     Remaining budget = hard_limit_usd − total_usage/100, refreshed at
 *     startup and after each turn (TTL-debounced via settings
 *     `gptplus5.balanceRefreshSeconds`, default 30; 0 = every turn) and
 *     shown in the footer. This site displays quotas as USD
 *     (`quota_display_type: "USD"`), so amounts are dollars.
 *   - GLM reasoning replay (`before_provider_request`): the same GLM
 *     quirk as on RouterAI (pi issue #10262) — replayed `reasoning` is
 *     duplicated as `reasoning_content` for GLM chat templates. Toggle via
 *     settings.json `gptplus5.reasoningReplay`: "duplicate" (default),
 *     "rename", or "off".
 *   - `/gptplus5-models` opens a provider-scoped, searchable model picker
 *     with prices (like `/routerai-models`): price sorts (ctrl+t), a catalog
 *     refresh (ctrl+r), capability filter tokens (free/cheap/big/current) and
 *     ctrl+s to persist the highlighted model as the global default — the
 *     same key and effect as the built-in /model picker's "save as default".
 *     Provider-scoped because pi's built-in /model search matches tokens as
 *     subsequences of "provider id" — typing "gptplus5 glm" there also hits
 *     e.g. MiniMax ("gptplus5" supplies g…l, "minimax" the m).
 *   - The footer shows $/Mtok rates for the current model, session spend,
 *     and the key's remaining budget. `/gptplus5-refresh` force-refreshes
 *     the catalog and the balance.
 *
 * Usage:
 *   pi -e ./gptplus5-provider.ts
 *   # Then /login gptplus5 to set your API key
 */

import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
	Container,
	Input,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

interface PricingEntry {
	model_name: string;
	/** 0 = token-billed, 1 = per-call priced (image/video/serpapi) */
	quota_type: number;
	model_ratio: number;
	model_price: number;
	completion_ratio: number;
	cache_ratio?: number;
	/** Multiplier on cache_ratio for cache-write tokens. */
	create_cache_ratio?: number;
	enable_groups: string[];
	supported_endpoint_types: string[];
	/** Expression-based billing: coefficients are real $/1M prices. */
	billing_mode?: string;
	billing_expr?: string;
}

interface PricingPayload {
	data: PricingEntry[];
	group_ratio: Record<string, number>;
	success: boolean;
}

const PROVIDER_ID = "gptplus5";
const BASE_URL = "https://az.gptplus5.com/v1";
const PRICING_URL = "https://az.gptplus5.com/api/pricing";

/** new-api convention: model_ratio 1 = $2 per 1M tokens (quota_per_unit 500k). */
const USD_PER_MTOK_PER_RATIO = 2;

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

// ── Settings readers ──

/** Billing group: settings.json `gptplus5.group` (default "default"). */
function getGroup(): string {
	try {
		if (existsSync(SETTINGS_PATH)) {
			const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
			const value = parsed["gptplus5"]?.["group"];
			if (typeof value === "string" && value.length > 0) return value;
		}
	} catch {
		// fall through to default
	}
	return "default";
}

/** Min seconds between key-balance fetches (turn_end debounce).
 * settings.json `gptplus5.balanceRefreshSeconds`, default 30; 0 = every turn. */
function getBalanceRefreshSeconds(): number {
	try {
		if (existsSync(SETTINGS_PATH)) {
			const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
			const value = parsed["gptplus5"]?.["balanceRefreshSeconds"];
			if (typeof value === "number" && value >= 0) return value;
		}
	} catch {
		// fall through to default
	}
	return 30;
}

/** Absolute token threshold at which compaction should trigger
 * (settings.json `compactionThreshold`, shared with routerai-provider). */
function getCompactionThreshold(): number | null {
	try {
		if (!existsSync(SETTINGS_PATH)) return null;
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
		const value = parsed["compactionThreshold"];
		if (value === null) return null;
		return typeof value === "number" && value >= 1000 ? value : null;
	} catch {
		return null;
	}
}

function getReserveTokens(): number {
	try {
		if (existsSync(SETTINGS_PATH)) {
			const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
			const value = parsed["compaction"]?.["reserveTokens"];
			if (typeof value === "number" && value > 0) return value;
		}
	} catch {
		// fall through to default
	}
	return 16_384;
}

/**
 * Clamp the context window pi sees so native auto-compaction (threshold,
 * overflow, and mid-run split-turn checks) fires at the absolute
 * `compactionThreshold` and continues the run. Mirrors routerai-provider.
 */
function clampContextWindow(realContextWindow: number): number {
	const threshold = getCompactionThreshold();
	if (threshold === null || threshold >= realContextWindow) {
		return realContextWindow;
	}
	return Math.min(realContextWindow, threshold + getReserveTokens());
}

// ── GLM reasoning replay normalization ──

function getReasoningReplayMode(): "duplicate" | "rename" | "off" {
	try {
		if (existsSync(SETTINGS_PATH)) {
			const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
			const value = parsed["gptplus5"]?.["reasoningReplay"];
			if (value === "duplicate" || value === "rename" || value === "off") return value;
		}
	} catch {
		// fall through to default
	}
	return "duplicate";
}

/**
 * GLM chat templates read `reasoning_content` on replayed assistant turns;
 * pi echoes the trace under `reasoning`. Copy (or move) it so GLM keeps its
 * cross-turn reasoning trace. See pi issue #10262 and routerai-provider.
 */
function normalizeReasoningReplay(payload: unknown): unknown {
	if (getReasoningReplayMode() === "off") return payload;
	if (typeof payload !== "object" || payload === null) return payload;
	const messages = (payload as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return payload;
	for (const msg of messages as Record<string, unknown>[]) {
		if (msg.role !== "assistant") continue;
		const reasoning = msg.reasoning;
		if (typeof reasoning !== "string" || reasoning.length === 0) continue;
		if (typeof msg.reasoning_content !== "string" || msg.reasoning_content.length === 0) {
			msg.reasoning_content = reasoning;
		}
		if (getReasoningReplayMode() === "rename") {
			delete msg.reasoning;
		}
	}
	return payload;
}

// ── Context windows ──
// The API exposes no context lengths. Family-based table, first match wins;
// explicit "128k"/"256k" markers in the model name take precedence.

const CONTEXT_RULES: [RegExp, number][] = [
	[/128k/i, 131_072],
	[/256k/i, 262_144],
	[/gemini/i, 1_048_576],
	[/gpt-4\.1/i, 1_048_576],
	[/gpt-[56]/i, 400_000],
	[/^o[34](-|$)|^o\d/i, 200_000],
	[/gpt-4o|chatgpt|gpt-4|gpt-3\.5/i, 131_072],
	[/claude/i, 200_000],
	[/glm/i, 200_000],
	[/kimi/i, 256_000],
	[/doubao/i, 256_000],
	[/qwen|qwq|qvq/i, 131_072],
	[/deepseek/i, 131_072],
	[/grok/i, 256_000],
	[/minimax/i, 196_608],
	[/mimo/i, 256_000],
	[/kat-coder/i, 256_000],
	[/codex/i, 400_000],
];

function lookupContextWindow(modelName: string): number {
	const name = modelName.toLowerCase();
	for (const [re, ctx] of CONTEXT_RULES) {
		if (re.test(name)) return ctx;
	}
	return 131_072;
}

// ── Catalog filtering ──
// The pricing endpoint lists every model the gateway knows, including
// embeddings, TTS, realtime audio, image/video generation and per-call
// serpapi tools. Keep only token-billed chat-capable text models.

const NON_CHAT = /embedding|whisper|tts|realtime|audio|image|video|davinci|moderation|serpapi|rerank|speech|transcri|captioner|omni|dall-e|seedream|seedance|imagine/i;

function isChatModel(m: PricingEntry): boolean {
	return (
		m.quota_type === 0 &&
		m.model_ratio > 0 &&
		Array.isArray(m.enable_groups) &&
		m.enable_groups.includes(getGroup()) &&
		!NON_CHAT.test(m.model_name)
	);
}

// ── tiered_expr parsing ──
// new-api billing expressions (pkg/billingexpr/expr.md): coefficients are
// REAL $/1M-token prices, tier("name", p * 2.5 + c * 15 + cr * 0.25).
// For expression-billed models the flat ratio math is meaningless, so we
// parse the FIRST tier as the estimate (base for context-length tiers;
// peak for time-of-day tiers — a slight overestimate off-peak).

type TierCoeffs = Partial<Record<"p" | "c" | "cr" | "cc" | "cc1h", number>>;

/** Args of every tier("name", EXPR) call, in order. Request rules after
 * `|||` are stripped. Handles nested parens in the tier argument. */
export function extractTierCostExprs(expr: string): string[] {
	const src = expr.split("|||")[0];
	const out: string[] = [];
	for (let i = src.indexOf("tier("); i !== -1; i = src.indexOf("tier(", i + 1)) {
		const open = i + "tier".length;
		let depth = 0;
		let close = -1;
		for (let k = open; k < src.length; k++) {
			if (src[k] === "(") depth++;
			else if (src[k] === ")") {
				depth--;
				if (depth === 0) {
					close = k;
					break;
				}
			}
		}
		if (close === -1) break;
		const inner = src.slice(open + 1, close);
		// inner = `"name", cost expr` — drop the quoted name.
		const m = /^"[^"]*"\s*,\s*([\s\S]+)$/.exec(inner);
		if (m) out.push(m[1]);
	}
	return out;
}

/** Coefficients of the first tier's cost expression. undefined when the
 * expression doesn't parse or prices nothing we bill. */
export function parseTieredPricing(expr: string): TierCoeffs | undefined {
	const tiers = extractTierCostExprs(expr);
	if (tiers.length === 0) return undefined;
	const first = tiers[0];
	const coeffs: TierCoeffs = {};
	for (const v of ["p", "c", "cr", "cc", "cc1h"] as const) {
		const m =
			new RegExp(`\\b${v}\\s*\\*\\s*([0-9]+(?:\\.[0-9]+)?)`).exec(first) ??
			new RegExp(`\\b([0-9]+(?:\\.[0-9]+)?)\\s*\\*\\s*${v}\\b`).exec(first);
		if (m) coeffs[v] = parseFloat(m[1]);
	}
	if (coeffs.p === undefined && coeffs.c === undefined) return undefined;
	return coeffs;
}

// ── Catalog → pi model defs ──

type GptPlus5Model = Model<"openai-completions"> & {
	rawContextWindow?: number;
	tieredBilling?: boolean;
};

function toModelDef(m: PricingEntry, groupRatio: number): GptPlus5Model {
	const realContextWindow = lookupContextWindow(m.model_name);
	const contextWindow = clampContextWindow(realContextWindow);

	let inputPerMtok: number;
	let outputPerMtok: number;
	let cacheReadPerMtok: number;
	let cacheWritePerMtok: number;
	let tieredBilling = false;

	const tier = m.billing_mode === "tiered_expr" && m.billing_expr
		? parseTieredPricing(m.billing_expr)
		: undefined;
	if (tier) {
		// Expression coefficients are real $/1M prices; group ratio applies on
		// top of the expression result. Cache-create tokens (cc/cc1h, Claude
		// style) are billed at their coefficients; when absent they are priced
		// inside `p` at the input rate.
		tieredBilling = true;
		inputPerMtok = (tier.p ?? 0) * groupRatio;
		outputPerMtok = (tier.c ?? 0) * groupRatio;
		cacheReadPerMtok = (tier.cr ?? 0) * groupRatio;
		cacheWritePerMtok = ((tier.cc ?? tier.p ?? 0) + (tier.cc1h ?? 0)) * groupRatio;
	} else {
		inputPerMtok = m.model_ratio * groupRatio * USD_PER_MTOK_PER_RATIO;
		outputPerMtok = inputPerMtok * m.completion_ratio;
		cacheReadPerMtok = inputPerMtok * (m.cache_ratio ?? 0);
		cacheWritePerMtok = cacheReadPerMtok * (m.create_cache_ratio ?? 1);
	}

	return {
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		id: m.model_name,
		name: m.model_name,
		reasoning: false,
		input: ["text"],
		// pi-ai's calculateCost treats model.cost as $/Mtok and divides by 1e6
		// itself — store rates in this scale, NOT per-token.
		cost: {
			input: inputPerMtok,
			output: outputPerMtok,
			cacheRead: cacheReadPerMtok,
			cacheWrite: cacheWritePerMtok,
		},
		contextWindow,
		rawContextWindow: realContextWindow,
		tieredBilling,
		// Derive from the REAL context length, not the clamped window — the
		// clamp only exists to move the compaction trigger earlier.
		maxTokens: Math.max(Math.min(realContextWindow, 64_000), 32_000),
	};
}

async function fetchGptPlus5Models(signal?: AbortSignal): Promise<GptPlus5Model[]> {
	const response = await fetch(PRICING_URL, {
		headers: { Accept: "application/json" },
		...(signal ? { signal } : {}),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch pricing from GPTPlus5: ${response.status} ${await response.text()}`);
	}

	const payload = (await response.json()) as PricingPayload;
	if (!payload.success || !Array.isArray(payload.data)) {
		throw new Error("GPTPlus5 /api/pricing returned an unexpected payload");
	}

	const group = getGroup();
	const groupRatio = payload.group_ratio?.[group] ?? 1;

	return payload.data
		.filter((m) => isChatModel(m))
		.map((m) => toModelDef(m, groupRatio));
}

// ── Key balance (remaining budget) ──
// new-api's OpenAI-compatible billing endpoints, authenticated with the
// chat key: hard_limit_usd = (remain + used) / quota_per_unit (1e8 =
// unlimited token), total_usage = used dollars × 100. This site displays
// quotas as USD (quota_display_type "USD"), so amounts are dollars.

interface KeyBalance {
	/** (remain + used) in USD; 1e8 for unlimited tokens. */
	total: number;
	/** used in USD */
	used: number;
	/** remaining in USD; undefined for unlimited tokens */
	remaining?: number;
	unlimited: boolean;
	checkedAt: number;
}

function isUnlimitedLimit(total: number): boolean {
	return total >= 99_999_999;
}

// The API key, captured when pi resolves the stored credential (and from
// request headers as a fallback). Module-level: balance fetches need it
// outside the auth flow.
let apiKey: string | undefined;
let balance: KeyBalance | undefined;
let balanceFetchInFlight = false;
let lastBalanceFetchAt = 0;

async function fetchBalance(signal?: AbortSignal): Promise<KeyBalance | undefined> {
	if (!apiKey) return undefined;
	const headers = { Authorization: `Bearer ${apiKey}` };
	const [subRes, usageRes] = await Promise.all([
		fetch(`${BASE_URL}/dashboard/billing/subscription`, { headers, ...(signal ? { signal } : {}) }),
		fetch(`${BASE_URL}/dashboard/billing/usage`, { headers, ...(signal ? { signal } : {}) }),
	]);
	if (!subRes.ok || !usageRes.ok) return undefined;
	const sub = (await subRes.json()) as { hard_limit_usd?: number };
	const usage = (await usageRes.json()) as { total_usage?: number };
	if (typeof sub.hard_limit_usd !== "number" || typeof usage.total_usage !== "number") return undefined;
	const total = sub.hard_limit_usd;
	const used = usage.total_usage / 100;
	const unlimited = isUnlimitedLimit(total);
	return {
		total,
		used,
		remaining: unlimited ? undefined : total - used,
		unlimited,
		checkedAt: Date.now(),
	};
}

/**
 * Refresh the key balance (TTL-debounced unless `force`), then update the
 * footer. Fire-and-forget friendly; single-flight; failures keep the last
 * known balance.
 */
async function refreshBalance(
	ctx: ExtensionContext,
	force: boolean,
): Promise<void> {
	if (!apiKey || balanceFetchInFlight) return;
	const ttl = getBalanceRefreshSeconds() * 1000;
	if (!force && ttl > 0 && Date.now() - lastBalanceFetchAt < ttl) return;
	balanceFetchInFlight = true;
	try {
		const fresh = await fetchBalance();
		if (fresh) {
			balance = fresh;
			lastBalanceFetchAt = fresh.checkedAt;
		}
	} catch {
		// non-fatal: keep the previous balance
	} finally {
		balanceFetchInFlight = false;
	}
	updateFooter(ctx);
}

// ── Formatting ──

function fmtPrice(usdPerMtok: number): string {
	if (!Number.isFinite(usdPerMtok)) return "?";
	if (usdPerMtok === 0) return "0";
	if (usdPerMtok >= 100) return usdPerMtok.toFixed(0);
	if (usdPerMtok >= 10) return usdPerMtok.toFixed(1);
	const s = usdPerMtok.toFixed(3);
	return s.replace(/0+$/, "").replace(/\.$/, "");
}

interface SessionCostBreakdown {
	input: number;
	output: number;
	/** cacheRead + cacheWrite */
	cache: number;
	total: number;
}

function addUsageCost(
	sum: SessionCostBreakdown,
	cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } | undefined,
) {
	if (!cost) return;
	sum.input += cost.input ?? 0;
	sum.output += cost.output ?? 0;
	sum.cache += (cost.cacheRead ?? 0) + (cost.cacheWrite ?? 0);
	sum.total += cost.total ?? 0;
}

function sessionCost(ctx: ExtensionContext): SessionCostBreakdown {
	const sum: SessionCostBreakdown = { input: 0, output: 0, cache: 0, total: 0 };
	for (const entry of ctx.sessionManager.getBranch()) {
		// Assistant messages…
		if (entry.type === "message" && entry.message.role === "assistant") {
			addUsageCost(
				sum,
				(
					entry.message as {
						usage?: { cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } };
					}
				).usage?.cost,
			);
		}
		// …and compactions: each compaction runs an LLM call whose usage/cost
		// pi records on the compaction entry itself.
		if (entry.type === "compaction") {
			addUsageCost(
				sum,
				(
					entry as {
						usage?: { cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number } };
					}
				).usage?.cost,
			);
		}
	}
	return sum;
}

// ── Footer: rates, session spend, remaining key budget ──

function updateFooter(ctx: ExtensionContext) {
	const model = ctx.model as GptPlus5Model | undefined;
	if (!model || model.provider !== PROVIDER_ID) {
		ctx.ui.setStatus("gptplus5", undefined);
		return;
	}
	const rates =
		`${model.tieredBilling ? "≈" : ""}${fmtPrice(model.cost.input)}/`
		+ `${fmtPrice(model.cost.output)}/`
		+ `${fmtPrice(model.cost.cacheRead)} $/Mtok`;
	const cost = sessionCost(ctx);
	const split =
		cost.input > 0 || cost.output > 0 || cost.cache > 0
			? ` (${cost.input.toFixed(3)}/${cost.output.toFixed(3)}/${cost.cache.toFixed(3)})`
			: "";
	const spent = `$${cost.total.toFixed(3)}${split}`;
	let budget = "";
	if (balance) {
		budget = balance.unlimited || balance.remaining === undefined
			? " · left ∞"
			: ` · left $${balance.remaining!.toFixed(2)}`;
	}
	ctx.ui.setStatus(
		"gptplus5",
		ctx.ui.theme.fg("dim", `${rates} · ${spent}${budget} · group ${getGroup()}`),
	);
}

/** Persisted default model (settings.json defaultProvider/defaultModel) —
 * the same keys the built-in /model picker's ctrl+s writes. */
interface DefaultModelSetting {
	provider: string;
	id: string;
}

/** Read the persisted default model from settings.json. */
function readDefaultModelSetting(): DefaultModelSetting | null {
	try {
		if (!existsSync(SETTINGS_PATH)) return null;
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
		if (typeof parsed.defaultProvider === "string" && typeof parsed.defaultModel === "string") {
			return { provider: parsed.defaultProvider, id: parsed.defaultModel };
		}
	} catch {
		// malformed settings: no default
	}
	return null;
}

/** Persist the default model to settings.json (read-modify-write, preserving
 * all other settings) — the same thing the built-in /model picker's ctrl+s does. */
function writeDefaultModelSetting(provider: string, id: string): void {
	try {
		const settings = existsSync(SETTINGS_PATH)
			? JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"))
			: {};
		settings.defaultProvider = provider;
		settings.defaultModel = id;
		writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
	} catch {
		// best effort: the selection stays session-only
	}
}

function fmtCtx(model: GptPlus5Model): string {
	const real = model.rawContextWindow ?? model.contextWindow;
	const ctx = real >= 1000 ? `${Math.round(real / 1000)}k` : `${real}`;
	if (model.contextWindow < real) {
		const clamped = model.contextWindow >= 1000 ? `${Math.round(model.contextWindow / 1000)}k` : `${model.contextWindow}`;
		return `${ctx} (♻${clamped})`;
	}
	return ctx;
}

interface PickerItem extends SelectItem {
	model: GptPlus5Model;
}

interface CapabilityFilter {
	token: string;
	test: (m: GptPlus5Model) => boolean;
}

interface SortOption {
	id: "relevance" | "name" | "input" | "output";
	label: string;
	/** undefined = keep the incoming (fuzzy match-quality) order. */
	cmp?: (a: GptPlus5Model, b: GptPlus5Model) => number;
}

const SORT_KEY = "ctrl+t";
const REFRESH_KEY = "ctrl+r";
const DEFAULT_KEY = "ctrl+s";

export default async function (pi: ExtensionAPI) {
	// ── GLM reasoning replay (see header comment) ──

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return undefined;
		return normalizeReasoningReplay(event.payload);
	});

	// ── Capture the API key for balance queries ──
	// Primary source: the auth resolve callback (fires when pi resolves the
	// stored credential). Fallback: the Authorization header on outgoing
	// requests — covers keys resolved through other paths (env, /login in a
	// previous session) before `resolve` runs.

	pi.registerProvider(createProvider({
		id: PROVIDER_ID,
		name: "GPTPlus5",
		baseUrl: BASE_URL,
		auth: {
			apiKey: {
				name: "GPTPlus5 API key",
				async login(interaction) {
					return {
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "Enter your GPTPlus5 API key" }),
					};
				},
				async resolve({ credential }) {
					if (credential?.key) {
						apiKey = credential.key;
						return { auth: { apiKey: credential.key }, source: "stored API key" };
					}
					return undefined;
				},
			},
		},
		models: [], // dynamic provider: catalog comes from fetchModels / persisted store
		fetchModels: async ({ signal }) => fetchGptPlus5Models(signal),
		api: openAICompletionsApi(),
	}));

	pi.on("before_provider_headers", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		const auth = event.headers.authorization ?? event.headers.Authorization;
		if (typeof auth === "string" && auth.startsWith("Bearer ")) {
			apiKey = auth.slice("Bearer ".length);
		}
	});

	// ── /gptplus5-refresh: force a catalog + balance refresh now ──

	async function refreshPrices(ctx: ExtensionContext, notify: boolean): Promise<boolean> {
		try {
			const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
			const error = result.errors.get(PROVIDER_ID);
			if (error) {
				if (notify) ctx.ui.notify(`GPTPlus5 refresh failed, showing cached models (${error.message})`, "warning");
				return false;
			}
			// Re-apply the current model so it picks up the refreshed def.
			const model = ctx.model;
			if (model?.provider === PROVIDER_ID) {
				const fresh = ctx.modelRegistry
					.getAll()
					.find((m) => m.provider === PROVIDER_ID && m.id === model.id);
				if (fresh) await pi.setModel(fresh);
			}
			updateFooter(ctx);
			if (notify) ctx.ui.notify("GPTPlus5 catalog refreshed", "info");
			return true;
		} catch (error) {
			if (notify) {
				ctx.ui.notify(`GPTPlus5 refresh failed (${error instanceof Error ? error.message : String(error)})`, "warning");
			}
			return false;
		}
	}

	pi.registerCommand("gptplus5-refresh", {
		description: "Force-refresh GPTPlus5 model catalog, prices, and key balance",
		handler: async (_args, ctx) => {
			await refreshBalance(ctx, true);
			await refreshPrices(ctx, true);
		},
	});

	// ── /gptplus5-models: provider-scoped, searchable price picker ──
	// Scoped to GPTPlus5 models only — pi's built-in /model search can't do
	// "provider first, then model name" because its subsequence matching lets
	// the provider name satisfy model-name tokens (see header comment).
	// ctrl+s = save highlighted model as global default (matches the built-in
	// /model picker's "save as default" semantics, app.models.save = ctrl+s).

	pi.registerCommand("gptplus5-models", {
		description: "Searchable GPTPlus5 model picker with prices",
		handler: async (_args, ctx) => {
			const models = () =>
				ctx.modelRegistry.getAll().filter(
					(m): m is GptPlus5Model => m.provider === PROVIDER_ID,
				);
			if (models().length === 0) {
				ctx.ui.notify("No GPTPlus5 models loaded yet — try /gptplus5-refresh", "warning");
				return;
			}

			const current = ctx.model;
			let sortIndex = 0;
			let defaultSel = readDefaultModelSetting();

			const SORTS: SortOption[] = [
				// "best match": preserves fuzzyFilter's ranking; catalog order when
				// the query is empty.
				{ id: "relevance", label: "best match" },
				{ id: "name", label: "name", cmp: (a, b) => a.name.localeCompare(b.name) },
				{ id: "input", label: "input price ↑", cmp: (a, b) => a.cost.input - b.cost.input || a.name.localeCompare(b.name) },
				{ id: "output", label: "output price ↑", cmp: (a, b) => a.cost.output - b.cost.output || a.name.localeCompare(b.name) },
			];

			const FILTERS: CapabilityFilter[] = [
				{ token: "free", test: (m) => m.cost.output === 0 },
				{ token: "cheap", test: (m) => m.cost.output > 0 && m.cost.output <= 5 },
				{ token: "big", test: (m) => (m.rawContextWindow ?? m.contextWindow) >= 256_000 },
				{
					token: "current",
					test: (m) => (current ? current.provider === m.provider && current.id === m.id : false),
				},
			];
			const filtersHint = FILTERS.map((f) => f.token).join(" ");

			// value: model id (search key), label: display name, description:
			// prices + context window + tiered-billing badge.
			const byId = new Map<string, PickerItem>();
			function rebuildById() {
				byId.clear();
				for (const m of models()) {
					byId.set(m.id, {
						model: m,
						value: m.id,
						label: m.name,
						description:
							`${m.tieredBilling ? "≈" : ""}in ${fmtPrice(m.cost.input)}`
							+ ` / out ${fmtPrice(m.cost.output)}`
							+ ` / cache ${fmtPrice(m.cost.cacheRead)} $/Mtok`
							+ ` · ctx ${fmtCtx(m)}`,
					});
				}
			}
			rebuildById();

			const result = await ctx.ui.custom<GptPlus5Model | null>(
				(tui, theme, kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
					container.addChild(new Text(theme.fg("accent", theme.bold("GPTPlus5 Models — prices in $/Mtok"))));

					const searchInput = new Input({ prompt: "Search: " });
					container.addChild(searchInput);

					const selectTheme = {
						selectedPrefix: (text: string) => theme.fg("accent", text),
						selectedText: (text: string) => theme.fg("accent", text),
						description: (text: string) => theme.fg("muted", text),
						scrollInfo: (text: string) => theme.fg("dim", text),
						noMatch: (text: string) => theme.fg("warning", text),
					};
					const listLayout = { minPrimaryColumnWidth: 36, maxPrimaryColumnWidth: 42 };

					// The list is rebuilt on every filter/sort change
					// (SelectList's item accessors are private).
					const listContainer = new Container();
					const countLine = new Text("", 0, 0);
					const statusLine = new Text("", 0, 0);
					const sortStatus = new Text("", 0, 0);

					let selectList = new SelectList([], 10, selectTheme, listLayout);

					function makeList(filtered: PickerItem[], keepSelection: boolean) {
						const previousId = keepSelection ? selectList.getSelectedItem()?.value : undefined;
						selectList = new SelectList(filtered, 10, selectTheme, listLayout);
						selectList.onSelect = (item) => done((item as PickerItem).model);
						selectList.onCancel = () => done(null);
						if (previousId) {
							const index = filtered.findIndex((item) => item.value === previousId);
							if (index > 0) selectList.setSelectedIndex(index);
						}
						listContainer.clear();
						listContainer.addChild(selectList);
					}

					function setSortStatus() {
						sortStatus.setText(theme.fg("dim", `  sort: ${SORTS[sortIndex].label} · ${SORT_KEY} cycle`));
					}

					function computeFiltered(): PickerItem[] {
						const raw = searchInput.getValue();
						let stripped = raw;
						let list = [...byId.values()];

						for (const f of FILTERS) {
							if (stripped.includes(f.token)) {
								list = list.filter((item) => f.test(item.model));
								stripped = stripped.split(f.token).join(" ");
							}
						}
						stripped = stripped.replace(/\s+/g, " ").trim();

						// fuzzyFilter sorts by match quality (best first)
						let filtered: PickerItem[] = stripped
							? fuzzyFilter(list, stripped, (item) => `${item.value} ${item.label}`)
							: list;

						const cmp = SORTS[sortIndex].cmp;
						if (cmp) filtered = filtered.slice().sort((a, b) => cmp(a.model, b.model));
						return filtered;
					}

					function refresh(keepSelection: boolean) {
						let filtered = computeFiltered();
						// "· default" badge on the persisted default model (clones —
						// byId labels stay pristine for search/matching)
						if (defaultSel) {
							const def = defaultSel;
							filtered = filtered.map((it) =>
								it.model.provider === def.provider && it.model.id === def.id
									? { ...it, label: `${it.label} · default` }
									: it,
							);
						}
						makeList(filtered, keepSelection);
						setSortStatus();
						countLine.setText(theme.fg("dim", `  ${filtered.length} / ${byId.size} models`));
					}

					function cycleSort() {
						sortIndex = (sortIndex + 1) % SORTS.length;
						refresh(true);
					}

					// ctrl+s: persist the highlighted model as the global default
					// (settings.json defaultProvider/defaultModel — same as the
					// built-in /model picker's "save as default").
					function saveHighlightedAsDefault() {
						const item = selectList.getSelectedItem() as PickerItem | null;
						if (!item) return;
						writeDefaultModelSetting(item.model.provider, item.model.id);
						defaultSel = { provider: item.model.provider, id: item.model.id };
						statusLine.setText(theme.fg("accent", `  ✓ default model saved: ${item.model.provider}/${item.model.id}`));
						refresh(true);
					}

					// ctrl+r: re-fetch the catalog (one /api/pricing request refreshes
					// every model) and rebuild the list in place.
					let refreshing = false;
					async function refreshCatalog() {
						if (refreshing) return;
						refreshing = true;
						statusLine.setText(theme.fg("warning", "  ⟳ refreshing catalog…"));
						tui.requestRender();
						try {
							await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
							rebuildById();
							statusLine.setText(theme.fg("dim", `  ⟳ refreshed ${byId.size} models`));
						} catch (error) {
							statusLine.setText(theme.fg("warning", `  ⟳ refresh failed (${error instanceof Error ? error.message : String(error)})`));
						} finally {
							refreshing = false;
						}
						refresh(true);
						tui.requestRender();
					}

					container.addChild(countLine);
					container.addChild(listContainer);
					container.addChild(statusLine);
					container.addChild(sortStatus);
					container.addChild(new Text(theme.fg("dim", `↑↓ navigate · enter select · esc cancel · ${SORT_KEY} sort · ${REFRESH_KEY} refresh · ${DEFAULT_KEY} default · filters: ${filtersHint}`)));

					refresh(false);

					return {
						render(width: number) {
							return container.render(width);
						},
						invalidate() {
							container.invalidate();
						},
						handleInput(data: string) {
							// Route list keys (arrows/enter/esc) to the list, sort/refresh
							// combos to their actions, everything else (typing,
							// backspace, …) to the search input.
							if (
								kb.matches(data, "tui.select.up") ||
								kb.matches(data, "tui.select.down") ||
								kb.matches(data, "tui.select.confirm") ||
								kb.matches(data, "tui.select.cancel")
							) {
								selectList.handleInput(data);
							} else if (matchesKey(data, REFRESH_KEY)) {
								void refreshCatalog();
							} else if (matchesKey(data, DEFAULT_KEY)) {
								saveHighlightedAsDefault();
							} else if (matchesKey(data, SORT_KEY)) {
								cycleSort();
							} else {
								searchInput.handleInput(data);
								refresh(false);
							}
							tui.requestRender();
						},
					};
				},
			);

			if (!result) return;

			const success = await pi.setModel(result);
			if (!success) {
				ctx.ui.notify(`Could not switch to ${result.provider}/${result.id} — no API key configured`, "warning");
			}
		},
	});

	// ── Keep footer fresh ──

	pi.on("session_start", async (_event, ctx) => {
		// The persisted catalog is already restored at this point (offline
		// phase). Kick off non-blocking refreshes of the (public, cheap)
		// pricing endpoint and the key balance. Failures are non-fatal.
		void refreshPrices(ctx, false);
		void refreshBalance(ctx, true);
		updateFooter(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateFooter(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateFooter(ctx);
		void refreshBalance(ctx, false);
	});
}
