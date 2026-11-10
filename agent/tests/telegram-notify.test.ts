/**
 * Tests for the telegram-notify extension's pure core.
 *
 * The tests import the real core module — no copy to drift. The core has no
 * value imports from the pi package, so the jiti loader never needs to
 * resolve it:
 *
 *   node --import ~/.local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-register.mjs \
 *     agent/tests/telegram-notify.test.ts
 */

import assert from "node:assert/strict";
import { homedir, hostname } from "node:os";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildConfig,
	escapeFor,
	markdownToTelegramHtml,
	sendText,
	shortenDir,
	signature,
	splitMessage,
	writeCredential,
} from "../extensions/telegram-notify/core.ts";

// ── shortenDir ──────────────────────────────────────────────────────────
assert.equal(shortenDir(homedir() + "/work/tmp/1"), "~/work/tmp/1");
assert.equal(shortenDir(homedir()), "~");
assert.equal(shortenDir("/"), "/");
assert.equal(shortenDir("/opt/very/long/nested/path/that/goes/on/and/on/forever"), "…/on/forever");

// ── escapeFor ───────────────────────────────────────────────────────────
assert.equal(escapeFor("HTML", "a<b>&c"), "a&lt;b&gt;&amp;c");
assert.equal(escapeFor("none", "a<b>&c"), "a<b>&c");
// MarkdownV2 must escape everything Telegram's parser treats specially
assert.equal(escapeFor("MarkdownV2", "1.2-3_4"), "1\\.2\\-3\\_4");

// ── signature ───────────────────────────────────────────────────────────
{
	const ctx = { sessionManager: { getCwd: () => "/work/tmp.dir", getSessionId: () => "abcdef12-3456" } };
	const sig = signature("none", ctx, undefined);
	assert.ok(sig.includes(hostname()), "signature contains hostname");
	assert.ok(sig.includes("(untitled)"), "unnamed session → (untitled)");
	assert.ok(sig.includes("abcdef12"), "signature contains 8-char session id prefix");
	assert.ok(!sig.includes("abcdef12-"), "session id is truncated to 8 chars");
	assert.equal(signature("none", ctx, "  "), sig, "blank session name → (untitled)");
	assert.equal(signature("none", ctx, "my session").includes("my session"), true);

	// parse-mode escaping applies to the whole header
	const md = signature("MarkdownV2", ctx, undefined);
	assert.ok(md.includes("\\."), "MarkdownV2 signature escapes dots (e.g. in paths)");

	// fallbacks when no sessionManager is available
	const bare = signature("none", {}, undefined);
	assert.ok(bare.includes("????????"));
	assert.ok(bare.includes(shortenDir(process.cwd())));
}

// ── splitMessage ────────────────────────────────────────────────────────
{
	assert.deepEqual(splitMessage("hello"), ["hello"]);

	const long = Array.from({ length: 30 }, (_, i) => `P${i} ${"x".repeat(300)}`).join("\n\n");
	const chunks = splitMessage(long);
	assert.ok(chunks.length > 1);
	assert.ok(chunks.every((c) => c.length <= 4096));
	assert.equal(chunks.join("\n\n"), long, "paragraph-boundary split is lossless");

	// no paragraph breaks at all → hard cut at the limit
	const flat = "y".repeat(10_000);
	assert.deepEqual(splitMessage(flat).map((c) => c.length), [4096, 4096, 1808]);

	// a >4096 first paragraph still yields chunks within the limit
	const bigPara = "a".repeat(4000) + "\n\n" + "b".repeat(200);
	assert.deepEqual(splitMessage(bigPara).map((c) => c.length), [4000, 200]);
}

// ── buildConfig ─────────────────────────────────────────────────────────
{
	const unconfigured = await buildConfig(undefined, {});
	assert.ok("error" in unconfigured);
	assert.match(unconfigured.error, /telegram-notify-setup/);

	// empty token from a !command → config error, never a throw
	const bad = await buildConfig({ key: "!exit 3" }, {});
	assert.ok("error" in bad);
	assert.match(bad.error, /key could not be resolved|empty/);

	// !command keys resolve through sh
	const ok = await buildConfig({ key: "!echo 123:abc", chatId: "42" }, {});
	assert.ok(!("error" in ok));
	assert.equal(ok.token, "123:abc");
	assert.equal(ok.source, "auth.json (command-resolved)");

	// env vars win and are reported as the source
	const env = await buildConfig({ key: "stored", chatId: "1" }, { token: "env-tok", chatId: "2" });
	assert.ok(!("error" in env));
	assert.equal(env.source, "env");
	assert.equal(env.chatId, "2");

	// token present but no chatId anywhere → actionable error
	const noChat = await buildConfig({ key: "tok" }, {});
	assert.ok("error" in noChat);
	assert.match(noChat.error, /chat id/);
}

