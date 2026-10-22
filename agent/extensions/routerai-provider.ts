/**
 * RouterAI Custom Provider Extension
 *
 * Provides access to models available at https://routerai.ru/api/v1
 * Uses OpenAI-compatible chat completions API (OpenRouter-style).
 *
 * Prices are fetched live from the RouterAI models endpoint and kept
 * up to date via a dynamic provider catalog (`fetchModels`):
 *   - On startup the last persisted catalog is restored (no network needed).
 *   - On `session_start` a networked refresh pulls fresh prices.
 *   - `/routerai-models` opens a searchable price picker (like /model)
 *     with capability filters, pin-for-comparison (ctrl+space) and a
 *     cost sort toggle (ctrl+s).
 *   - The footer shows per-million-token rates for the current model.
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
	pricing: {
		prompt: number;
		completion: number;
		input_cache_read?: number;
		input_cache_write?: number;
	};
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

function toModelDef(m: RouterAIModel): Model<"openai-completions"> {
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
	const cost = {
		input: m.pricing.prompt * 1_000_000,
		output: m.pricing.completion * 1_000_000,
		cacheRead: (m.pricing.input_cache_read ?? 0) * 1_000_000,
		cacheWrite: (m.pricing.input_cache_write ?? 0) * 1_000_000,
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

async function fetchRouterAIModels(signal?: AbortSignal): Promise<Model<"openai-completions">[]> {
	const response = await fetch(`${BASE_URL}/models`, {
		headers: { Accept: "application/json" },
		...(signal ? { signal } : {}),
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch models from RouterAI: ${response.status} ${await response.text()}`);
	}

	const payload = (await response.json()) as { data: RouterAIModel[] };

	return payload.data
		.filter((m) => isTextModel(m.architecture.modality))
		.map(toModelDef);
}

function fmtPrice(rubPerMtok: number): string {
	if (!Number.isFinite(rubPerMtok)) return "?";
	if (rubPerMtok === 0) return "0";
	if (rubPerMtok >= 100) return rubPerMtok.toFixed(0);
	if (rubPerMtok >= 10) return rubPerMtok.toFixed(1);
	const s = rubPerMtok.toFixed(2);
	return s.endsWith("0") ? s.slice(0, -1) : s;
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

	// ── GLM reasoning replay: reasoning → reasoning_content ──
	// Keep RouterAI's OpenRouter-style request format (it works), but make
	// the replayed reasoning trace visible to GLM chat templates. See header
	// comment and pi issue #10262.
	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID || !ctx.model.reasoning) return undefined;
		return normalizeReasoningReplay(event.payload);
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

	// ── Footer status: rates for the current model + session spend ──

	function routeraiModels(ctx: ExtensionContext): RouterAIModelType[] {
		return ctx.modelRegistry.getAll().filter(
			(m): m is RouterAIModelType => m.provider === PROVIDER_ID,
		);
	}

	function sessionCost(ctx: ExtensionContext): number {
		let cost = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && entry.message.role === "assistant") {
				cost += (entry.message as { usage?: { cost?: { total?: number } } }).usage?.cost?.total ?? 0;
			}
		}
		return cost;
	}

	function updateFooter(ctx: ExtensionContext) {
		const model = ctx.model;
		if (!model || model.provider !== PROVIDER_ID) {
			ctx.ui.setStatus("routerai", undefined);
			return;
		}
		const rates = `${fmtPrice(model.cost.input)}/${fmtPrice(model.cost.output)} ₽/Mtok`;
		const spent = `₽${sessionCost(ctx).toFixed(3)}`;
		ctx.ui.setStatus("routerai", ctx.ui.theme.fg("dim", `₽ ${rates} · ${spent}`));
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

					container.addChild(countLine);
					container.addChild(pinTable);
					container.addChild(listContainer);
					container.addChild(sortStatus);
					container.addChild(new Text(theme.fg("dim", `↑↓ navigate · enter select · esc cancel · ${PIN_KEY} pin/unpin · filters: ${filtersHint}`)));

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
		// Kick off a networked refresh for up-to-date prices; failures are
		// non-fatal — the restored catalog stays usable.
		ctx.modelRegistry
			.refresh({ providers: [PROVIDER_ID], force: true })
			.then((result) => {
				const error = result.errors.get(PROVIDER_ID);
				if (error) {
					ctx.ui.notify(`RouterAI price refresh failed, showing cached prices (${error.message})`, "warning");
				}
			})
			.catch((error: unknown) => {
				ctx.ui.notify(`RouterAI price refresh failed (${error instanceof Error ? error.message : String(error)})`, "warning");
			});

		updateFooter(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateFooter(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		updateFooter(ctx);
	});
}
