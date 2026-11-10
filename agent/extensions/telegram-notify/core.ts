/**
 * Telegram Notify — pure core (no pi imports, unit-testable via jiti).
 *
 * The extension shell (`telegram-notify.ts`) wires this into pi: the tool,
 * the /telegram-notify-setup command, and credential storage in
 * `<agent-dir>/auth.json`. Secrets never appear in this repo — the shell
 * passes the credential in, and this module only ever returns/redacts it.
 */

import { execFile } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const AUTH_KEY = "telegram-notify";
export const MAX_MESSAGE = 4096;

export interface NotifyCredential {
	type?: string;
	key?: string;
	chatId?: string;
	botUsername?: string;
}

export interface ResolvedConfig {
	token: string;
	chatId: string;
	botUsername?: string;
	source: "env" | "auth.json (plain)" | "auth.json (command-resolved)";
}

export type SendReport =
	| { ok: true; messageIds: number[]; chunks: number }
	| { ok: false; messageIds: number[]; chunks: number; error: string };

// ── Signature ──────────────────────────────────────────────────────────
// Every notification is stamped with deterministic origin metadata,
// computed HERE (never by the model): hostname, working directory,
// session name, session id — so messages are attributable at a glance
// and the model cannot spoof or forget them.

export function shortenDir(cwd: string): string {
	const home = homedir();
	let dir = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
	if (dir.length > 30) {
		const parts = dir.split("/").filter(Boolean);
		dir = `…/${parts.slice(-2).join("/")}`;
	}
	return dir || "/";
}

export function escapeFor(mode: "none" | "HTML" | "MarkdownV2", s: string): string {
	if (mode === "HTML") return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	if (mode === "MarkdownV2") return s.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
	return s;
}

export interface SignatureSource {
	getCwd?: () => string;
	getSessionId?: () => string;
}

export function signature(
	mode: "none" | "HTML" | "MarkdownV2",
	ctx: { sessionManager?: SignatureSource },
	sessionName: string | undefined,
): string {
	const cwd = ctx.sessionManager?.getCwd?.() ?? process.cwd();
	const sid = ctx.sessionManager?.getSessionId?.()?.slice(0, 8) ?? "????????";
	const name = sessionName?.trim() || "(untitled)";
	return escapeFor(mode, `📡 ${hostname()} · ${shortenDir(cwd)} · ${name} · ${sid}`);
}

// ── Credential resolution ──────────────────────────────────────────────

export async function resolveKey(raw: string): Promise<{ token: string; commandResolved: boolean }> {
	if (raw.startsWith("!")) {
		const { stdout } = await execFileP("sh", ["-c", raw.slice(1)], { timeout: 10_000 });
		const token = stdout.trim();
		if (!token) throw new Error(`key command produced empty output: ${raw.slice(1)}`);
		return { token, commandResolved: true };
	}
	return { token: raw.trim(), commandResolved: false };
}

/**
 * Merge the stored credential with environment overrides into a usable
 * config, or a user-facing error the agent may relay verbatim.
 */
export async function buildConfig(
	cred: NotifyCredential | undefined,
	env: { token?: string; chatId?: string },
): Promise<ResolvedConfig | { error: string }> {
	if (env.token && env.chatId) {
		return { token: env.token.trim(), chatId: env.chatId.trim(), source: "env" };
	}
	if (!cred || !cred.key) {
		return {
			error:
				"telegram-notify is not configured. Tell the user to run /telegram-notify-setup (interactive pi) " +
				"or set TELEGRAM_NOTIFY_BOT_TOKEN + TELEGRAM_NOTIFY_CHAT_ID env vars. " +
				"NEVER ask them to paste a bot token into the chat — it would be stored in the session transcript.",
		};
	}

	let resolved: { token: string; commandResolved: boolean };
	try {
		resolved = await resolveKey(cred.key);
	} catch (err) {
		return {
			error:
				`telegram-notify key could not be resolved (${err instanceof Error ? err.message : String(err)}). ` +
				"Tell the user to check the !command in their auth.json or re-run /telegram-notify-setup.",
		};
	}
	if (!resolved.token) {
		return { error: "telegram-notify key resolved to an empty token. Tell the user to re-run /telegram-notify-setup." };
	}
	if (!cred.chatId && !env.chatId) {
		return {
			error:
				"telegram-notify has a token but no chat id. Tell the user to re-run /telegram-notify-setup " +
				"(they must send at least one message to the bot first) or set TELEGRAM_NOTIFY_CHAT_ID.",
		};
	}
	return {
		token: resolved.token,
		chatId: (env.chatId ?? cred.chatId ?? "").trim(),
		botUsername: cred.botUsername,
		source: env.token ? "env" : resolved.commandResolved ? "auth.json (command-resolved)" : "auth.json (plain)",
	};
}

/**
 * Merge-write the telegram-notify entry into an auth.json, preserving every
 * other entry (pi itself stores provider credentials there). Atomic replace,
 * 0600, same directory. Synchronous on purpose: partial writes must never be
 * observable.
 */
