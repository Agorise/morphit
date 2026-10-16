/**
 * The access log must never write down anything from an offline-notice
 * answer.
 *
 * The access log copies a response's `code` (or `status`) into each line, for
 * triage. Settings → Offline Notifications answers "Connect Telegram" with the
 * 8-digit code she is about to send the bot — in a field named `code`. Copied
 * into the log, anyone who can read it inside the next fifteen minutes could
 * send that code to the bot first and have her notices delivered to THEIR
 * Telegram. So nothing is read from the body of a /v1/notify answer; other
 * routes keep their triage code.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const lines: Array<Record<string, unknown>> = [];
vi.mock('$log', () => {
	const rec =
		(level: string) =>
		(msg: string, ctx: Record<string, unknown> = {}): void => {
			lines.push({ level, msg, ...ctx });
		};
	return {
		logger: () => ({
			info: rec('info'),
			warn: rec('warn'),
			error: rec('error'),
			debug: rec('debug')
		})
	};
});

const { accessLog } = await import('../src/middleware/access_log.ts');

describe('access log × offline notices', () => {
	const app = new Hono();
	app.use('*', accessLog());
	app.post('/v1/notify/set', (c) =>
		c.json({ status: 'telegram_code', code: '48201937', bot: 'VigilanteTradingBot' })
	);
	app.post('/v1/notify/verify', (c) => c.json({ status: 'wrong' }, 400));
	app.post('/v1/other', (c) => c.json({ code: 'invite_used' }, 409));

	it('never logs the Telegram code, nor anything else from a notice answer', async () => {
		await app.request('/v1/notify/set', { method: 'POST' });
		await app.request('/v1/notify/verify', { method: 'POST' });
		const notice = lines.filter((l) => String(l.path).startsWith('/v1/notify/'));
		expect(notice).toHaveLength(2);
		expect(JSON.stringify(notice)).not.toContain('48201937');
		expect(notice.every((l) => !('code' in l))).toBe(true);
		// The line is still there: method, path, status, duration.
		expect(notice.map((l) => [l.path, l.status])).toEqual([
			['/v1/notify/set', 200],
			['/v1/notify/verify', 400]
		]);
	});

	it('other routes keep their triage code', async () => {
		await app.request('/v1/other', { method: 'POST' });
		expect(lines.at(-1)).toMatchObject({ path: '/v1/other', status: 409, code: 'invite_used' });
	});
});
