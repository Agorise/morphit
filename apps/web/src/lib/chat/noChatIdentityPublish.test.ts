/**
 * v1.21.14 — chat relies on the posting key only: nothing publishes (or
 * re-publishes) a chat identity any more.
 *
 * W-M7 of the full chat audit was the re-publication contest between two
 * devices of one account with different posting keys: each overwrote the
 * other's chat key at every chat opening, a network fee each time, and every
 * peer saw "safety number changed". The fix is that no code broadcasts the
 * `morphit_chat_identity_v1` op at all (ensureChatIdentity and the op's
 * broadcaster are gone); the op id is only READ — to confirm an older
 * message's chat key on chain, and to label the op in the explorer.
 *
 * Static on purpose: what is pinned is the ABSENCE of a broadcast anywhere in
 * the app, which no single module test can show.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../..', import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) sources(p, out);
		else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
	}
	return out;
}

describe('no chat identity is published', () => {
	const files = sources(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, 'utf8') }));

	it('the op id is only read: chain verification and the explorer label', () => {
		const users = files
			.filter((f) => /OP_IDS\.chatIdentity\b|['"]morphit_chat_identity_v1['"]/.test(f.text))
			.map((f) => f.rel)
			.sort();
		expect(users).toEqual([
			'lib/chat/chainVerify.ts',
			'lib/explorer/decorate.ts',
			'lib/net/config.ts'
		]);
	});

	it('nothing broadcasts it, and the publishing modules are gone', () => {
		for (const f of files) {
			expect(f.text, f.rel).not.toMatch(/broadcastCustomJson\([^)]*chatIdentity/);
			expect(f.text, f.rel).not.toMatch(/ensureChatIdentity|broadcastChatIdentity/);
		}
		expect(files.some((f) => f.rel === 'lib/chat/ensureChatIdentity.ts')).toBe(false);
		expect(files.some((f) => f.rel === 'lib/blurt/ops/chatIdentity.ts')).toBe(false);
	});
});
