/**
 * RouterAI Custom Provider Extension
 *
 * Provides access to models available at https://routerai.ru/api/v1
 * Uses OpenAI-compatible chat completions API (OpenRouter-style).
 *
 * Prices are fetched live from the RouterAI models endpoint and kept
 * up to date via a dynamic provider catalog (`fetchModels`):
 *   - On startup the last persisted catalog is restored (no network needed).
 *   - Pricing is refreshed LAZILY, per model: `/endpoints` is fetched for the
 *     current model only, at natural boundaries (session start, model select,
 *     turn end, picker open) and only when its cached data is older than
 *     `routerai.priceRefreshMinutes` (settings.json, default 5, 0 = manual
 *     only; /routerai-refresh always bypasses the TTL). Each refresh is a
 *     single request — no idle timers, no bulk sweeps of all 578 models.
 *   - `/routerai-refresh` re-fetches the catalog list + the current model's
 *     endpoint pricing (force), and re-applies the current model.
 *   - `/routerai-models` opens a searchable price picker (like /model)
 *     with capability filters, pin-for-comparison (ctrl+space), a cost
 *     sort toggle (ctrl+s), a deep refresh of visible+pinned models
 *     (ctrl+r) and a provider preference chooser for the highlighted
 *     model (ctrl+p). Opening it TTL-debounces a cheap catalog-list
 *     refresh.
 *   - `/routerai-providers` opens the same provider preference chooser
 *     for the current model: multi-select (ctrl+space) and reorder
 *     mode (ctrl+o: ↑↓ choose, ←→ move, ctrl+space remove); the ordered
 *     list is sent as `provider.order` (fallbacks allowed — preference,
 *     not a hard pin), "Auto" restores RouterAI's default routing.
 *     Choices persist in settings.json (`routerai.providerPrefs`).
 *   - The footer shows per-million-token rates for the current model.
 *
 * Price accounting — the routing pitfall and how this extension fixes it:
 *   The /api/v1/models list returns ONE `pricing` per model — the cheapest
 *   provider's (e.g. Relace for glm-5.3-flash: 3.97/9.74/3.45 ₽/Mtok) — but
 *   RouterAI routes requests to its "Приоритетный" provider (BytePlus:
 *   17.27/57.55/3.45 ₽/Mtok) and bills at THAT provider's rates. In a 2026-10-27
 *   session pi showed ~117 ₽ while the actual bill was ~673 ₽ (~5.7× low).
 *
 *   Fix — three layers, no provider pinning:
 *   1. Per-provider pricing table: `fetchModels` also pulls
 *      `GET /api/v1/models/{id}/endpoints` (public) for every model, building
 *      model → provider → pricing. Cached in ~/.pi/agent/routerai-endpoints.json
 *      so it works offline/at startup.
 *   2. Routed-provider detection: RouterAI reports the actual upstream
 *      provider on every stream chunk ("provider":"BytePlus"). The
 *      `provider_stream_event` hook records it per model.
 *   3. Cost correction: on `message_end` the recorded usage cost is recomputed
 *      with the routed provider's real pricing and the message is replaced.
 *      Before the first chunk of a request arrives (and for nested calls like
 *      compaction that bypass `message_end`), estimates use the PRIORITY
 *      provider's pricing — the first endpoint in the /endpoints list, which
 *      matches RouterAI's stated default routing ("priority provider first,
 *      on failure the cheapest of the rest") and the label observed on the
 *      model pages. No hardcoded overrides.
 *
 * Context clamping for auto-compaction:
 *   The reported `contextWindow` of every RouterAI model is clamped to
 *   `compactionThreshold + reserveTokens` (read from settings.json, falling
 *   back to COMPACTION_THRESHOLD). pi's native auto-compaction triggers at
 *   `contextTokens > contextWindow - reserveTokens`, so this makes pi compact
 *   at an absolute token threshold — including the mid-run (split-turn)
 *   check, which compacts between tool batches and continues the run.
 *   `maxTokens` is still derived from the model's real context length.
 *   The raw context length is kept on the model as `rawContextWindow` so UI
 *   can display the true value.
 *
 * GLM reasoning replay (`before_provider_request`):
 *   RouterAI streams reasoning traces in the `reasoning` field, so pi saves
 *   thinking blocks with signature `reasoning` and replays them under that
 *   same field on subsequent requests. GLM chat templates (and z.ai's API)
 *   read `reasoning_content` instead — see pi issue #10262. The replayed
 *   trace is therefore silently dropped, and GLM loses its cross-turn
 *   working memory; in practice it starts smuggling its reasoning into tool
 *   call arguments (bash `#` comments). To match the built-in zai provider
 *   behavior, every assistant message with a non-empty `reasoning` field
 *   gets a duplicate `reasoning_content` field in the outgoing payload.
 *   Toggle via settings.json `routerai.reasoningReplay`: "duplicate"
 *   (default), "rename" (moves the value), or "off".
 *
 * Usage:
 *   pi -e ./routerai-provider.ts
 *   # Then /login routerai to set your API key
 */

