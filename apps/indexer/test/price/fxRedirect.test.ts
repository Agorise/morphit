/**
 * FX fetch redirects. An upstream allowed to follow a redirect
 * (currency-api's `@latest` → dated version) follows ONE hop, by hand, and only
 * on the same host. It used to let fetch follow and check the final URL after,
 * so the request to the other host had already been made when it was rejected.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { fxGetJson } from '$indexer/fx/fetchUtil';

let other: http.Server;
let origin: http.Server;
const otherHits: string[] = [];
let otherPort = 0;
let originPort = 0;

beforeAll(async () => {
	other = http.createServer((req, res) => {
		otherHits.push(req.url ?? '');
		res.setHeader('content-type', 'application/json');
		res.end('{"rates":{"EUR":0.9}}');
	});
	await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
	otherPort = (other.address() as AddressInfo).port;
	origin = http.createServer((req, res) => {
		if (req.url === '/cross') {
			res.statusCode = 302;
			res.setHeader('location', `http://127.0.0.1:${otherPort}/exfil?from=fx`);
			res.end();
		} else if (req.url === '/same') {
			res.statusCode = 302;
			res.setHeader('location', '/dated');
			res.end();
		} else if (req.url === '/twice') {
			res.statusCode = 302;
			res.setHeader('location', '/same');
			res.end();
		} else {
			res.setHeader('content-type', 'application/json');
			res.end('{"rates":{"EUR":0.91}}');
		}
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	originPort = (origin.address() as AddressInfo).port;
});

afterAll(() => {
	other.close();
	origin.close();
});

describe('fxGetJson redirects', () => {
	it('a cross-host redirect is refused before anything is sent to the other host', async () => {
		const out = await fxGetJson(`http://127.0.0.1:${originPort}/cross`, 3000, fetch, {
			followSameHostRedirect: true
		});
		expect(out).toBeNull();
		expect(otherHits).toEqual([]);
	});

	it('a same-host redirect is followed once', async () => {
		const out = await fxGetJson(`http://127.0.0.1:${originPort}/same`, 3000, fetch, {
			followSameHostRedirect: true
		});
		expect(out).toEqual({ rates: { EUR: 0.91 } });
	});

	it('only one hop', async () => {
		const out = await fxGetJson(`http://127.0.0.1:${originPort}/twice`, 3000, fetch, {
			followSameHostRedirect: true
		});
		expect(out).toBeNull();
	});

	it('an upstream that did not opt in follows nothing', async () => {
		const out = await fxGetJson(`http://127.0.0.1:${originPort}/same`, 3000, fetch);
		expect(out).toBeNull();
	});
});
