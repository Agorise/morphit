/**
 * v1.21.14 full chat audit, W-M3 / W-L4 — the two chat ROUTES' read-ack
 * wiring. The behaviour itself is tested on the real modules
 * (notifications/readAckClock.test.ts for ackThreadRead,
 * components/ConversationView.auditFlows.test.ts for the conversation's own
 * acks); the routes are too large to mount, so this pins that they hand the
 * ack to those and nothing else:
 *
 *   - the inbox acks a thread (open, Mark all read, Archive) only through
 *     ackThreadRead, with the row's newest message time — never the device
 *     clock, never markConversationRead directly;
 *   - the conversation route no longer acks at load (it acked with the device
 *     clock, locally AND on chain, before a single message was shown); the
 *     view acks once its first answer is in.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const script = (src: string) => src.slice(0, src.indexOf('</script>'));
const INBOX = read('./+page.svelte');
const THREAD = read('./[peer=account]/+page.svelte');

/** Every `name(…)` call in `src`, with its argument text (balanced parens). */
function calls(src: string, name: string): string[] {
	const out: string[] = [];
	const re = new RegExp(`\\b${name}\\(`, 'g');
	for (let m = re.exec(src); m !== null; m = re.exec(src)) {
		let depth = 1;
		let i = m.index + m[0].length;
		const start = i;
		while (depth > 0 && i < src.length) {
			if (src[i] === '(') depth++;
			else if (src[i] === ')') depth--;
			i++;
		}
		out.push(src.slice(start, i - 1));
	}
	return out;
}

describe('the inbox acks through ackThreadRead, with the row’s time', () => {
	it('open, Mark all read and Archive each pass the thread’s newest message time', () => {
		const acks = calls(script(INBOX), 'ackThreadRead');
		// handleOpen, handleMarkAllRead, handleArchive.
		expect(acks).toHaveLength(3);
		expect(acks[0]).toBe('peer, orderPermlink, lastMessageAt');
		for (const a of acks.slice(1))
			expect(a).toMatch(/'fastOnly' in \w+ \? undefined : \w+\.last_message_at$/);
	});

	it('a card’s click hands handleOpen that time too (none for a push-only card)', () => {
		const opens = calls(INBOX, 'handleOpen').filter((a) => a.includes('convo.peer'));
		expect(opens).toEqual([
			"convo.peer, convo.order?.permlink ?? '', 'fastOnly' in convo ? undefined : convo.last_message_at"
		]);
	});

	it('nothing in the inbox stamps a read with the device clock', () => {
		const s = script(INBOX);
		expect(calls(s, 'markConversationRead')).toEqual([]);
		expect(calls(s, 'readAckTimestamp')).toEqual([]);
		for (const a of calls(s, 'ackThreadRead')) expect(a).not.toMatch(/new Date|Date\.now/);
	});
});

describe('the conversation route does not ack at load', () => {
	it('no local and no on-chain ack from the route', () => {
		const s = script(THREAD);
		expect(calls(s, 'markConversationRead')).toEqual([]);
		expect(calls(s, 'broadcastChatRead')).toEqual([]);
		expect(s).not.toMatch(/ops\/chatRead/);
	});
});