import { createProvider, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
	Container,
	Input,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	Text,
	truncateToWidth,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

interface RouterAIPricing {
	prompt: number;
	completion: number;
	input_cache_read?: number;
	input_cache_write?: number;
}

interface RouterAIEndpoint {
	name: string;
	provider_name: string;
	tag: string;
	pricing: RouterAIPricing;
	quantization?: string | null;
}

interface RouterAIModel {
	id: string;
	name: string;
	context_length: number | null;
	architecture: {
		modality: string;
		tokenizer: string | null;
		instruct_type: string | null;
		input_modalities: string[];
		output_modalities: string[];
	};
	pricing: RouterAIPricing;
	supported_parameters: string[] | null;
	default_parameters: Record<string, unknown> | null;
}

const PROVIDER_ID = "routerai";
const BASE_URL = "https://routerai.ru/api/v1";

// ── Compaction threshold clamp ──
// Native compaction fires when contextTokens > contextWindow - reserveTokens,
// so clamping contextWindow to (threshold + reserveTokens) makes pi compact
// once the context crosses `threshold` — with native mid-run continuation.

/** Absolute token threshold at which compaction should trigger. */
const COMPACTION_THRESHOLD = 150_000;
const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/**
 * Effective compaction threshold: reads `compactionThreshold` from
 * settings.json (shared with the compaction-threshold extension), falling
 * back to COMPACTION_THRESHOLD. `null` disables the clamp (use the real
 * context length).
 */
function getCompactionThreshold(): number | null {
	try {
		if (!existsSync(SETTINGS_PATH)) return COMPACTION_THRESHOLD;
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
		const value = parsed["compactionThreshold"];
		if (value === null) return null;
		return typeof value === "number" && value >= 1000 ? value : COMPACTION_THRESHOLD;
	} catch {
		return COMPACTION_THRESHOLD;
	}
}

/**
 * Keep reserveTokens in sync with settings.json `compaction.reserveTokens`
 * so the effective trigger stays at exactly `threshold`.
 */
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

// ── Per-provider endpoint pricing (lazy, per model) ──
// model id → { checkedAt, endpoints: ProviderEndpoint[] }, ordered as
// RouterAI reports them — the first entry is the PRIORITY provider, the one
// default routing bills at. Stream chunks report the display provider name
// ("BytePlus"); tags are "byteplus" — lookup matches either, lowercased.
const ENDPOINTS_CACHE_PATH = join(homedir(), ".pi", "agent", "routerai-endpoints.json");

interface ProviderEndpoint {
	tag: string;
	providerName: string;
	pricing: RouterAIPricing;
	countries?: string[];
	contextLength?: number;
	maxCompletionTokens?: number;
	quantization?: string | null;
	status?: number;
	supportedParameters?: string[];
}

interface ModelEndpointPricing {
	checkedAt: number;
	endpoints: ProviderEndpoint[];
}

const endpointPricing = new Map<string, ModelEndpointPricing>();

function loadEndpointPricingCache(): void {
	try {
		if (!existsSync(ENDPOINTS_CACHE_PATH)) return;
		const parsed = JSON.parse(readFileSync(ENDPOINTS_CACHE_PATH, "utf-8")) as {
			models?: Record<string, ModelEndpointPricing>;
		};
		for (const [id, entry] of Object.entries(parsed.models ?? {})) {
			// Entries from older formats (flat providers map, {priority, providers})
			// lack the `endpoints` array and are ignored — re-fetched lazily.
			if (entry && typeof entry === "object" && Array.isArray(entry.endpoints)) {
				endpointPricing.set(id, entry);
			}
		}
	} catch {
		// corrupt cache: ignore, will be rebuilt lazily
	}
}

function saveEndpointPricingCache(): void {
	try {
		const models: Record<string, ModelEndpointPricing> = {};
		for (const [id, entry] of endpointPricing) {
			models[id] = entry;
		}
		writeFileSync(
			ENDPOINTS_CACHE_PATH,
			JSON.stringify({ checkedAt: Date.now(), models }, null, 2) + "\n",
			"utf-8",
		);
	} catch {
		// best effort
	}
}

loadEndpointPricingCache();

function recordEndpointPricing(id: string, endpoints: RouterAIEndpoint[]): void {
	const list: ProviderEndpoint[] = [];
	for (const e of endpoints) {
		if (!e.pricing) continue;
		const tag = e.tag || e.provider_name.toLowerCase();
		if (!tag) continue;
		list.push({
			tag,
			providerName: e.provider_name || e.tag,
			pricing: e.pricing,
			countries: e.countries,
			contextLength: (e as { context_length?: unknown }).context_length as number | undefined,
			maxCompletionTokens: (e as { max_completion_tokens?: unknown }).max_completion_tokens as number | undefined,
			quantization: e.quantization ?? undefined,
			status: (e as { status?: unknown }).status as number | undefined,
			supportedParameters: (e as { supported_parameters?: unknown }).supported_parameters as string[] | undefined,
		});
	}
	if (list.length > 0) endpointPricing.set(id, { checkedAt: Date.now(), endpoints: list });
}

/** Pricing for a routed provider (chunk `provider` value or endpoint tag). */
function lookupEndpointPricing(modelId: string, provider: string): RouterAIPricing | undefined {
	const p = provider.toLowerCase();
	return endpointPricing.get(modelId)?.endpoints.find(
		(e) => e.tag === p || e.providerName.toLowerCase() === p,
	)?.pricing;
}

// Routed provider as reported on stream chunks, per model id. The agent loop
// is sequential, so the latest value per model is the one to bill with.
const routedProvider = new Map<string, string>();

// Preferred upstream providers per model id (lowercase tags, e.g. "relace"),
// ORDERED — injected into request bodies as `provider.order` with fallbacks
// allowed: RouterAI serves the request from the first healthy provider in
// the list, falling back to its own routing otherwise. Chosen via
// /routerai-providers or ctrl+p in the model picker (ctrl+space toggles,
// ctrl+o reorder mode (↑↓ pick, ←→ move), enter applies). PERSISTED in
// settings.json as `routerai.providerPrefs` ({ modelId: [tags…] }) and
// reloaded on every start; note settings.json is live config — the file
// changes when a preference is picked, and committing it needs approval
// (see ~/.pi/AGENTS.md).
const providerPrefs = new Map<string, string[]>();

/** Load `routerai.providerPrefs` from settings.json ({ modelId: [tags…] }). */
function loadProviderPrefsFromSettings(): void {
	try {
		if (!existsSync(SETTINGS_PATH)) return;
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
		const stored = parsed["routerai"]?.["providerPrefs"];
		if (!stored || typeof stored !== "object") return;
		for (const [id, tags] of Object.entries(stored)) {
			if (!Array.isArray(tags)) continue;
			const clean = tags.filter((t): t is string => typeof t === "string" && t.length > 0);
			if (clean.length > 0) providerPrefs.set(id, clean);
		}
	} catch {
		// malformed settings: start empty
	}
}

/** Write the current preferences back to settings.json (read-modify-write,
 * preserving all other settings). Removes the key entirely when empty. */
function saveProviderPrefsToSettings(): void {
	try {
		const settings = existsSync(SETTINGS_PATH)
			? JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"))
			: {};
		const routerai = settings["routerai"] ??= {};
		if (providerPrefs.size === 0) delete routerai["providerPrefs"];
		else routerai["providerPrefs"] = Object.fromEntries(providerPrefs);
		writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n", "utf-8");
	} catch {
		// best effort: the preference stays active for this session
	}
}

loadProviderPrefsFromSettings();

/**
 * TTL for cached per-model pricing and the catalog list, in minutes (settings
 * `routerai.priceRefreshMinutes`; 0 = refresh only via /routerai-refresh and
 * picker ctrl+r). Each lazy refresh is a single request, so the default is
 * small. Applies at natural boundaries only — session start, model select,
 * turn end, picker open — never on an idle timer.
 */
function getPriceRefreshMinutes(): number {
	try {
		if (existsSync(SETTINGS_PATH)) {
			const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
			const value = parsed["routerai"]?.["priceRefreshMinutes"];
			if (typeof value === "number" && value >= 0) return value;
		}
	} catch {
		// fall through to default
	}
	return 5;
}

// ── GLM reasoning replay normalization ──

function getReasoningReplayMode(): "duplicate" | "rename" | "off" {
	try {
		if (existsSync(SETTINGS_PATH)) {
			const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
			const value = parsed["routerai"]?.["reasoningReplay"];
			if (value === "duplicate" || value === "rename" || value === "off") return value;
		}
	} catch {
		// fall through to default
	}
	return "duplicate";
}

/**
 * GLM chat templates read `reasoning_content` on replayed assistant turns;
 * pi echoes the trace under the field RouterAI used when streaming it
 * (`reasoning`). Copy (or move) it so the model keeps its cross-turn
 * reasoning trace. Mirrors pi-ai's opencode-go special-case and the
 * built-in zai provider's replay behavior (pi issue #10262).
 */
function normalizeReasoningReplay(payload: unknown): unknown {
	const mode = getReasoningReplayMode();
	if (mode === "off") return payload;
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
		if (mode === "rename") {
			delete msg.reasoning;
		}
	}
	return payload;
}

function clampContextWindow(realContextWindow: number): number {
	const threshold = getCompactionThreshold();
	// null ("off") or a threshold at/above the real window: no clamp needed —
	// pi's native window-relative compaction fires first anyway.
	if (threshold === null || threshold >= realContextWindow) {
		return realContextWindow;
	}
	const reserve = getReserveTokens();
	return Math.min(realContextWindow, threshold + reserve);
}

