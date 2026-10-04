/**
 * BTC/XMR fee explorers: no redirects followed, bodies capped, and the
 * BTC quorum defaults to two agreeing explorers.
 *
 * Before: one hostile explorer (any of the defaults, compromised, or one an
 * operator added) marked any BTC fee paid on its own word; a 302 sent the
 * indexer — and, on the XMR txprove path, the payer's tx key — to any host,
 * internal ones included, whose JSON was then accepted; a 64 MiB answer was
 * read whole.
 *
 * Real verifiers, real HTTP servers on loopback.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { BitcoinExplorerFeeVerifier } from '$indexer/fee/bitcoinExplorerVerifier';
import { MoneroProofFeeVerifier } from '$indexer/fee/moneroProofVerifier';
import { loadConfig } from '$config';

const FEE = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const TXID = 'a'.repeat(64);
const XMR =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
const BOMB = 24 * 1024 * 1024;

interface Srv {
	url: string;
	server: http.Server;
}
async function serve(h: http.RequestListener): Promise<Srv> {
	const server = http.createServer(h);
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
	return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server };
}
function close(...ss: Srv[]): void {
	for (const s of ss) {
		s.server.closeAllConnections?.();
		s.server.close();
	}
}

/** A server that answers every request with a BOMB-byte JSON body, counting
 *  what it managed to send before the client went away. */
async function bomber(): Promise<Srv & { sent: () => number }> {
	let sent = 0;
	const srv = await serve((_req, res) => {
		res.setHeader('content-type', 'application/json');
		res.write('{"txid":"');
		const chunk = 'A'.repeat(1 << 20);
		let n = 0;
		const pump = (): void => {
			while (n < BOMB) {
				if (res.destroyed) return;
				n += chunk.length;
				sent += chunk.length;
				if (!res.write(chunk)) {
					res.once('drain', pump);
					return;
				}
			}
			res.end('"}');
		};
		res.on('close', () => undefined);
		pump();
	});
	return { ...srv, sent: () => sent };
}

/** An explorer that proves anything for /api/tx and redirects everything
 *  else to `internal`; and the internal service, which records what reaches it. */
async function hostileAndInternal(): Promise<{ hostile: Srv; internal: Srv; hits: string[] }> {
	const hits: string[] = [];
	const internal = await serve((req, res) => {
		hits.push(`${req.method} ${req.url}`);
		res.setHeader('content-type', 'application/json');
		res.end(
			JSON.stringify({
				status: 'success',
				data: {
					tx_hash: TXID,
					outputs: [{ amount: 999_999_999_999, match: true }],
					tx_confirmations: 50
				},
				chain_stats: { funded_txo_sum: 99_999_999 },
				mempool_stats: { funded_txo_sum: 0 }
			})
		);
	});
	const hostile = await serve((req, res) => {
		const u = req.url ?? '';
		if (u === `/api/tx/${TXID}`) {
			res.setHeader('content-type', 'application/json');
			res.end(
				JSON.stringify({
					txid: TXID,
					vout: [{ value: 1_000_000, scriptpubkey_address: FEE }],
					status: { confirmed: true, block_height: 1 }
				})
			);
			return;
		}
		const q = u.indexOf('?');
		res.writeHead(302, { location: `${internal.url}/internal-admin${q >= 0 ? u.slice(q) : ''}` });
		res.end();
	});
	return { hostile, internal, hits };
}

describe('fee explorers are not trusted further than their own answer', () => {
	it('the shipped BTC quorum is two agreeing explorers', () => {
		const saved = { ...process.env };
		Object.assign(process.env, {
			MORPHIT_INDEXER_DATABASE_URL: 'postgres://unused@localhost/unused',
			MORPHIT_INDEXER_RELAY_ACCOUNT: 'morphit-relay',
			MORPHIT_INDEXER_FEE_RECIPIENT: 'morphit-fees',
			MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
			MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
			MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
				'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9'
		});
		delete process.env.MORPHIT_INDEXER_BTC_MIN_SUCCESSFUL_RESPONSES;
		try {
			expect(loadConfig().btcMinSuccessfulResponses).toBe(2);
		} finally {
			process.env = saved;
		}
	});

	const btcClaim = {
		feeMethod: 'btc',
		expectedAmount: 416,
		externalTxId: TXID,
		txProof: null,
		permlink: 'p',
		signer: 's'
	} as never;
	const xmrClaim = {
		feeMethod: 'xmr',
		externalTxId: TXID,
		txKey: 'b'.repeat(64),
		expectedAmount: 781_250_000n,
		permlink: 'p'
	} as never;
	const btc = (urls: string[], quorum: number) =>
		new BitcoinExplorerFeeVerifier({
			feeAddress: FEE,
			explorerUrls: urls,
			minConfirmations: 1,
			requestTimeoutMs: 10_000,
			minSuccessfulResponses: quorum
		});
	const xmr = (target: string) =>
		new MoneroProofFeeVerifier(
			{
				feeAddress: XMR,
				explorerUrls: ['https://explorer.example'],
				minConfirmations: 1,
				requestTimeoutMs: 10_000,
				minSuccessfulResponses: 1
			},
			((u: string | URL, init?: RequestInit) =>
				fetch(String(u).replace('https://explorer.example', target), init)) as typeof fetch
		);

	it('one hostile explorer alone cannot mark a BTC fee paid under the shipped quorum', async () => {
		const { hostile, internal } = await hostileAndInternal();
		const honest = await serve((_req, res) => {
			res.writeHead(404);
			res.end();
		});
		try {
			const r = await btc([`${hostile.url}/api`, `${honest.url}/api`], 2).verify(btcClaim);
			expect(r.kind).not.toBe('verified');
		} finally {
			close(hostile, internal, honest);
		}
	});

	it('a BTC explorer redirect is not followed: the internal host is never asked, nothing counts as paid', async () => {
		const { hostile, internal, hits } = await hostileAndInternal();
		try {
			const r = await btc([`${hostile.url}/api`], 1).checkAddressPayment(
				'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
				416
			);
			expect(hits, hits.join(' | ')).toEqual([]);
			expect(r.kind).not.toBe('paid');
		} finally {
			close(hostile, internal);
		}
	});

	it('a BTC explorer answer past the size cap is refused without reading it whole', async () => {
		const b = await bomber();
		try {
			const r = await btc([`${b.url}/api`], 1).verify(btcClaim);
			expect(r.kind).not.toBe('verified');
			expect(b.sent(), 'the whole oversized answer was read').toBeLessThan(BOMB / 2);
		} finally {
			close(b);
		}
	});

	it('an XMR explorer redirect is not followed: the payer\u2019s tx key never reaches another host', async () => {
		const { hostile, internal, hits } = await hostileAndInternal();
		try {
			const r = await xmr(hostile.url).verify(xmrClaim);
			expect(hits, 'the internal host was asked (with the tx key)').toEqual([]);
			expect(r.kind).not.toBe('verified');
		} finally {
			close(hostile, internal);
		}
	});

	it('an XMR explorer answer past the size cap is refused without reading it whole', async () => {
		const b = await bomber();
		try {
			const r = await xmr(b.url).verify(xmrClaim);
			expect(r.kind).not.toBe('verified');
			expect(b.sent(), 'the whole oversized answer was read').toBeLessThan(BOMB / 2);
		} finally {
			close(b);
		}
	});
});
