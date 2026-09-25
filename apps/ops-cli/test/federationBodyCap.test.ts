/**
 * Morphit ops CLI — the federation batch-size check in `morphit-ops doctor`.
 *
 * WHAT THIS PROTECTS, AND WHY IT IS A TEST RATHER THAN A DOC LINE.
 *
 * Federated chat groups messages when a peer is already busy, because one
 * connection over Tor or I2P completes one round trip at a time. A full group is
 * a couple of hundred kilobytes; every other endpoint on this service takes a
 * few. So a reverse proxy configured for the rest of the API rejects the group
 * before the indexer ever sees it — and nothing errors, single messages keep
 * working, and chat only goes slow when the instance is BUSY, which is when
 * nobody is reading logs.
 *
 * An operator upgrading from an older release keeps their proxy config by
 * definition, so that is the DEFAULT state of an upgrade rather than an unlucky
 * one. Hence a check that tries it for real.
 *
 * The case that matters most here is the last one: the check must go through the
 * PUBLIC origin. Probing loopback would skip the proxy and pass on a box that is
 * misconfigured — a check that cannot fail, which is worse than no check at all.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkFederationBodyCap } from '../src/commands/doctor.ts';

/** A morphit.env holding just the origin keys this check reads. */
function envWith(lines: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'morphit-doctor-'));
	const p = join(dir, 'morphit.env');
	writeFileSync(p, lines, 'utf8');
	return p;
}

interface Seen {
	url: string;
	bytes: number;
}

/** Install a fetch that answers with `status` and records what it was asked. */
function stubFetch(status: number, seen: Seen[]): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string, init?: { body?: string }) => {
			seen.push({ url: String(url), bytes: (init?.body ?? '').length });
			return { status } as unknown as Response;
		})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('doctor — federation batch size', () => {
	it('reports a proxy that refuses the batch, and names the fix', async () => {
		// The whole point. 413 is what an un-updated nginx answers, and the
		// operator needs to be told which setting, not merely that something is
		// wrong.
		const seen: Seen[] = [];
		stubFetch(413, seen);
		const r = await checkFederationBodyCap(envWith('MORPHIT_INSTANCE_ORIGIN=https://example.test\n'), null);
		expect(r.level).toBe('warn');
		expect(r.detail).toMatch(/client_max_body_size/);
		expect(r.detail).toMatch(/slow under load/i);
	});

	it('passes when the body gets through, even though the indexer refuses it', async () => {
		// A 400 is the EXPECTED answer: the payload is deliberately not a real
		// transaction, so the indexer rejects it on contents. That the rejection
		// happened at all proves the bytes arrived, which is the only thing under
		// test. Reading 400 as a failure would make this check cry wolf on every
		// correctly configured instance.
		const seen: Seen[] = [];
		stubFetch(400, seen);
		const r = await checkFederationBodyCap(envWith('MORPHIT_INSTANCE_ORIGIN=https://example.test\n'), null);
		expect(r.level).toBe('ok');
	});

	it('sends a body big enough to trip the small default and small enough to be harmless', async () => {
		// Below the 4 KB read default it would pass against a misconfigured proxy;
		// near the 256 KB federation cap it would be a rude thing for a diagnostic
		// to send.
		const seen: Seen[] = [];
		stubFetch(400, seen);
		await checkFederationBodyCap(envWith('MORPHIT_INSTANCE_ORIGIN=https://example.test\n'), null);
		expect(seen[0]?.bytes).toBeGreaterThan(4096);
		expect(seen[0]?.bytes).toBeLessThan(262144);
	});

	it('goes through the PUBLIC origin and never loopback', async () => {
		// The assertion this file exists for. A loopback probe bypasses the proxy
		// entirely, so it would report "all clear" on exactly the box that has the
		// problem — a check that cannot fail.
		const seen: Seen[] = [];
		stubFetch(400, seen);
		await checkFederationBodyCap(envWith('MORPHIT_INSTANCE_ORIGIN=https://example.test\n'), null);
		expect(seen[0]?.url).toBe('https://example.test/v1/federation/chat-fast');
		expect(seen[0]?.url).not.toMatch(/127\.0\.0\.1|localhost|\[::1\]/);
	});

	it('derives the site origin from the indexer origin when only that is set', async () => {
		// A common deployment serves the indexer from indexer.<domain> while peers
		// push to the site. Probing the indexer host would test a different proxy
		// path from the one a peer actually uses.
		const seen: Seen[] = [];
		stubFetch(400, seen);
		await checkFederationBodyCap(
			envWith('MORPHIT_INDEXER_PUBLIC_ORIGIN=https://indexer.example.test\n'),
			null
		);
		expect(seen[0]?.url).toBe('https://example.test/v1/federation/chat-fast');
	});

	it('says it could not check, rather than guessing, when the origin is unknown', async () => {
		const seen: Seen[] = [];
		stubFetch(400, seen);
		const r = await checkFederationBodyCap(envWith('# nothing here\n'), null);
		expect(r.level).toBe('warn');
		expect(r.detail).toMatch(/could not determine/i);
		expect(seen).toHaveLength(0);
	});

	it('says it could not check when NEITHER the public origin nor the front end answers', async () => {
		// Both unreachable is the genuinely unknown case, and it must not be
		// reported as a finding about the proxy — doing so would train operators
		// to ignore this line.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => {
				throw new Error('getaddrinfo ENOTFOUND');
			})
		);
		const r = await checkFederationBodyCap(
			envWith('MORPHIT_INSTANCE_ORIGIN=http://abc.onion\n'),
			null
		);
		expect(r.level).toBe('warn');
		expect(r.detail).toMatch(/could not reach/i);
		expect(r.detail).toMatch(/MORPHIT_ONION_FRONTEND_PORT/);
		expect(r.detail).not.toMatch(/client_max_body_size/);
	});
});