// ── writeCredential (merge-write, preserves other entries) ──────────────
{
	const dir = mkdtempSync(join(tmpdir(), "tg-notify-test-"));
	try {
		const path = join(dir, "auth.json");
		writeFileSync(path, JSON.stringify({ existing: { key: "keep-me" } }, null, "\t") + "\n", { mode: 0o600 });
		writeCredential(path, { type: "bot", key: "new-tok", chatId: "42", botUsername: "test_bot" });
		const data = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(data.existing.key, "keep-me", "other auth.json entries survive");
		assert.equal(data["telegram-notify"].chatId, "42");

		// crash-safety: no temp files left behind
		const leftovers = readFileSync(path, "utf8");
		assert.ok(leftovers.includes("telegram-notify"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// ── markdownToTelegramHtml ───────────────────────────────────────
{
	assert.equal(markdownToTelegramHtml("**bold** and *it*"), "<b>bold</b> and <i>it</i>");
	assert.equal(markdownToTelegramHtml("see `a.b(c)` now"), "see <code>a.b(c)</code> now");
	assert.equal(markdownToTelegramHtml("[x](https://e.example)"), '<a href="https://e.example">x</a>');
	assert.equal(markdownToTelegramHtml("## Head"), "<b>Head</b>");
	assert.equal(markdownToTelegramHtml("- one\n- two"), "• one\n• two");
	// fenced code: content escaped, markers gone, inner markdown untouched
	assert.equal(markdownToTelegramHtml("```js\nif (a < b && c > d) {x()}\n```"), "<pre>if (a &lt; b &amp;&amp; c &gt; d) {x()}</pre>");
	// unclosed fence tolerated
	assert.match(markdownToTelegramHtml("text\n```\nfoo < bar"), /<pre>foo &lt; bar<\/pre>/);
	// plain HTML in source is escaped, not injected
	assert.equal(markdownToTelegramHtml("<script>x</script>"), "&lt;script&gt;x&lt;/script&gt;");
	// code content is not re-escaped (no &amp;amp;)
	assert.equal(markdownToTelegramHtml("`a & b`"), "<code>a &amp; b</code>");
	// markdown-free text passes through unchanged
	assert.equal(markdownToTelegramHtml("just words 1.2"), "just words 1.2");
	// snake_case is not italicized (no _ handling)
	assert.equal(markdownToTelegramHtml("var my_var = 1"), "var my_var = 1");
	// signature line survives conversion untouched
	assert.equal(markdownToTelegramHtml("📡 prime · ~/work/tmp-1 · (untitled) · a1b2c3d4"), "📡 prime · ~/work/tmp-1 · (untitled) · a1b2c3d4");
}

// ── sendText against a stubbed fetch (split + failure semantics) ────────
{
	// Patch globalThis.fetch for the duration of this block.
	const realFetch = globalThis.fetch;
	let calls = 0;
	const sent: unknown[] = [];
	// @ts-expect-error — test stub
	globalThis.fetch = async (_url: string, init?: { body?: string }) => {
		calls++;
		sent.push(JSON.parse(init?.body ?? "{}"));
		if (calls === 2) return { json: async () => ({ ok: false, description: "chat not found" }) };
		return { json: async () => ({ ok: true, result: { message_id: 100 + calls } }) };
	};
	try {
		const long = Array.from({ length: 30 }, (_, i) => `P${i} ${"x".repeat(200)}`).join("\n\n");
		const r = await sendText("tok", "42", long, "none", false);
		assert.equal(r.ok, false);
		assert.equal(r.chunks, 1, "failed on chunk 2 of the split");
		assert.deepEqual(r.messageIds, [101]);
		assert.equal(calls, 2);

		const good = await sendText("tok", "42", "short", "none", false);
		assert.equal(good.ok, true);
		assert.deepEqual(good.messageIds, [103]);
	} finally {
		globalThis.fetch = realFetch;
	}
}

console.log("telegram-notify core tests passed");
