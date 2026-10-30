/**
 * fetchRegisteredTag — what `edit` → Operator tag reads to keep the tag the
 * account registered on chain. It asked only a fixed http://127.0.0.1:8081,
 * so on a node whose indexer listens elsewhere (indexer.env
 * MORPHIT_INDEXER_LISTEN_HOST/_PORT) it never found the registered tag, and
 * `edit` offered to change a tag the chain will not let change. It now asks
 * where the rest of the CLI asks (localIndexerBases), within one bounded wait.
 * A stand-in indexer on loopback plays this node's indexer.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchRegisteredTag } from '../src/lib/operatorTagGuard.ts';

const servers: Server[] = [];
let root = '';

/** A stand-in for /v1/operators; `hang` takes the request and never answers. */
async function indexer(opts: { hang?: boolean } = {}): Promise<string> {
	const s = createServer((req, res) => {
		if (opts.hang) return;
		if (req.url === '/v1/operators') {
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({ operators: [{ account: 'alice', tag: 'alice-node' }] }));
			return;
		}
		res.statusCode = 404;
		res.end('{}');
	});
	servers.push(s);
	await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
	return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'morphit-tagguard-'));
	mkdirSync(join(root, 'etc', 'morphit'), { recursive: true });
	vi.stubEnv('MORPHIT_ENV_ROOT', root);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const s of servers.splice(0)) {
		s.closeAllConnections();
		await new Promise((r) => s.close(r));
	}
	rmSync(root, { recursive: true, force: true });
});

describe('fetchRegisteredTag', () => {
	it("reads the tag from this node's indexer at the address indexer.env gives", async () => {
		const base = await indexer();
		const port = new URL(base).port;
		writeFileSync(
			join(root, 'etc', 'morphit', 'indexer.env'),
			`MORPHIT_INDEXER_LISTEN_HOST=127.0.0.1\nMORPHIT_INDEXER_LISTEN_PORT=${port}\n`
		);
		expect(await fetchRegisteredTag('alice', { timeoutMs: 3_000 })).toBe('alice-node');
		expect(await fetchRegisteredTag('bob', { timeoutMs: 3_000 })).toBeNull();
	});

	it('an address that takes the request and never answers cannot stretch the wait past the limit', async () => {
		const hung = [await indexer({ hang: true }), await indexer({ hang: true })];
		const started = Date.now();
		expect(
			await fetchRegisteredTag('alice', { bases: [...hung, hung[0]!], timeoutMs: 1_000 })
		).toBeNull();
		expect(Date.now() - started).toBeLessThan(1_800);
	});

	it('an address that is not the indexer is passed over for the next one', async () => {
		const notIt = createServer((_q, r) => {
			r.statusCode = 404;
			r.end('not here');
		});
		servers.push(notIt);
		await new Promise<void>((r) => notIt.listen(0, '127.0.0.1', r));
		const other = `http://127.0.0.1:${(notIt.address() as AddressInfo).port}`;
		const good = await indexer();
		expect(await fetchRegisteredTag('alice', { bases: [other, good], timeoutMs: 3_000 })).toBe(
			'alice-node'
		);
	});
});
