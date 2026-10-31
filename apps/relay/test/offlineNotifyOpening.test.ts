/**
 * Offline notices — the relay started before the indexer's v71 migration had
 * run (an upgrade restarts both, in no set order): the store cannot open yet
 * (42P01), offline notices are off — and come on by themselves once the
 * migration has run, without a restart (notify/opening.ts). On a real
 * Postgres (TEST_DATABASE_URL; skipped without), the real endpoints, a
 * stand-in homeserver.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { PrivateKey } from '@beblurt/dblurt';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '../src/log/index.ts';
import { notifyLimits, OfflineNotifyEndpoints } from '../src/notify/api.ts';
import type { NotifyConfig } from '../src/notify/config.ts';
import type { OfflineNotifyStore } from '../src/notify/store.ts';
import { keepOpening, openOfflineNotify } from '../src/notify/opening.ts';
import { NotifySigVerifier, notifyCanonical, notifyPayload } from '../src/notify/sig.ts';
import { Presence } from '../src/notify/worker.ts';
import { DB_TESTS, notifyDb, schemaFrom, schemaSection } from './notifyDb.ts';
import { fakeHomeserver } from './notifyFakes.ts';

const AUDIENCE = 'site-relay';
const key = PrivateKey.fromSeed('opening-site-owner');
const OP = '@op:example.org';

const closing: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const c of closing.splice(0).reverse()) await c().catch(() => undefined);
});

const silent: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const notYet = () =>
	Promise.reject(Object.assign(new Error('relation does not exist'), { code: '42P01' }));

describe('offline notices: trying again to open the store', () => {
	it('stop() ends the tries (the relay shutting down)', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		let calls = 0;
		const opening = keepOpening(
			() => (calls++, notYet()),
			() => undefined,
			silent,
			[50]
		);
		await opening.first;
		opening.stop();
		// Long past the next try's time: none was made.
		await vi.advanceTimersByTimeAsync(300);
		expect(calls).toBe(1);
		vi.useRealTimers();
	});

	it('stopped while a try is under way: what it opens is not used', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		let calls = 0;
		let opened = 0;
		let release!: () => void;
		const opening = keepOpening(
			async () => {
				calls++;
				if (calls === 1) return notYet();
				await new Promise<void>((r) => (release = r));
				return {} as OfflineNotifyStore;
			},
			() => opened++,
			silent,
			[50]
		);
		await opening.first;
		await vi.advanceTimersByTimeAsync(50); // the second try starts…
		expect(calls).toBe(2);
		opening.stop(); // …the relay stops…
		release(); // …and then that try opens the store.
		await vi.advanceTimersByTimeAsync(300);
		expect(opened).toBe(0);
		expect(calls).toBe(2);
		vi.useRealTimers();
	});

	it('a try waiting for its turn does not keep the relay process alive', () => {
		// A process with nothing to do but the next try (in a minute) ends now.
		const opening = join(import.meta.dirname, '../src/notify/opening.ts');
		const t0 = Date.now();
		const r = spawnSync(
			join(import.meta.dirname, '../../../node_modules/.bin/tsx'),
			[
				'-e',
				`import(${JSON.stringify(opening)}).then((m) => { m.keepOpening(() => Promise.reject(Object.assign(new Error('x'), { code: '42P01' })), () => undefined, { debug() {}, info() {}, warn() {}, error() {} }, [60000]); console.log('waiting'); });`
			],
			{ encoding: 'utf8', timeout: 20_000 }
		);
		expect(r.stdout).toContain('waiting');
		expect(r.status).toBe(0);
		expect(Date.now() - t0).toBeLessThan(15_000);
	}, 30_000);
});

describe.skipIf(!DB_TESTS)('offline notices: the store opens once the migration has run', () => {
	it('half a v71 (its table, not its queue column): not opened (42703)', async () => {
		const v71 = schemaSection(71);
		const tableOnly = v71.slice(0, v71.indexOf('ALTER TABLE offline_notify_leave'));
		const d = await notifyDb({ sql: `${schemaSection(69)}\n${schemaSection(70)}\n${tableOnly}` });
		closing.push(() => d.close());
		const err = await d.open().then(
			() => 'opened',
			(e: { code?: string }) => e.code
		);
		expect(err).toBe('42703');
	});

	it('fails with 42P01 first, is tried again, and notices then work without a restart', async () => {
		// The database as the indexer left it before v71: v69 and v70 only.
		const d = await notifyDb({ sql: `${schemaSection(69)}\n${schemaSection(70)}` });
		closing.push(() => d.close());
		const hs = await fakeHomeserver({ autoJoin: [OP] });
		closing.push(() => hs.close());
		const cfg: NotifyConfig = {
			siteName: 'Test Site',
			audience: AUDIENCE,
			linkOrigin: 'https://site.example',
			linkOrigins: { clearnet: null, tor: null, i2p: null, loki: null },
			policy: { torSocks: '', hiddenOnly: false },
			email: null,
			matrix: { homeserver: hs.url, accessToken: hs.token, userId: hs.bot },
			xmpp: null,
			telegram: null,
			session: null,
			off: {}
		};
		const logged: Array<{ level: string; event: string; ctx?: Record<string, unknown> }> = [];
		const log: Logger = {
			debug: (event, ctx) => logged.push({ level: 'debug', event, ctx }),
			info: (event, ctx) => logged.push({ level: 'info', event, ctx }),
			warn: (event, ctx) => logged.push({ level: 'warn', event, ctx }),
			error: (event, ctx) => logged.push({ level: 'error', event, ctx })
		};
		const app = new Hono();
		const endpoints = new OfflineNotifyEndpoints(
			cfg,
			null,
			new NotifySigVerifier(
				{ postingKeyAgreed: async () => ({ key: key.createPublic('BLT').toString() }) },
				AUDIENCE
			),
			new Presence(),
			notifyLimits(),
			{ codeAnswerMs: 500 }
		);
		endpoints.register(app);
		const set = async () => {
			const fields = { channel: 'matrix', address: OP, locale: 'en', net: 'clearnet' };
			const timestamp = Math.floor(Date.now() / 1000);
			const nonce = randomBytes(16).toString('hex');
			const digest = createHash('sha256')
				.update(
					notifyCanonical('set', AUDIENCE, 'owner', nonce, notifyPayload('set', fields), timestamp),
					'utf8'
				)
				.digest();
			const r = await app.request('/v1/notify/set', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					...fields,
					account: 'owner',
					nonce,
					timestamp,
					signature: key.sign(digest).toString()
				})
			});
			return ((await r.json()) as { status: string }).status;
		};
		const stored = async () =>
			((await (await app.request('/v1/notify/channels')).json()) as { stored: boolean }).stored;

		let opened = 0;
		let tries = 0;
		let triesWhenOpened = 0;
		const opening = keepOpening(
			() => (tries++, openOfflineNotify(d.db, d.dataDir, cfg, log)),
			(store) => {
				opened++;
				triesWhenOpened = tries;
				endpoints.useStore(store);
			},
			log,
			[100]
		);
		closing.push(async () => opening.stop());
		await opening.first;
		expect(opened).toBe(0);
		expect(await stored()).toBe(false);
		expect(await set()).toBe('offline_notify_unavailable');
		const off = logged.filter((l) => l.event === 'offline_notify_unavailable');
		expect(off).toHaveLength(1);
		expect(String(off[0]!.ctx?.hint)).toMatch(/42P01.*tries again by itself/);
		// Tried again, quietly (the same reason is not logged again).
		await vi.waitFor(() => expect(tries).toBeGreaterThanOrEqual(3));
		expect(opened).toBe(0);
		expect(logged.filter((l) => l.event === 'offline_notify_unavailable')).toHaveLength(1);

		// The indexer's v71 migration lands.
		await d.admin.query(schemaFrom(71));
		await vi.waitFor(() => expect(opened).toBe(1), { timeout: 3000 });
		expect(logged.some((l) => l.event === 'offline_notify_on')).toBe(true);
		expect(await stored()).toBe(true);
		expect(await set()).toBe('code_sent');
		await vi.waitFor(() => expect(hs.made()).toBe(1));
		const room = [...hs.rooms.values()][0]!;
		expect(room.messages.at(-1)?.body).toMatch(/\b\d{6}\b/);
		// Once open, it is not tried again (all the while the code went out).
		expect(tries).toBe(triesWhenOpened);
		expect(opened).toBe(1);
	}, 30_000);

	it('nothing to open (no app set up, nothing saved): not tried again', async () => {
		const d = await notifyDb();
		closing.push(() => d.close());
		const cfg = {
			siteName: 'x',
			audience: AUDIENCE,
			linkOrigin: null,
			linkOrigins: { clearnet: null, tor: null, i2p: null, loki: null },
			policy: { torSocks: '', hiddenOnly: false },
			email: null,
			matrix: null,
			xmpp: null,
			telegram: null,
			session: null,
			off: {}
		} as NotifyConfig;
		let calls = 0;
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const opening = keepOpening(
			() => {
				calls++;
				return openOfflineNotify(d.db, d.dataDir, cfg, silent);
			},
			() => {
				throw new Error('nothing should open');
			},
			silent,
			[50]
		);
		await opening.first;
		await vi.advanceTimersByTimeAsync(250);
		vi.useRealTimers();
		expect(calls).toBe(1);
		opening.stop();
	});
});