/**
 * THE PRIVACY-ONLY PATH, which used to be checked by giving up.
 *
 * An instance whose only addresses are a `.onion` and a `.b32.i2p` cannot
 * resolve its own origin from its own host, so the public-origin probe always
 * failed and the check always ended "could not verify". The operators who
 * depend on federated chat MOST were the ones whose configuration nobody
 * looked at.
 *
 * Tor and i2pd do not deliver to the indexer directly — they hand a request to
 * a local front end (`HiddenServicePort 80 127.0.0.1:8090`). Asking THAT is not
 * the loopback shortcut this check warns about: the front end is the proxy, so
 * the request crosses the same server block, the same location match and the
 * same body limit a peer's push does. It is the only honest way to check the
 * path these instances actually use.
 */
describe('doctor — federation batch size on a privacy-only instance', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	/** Public origin unreachable; the local front end answers with `status`. */
	function stubUnresolvableOriginWithFrontend(status: number, seen: string[]): void {
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string) => {
				seen.push(url);
				if (!url.startsWith('http://127.0.0.1:')) throw new Error('getaddrinfo ENOTFOUND');
				return { status, ok: status < 400 } as Response;
			})
		);
	}

	it('checks the hidden-service front end when the public origin is unresolvable', async () => {
		const seen: string[] = [];
		stubUnresolvableOriginWithFrontend(400, seen);
		const r = await checkFederationBodyCap(
			envWith('MORPHIT_INSTANCE_ORIGIN=http://abc.onion\n'),
			null
		);
		expect(r.level).toBe('ok');
		expect(r.detail).toMatch(/privacy-only/i);
		expect(r.detail).toMatch(/hidden-service front end/i);
		// v1.18.0 review (O1): the ONION IS NEVER FETCHED. This test used to
		// assert that it was tried first — and a plain fetch of an onion origin
		// asks the system resolver for the onion name, which on a tor-only home
		// server is the ISP's: the one link tor-only mode exists to hide. There
		// is nothing a hidden origin can say over that path but "no".
		expect(
			seen.some((u) => u.includes('.onion')),
			'the onion origin was sent to the system resolver'
		).toBe(false);
		expect(seen).toEqual(['http://127.0.0.1:8090/v1/federation/chat-fast']);
	});

	it('the same for an I2P or Lokinet origin', async () => {
		for (const origin of ['http://abc.b32.i2p', 'http://morphit.i2p', 'http://morphit.loki']) {
			const seen: string[] = [];
			stubUnresolvableOriginWithFrontend(400, seen);
			await checkFederationBodyCap(envWith(`MORPHIT_INSTANCE_ORIGIN=${origin}\n`), null);
			expect(seen, `${origin} was fetched directly`).toEqual([
				'http://127.0.0.1:8090/v1/federation/chat-fast'
			]);
			vi.unstubAllGlobals();
		}
	});

	it('reports a 413 from the front end as the finding it is', async () => {
		const seen: string[] = [];
		stubUnresolvableOriginWithFrontend(413, seen);
		const r = await checkFederationBodyCap(
			envWith('MORPHIT_INSTANCE_ORIGIN=http://abc.onion\n'),
			null
		);
		expect(r.level).toBe('warn');
		expect(r.detail).toMatch(/hidden-service front end/i);
		expect(r.detail).toMatch(/client_max_body_size 256k/);
	});

	it('honours MORPHIT_ONION_FRONTEND_PORT for a front end that listens elsewhere', async () => {
		const seen: string[] = [];
		stubUnresolvableOriginWithFrontend(400, seen);
		await checkFederationBodyCap(
			envWith('MORPHIT_INSTANCE_ORIGIN=http://abc.onion\nMORPHIT_ONION_FRONTEND_PORT=9099\n'),
			null
		);
		expect(seen[0]).toBe('http://127.0.0.1:9099/v1/federation/chat-fast');
	});

	/**
	 * The front end is NOT consulted when the public origin answered. A
	 * clearnet instance whose proxy refuses batches must go on failing this
	 * check — a fallback that can rescue a real finding is worse than no
	 * fallback, because it turns a check into reassurance.
	 */
	it('does not fall back when the public origin answered 413', async () => {
		const seen: Seen[] = [];
		stubFetch(413, seen);
		const r = await checkFederationBodyCap(
			envWith('MORPHIT_INSTANCE_ORIGIN=https://morphit.io\n'),
			null
		);
		expect(r.level).toBe('warn');
		expect(seen).toHaveLength(1);
		expect(seen[0]?.url).toBe('https://morphit.io/v1/federation/chat-fast');
	});
});
