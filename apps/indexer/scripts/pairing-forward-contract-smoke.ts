#!/usr/bin/env tsx
/**
 * pairing-forward-contract-smoke (v1.20.0) — cross-instance QR sign-in's paths,
 * written in four places, driven together.
 *
 *   1. THE PHONE    apps/web/src/lib/auth/pairingDelivery.ts posts to
 *                   `/v1/pairing/forward`, asks `/v1/pairing/target`, and (same
 *                   instance) posts to `/v1/login-pairing/<pid>/deliver`.
 *   2. THE MOUNTS   apps/indexer/src/main.ts mounts the forward route and the
 *                   pairing route at their prefixes.
 *   3. THE FORWARD  pairingForward.ts dials `/v1/login-pairing/<pid>/deliver`
 *                   on the target instance.
 *   4. THE PROXIES  ops/nginx/web.conf and ops/bunkerweb/frontend/nginx.conf cap
 *                   `/v1/` request bodies; the forward must fit under that cap.
 *
 * Each copy looks right alone; a moved mount would make every cross-instance
 * sign-in 404 with nothing else failing (test/api/pairingForward.test.ts mounts
 * the routes itself). So the paths are READ from 1 and 2 and then DRIVEN
 * against the real route factories mounted where main.ts mounts them, with the
 * forward's own outgoing URL fed back into the target instance.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';

import { loginPairingRoute, PairingRegistry } from '../src/api/loginPairing.ts';
import {
	FORWARD_BODY_MAX_BYTES,
	pairingForwardRoute,
	selfPairingAddresses
} from '../src/api/pairingForward.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

let scenarios = 0;
let failures = 0;
async function scenario(name: string, fn: () => Promise<void> | void): Promise<void> {
	scenarios++;
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : String(err)}`);
	}
}
function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

const main = read('apps/indexer/src/main.ts');
const web = read('apps/web/src/lib/auth/pairingDelivery.ts');
const fwdPrefix = /app\.route\(\s*'([^']+)'\s*,\s*pairingForwardApp\s*\)/.exec(main)?.[1];
const lpPrefix = /app\.route\(\s*'([^']+)'\s*,\s*loginPairingApp\s*\)/.exec(main)?.[1];
const webForward = /'(\/v1\/[a-z-]+\/forward)'/.exec(web)?.[1];
const webTarget = /`(\/v1\/[a-z-]+\/target)\?origin=/.exec(web)?.[1];
const webDeliver = /`(\/v1\/[a-z-]+\/)\$\{[^}]+\}(\/deliver)`/.exec(web);

const A_ONION = `${'a'.repeat(56)}.onion`;
const pid = randomBytes(32).toString('hex');
const delivery = {
	v: 1,
	pid,
	ephemeral_pub: randomBytes(32).toString('base64'),
	nonce: randomBytes(12).toString('base64'),
	ciphertext: randomBytes(700).toString('base64')
};

async function main_(): Promise<void> {
	console.log('\npairing-forward contract smoke:\n');

	await scenario('every path is found where it is written', () => {
		assert(fwdPrefix !== undefined, 'main.ts: app.route(<prefix>, pairingForwardApp) not found');
		assert(lpPrefix !== undefined, 'main.ts: app.route(<prefix>, loginPairingApp) not found');
		assert(webForward !== undefined, 'pairingDelivery.ts: forward path not found');
		assert(webTarget !== undefined, 'pairingDelivery.ts: target path not found');
		assert(webDeliver !== null, 'pairingDelivery.ts: same-instance deliver path not found');
	});

	// Instance A (target) and B (the phone's), each mounted exactly as main.ts
	// mounts them. B's forward dials A by handing its outgoing URL to A's app.
	const regA = new PairingRegistry();
	const regB = new PairingRegistry();
	const appA = new Hono();
	appA.route(lpPrefix ?? '/__missing', loginPairingRoute(regA));
	const dialled: string[] = [];
	const appB = new Hono();
	appB.route(lpPrefix ?? '/__missing', loginPairingRoute(regB));
	appB.route(
		fwdPrefix ?? '/__missing',
		pairingForwardRoute({
			db: {
				async query() {
					return {
						rows: [
							{
								origin: 'https://a.example',
								reg_alt_networks: { tor: A_ONION },
								last_probe_status: 'good',
								last_probed_at: null,
								registered_at_time: new Date(0),
								last_probe_error: null
							}
						]
					} as never;
				}
			},
			self: selfPairingAddresses(['https://b.example']),
			proxies: { torSocks: '127.0.0.1:9', i2pHttpProxy: '' },
			deliverLocal: (p, j, n) => regB.deliver(p, j, n),
			postHidden: async (url, body) => {
				dialled.push(url);
				const res = await appA.request(new URL(url).pathname, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				});
				return { status: res.status, body: await res.text() };
			},
			postClearnet: async () => {
				throw new Error('clearnet not expected');
			}
		})
	);

	await scenario('the phone’s preflight path reaches the forward route', async () => {
		const res = await appB.request(
			`${webTarget}?origin=${encodeURIComponent('https://a.example')}`
		);
		assert(res.status === 200, `GET ${webTarget} → ${res.status}`);
		const body = (await res.json()) as { known?: unknown };
		assert(body.known === true, `known: ${JSON.stringify(body)}`);
	});

	await scenario(
		'the phone’s forward path → B → A’s mounted deliver route → handed to A’s waiting desktop',
		async () => {
			// A's desktop is already waiting on the code it shows; a bundle for
			// a code nobody waits on is refused.
			assert(regA.register(pid, Date.now()).kind === 'waiting', 'A: register');
			const res = await appB.request(webForward ?? '/__missing', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ target: 'https://a.example', pid, delivery })
			});
			assert(res.status === 200, `POST ${webForward} → ${res.status} ${await res.text()}`);
			assert(dialled.length === 1, `dialled ${dialled.length}`);
			assert(dialled[0] === `http://${A_ONION}${lpPrefix}/${pid}/deliver`, `dialled ${dialled[0]}`);
			let got: string | null = null;
			const r = regA.setWaiter(pid, (json) => (got = json));
			assert(r === 'fired_immediately' && got !== null, `A's registry: ${r}`);
		}
	);

	await scenario(
		'the phone’s same-instance deliver path reaches the mounted deliver route',
		async () => {
			const p2 = randomBytes(32).toString('hex');
			assert(regB.register(p2, Date.now()).kind === 'waiting', 'B: register');
			const path = `${webDeliver?.[1]}${p2}${webDeliver?.[2]}`;
			const res = await appB.request(path, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...delivery, pid: p2 })
			});
			assert(res.status === 200, `POST ${path} → ${res.status}`);
		}
	);

	await scenario('both reverse proxies let a full-size forward through /v1/', () => {
		for (const f of ['ops/nginx/web.conf', 'ops/bunkerweb/frontend/nginx.conf']) {
			const conf = read(f);
			const block = /location \/v1\/ \{([\s\S]*?)\n\s*\}/.exec(conf)?.[1];
			assert(block !== undefined, `${f}: no 'location /v1/' block`);
			const m = /client_max_body_size\s+(\d+)([kKmM]?);/.exec(block);
			assert(m !== null, `${f}: /v1/ has no client_max_body_size`);
			const n = Number(m[1]) * (/k/i.test(m[2] ?? '') ? 1024 : /m/i.test(m[2] ?? '') ? 1048576 : 1);
			assert(
				n >= FORWARD_BODY_MAX_BYTES,
				`${f}: /v1/ cap ${n} < FORWARD_BODY_MAX_BYTES ${FORWARD_BODY_MAX_BYTES}`
			);
			for (const other of ['/v1/pairing', '/v1/login-pairing']) {
				assert(
					!conf.includes(`location ${other}`),
					`${f}: a dedicated ${other} block would need its own review`
				);
			}
		}
	});

	regA.close();
	regB.close();
	console.log(
		`\n${failures === 0 ? '✓ all' : '✗'} ${scenarios - failures}${failures === 0 ? '' : '/' + scenarios} pairing-forward contract scenarios passed`
	);
	process.exit(failures === 0 ? 0 : 1);
}

main_().catch((err) => {
	console.error('FATAL:', err);
	process.exit(1);
});