// ── Compaction threshold: dynamic setting + UI ──
// The clamp above reads `compactionThreshold` from settings.json on every
// catalog fetch, so changing the setting + refreshing the catalog moves the
// compaction trigger. This section ports the UI from the old
// compaction-threshold extension: /compact-threshold menu + footer %.

/** Save threshold to global settings.json. null = clamp off. */
function saveGlobalThreshold(n: number | null): boolean {
	try {
		const raw = readFileSync(SETTINGS_PATH, "utf-8");
		const parsed = JSON.parse(raw);
		parsed["compactionThreshold"] = n;
		writeFileSync(SETTINGS_PATH, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

function parseThresholdInput(input: string): number | null {
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

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function isTextModel(modality: string): boolean {
	const outputPart = modality.split("->")[1] ?? "";
	return outputPart.includes("text");
}

function supportsReasoning(model: RouterAIModel): boolean {
	if (!model.supported_parameters) return false;
	return (
		model.supported_parameters.includes("reasoning") ||
		model.supported_parameters.includes("include_reasoning")
	) && isTextModel(model.architecture.modality);
}

function supportsReasoningEffort(params: string[] | null): boolean {
	return params ? params.includes("reasoning_effort") : false;
}

function supportsImages(inputModalities: string[]): boolean {
	return inputModalities.includes("image");
}

function toModelDef(m: RouterAIModel, basePricing?: RouterAIPricing): Model<"openai-completions"> {
	const inputModalities: ("text" | "image")[] = ["text"];
	if (supportsImages(m.architecture.input_modalities ?? [])) {
		inputModalities.push("image");
	}

	const realContextWindow = m.context_length ?? 128000;
	// Clamp the window pi sees so native auto-compaction (threshold,
	// overflow, and mid-run split-turn checks) fires at our absolute
	// threshold and continues the run. See header comment.
	const contextWindow = clampContextWindow(realContextWindow);

	// RouterAI returns prices in RUB/token. Keep as RUB per million tokens.
	// Base estimate = the PRIORITY provider's pricing (first endpoint in the
	// /endpoints list — matches RouterAI's default routing and the site's
	// «Приоритетный» label), falling back to the list price (cheapest
	// provider). Once a request's routed provider is known, `message_end`
	// recomputes cost from that provider's exact endpoint pricing.
	const p = basePricing ?? m.pricing;
	const cost = {
		input: p.prompt * 1_000_000,
		output: p.completion * 1_000_000,
		cacheRead: (p.input_cache_read ?? 0) * 1_000_000,
		cacheWrite: (p.input_cache_write ?? 0) * 1_000_000,
	};

	const reasoning = supportsReasoning(m);
	const supportsEffort = supportsReasoningEffort(m.supported_parameters);

	const compat: Record<string, string | boolean> = {};
	if (reasoning) {
		compat.supportsReasoningEffort = supportsEffort;
		compat.thinkingFormat = "openrouter";
	}
	if (m.supported_parameters?.includes("max_completion_tokens")) {
		compat.maxTokensField = "max_completion_tokens";
	} else if (m.supported_parameters?.includes("max_tokens")) {
		// Explicitly use max_tokens when supported (default behavior, but explicit is clear)
		compat.maxTokensField = "max_tokens";
	}

	const model: Model<"openai-completions"> & { rawContextWindow?: number } = {
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		id: m.id,
		name: m.name,
		reasoning,
		input: inputModalities,
		cost,
		contextWindow,
		// Raw context length for display (footer/picker); pi ignores unknown fields.
		rawContextWindow: realContextWindow,
		// Use a high default maxTokens — 4096 was too low for reasoning models (issue #7855)
		// Derive from the REAL context length, not the clamped window — the clamp
		// only exists to move the compaction trigger earlier.
		maxTokens: Math.max(realContextWindow > 0 ? Math.min(realContextWindow, 64000) : 32000, 32000),
		...(Object.keys(compat).length > 0 ? { compat } : {}),
	};
	return model;
}

async function fetchModelEndpoints(
	id: string,
	signal?: AbortSignal,
): Promise<RouterAIEndpoint[] | undefined> {
	try {
		const response = await fetch(`${BASE_URL}/models/${id}/endpoints`, {
			headers: { Accept: "application/json" },
			...(signal ? { signal } : {}),
		});
		if (!response.ok) return undefined;
		const payload = (await response.json()) as { data?: { endpoints?: RouterAIEndpoint[] } };
		return payload.data?.endpoints;
	} catch {
		return undefined;
	}
}

/** Timestamp of the persisted catalog (models-store.json), so a catalog
 * freshly restored at startup isn't immediately re-fetched by the picker. */
function readModelsStoreCheckedAt(): number {
	try {
		const storePath = join(homedir(), ".pi", "agent", "models-store.json");
		if (!existsSync(storePath)) return 0;
		const parsed = JSON.parse(readFileSync(storePath, "utf-8")) as {
			routerai?: { checkedAt?: number };
		};
		return typeof parsed.routerai?.checkedAt === "number" ? parsed.routerai.checkedAt : 0;
	} catch {
		return 0;
	}
}

/** Last time the RouterAI model catalog was fetched from the network. */
let lastCatalogFetchAt = readModelsStoreCheckedAt();

async function fetchRouterAIModels(signal?: AbortSignal): Promise<Model<"openai-completions">[]> {
	const response = await fetch(`${BASE_URL}/models`, {
		headers: { Accept: "application/json" },
		...(signal ? { signal } : {}),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch models from RouterAI: ${response.status} ${await response.text()}`);
	}

	const payload = (await response.json()) as { data: RouterAIModel[] };
	lastCatalogFetchAt = Date.now();

	const candidates = payload.data.filter((m) => isTextModel(m.architecture.modality));

	// Per-provider pricing is fetched LAZILY, per model (see ensureFreshPricing):
	// fetching /endpoints for all ~500 models here would mean one bulk sweep of
	// 500 requests on every refresh. Base price comes from the cached priority
	// provider when known; models never fetched yet fall back to the list price
	// (cheapest provider) until they are used or inspected in the picker.
	return candidates.map((m) =>
		toModelDef(m, endpointPricing.get(m.id)?.endpoints[0]?.pricing),
	);
}

function fmtPrice(rubPerMtok: number): string {
	if (!Number.isFinite(rubPerMtok)) return "?";
	if (rubPerMtok === 0) return "0";
	if (rubPerMtok >= 100) return rubPerMtok.toFixed(0);
	if (rubPerMtok >= 10) return rubPerMtok.toFixed(1);
	const s = rubPerMtok.toFixed(2);
	return s.endsWith("0") ? s.slice(0, -1) : s;
}

/** Compact token-count format: 1048576 → 1M, 943717 → 944k. */
function fmtTokens(n?: number): string {
	if (!n || !Number.isFinite(n)) return "?";
	if (n >= 1_000_000) {
		const m = n / 1_000_000;
		return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
	}
	return `${Math.round(n / 1000)}k`;
}

function fmtCtx(model: Model<"openai-completions"> & { rawContextWindow?: number }): string {
	const real = model.rawContextWindow ?? model.contextWindow;
	const ctx = fmtCtxTokens(real);
	if (model.contextWindow < real) {
		return `${ctx} (♻${fmtCtxTokens(model.contextWindow)})`;
	}
	return ctx;
}

function fmtCtxTokens(tokens: number): string {
	return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : `${tokens}`;
}

interface PickerItem extends SelectItem {
	model: Model<"openai-completions">;
}

interface CapabilityFilter {
	token: string;
	test: (m: RouterAIModelType) => boolean;
}

type RouterAIModelType = Model<"openai-completions"> & { rawContextWindow?: number };

interface SortOption {
	id: "relevance" | "name" | "input" | "output";
	label: string;
	/**
	 * undefined = keep the incoming (fuzzy match-quality) order.
	 * Set = order by this comparator within the pinned/unpinned groups.
	 */
	cmp?: (a: RouterAIModelType, b: RouterAIModelType) => number;
}

const PIN_KEY = "ctrl+space";
const SORT_KEY = "ctrl+s";
const REFRESH_KEY = "ctrl+r";
const PROV_KEY = "ctrl+p";
const ORDER_KEY = "ctrl+o";
const PIN_MARKER = "◆ ";

// Aligned side-by-side comparison table for pinned models.
function compareTableLines(
	pins: RouterAIModelType[],
	width: number,
	dim: (text: string) => string,
): string[] {
	const nameW = 34;
	const colW = 9;
	const lines: string[] = [];
	const header =
		`  ${"model".padEnd(nameW)}${"in".padStart(colW)}${"out".padStart(colW)}${"cache".padStart(colW)}  ctx`;
	lines.push(dim(truncateToWidth(header, width)));
	for (const m of pins) {
		const row =
			`  ${truncateToWidth(m.name, nameW).padEnd(nameW)}`
			+ fmtPrice(m.cost.input).padStart(colW)
			+ fmtPrice(m.cost.output).padStart(colW)
			+ fmtPrice(m.cost.cacheRead).padStart(colW)
			+ `  ${fmtCtx(m)}`;
		lines.push(truncateToWidth(row, width));
	}
	return lines;
}

export default async function (pi: ExtensionAPI) {
	// ── Tag every request with the current session ID ──

	pi.on("before_provider_headers", (event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId) {
			event.headers["x-session-id"] = sessionId;
		}
	});

	// ── Provider preference + GLM reasoning replay ──
	//
	// 1. Provider preference (per model, session-scoped, chosen via
	//    /routerai-providers or ctrl+p in the model picker): inject
	//    `provider.order` into the request body (fallbacks allowed — a
	//    preference, not a hard pin; see
	//    https://routerai.ru/docs/guides/overview/provider-selection). Not
	//    injected if the payload already carries a `provider` object.
	// 2. GLM reasoning replay: reasoning → reasoning_content. Keep RouterAI's
	//    OpenRouter-style request format (it works), but make the replayed
	//    reasoning trace visible to GLM chat templates. See header comment
	//    and pi issue #10262.
	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		if (model?.provider !== PROVIDER_ID) return undefined;
		const payload = event.payload;
		if (payload && typeof payload === "object") {
			const body = payload as Record<string, unknown>;
			const pref = providerPrefs.get(model.id);
			if (pref && pref.length > 0 && !body.provider) {
				body.provider = { order: [...pref], allow_fallbacks: true };
			}
		}
		if (!model.reasoning) return undefined;
		return normalizeReasoningReplay(payload);
	});

	// ── Routed-provider tracking + cost correction ──
	//
	// RouterAI reports the actual upstream provider on every stream chunk
	// ("provider":"BytePlus"). Record it per model, then on `message_end`
	// recompute the recorded usage cost with THAT provider's endpoint pricing
	// — the model's list price is the cheapest provider's, which can be ~6×
	// lower than what routing actually bills.
	pi.on("provider_stream_event", (event) => {
		const chunk = event.data as { provider?: unknown } | null | undefined;
		if (chunk && typeof chunk === "object" && typeof chunk.provider === "string" && chunk.provider) {
			routedProvider.set(event.model, chunk.provider);
		}
	});

	/**
	 * Recompute a usage record's cost with the routed provider's per-token
	 * rates (mirrors pi-ai's calculateCost). Returns true when applied.
	 */
	function applyEndpointPricing(
		modelId: string,
		usage: {
			input: number; output: number; cacheRead: number; cacheWrite: number;
			cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
		},
	): boolean {
		const provider = routedProvider.get(modelId);
		if (!provider) return false;
		const pricing = lookupEndpointPricing(modelId, provider);
		if (!pricing) return false;
		usage.cost.input = usage.input * pricing.prompt;
		usage.cost.output = usage.output * pricing.completion;
		usage.cost.cacheRead = usage.cacheRead * (pricing.input_cache_read ?? 0);
		usage.cost.cacheWrite = usage.cacheWrite * (pricing.input_cache_write ?? 0);
		usage.cost.total =
			usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
		return true;
	}

	pi.on("message_end", (event) => {
		const msg = event.message as {
			role?: string;
			provider?: string;
			model?: string;
			usage?: {
				input: number; output: number; cacheRead: number; cacheWrite: number;
				cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
			};
		};
		if (
			msg?.role !== "assistant" ||
			msg.provider !== PROVIDER_ID ||
			!msg.model ||
			!msg.usage?.cost
		) {
			return undefined;
		}
		if (applyEndpointPricing(msg.model, msg.usage)) {
			return { message: event.message };
		}
		return undefined;
	});

	// ── Dynamic provider: catalog (and prices) refresh via fetchModels ──
	//
	// `fetchModels` makes this a dynamic provider. pi's createProvider wrapper:
	//   - restores the persisted catalog from the models store before any network
	//     access, so models/prices are available immediately on startup;
	//   - fetches fresh data over the network and persists it (models-store.json)
	//     whenever a networked refresh runs (see the session_start handler below).

	pi.registerProvider(createProvider({
		id: PROVIDER_ID,
		name: "RouterAI",
		baseUrl: BASE_URL,
		auth: {
			apiKey: {
				name: "RouterAI API key",
				async login(interaction) {
					return {
						type: "api_key",
						key: await interaction.prompt({ type: "secret", message: "Enter your RouterAI API key" }),
					};
				},
				async resolve({ credential }) {
					if (credential?.key) {
						return { auth: { apiKey: credential.key }, source: "stored API key" };
					}
					return undefined;
				},
			},
		},
		models: [], // dynamic provider: catalog comes from fetchModels / persisted store
		fetchModels: async ({ signal }) => fetchRouterAIModels(signal),
		api: openAICompletionsApi(),
	}));

	// ── Lazy per-model pricing refresh ──
	// One /endpoints request per model, fetched only when that model's cached
	// data is older than the TTL, and only at natural boundaries (session
	// start, model select, turn end, picker open). Fire-and-forget — never
	// delays a turn; network failures leave the previous data in place.

	let refreshInFlight = false;

	/**
	 * Fetch /endpoints for one model if its cached pricing is stale (or always
	 * with `force`), update the cache and the model def. Single-flight.
	 */
	async function ensureFreshPricing(ctx: ExtensionContext, modelId: string, force: boolean): Promise<void> {
		if (refreshInFlight) return;
		if (!force) {
			const ttl = getPriceRefreshMinutes() * 60_000;
			if (ttl === 0) return;
			const cached = endpointPricing.get(modelId);
			if (cached && Date.now() - cached.checkedAt < ttl) return;
		}
		refreshInFlight = true;
		try {
			const endpoints = await fetchModelEndpoints(modelId);
			if (endpoints?.length) {
				recordEndpointPricing(modelId, endpoints);
				saveEndpointPricingCache();
				await applyPricing(ctx, modelId);
			}
		} catch {
			// non-fatal: stale pricing stays in use
		} finally {
			refreshInFlight = false;
		}
	}

	/**
	 * Patch the model def for `modelId` in place with its cached priority
	 * pricing, and re-apply it as the current model so future estimates use
	 * fresh prices. No-op when nothing is cached.
	 */
	async function applyPricing(ctx: ExtensionContext, modelId: string): Promise<void> {
		const priority = endpointPricing.get(modelId)?.endpoints[0]?.pricing;
		if (!priority) return;
		const fresh = ctx.modelRegistry
			.getAll()
			.find((m) => m.provider === PROVIDER_ID && m.id === modelId);
		if (!fresh) return;
		fresh.cost = {
			input: priority.prompt * 1_000_000,
			output: priority.completion * 1_000_000,
			cacheRead: (priority.input_cache_read ?? 0) * 1_000_000,
			cacheWrite: (priority.input_cache_write ?? 0) * 1_000_000,
		};
		const model = ctx.model;
		if (model?.provider === PROVIDER_ID && model.id === modelId) {
			await pi.setModel(fresh);
		}
	}

	/**
	 * Refresh the catalog list (1 request) and force-refresh the current
	 * model's endpoint pricing (1 request); re-applies the current model and
	 * updates the footer. `notify` controls user-facing messages (silent for
	 * background refreshes).
	 */
	async function refreshPrices(ctx: ExtensionContext, notify: boolean): Promise<boolean> {
		try {
			const result = await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
			const error = result.errors.get(PROVIDER_ID);
			if (error) {
				if (notify) ctx.ui.notify(`RouterAI price refresh failed, showing cached prices (${error.message})`, "warning");
				return false;
			}
			const model = ctx.model;
			if (model?.provider === PROVIDER_ID) {
				await ensureFreshPricing(ctx, model.id, true);
			}
			updateFooter(ctx);
			if (notify) ctx.ui.notify("RouterAI prices refreshed", "info");
			return true;
		} catch (error) {
			if (notify) {
				ctx.ui.notify(`RouterAI price refresh failed (${error instanceof Error ? error.message : String(error)})`, "warning");
			}
			return false;
		}
	}

	// ── Footer status: rates for the current model + session spend ──

	function routeraiModels(ctx: ExtensionContext): RouterAIModelType[] {
		return ctx.modelRegistry.getAll().filter(
			(m): m is RouterAIModelType => m.provider === PROVIDER_ID,
		);
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
			// …and compactions: each compaction runs an LLM call (full uncached
			// context + summary output) whose usage/cost pi records on the
			// compaction entry itself. Skipping it made the footer drift below
			// pi's own total after every compaction.
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

	function updateFooter(ctx: ExtensionContext) {
		const model = ctx.model;
		if (!model || model.provider !== PROVIDER_ID) {
			ctx.ui.setStatus("routerai", undefined);
			return;
		}
		// Show the routed provider's real rates once known — they're what
		// requests are actually billed at; before the first response the
		// catalog's priority-provider estimate is shown.
		const via = routedProvider.get(model.id);
		const routed = via ? lookupEndpointPricing(model.id, via) : undefined;
		const inR = (routed?.prompt ?? model.cost.input / 1_000_000) * 1_000_000;
		const outR = (routed?.completion ?? model.cost.output / 1_000_000) * 1_000_000;
		const cacheR = (routed?.input_cache_read ?? model.cost.cacheRead / 1_000_000) * 1_000_000;
		const rates = `${fmtPrice(inR)}/${fmtPrice(outR)}/${fmtPrice(cacheR)} ₽/Mtok`;
		const cost = sessionCost(ctx);
		// Total spend, then the input/output/cache split in fixed positions
		// (same format as turn-timer's summary). Currency symbol once, bare
		// numbers inside; the split is omitted when it's all zeros.
		const split =
			cost.input > 0 || cost.output > 0 || cost.cache > 0
				? ` (${cost.input.toFixed(3)}/${cost.output.toFixed(3)}/${cost.cache.toFixed(3)})`
				: "";
		const spent = `₽${cost.total.toFixed(3)}${split}`;
		const pref = providerPrefs.get(model.id);
		ctx.ui.setStatus(
			"routerai",
			ctx.ui.theme.fg("dim", `${rates} · ${spent}${via ? ` via ${via}` : ""}${pref?.length ? ` ⭑ ${pref.join("→")}` : ""}`),
		);
	}

	// ── /routerai-models: searchable, filterable price picker ──
	//
	// Pinned model ids for cost comparison. Session-scoped: the pins live as
	// long as this extension instance (cleared when pi restarts).

	const pinnedIds = new Set<string>();

	const SORTS: SortOption[] = [
		// "best match": preserves fuzzyFilter's ranking (consecutive/word-boundary
		// matches like "luna" -> "gpt-luna" outrank loose subsequence matches).
		// Falls back to catalog order when the query is empty.
		{ id: "relevance", label: "best match" },
		{ id: "name", label: "name", cmp: (a, b) => a.name.localeCompare(b.name) },
		{ id: "input", label: "input price ↑", cmp: (a, b) => a.cost.input - b.cost.input || a.name.localeCompare(b.name) },
		{ id: "output", label: "output price ↑", cmp: (a, b) => a.cost.output - b.cost.output || a.name.localeCompare(b.name) },
	];

	pi.registerCommand("routerai-models", {
		description: "Searchable RouterAI model picker with prices and capability filters",
		handler: async (_args, ctx) => {
			// TTL-debounced catalog refresh on open: at most one list request
			// when the snapshot is older than the TTL, so the picker shows
			// current models/prices. Falls back to cached models when offline.
			const ttlMinutes = getPriceRefreshMinutes();
			if (ttlMinutes > 0 && Date.now() - lastCatalogFetchAt > ttlMinutes * 60_000) {
				try {
					await ctx.modelRegistry.refresh({ providers: [PROVIDER_ID], force: true });
				} catch {
					// fall back to cached models
				}
			}
			const models = routeraiModels(ctx);
			if (models.length === 0) {
				ctx.ui.notify("No RouterAI models loaded yet — try again after the catalog refresh completes", "warning");
				return;
			}

			const current = ctx.model;
			let sortIndex = 0;

			// value: model id (search key), label: display name,
			// description: prices + context window + capability badges.
			const byId = new Map<string, PickerItem>();
			for (const m of models) {
				byId.set(m.id, {
					model: m,
					value: m.id,
					label: pinnedIds.has(m.id) ? `${PIN_MARKER}${m.name}` : m.name,
					description:
						`in ${fmtPrice(m.cost.input)} / out ${fmtPrice(m.cost.output)}`
						+ ` / cache ${fmtPrice(m.cost.cacheRead)} ₽/Mtok · ctx ${fmtCtx(m)}`
						+ (m.input.includes("image") ? " · vision" : "")
						+ (m.reasoning ? " · reasoning" : ""),
				});
			}

			// ── Capability filters, activated by including the token in the query ──
			const FILTERS: CapabilityFilter[] = [
				{ token: "vision", test: (m) => m.input.includes("image") },
				{ token: "text", test: (m) => !m.input.includes("image") },
				{ token: "reasoning", test: (m) => m.reasoning },
				{ token: "cheap", test: (m) => m.cost.output > 0 && m.cost.output <= 10 },
				{ token: "free", test: (m) => m.cost.output === 0 },
				{ token: "big", test: (m) => (m.rawContextWindow ?? m.contextWindow) >= 256_000 },
				{
					token: "current",
					test: (m) => (current ? current.provider === m.provider && current.id === m.id : false),
				},
			];
			const filtersHint = FILTERS.map((f) => f.token).join(" ");

			// ── Custom picker component: search input + SelectList ──
			const result = await ctx.ui.custom<RouterAIModelType | null>(
				(tui, theme, kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
					container.addChild(new Text(theme.fg("accent", theme.bold("RouterAI Models — prices in ₽/Mtok"))));

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

					// The list is rebuilt on every filter/pin/sort change
					// (SelectList's item accessors are private).
					const listContainer = new Container();
					const countLine = new Text("", 0, 0);
					const pinTable = new Text("", 0, 0);
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

					function setPinTable() {
						const pins = [...pinnedIds]
							.map((id) => byId.get(id)?.model)
							.filter((m): m is RouterAIModelType => m !== undefined);
						if (pins.length === 0) {
							pinTable.setText("");
							return;
						}
						const lines = [
							theme.fg("accent", `📌 Pinned (compare) — ${pins.length}`),
							...compareTableLines(pins, 100, (text) => theme.fg("dim", text)),
						];
						pinTable.setText(lines.join("\n"));
					}

					function setSortStatus() {
						sortStatus.setText(theme.fg("dim", `  sort: ${SORTS[sortIndex].label} · ${SORT_KEY} cycle`));
					}

					// ── Filtering: capability tokens + fuzzy text search, then
					// pinned-first ordering under the active sort ──
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

						// Pinned models always float to the top. Array#sort is stable,
						// so with no comparator the fuzzy relevance order is preserved
						// within each group; with a comparator the group is re-ordered
						// by the active sort.
						const cmp = SORTS[sortIndex].cmp;
						filtered = filtered.slice().sort((a, b) => {
							const pa = pinnedIds.has(a.value) ? 0 : 1;
							const pb = pinnedIds.has(b.value) ? 0 : 1;
							if (pa !== pb) return pa - pb;
							return cmp ? cmp(a.model, b.model) : 0;
						});
						return filtered;
					}

					function refresh(keepSelection: boolean) {
						const filtered = computeFiltered();
						makeList(filtered, keepSelection);
						setPinTable();
						setSortStatus();
						countLine.setText(theme.fg("dim", `  ${filtered.length} / ${byId.size} models`));
					}

					function pinHighlighted() {
						const item = selectList.getSelectedItem() as PickerItem | null;
						if (!item) return;
						if (pinnedIds.has(item.value)) {
							pinnedIds.delete(item.value);
						} else {
							pinnedIds.add(item.value);
						}
						// Relabel so the pin marker shows in the main list too.
						for (const id of pinnedIds) {
							const entry = byId.get(id);
							if (entry && !entry.label.startsWith(PIN_MARKER)) {
								entry.label = `${PIN_MARKER}${entry.model.name}`;
							}
						}
						for (const [id, entry] of byId) {
							if (!pinnedIds.has(id) && entry.label.startsWith(PIN_MARKER)) {
								entry.label = entry.model.name;
							}
						}
						refresh(true);
					}

					function cycleSort() {
						sortIndex = (sortIndex + 1) % SORTS.length;
						refresh(true);
					}

					// ctrl+r: deep-refresh the visible page + pinned models — fetch
					// each one's /endpoints (a handful of requests, not a bulk sweep),
					// update the cache and patch this picker's model objects in place.
					let deepRefreshing = false;
					async function deepRefresh() {
						if (deepRefreshing) return;
						const visible = computeFiltered().slice(0, 10).map((item) => item.model);
						const pins = [...pinnedIds]
							.map((id) => byId.get(id)?.model)
							.filter((m): m is RouterAIModelType => m !== undefined);
						const ids = [...new Set([...pins, ...visible].map((m) => m.id))];
						if (ids.length === 0) return;
						deepRefreshing = true;
						statusLine.setText(theme.fg("warning", "  ⟳ refreshing prices…"));
						tui.requestRender();
						try {
							let updated = 0;
							for (const id of ids) {
								try {
									const endpoints = await fetchModelEndpoints(id);
									if (endpoints?.length) {
										recordEndpointPricing(id, endpoints);
										updated++;
									}
								} catch {
									// skip failed model
								}
							}
							if (updated > 0) saveEndpointPricingCache();
							for (const id of ids) await applyPricing(ctx, id);
							statusLine.setText(theme.fg("dim", `  ⟳ refreshed ${updated}/${ids.length} models`));
						} finally {
							deepRefreshing = false;
						}
						refresh(true);
						tui.requestRender();
					}

					container.addChild(countLine);
					container.addChild(pinTable);
					container.addChild(listContainer);
					container.addChild(statusLine);
					container.addChild(sortStatus);
					container.addChild(new Text(theme.fg("dim", `↑↓ navigate · enter select · esc cancel · ${PIN_KEY} pin/unpin · ${SORT_KEY} sort · ${REFRESH_KEY} refresh prices · ${PROV_KEY} providers · filters: ${filtersHint}`)));

					refresh(false);

					return {
						render(width: number) {
							return container.render(width);
						},
						invalidate() {
							container.invalidate();
						},
						handleInput(data: string) {
							// Route list keys (arrows/enter/esc) to the list, pin/sort
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
								void deepRefresh();
							} else if (matchesKey(data, PROV_KEY)) {
								const item = selectList.getSelectedItem() as PickerItem | null;
								if (item) {
									done(null);
									void openProviderPicker(ctx, item.model);
								}
							} else if (matchesKey(data, PIN_KEY)) {
								pinHighlighted();
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

	// ── Provider preference chooser (for one model) ──
	//
	// Same UX as the model picker: search, sort cycling, filter tokens.
	// Multi-select with explicit ordering, mirroring the pin-for-comparison
	// UX, in two modes (ctrl+arrows are taken by pi's transcript scrolling,
	// so reordering gets its own mode):
	//   select mode — navigate/search all providers, ctrl+space toggles them
	//     into the preference list (◆ marker, numbered table like the pinned
	//     comparison)
	//   reorder mode (ctrl+o) — the list shows only the drafted providers:
	//     ↑↓ pick one, ←→ move it within the order, ctrl+space removes it,
	//     ctrl+o back to select mode (exits automatically when the draft
	//     becomes empty)
	// Enter applies:
	//   - on "Auto" — clears the preference (RouterAI default routing)
	//   - on a provider row — applies the draft order; with an empty draft it
	//     is a shortcut for "prefer exactly this one"
	// The result is injected into request bodies as `provider.order` with
	// fallbacks allowed — a preference, not a hard pin: RouterAI falls back to
	// its own routing when every listed provider is unhealthy.

	interface ProviderOption {
		value: string; // "" = Auto
		label: string;
		description: string;
		search: string;
		endpoint?: ProviderEndpoint;
	}

	interface ProviderChoice {
		tags: string[]; // empty = Auto; null would be cancel (handled via done(null))
	}

	async function openProviderPicker(ctx: ExtensionContext, model: RouterAIModelType): Promise<void> {
		// Make sure we have endpoint data for this model (1 request when stale).
		if (!endpointPricing.get(model.id)?.endpoints?.length) {
			await ensureFreshPricing(ctx, model.id, true);
		}
		const endpoints = endpointPricing.get(model.id)?.endpoints ?? [];
		if (endpoints.length === 0) {
			ctx.ui.notify(`No provider/endpoint data for ${model.name} yet — try again in a moment`, "warning");
			return;
		}

		const byValue = new Map<string, ProviderOption>();
		byValue.set("", {
			value: "",
			label: "Auto — RouterAI routing",
			description: `default: stable providers first, then cheapest (${endpoints.length} endpoints)`,
			search: "auto default",
		});
		for (const e of endpoints) {
			byValue.set(e.tag, {
				value: e.tag,
				label: e.providerName,
				description:
					`in ${fmtPrice(e.pricing.prompt * 1_000_000)}`
					+ ` / out ${fmtPrice(e.pricing.completion * 1_000_000)}`
					+ ` / cache ${fmtPrice((e.pricing.input_cache_read ?? 0) * 1_000_000)} ₽/Mtok`
					+ (e.contextLength ? ` · ctx ${fmtTokens(e.contextLength)}` : "")
					+ (e.maxCompletionTokens ? ` · max out ${fmtTokens(e.maxCompletionTokens)}` : "")
					+ (e.countries?.length ? ` · ${e.countries.join("/")}` : "")
					+ (e.quantization ? ` · ${e.quantization}` : "")
					+ (e.supportedParameters?.includes("tools") ? " · tools" : "")
					+ ((e.status ?? 0) !== 0 ? ` · status ${e.status}` : ""),
				search: `${e.providerName} ${e.tag} ${(e.countries ?? []).join(" ")}`,
				endpoint: e,
			});
		}

		const draft = [...(providerPrefs.get(model.id) ?? [])].filter((t) => byValue.has(t));
		let reorderMode = false;

		const SORTS: { id: string; label: string; price?: (e: ProviderEndpoint) => number }[] = [
			// RouterAI's reported endpoint order (priority provider first)
			{ id: "default", label: "router priority" },
			{ id: "input", label: "input price ↑", price: (e) => e.pricing.prompt },
			{ id: "output", label: "output price ↑", price: (e) => e.pricing.completion },
			{ id: "cache", label: "cache price ↑", price: (e) => e.pricing.input_cache_read ?? 0 },
		];

		const FILTERS: { token: string; test: (o: ProviderOption) => boolean }[] = [
			{ token: "free", test: (o) => (o.endpoint?.pricing.completion ?? 1) === 0 },
			{ token: "big", test: (o) => (o.endpoint?.contextLength ?? 0) >= 256_000 },
		];
		const filtersHint = FILTERS.map((f) => f.token).join(" ");
		let sortIndex = 0;

		const result = await ctx.ui.custom<ProviderChoice | null>(
			(tui, theme, kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((str) => theme.fg("accent", str)));
				container.addChild(new Text(theme.fg("accent", theme.bold(`${model.name} — provider preference (prices in ₽/Mtok)`))));

				const searchInput = new Input({ prompt: "Search: " });
				container.addChild(searchInput);

				const selectTheme = {
					selectedPrefix: (text: string) => theme.fg("accent", text),
					selectedText: (text: string) => theme.fg("accent", text),
					description: (text: string) => theme.fg("muted", text),
					scrollInfo: (text: string) => theme.fg("dim", text),
					noMatch: (text: string) => theme.fg("warning", text),
				};
				const listLayout = { minPrimaryColumnWidth: 22, maxPrimaryColumnWidth: 28 };

				const listContainer = new Container();
				const prefTable = new Text("", 0, 0);
				const countLine = new Text("", 0, 0);
				const sortStatus = new Text("", 0, 0);

				let selectList = new SelectList([], 12, selectTheme, listLayout);

				function relabel() {
					for (const [value, option] of byValue) {
						if (!option.endpoint) continue;
						const base = option.label.startsWith(PIN_MARKER) ? option.label.slice(PIN_MARKER.length) : option.label;
						option.label = draft.includes(value) ? `${PIN_MARKER}${base}` : base;
					}
				}

				function setPrefTable() {
					if (draft.length === 0) {
						prefTable.setText("");
						return;
					}
					const lines = [theme.fg("accent", `⭑ Preference order (tried top to bottom) — enter applies · ${ORDER_KEY} reorder`)];
					draft.forEach((tag, i) => {
						const o = byValue.get(tag);
						const e = o?.endpoint;
						if (!o || !e) return;
						const row = `  ${i + 1}.`.padEnd(4)
							+ o.label.padEnd(18)
							+ `in ${fmtPrice(e.pricing.prompt * 1_000_000)}`
							+ ` / out ${fmtPrice(e.pricing.completion * 1_000_000)}`
							+ ` / cache ${fmtPrice((e.pricing.input_cache_read ?? 0) * 1_000_000)} ₽/Mtok`;
						lines.push(theme.fg("dim", truncateToWidth(row, 100)));
					});
					prefTable.setText(lines.join("\n"));
				}

				function computeFiltered(): ProviderOption[] {
					const raw = searchInput.getValue();
					let stripped = raw;
					let list = [...byValue.values()];
					for (const f of FILTERS) {
						if (stripped.includes(f.token)) {
							list = list.filter((o) => f.test(o));
							stripped = stripped.split(f.token).join(" ");
						}
					}
					stripped = stripped.replace(/\s+/g, " ").trim();
					let filtered: ProviderOption[] = stripped
						? fuzzyFilter(list, stripped, (o) => `${o.value} ${o.label} ${o.search}`)
						: list;
					const price = SORTS[sortIndex].price;
					if (price) {
						filtered = filtered.slice().sort((a, b) => {
							// "Auto" always stays on top under price sorts
							if (!a.endpoint) return -1;
							if (!b.endpoint) return 1;
							return price(a.endpoint) - price(b.endpoint);
						});
					}
					return filtered;
				}

				function refresh(keepSelection: boolean) {
					const previousId = keepSelection ? selectList.getSelectedItem()?.value : undefined;
					const filtered = reorderMode
						? draft.map((tag) => byValue.get(tag)).filter((o): o is ProviderOption => o !== undefined)
						: computeFiltered();
					selectList = new SelectList(filtered, 12, selectTheme, listLayout);
					selectList.onSelect = (item) => {
						const option = item as ProviderOption;
						// Enter on Auto = clear; on a drafted row (or any row with a
						// non-empty draft) = apply the draft; on an undrafted row with
						// an empty draft = quick "prefer exactly this one".
						if (!option.endpoint) done({ tags: [] });
						else if (draft.includes(option.value) || draft.length > 0) done({ tags: [...draft] });
						else done({ tags: [option.value] });
					};
					selectList.onCancel = () => done(null);
					if (previousId) {
						const index = filtered.findIndex((o) => o.value === previousId);
						if (index > 0) selectList.setSelectedIndex(index);
					}
					listContainer.clear();
					listContainer.addChild(selectList);
					countLine.setText(theme.fg("dim", `  ${filtered.length} / ${byValue.size} providers`));
					sortStatus.setText(theme.fg("dim", `  sort: ${SORTS[sortIndex].label} · ${SORT_KEY} cycle`));
				}

				function toggleHighlighted() {
					const item = selectList.getSelectedItem() as ProviderOption | null;
					if (!item?.endpoint) return;
					const idx = draft.indexOf(item.value);
					if (idx === -1) draft.push(item.value);
					else draft.splice(idx, 1);
					relabel();
					setPrefTable();
					// Removing the last entry in reorder mode: nothing left to order —
					// exit first so the refresh shows the full list again.
					if (reorderMode && draft.length === 0) {
						reorderMode = false;
					}
					refresh(true);
					setModeLine();
				}

				function moveHighlighted(delta: number) {
					const item = selectList.getSelectedItem() as ProviderOption | null;
					if (!item?.endpoint) return;
					const idx = draft.indexOf(item.value);
					if (idx === -1) return;
					const to = idx + delta;
					if (to < 0 || to >= draft.length) return;
					draft.splice(idx, 1);
					draft.splice(to, 0, item.value);
					setPrefTable();
					refresh(true);
				}

				function setModeLine() {
					modeLine.setText(reorderMode
						? theme.fg("warning", `  REORDER — ↑↓ choose · ←→ move · ${PIN_KEY} remove · ${ORDER_KEY} back`)
						: theme.fg("dim", `  select — ${PIN_KEY} add/remove from preference · ${ORDER_KEY} reorder`));
				}

				const modeLine = new Text("", 0, 0);
				container.addChild(countLine);
				container.addChild(prefTable);
				container.addChild(listContainer);
				container.addChild(sortStatus);
				container.addChild(modeLine);
				container.addChild(new Text(theme.fg("dim", `↑↓ navigate · enter apply · esc cancel · ${SORT_KEY} sort · filters: ${filtersHint}`)));

				relabel();
				refresh(false);
				setPrefTable();
				setModeLine();

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput(data: string) {
						if (matchesKey(data, ORDER_KEY)) {
							// Toggle reorder mode; needs a non-empty draft.
							reorderMode = !reorderMode && draft.length > 0;
							refresh(true);
							setModeLine();
						} else if (reorderMode && matchesKey(data, "left")) {
							moveHighlighted(-1);
						} else if (reorderMode && matchesKey(data, "right")) {
							moveHighlighted(1);
						} else if (
							kb.matches(data, "tui.select.up") ||
							kb.matches(data, "tui.select.down") ||
							kb.matches(data, "tui.select.confirm") ||
							kb.matches(data, "tui.select.cancel")
						) {
							selectList.handleInput(data);
						} else if (matchesKey(data, PIN_KEY)) {
							toggleHighlighted();
						} else if (matchesKey(data, SORT_KEY)) {
							sortIndex = (sortIndex + 1) % SORTS.length;
							refresh(true);
						} else if (!reorderMode) {
							// Typing only makes sense in select mode.
							searchInput.handleInput(data);
							refresh(false);
						}
						tui.requestRender();
					},
				};
			},
		);

		if (!result) return;
		if (result.tags.length === 0) {
			providerPrefs.delete(model.id);
			ctx.ui.notify(`${model.name}: back to RouterAI default routing`, "info");
		} else {
			providerPrefs.set(model.id, result.tags);
			const names = result.tags
				.map((t) => byValue.get(t)?.label.replace(PIN_MARKER, "") ?? t)
				.join(" → ");
			ctx.ui.notify(`${model.name}: provider preference ${names} (saved to settings.json)`, "info");
		}
		saveProviderPrefsToSettings();
		if (ctx.model?.provider === PROVIDER_ID && ctx.model?.id === model.id) {
			updateFooter(ctx);
		}
	}

	pi.registerCommand("routerai-providers", {
		description: "Choose preferred upstream provider(s) for the current RouterAI model",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model || model.provider !== PROVIDER_ID) {
				ctx.ui.notify("Select a RouterAI model first (/model)", "warning");
				return;
			}
			await openProviderPicker(ctx, model);
		},
	});

	// ── /routerai-refresh: force a price refresh now ──

	pi.registerCommand("routerai-refresh", {
		description: "Force-refresh RouterAI model catalog and prices",
		handler: async (_args, ctx) => {
			await refreshPrices(ctx, true);
		},
	});

	// ── Keep prices and footer fresh ──

	// Current compaction threshold (read from settings.json; dynamic — the menu
	// writes the file, and the clamp re-reads it on every catalog fetch).

	// ── /compact-threshold: interactive menu (ported from compaction-threshold) ──

	pi.registerCommand("compact-threshold", {
		description: "Show/set proactive compaction threshold (tokens). Supports k/M suffixes.",
		handler: async (_args, ctx) => {
			const threshold = getCompactionThreshold();
			const currentVal = threshold === null ? "off" : formatTokens(threshold);
			let persistOnSubmit = false;

			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) => {
					const container = new Container();

					container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
					container.addChild(new Text(theme.fg("accent", theme.bold("Compaction Threshold")), 1, 0));
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
							if (persistOnSubmit) persistOnSubmit = false;
							ctx.ui.notify("Proactive compaction disabled", "warning");
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
							if (persistOnSubmit) persistOnSubmit = false;
							ctx.ui.notify(
								`Threshold set to ${formatTokens(parsed)} — refresh the catalog (restart or /routerai-models re-pick) to apply`,
								"info",
							);
							done(undefined);
						} else {
							ctx.ui.notify("Invalid threshold. Use a number ≥ 1000, or 'off'.", "error");
						}
					};
					input.onEscape = () => done(undefined);
					container.addChild(input);

					const previewText = new Text("", 1, 0);
					container.addChild(previewText);
					const persistIndicator = new Text("", 1, 0);
					container.addChild(persistIndicator);
					container.addChild(new Text(theme.fg("dim", "Enter: confirm · Esc: cancel · settings saved to ~/.pi/agent/settings.json"), 1, 0));
					container.addChild(new Text(theme.fg("dim", "Supports k/M suffixes · 'off' to disable"), 1, 0));
					container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));

					return {
						render: (w) => container.render(w),
						invalidate: () => container.invalidate(),
						handleInput: (data) => {
							if (matchesKey(data, Key.ctrl("s"))) {
								// Kept for muscle memory from the old extension; saving is
								// now always global, so this is a no-op toggle.
								persistOnSubmit = !persistOnSubmit;
								persistIndicator.setText(theme.fg("dim", persistOnSubmit ? "  (always saved globally)" : ""));
								tui.requestRender();
								return;
							}
							input.handleInput(data);
							const val = input.getValue();
							if (val.trim()) {
								const lower = val.trim().toLowerCase();
								if (lower === "off" || lower === "disable") {
									previewText.setText(theme.fg("dim", "  → compaction clamp disabled"));
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

	pi.on("session_start", async (_event, ctx) => {
		// The persisted catalog is already restored at this point (offline phase).
		// Kick off a lazy refresh: catalog list (1 request) + the current model's
		// endpoint pricing (1 request). Failures are non-fatal — cached data
		// stays usable.
		void refreshPrices(ctx, false);
		updateFooter(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateFooter(ctx);
		const model = ctx.model;
		if (model?.provider === PROVIDER_ID) void ensureFreshPricing(ctx, model.id, false);
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateFooter(ctx);
		const model = ctx.model;
		if (model?.provider === PROVIDER_ID) void ensureFreshPricing(ctx, model.id, false);
	});
}