export function writeCredential(authPath: string, cred: NotifyCredential): void {
	let data: Record<string, unknown> = {};
	try {
		data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
	} catch {
		data = {};
	}
	data[AUTH_KEY] = cred;
	const tmp = join(authPath, "..", ".auth.json.telegram-notify.tmp");
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(data, null, "\t") + "\n");
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, authPath);
}

// ── Telegram API ───────────────────────────────────────────────────────

export async function tgApi(
	token: string,
	method: string,
	body?: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; description?: string; error_code?: number }> {
	const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	return (await res.json()) as { ok: boolean; result?: unknown; description?: string; error_code?: number };
}

/**
 * Convert GitHub-style markdown (what models naturally emit) to the subset of
 * HTML Telegram accepts: bold, italic, inline code, fenced code blocks, links,
 * headers → bold lines, dash bullets → •. Everything else passes through.
 * Unbalanced fences are tolerated (closed at end of text).
 */
export function markdownToTelegramHtml(md: string): string {
	// 1. extract fenced code blocks (before any escaping), placeholders keep positions
	const blocks: string[] = [];
	let s = md.replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_m, code: string) => {
		blocks.push(code.replace(/\n$/, ""));
		return `\u0000B${blocks.length - 1}\u0000`;
	});
	// unclosed fence: treat the rest as a code block
	const open = s.indexOf("```");
	if (open !== -1) {
		blocks.push(s.slice(open + 3).replace(/^[a-zA-Z0-9_-]*\n?/, ""));
		s = s.slice(0, open) + `\u0000B${blocks.length - 1}\u0000`;
	}

	// 2. escape HTML in the remaining text
	s = s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

	// 3. inline code (content already HTML-escaped; restore as-is to avoid double escaping)
	const codes: string[] = [];
	s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => {
		codes.push(c);
		return `\u0000C${codes.length - 1}\u0000`;
	});

	// 4. links, bold, italic, headers, bullets
	s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
	s = s.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
	s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
	s = s.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");
	s = s.replace(/^(\s*)[-*]\s+/gm, "$1• ");

	// 5. restore: code blocks were captured pre-escape → escape now; inline code already escaped
	s = s.replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => `<code>${codes[+i]}</code>`);
	s = s.replace(/\u0000B(\d+)\u0000/g, (_m, i: string) => {
		const esc = blocks[+i].replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		return `<pre>${esc}</pre>`;
	});
	return s;
}

/** Split text into <=limit chunks, preferring paragraph, then line, boundaries. */
export function splitMessage(text: string, limit = MAX_MESSAGE): string[] {
	if (text.length <= limit) return [text];
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		let cut = rest.lastIndexOf("\n\n", limit);
		if (cut < limit * 0.3) cut = rest.lastIndexOf("\n", limit);
		if (cut < limit * 0.3) cut = limit;
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n+/, "");
	}
	if (rest.length > 0) chunks.push(rest);
	return chunks;
}

export async function sendText(
	token: string,
	chatId: string,
	text: string,
	parseMode: "none" | "HTML" | "MarkdownV2",
	silent: boolean,
): Promise<SendReport> {
	const chunks = splitMessage(text);
	const messageIds: number[] = [];
	for (let i = 0; i < chunks.length; i++) {
		const body: Record<string, unknown> = {
			chat_id: chatId,
			text: chunks[i],
			disable_notification: silent,
		};
		if (parseMode !== "none") body.parse_mode = parseMode;
		const r = await tgApi(token, "sendMessage", body);
		if (!r.ok || typeof r.result !== "object" || r.result === null) {
			return {
				ok: false,
				messageIds,
				chunks: i,
				error: `Telegram API error on chunk ${i + 1}/${chunks.length}: ${r.description ?? "unknown"}`,
			};
		}
		const result = r.result as { message_id?: number };
		if (typeof result.message_id === "number") messageIds.push(result.message_id);
	}
	return { ok: true, messageIds, chunks: chunks.length };
}

export async function sendDocument(
	token: string,
	chatId: string,
	text: string,
	filename: string,
	silent: boolean,
	caption?: string,
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
	const form = new FormData();
	form.append("chat_id", chatId);
	form.append("caption", caption ?? filename);
	form.append("disable_notification", String(silent));
	form.append(
		"document",
		new Blob([text], { type: "text/plain; charset=utf-8" }),
		filename,
	);
	const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
	const r = (await res.json()) as { ok: boolean; result?: { message_id?: number }; description?: string };
	if (!r.ok) return { ok: false, error: `Telegram API error: ${r.description ?? "unknown"}` };
	return { ok: true, messageId: r.result?.message_id };
}

/** Poll getUpdates briefly for the first chat that messaged the bot. */
export async function discoverChatId(token: string, waitMs = 30_000): Promise<string | undefined> {
	const deadline = Date.now() + waitMs;
	while (Date.now() < deadline) {
		const r = await tgApi(token, "getUpdates", { timeout: 5, allowed_updates: ["message"] });
		if (r.ok && Array.isArray(r.result)) {
			const updates = r.result as Array<{ message?: { chat?: { id?: number | string } } }>;
			for (const u of updates) {
				const id = u.message?.chat?.id;
				if (id !== undefined) return String(id);
			}
		}
	}
	return undefined;
}
