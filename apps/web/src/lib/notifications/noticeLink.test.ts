/**
 * A notice's link (/<lang>/chat?n=<token>) as the chat page follows it: what
 * ends up in her address bar and history, what she is told, and that one link
 * is asked about once however often the page mounts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NoticeLinkResult } from './offlineNotify';

type Mod = typeof import('./noticeLink');
let mod: Mod;
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWx';
const url = (q: string) => new URL(`https://site.test/es/chat${q}`);

function deps(answer: NoticeLinkResult | Error) {
	const log = {
		opened: [] as string[],
		goto: [] as Array<{ to: string; opts: Record<string, unknown> }>,
		toasts: [] as string[]
	};
	return {
		log,
		d: {
			lp: (p: string) => `/es${p}`,
			goto: async (to: string, opts: Record<string, unknown>) => void log.goto.push({ to, opts }),
			toast: (k: 'link_gone' | 'link_retry') => void log.toasts.push(k),
			open: async (t: string) => {
				log.opened.push(t);
				if (answer instanceof Error) throw answer;
				return answer;
			}
		}
	};
}

beforeEach(async () => {
	vi.resetModules();
	mod = await import('./noticeLink');
});

describe('a notice link on the chat page', () => {
	it('opens the conversation in place of the link (the spent token leaves history)', async () => {
		const { d, log } = deps({ kind: 'ok', peer: 'trader-joe', order: null });
		expect(await mod.followNoticeLink(url(`?n=${TOKEN}`), true, d)).toBe('opened');
		expect(log.opened).toEqual([TOKEN]);
		expect(log.goto).toEqual([{ to: '/es/chat/trader-joe', opts: { replaceState: true } }]);
		expect(log.toasts).toEqual([]);
	});

	it('scopes the thread to its order, encoded', async () => {
		const { d, log } = deps({ kind: 'ok', peer: 'trader-joe', order: 'buy blurt&x=1/../#a' });
		await mod.followNoticeLink(url(`?n=${TOKEN}`), true, d);
		expect(log.goto[0]!.to).toBe('/es/chat/trader-joe?order=buy%20blurt%26x%3D1%2F..%2F%23a');
		expect(new URL(log.goto[0]!.to, 'https://site.test').searchParams.get('order')).toBe(
			'buy blurt&x=1/../#a'
		);
		expect(log.goto[0]!.opts).toEqual({ replaceState: true });
	});

	it('a gone link: the token leaves the address bar and history, and she is told', async () => {
		const { d, log } = deps({ kind: 'gone' });
		expect(await mod.followNoticeLink(url(`?n=${TOKEN}`), true, d)).toBe('gone');
		expect(log.goto).toEqual([
			{ to: '/es/chat', opts: { replaceState: true, noScroll: true, keepFocus: true } }
		]);
		expect(log.toasts).toEqual(['link_gone']);
	});

	it('a busy or unreachable relay: the link stays in the address bar, and she is told to try again', async () => {
		for (const answer of [{ kind: 'retry' } as const, new Error('boom')]) {
			vi.resetModules();
			mod = await import('./noticeLink');
			const { d, log } = deps(answer);
			expect(await mod.followNoticeLink(url(`?n=${TOKEN}`), true, d)).toBe('retry');
			expect(log.goto).toEqual([]);
			expect(log.toasts).toEqual(['link_retry']);
		}
	});

	it('a peer that is not an account name is not followed (the token is dropped as gone)', async () => {
		for (const peer of ['/evil.example', '../settings', 'Trader', 'a', 'x?order=y']) {
			vi.resetModules();
			mod = await import('./noticeLink');
			const { d, log } = deps({ kind: 'ok', peer, order: null });
			await mod.followNoticeLink(url(`?n=${TOKEN}`), true, d);
			expect(
				log.goto.map((g) => g.to),
				peer
			).toEqual(['/es/chat']);
			expect(log.toasts).toEqual(['link_gone']);
		}
	});

	it('signed out or locked: nothing is asked and the token stays, to be opened after unlocking', async () => {
		const { d, log } = deps({ kind: 'ok', peer: 'trader-joe', order: null });
		expect(await mod.followNoticeLink(url(`?n=${TOKEN}`), false, d)).toBe('none');
		expect(log.opened).toEqual([]);
		expect(log.goto).toEqual([]);
		// After she unlocks, the same link opens.
		expect(await mod.followNoticeLink(url(`?n=${TOKEN}`), true, d)).toBe('opened');
		expect(log.opened).toEqual([TOKEN]);
	});

	it('one link is asked about once, however often the page mounts', async () => {
		const { d, log } = deps({ kind: 'ok', peer: 'trader-joe', order: null });
		await Promise.all([
			mod.followNoticeLink(url(`?n=${TOKEN}`), true, d),
			mod.followNoticeLink(url(`?n=${TOKEN}`), true, d)
		]);
		await mod.followNoticeLink(url(`?n=${TOKEN}`), true, d);
		expect(log.opened).toEqual([TOKEN]);
		expect(log.goto).toHaveLength(1);
	});

	it('no token, or not a token: nothing happens', async () => {
		const { d, log } = deps({ kind: 'ok', peer: 'trader-joe', order: null });
		for (const q of ['', '?n=', '?n=short', `?n=${TOKEN}%3Cx`, `?n=${'a'.repeat(41)}`])
			expect(await mod.followNoticeLink(url(q), true, d)).toBe('none');
		expect(log.opened).toEqual([]);
	});
});
