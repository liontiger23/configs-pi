/**
 * Telegram Notify — one-way notifications from pi to the user's Telegram.
 *
 * Design decisions (see also the git history of this file):
 * - ONE-WAY: send only. The tool never reads Telegram, so the model cannot
 *   pull remote content into the session.
 * - BYO bot: the user creates a personal bot via BotFather; the token lives
 *   in <agent-dir>/auth.json (gitignored, 0600) under "telegram-notify".
 *   A "!command" key pulls the token from the user's keychain at use time,
 *   so the token need not be stored on disk at all.
 * - SECRETS: the tool has no token parameter; the extension command
 *   /telegram-notify-setup is the only interactive path. The model is
 *   instructed to direct the user there instead of asking for tokens in
 *   chat (chat-pasted tokens live forever in transcripts and exports).
 * - SIGNATURE: every message gets a deterministic header (hostname ·
 *   directory · session name · session id) computed by core.signature() —
 *   never by the model, so it cannot spoof or forget it.
 * - LONG TEXTS: sent as a .txt document (asDocument=true) or split into
 *   <=4096-char chunks at paragraph boundaries.
 * - LAYOUT: this directory (index.ts + core.ts) so pi loads only the
 *   factory here; core.ts stays a plain module the tests can import.
 */

import { getAgentDir, readStoredCredential, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { join } from "node:path";
import {
	AUTH_KEY,
	buildConfig,
	discoverChatId,
	markdownToTelegramHtml,
	resolveKey,
	sendDocument,
	sendText,
	signature,
	tgApi,
	writeCredential,
	type NotifyCredential,
} from "./core.ts";

const NotifyParams = Type.Object({
	action: StringEnum(["send", "status"] as const, { description: "send = deliver text to the user's Telegram; status = show configuration state" }),
	text: Type.Optional(Type.String({ description: "Message body (for action=send). GitHub-style markdown by default (bold, code, links, headers — converted automatically); use parseMode to override." })),
	parseMode: Type.Optional(StringEnum(["markdown", "none", "HTML"] as const, { description: "markdown (default): GitHub-style markdown converted to Telegram HTML. none: plain text, no conversion. HTML: raw Telegram HTML (<b>, <i>, <code>, <pre>, <a href>)." })),
	silent: Type.Optional(Type.Boolean({ description: "Deliver without notification sound (default false)" })),
	asDocument: Type.Optional(Type.Boolean({ description: "Send the text as a .txt file instead of chat messages — use for long reports/reading lists" })),
	filename: Type.Optional(Type.String({ description: "File name when asDocument=true (default: report.txt)" })),
});

function authPath(): string {
	return join(getAgentDir(), "auth.json");
}

function text_(s: string) {
	return { content: [{ type: "text" as const, text: s }] };
}

export default function telegramNotifyExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "telegram_notify",
		label: "Telegram Notify",
		description:
			"Send one-way notifications to the user's Telegram account via their personal notify bot. " +
			"Use when the user asks to 'send it to my Telegram', 'notify me', or asks for a report/summary/reading list delivered to Telegram. " +
			"Works from any network. Does NOT read or receive messages. " +
			"A signed header (hostname · directory · session name · session id) is PREPENDED AUTOMATICALLY by the tool — " +
			"do not add host/session/location information yourself. " +
			"Write the text in GitHub-style markdown (bold **x**, code `x`, fences, [links](url), headers) — it is rendered properly in Telegram; do not avoid markdown formatting. " +
			"Long texts: either use asDocument=true or send as multiple plain messages (splitting is automatic). " +
			"Never ask the user to paste a bot token in chat — direct them to /telegram-notify-setup.",
		parameters: NotifyParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.action === "status") {
				const cfg = await buildConfig(readStoredCredential(AUTH_KEY) as NotifyCredential | undefined, {
					token: process.env.TELEGRAM_NOTIFY_BOT_TOKEN,
					chatId: process.env.TELEGRAM_NOTIFY_CHAT_ID,
				});
				if ("error" in cfg) return text_(JSON.stringify({ configured: false, error: cfg.error }, null, 2));
				let botUsername = cfg.botUsername;
				if (!botUsername) {
					const me = await tgApi(cfg.token, "getMe");
					if (me.ok && typeof me.result === "object" && me.result !== null) {
						botUsername = (me.result as { username?: string }).username;
					}
				}
				return text_(
					JSON.stringify(
						{
							configured: true,
							botUsername: botUsername ? `@${botUsername.replace(/^@+/, "")}` : undefined,
							chatId: cfg.chatId,
							source: cfg.source,
						},
						null,
						2,
					),
				);
			}

			const text = params.text ?? "";
			if (text.trim().length === 0) {
				return { ...text_("text is empty; nothing to send"), isError: true };
			}

			const cfg = await buildConfig(readStoredCredential(AUTH_KEY) as NotifyCredential | undefined, {
				token: process.env.TELEGRAM_NOTIFY_BOT_TOKEN,
				chatId: process.env.TELEGRAM_NOTIFY_CHAT_ID,
			});
			if ("error" in cfg) return { ...text_(cfg.error), isError: true };

			try {
				const sessionName = ctx.sessionManager?.getSessionName?.() ?? pi.getSessionName?.();
				if (params.asDocument) {
					const filename = (params.filename ?? "report.txt").replace(/[/\\]/g, "_") || "report.txt";
					const caption = signature("none", ctx, sessionName);
					const r = await sendDocument(cfg.token, cfg.chatId, text, filename, params.silent === true, caption);
					if (!r.ok) return { ...text_(r.error!), isError: true };
					return text_(`Delivered as document ${filename} (message id ${r.messageId}) via ${cfg.botUsername?.replace(/^@+/, "") ?? "bot"}.`);
				}

				const mode = params.parseMode ?? "markdown";
				// the signature is markdown-free, so prepending before conversion is safe
				const sig = signature(mode === "markdown" ? "HTML" : mode, ctx, sessionName);
				const body = mode === "markdown" ? markdownToTelegramHtml(`${sig}\n\n${text}`) : `${sig}\n\n${text}`;
				const wireMode = mode === "markdown" ? "HTML" : mode;
				const r = await sendText(cfg.token, cfg.chatId, body, wireMode, params.silent === true);
				if (!r.ok) return { ...text_(r.error), isError: true };
				return text_(`Delivered ${r.chunks} message(s), ids ${r.messageIds.join(", ")}, via ${cfg.botUsername?.replace(/^@+/, "") ?? "bot"}.`);
			} catch (err) {
				return { ...text_(`telegram-notify failed: ${err instanceof Error ? err.message : String(err)}`), isError: true };
			}
		},
	});

	pi.registerCommand("telegram-notify-setup", {
		description: "Configure the telegram-notify bot (token + chat id, stored in auth.json)",
		getArgumentCompletions: () => [],
		handler: async (args, ctx) => {
			const argToken = args.trim();
			const stored = readStoredCredential(AUTH_KEY) as NotifyCredential | undefined;

			let token: string;
			let commandResolved = false;

			if (argToken) {
				try {
					const r = await resolveKey(argToken);
					token = r.token;
					commandResolved = r.commandResolved;
				} catch (err) {
					ctx.ui.notify(`Key error: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
			} else if (stored?.key) {
				// Re-use the existing key; still verify it works.
				try {
					const r = await resolveKey(stored.key);
					token = r.token;
					commandResolved = r.commandResolved;
				} catch (err) {
					ctx.ui.notify(`Stored key failed: ${err instanceof Error ? err.message : String(err)}`, "error");
					return;
				}
			} else {
				const raw = await ctx.ui.input("Bot token (from @BotFather)", "123456:ABC-DEF…");
				if (!raw) return;
				const r = await resolveKey(raw);
				token = r.token;
				commandResolved = r.commandResolved;
			}

			const me = await tgApi(token, "getMe");
			if (!me.ok || typeof me.result !== "object" || me.result === null) {
				ctx.ui.notify(`Token rejected by Telegram: ${me.description ?? "unknown error"}`, "error");
				return;
			}
			const botUsername = (me.result as { username?: string }).username ?? "";

			const storedChatId = stored?.chatId;
			let chatId: string;
			if (storedChatId) {
				chatId = storedChatId;
			} else {
				ctx.ui.notify(`Now send ANY message to @${botUsername} in Telegram (one message is enough).`, "info");
				ctx.ui.notify("Waiting for your message…", "info");
				const discovered = await discoverChatId(token);
				if (!discovered) {
					ctx.ui.notify("No message received within the wait window — setup cancelled.", "error");
					return;
				}
				chatId = discovered;
			}

			writeCredential(authPath(), {
				type: "bot",
				key: commandResolved ? stored?.key ?? "!command" : token,
				chatId,
				botUsername: botUsername.replace(/^@+/, ""),
			});
			ctx.ui.notify(`telegram-notify configured: @${botUsername} → chat ${chatId} (stored in auth.json, 0600).`, "info");
		},
	});
}
