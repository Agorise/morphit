/**
 * v1.20.0 (MK-H2) — the one-time check the maintainer runs on a REAL bound XMR payment
 * before pinning the treasury primary address (docs/OPERATIONS.md §40.13).
 *
 * Everything in the bound-fee path was checked offline against independent
 * code (PyPI `monero`) and against the explorer's source code — except one
 * thing that cannot be checked offline: that the explorers Morphit actually
 * uses answer, for a real transaction, exactly as their source says. This
 * runs each step against those explorers and prints what it saw:
 *
 *   1. the payment ID + integrated address the order must have been paid to;
 *   2. per explorer: /api/transaction → the encrypted payment ID, that it is
 *      the one in the transaction's extra field, and what it decrypts to with
 *      the tx key; /api/outputs?txprove=1 → the amount the tx key proves;
 *   3. the real verifier (the same code every indexer runs) → `verified`;
 *   4. the same payment claimed for ANOTHER order → `payment_id_mismatch`.
 *
 * Steps 3 and 4 decide; 1–2 are there so a failure says where it failed.
 *
 * `payToAddress` (no payment yet) prints step 1 only: where to send the test
 * payment. `runXmrUnboundFeeSelftest` checks the pre-pin path (M-X1): a plain
 * payment to the shared fee address, proven with its tx key.
 */
import { MoneroProofFeeVerifier } from '../indexer/fee/moneroProofVerifier';
import { encryptedPaymentIdsFromExtra, xmrDecryptPaymentId } from '../indexer/fee/xmrPaymentId';
import { xmrBindingFor } from '../indexer/fee/xmrBinding';
import { checkTreasuryXmrPrimaryInput } from './treasuryXmrPrimaryInput';
import { xmrIntegratedAddress } from '@morphit/release-schema';
import { moneroTxHash, scanRawTxForAddress } from '../indexer/fee/xmrRawTx';
import { parseXmrExplorer } from '../config/xmrExplorers';

export interface XmrFeeSelftestOptions {
	readonly txid: string;
	readonly txKey: string;
	readonly account: string;
	readonly permlink: string;
	readonly primary: string;
	readonly piconero: bigint;
	readonly explorers: readonly string[];
}

const HEX64 = /^[0-9a-f]{64}$/;

async function postJson(
	fetchImpl: typeof fetch,
	url: string,
	payload: unknown
): Promise<{ status: number; body: unknown }> {
	const res = await fetchImpl(url, {
		method: 'POST',
		headers: { accept: 'application/json', 'content-type': 'application/json' },
		body: JSON.stringify(payload)
	});
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	return { status: res.status, body };
}

async function getJson(
	fetchImpl: typeof fetch,
	url: string
): Promise<{ status: number; body: unknown }> {
	const res = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' } });
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	return { status: res.status, body };
}

/** Where the test payment for (account, permlink) must go. */
export function xmrSelftestPayTo(
	primary: string,
	account: string,
	permlink: string
): string | null {
	const p = checkTreasuryXmrPrimaryInput(primary);
	if (!p.ok) return null;
	const b = xmrBindingFor(p.address, account, permlink);
	return b === null ? null : xmrIntegratedAddress(p.address, b.paymentId);
}

/** Pre-pin (unbound) path: the tx key must prove the amount at `feeAddress`
 *  on every explorer. True only on `verified`. */
export async function runXmrUnboundFeeSelftest(
	o: {
		txid: string;
		txKey: string;
		feeAddress: string;
		piconero: bigint;
		explorers: readonly string[];
	},
	fetchImpl: typeof fetch,
	print: (line: string) => void
): Promise<boolean> {
	const txid = o.txid.trim().toLowerCase();
	const txKey = o.txKey.trim().toLowerCase();
	if (!HEX64.test(txid) || !HEX64.test(txKey)) {
		print('✗ The txid and the tx key must each be 64 hex characters.');
		return false;
	}
	const verifier = new MoneroProofFeeVerifier(
		{
			feeAddress: o.feeAddress,
			explorerUrls: o.explorers,
			minConfirmations: 1,
			requestTimeoutMs: 20_000,
			minSuccessfulResponses: o.explorers.length
		},
		fetchImpl
	);
	const r = await verifier.verify({
		feeMethod: 'xmr',
		expectedAmount: o.piconero,
		externalTxId: txid,
		txProof: null,
		txKey,
		xmrBinding: null,
		permlink: 'selftest',
		signer: 'selftest'
	});
	print(
		`Unbound fee to ${o.feeAddress.slice(0, 12)}… (all ${o.explorers.length} explorers must agree):`
	);
	print(
		`   ${r.kind}${r.kind === 'verified' ? ` — ${r.observedAmount} piconero` : ` — ${r.reason}`}`
	);
	print(r.kind === 'verified' ? '✓ PASS' : '✗ FAIL');
	return r.kind === 'verified';
}

/** Returns true only when the real verifier verified the payment for its
 *  order AND refused it for another order. */
export async function runXmrFeeSelftest(
	o: XmrFeeSelftestOptions,
	fetchImpl: typeof fetch,
	print: (line: string) => void
): Promise<boolean> {
	const txid = o.txid.trim().toLowerCase();
	const txKey = o.txKey.trim().toLowerCase();
	if (!HEX64.test(txid)) {
		print('✗ The txid must be 64 hex characters.');
		return false;
	}
	if (!HEX64.test(txKey)) {
		print('✗ The tx key must be 64 hex characters (monero-wallet-cli: get_tx_key <txid>).');
		return false;
	}
	const primary = checkTreasuryXmrPrimaryInput(o.primary);
	if (!primary.ok) {
		print(`✗ Treasury main address: ${primary.message}`);
		return false;
	}
	if (o.explorers.length === 0 || o.explorers.some((u) => parseXmrExplorer(u) === null)) {
		print('✗ Give at least one explorer, each https:// (or raw-tx+https://, node+https://)');
		return false;
	}
	const binding = xmrBindingFor(primary.address, o.account, o.permlink)!;
	print('');
	print('1. The order this payment is for');
	print(`   order        : ${o.account}/${o.permlink}`);
	print(`   payment ID   : ${binding.paymentId}`);
	print(`   pay-to       : ${xmrIntegratedAddress(primary.address, binding.paymentId)}`);
	print("   (the wallet's history must show the payment went to exactly this address)");

	print('');
	print('2. What each explorer says');
	for (const spec of o.explorers) {
		const ex = parseXmrExplorer(spec)!;
		const base = ex.base;
		print(`   ${spec}`);
		if (ex.kind === 'raw-tx' || ex.kind === 'node') {
			// (wave 4) raw transaction, checked HERE: hash, outputs, commitments.
			// (v1.20.2) A node gives the same JSON through POST /get_transactions.
			try {
				let txData: unknown;
				let prunableHash: string | undefined;
				if (ex.kind === 'node') {
					const t = await postJson(fetchImpl, `${base}/get_transactions`, {
						txs_hashes: [txid],
						decode_as_json: true,
						prune: false
					});
					const d =
						(t.body as {
							status?: unknown;
							untrusted?: unknown;
							txs?: {
								tx_hash?: unknown;
								as_json?: unknown;
								prunable_hash?: unknown;
								in_pool?: unknown;
								confirmations?: unknown;
							}[];
							missed_tx?: unknown[];
						} | null) ?? null;
					const e = Array.isArray(d?.txs) ? d!.txs!.find((x) => x?.tx_hash === txid) : undefined;
					if (t.status !== 200 || d?.status !== 'OK' || d.untrusted === true || e === undefined) {
						print(
							`     node             : no usable answer (HTTP ${t.status}, status ${String(d?.status)}${d?.untrusted === true ? ', still syncing' : ''}${Array.isArray(d?.missed_tx) && d!.missed_tx!.includes(txid) ? ', transaction not found' : ''})`
						);
						continue;
					}
					try {
						txData = JSON.parse(String(e.as_json));
					} catch {
						print('     node             : its transaction JSON does not parse');
						continue;
					}
					prunableHash = typeof e.prunable_hash === 'string' ? e.prunable_hash : undefined;
					print(
						`     confirmations    : ${e.in_pool === true ? '0 (still in the pool)' : String(e.confirmations ?? '?')}`
					);
				} else {
					const t = await getJson(fetchImpl, `${base}/api/get_transaction_data/${txid}`);
					const d = (t.body as { status?: unknown; transaction_data?: unknown } | null) ?? null;
					if (t.status !== 200 || d?.status !== 'OK') {
						print(
							`     raw transaction  : no usable answer (HTTP ${t.status}, status ${String(d?.status)})`
						);
						continue;
					}
					txData = d.transaction_data;
				}
				const hashOk = moneroTxHash(txData, prunableHash) === txid;
				print(
					`     content hashes to the txid: ${hashOk ? 'yes' : 'NO — the explorer served other content'}`
				);
				const scan = scanRawTxForAddress(txData, txKey, {
					viewPub: binding.viewPub,
					spendPub: primary.spendPub
				});
				if ('error' in scan) {
					print(`     outputs          : ${scan.error}`);
				} else {
					print(
						`     proven amount    : ${scan.amount} piconero (outputs ${scan.outputs.join(', ') || 'none'}; commitments open)`
					);
					const dec = scan.encryptedPaymentIds[0]
						? xmrDecryptPaymentId(binding.viewPub, txKey, scan.encryptedPaymentIds[0])
						: null;
					print(
						`     decrypts to      : ${dec ?? '—'} ${dec === binding.paymentId ? '✓ this order' : '✗ not this order'}`
					);
				}
			} catch (e) {
				print(`     raw transaction  : failed (${e instanceof Error ? e.message : String(e)})`);
			}
			continue;
		}
		try {
			const t = await getJson(fetchImpl, `${base}/api/transaction/${txid}`);
			const d = (t.body as { status?: unknown; data?: Record<string, unknown> } | null) ?? null;
			if (t.status !== 200 || d?.status !== 'success' || d.data === undefined) {
				print(
					`     /api/transaction : no usable answer (HTTP ${t.status}, status ${String(d?.status)})`
				);
			} else {
				const enc = typeof d.data.payment_id8 === 'string' ? d.data.payment_id8 : '(field missing)';
				const extra = typeof d.data.extra === 'string' ? d.data.extra : '';
				const inExtra = extra === '' ? null : encryptedPaymentIdsFromExtra(extra);
				const dec = /^[0-9a-f]{16}$/i.test(enc)
					? xmrDecryptPaymentId(binding.viewPub, txKey, enc)
					: null;
				print(`     payment_id8      : ${enc === '' ? '(empty — no payment ID in this tx)' : enc}`);
				print(
					`     in tx extra      : ${inExtra === null ? '(no extra returned)' : inExtra.includes(enc) ? 'yes' : 'NO — explorer field does not match the raw tx'}`
				);
				print(
					`     decrypts to      : ${dec ?? '—'} ${dec === binding.paymentId ? '✓ this order' : '✗ not this order'}`
				);
				print(`     confirmations    : ${String(d.data.confirmations ?? '?')}`);
			}
		} catch (e) {
			print(`     /api/transaction : failed (${e instanceof Error ? e.message : String(e)})`);
		}
		try {
			const params = new URLSearchParams({
				txhash: txid,
				address: primary.address,
				viewkey: txKey,
				txprove: '1'
			});
			const r = await getJson(fetchImpl, `${base}/api/outputs?${params}`);
			const d = (r.body as { status?: unknown; data?: { outputs?: unknown } } | null) ?? null;
			const outs = Array.isArray(d?.data?.outputs)
				? (d!.data!.outputs as { amount?: unknown; match?: unknown }[])
				: null;
			if (r.status !== 200 || d?.status !== 'success' || outs === null) {
				print(
					`     /api/outputs     : no usable answer (HTTP ${r.status}, status ${String(d?.status)})`
				);
			} else {
				let sum = 0n;
				for (const x of outs) {
					if (x.match === true && (typeof x.amount === 'number' || typeof x.amount === 'string'))
						sum += BigInt(x.amount);
				}
				print(
					`     proven amount    : ${sum} piconero (${outs.filter((x) => x.match === true).length} matching output(s))`
				);
			}
		} catch (e) {
			print(`     /api/outputs     : failed (${e instanceof Error ? e.message : String(e)})`);
		}
	}

	const verifier = new MoneroProofFeeVerifier(
		{
			feeAddress: primary.address,
			explorerUrls: o.explorers,
			minConfirmations: 1,
			requestTimeoutMs: 20_000,
			minSuccessfulResponses: o.explorers.length
		},
		fetchImpl
	);
	const claim = (account: string, permlink: string) => ({
		feeMethod: 'xmr' as const,
		expectedAmount: o.piconero,
		externalTxId: txid,
		txProof: null,
		txKey,
		xmrBinding: xmrBindingFor(primary.address, account, permlink),
		permlink,
		signer: account
	});
	const own = await verifier.verify(claim(o.account, o.permlink));
	print('');
	print(
		`3. Indexer verdict for ${o.account}/${o.permlink} (all ${o.explorers.length} explorers must agree)`
	);
	print(`   ${own.kind}${own.kind === 'verified' ? '' : ` — ${own.reason}`}`);
	const other = await verifier.verify(claim(o.account, `${o.permlink}-copy`));
	print('');
	print(`4. The same payment claimed for another order (${o.account}/${o.permlink}-copy)`);
	print(`   ${other.kind}${other.kind === 'verified' ? '' : ` — ${other.reason}`}`);
	const ok =
		own.kind === 'verified' && other.kind === 'rejected' && other.reason === 'payment_id_mismatch';
	print('');
	print(
		ok
			? '✓ PASS — bound XMR fees work with these explorers.'
			: '✗ FAIL — do NOT pin the primary address yet.'
	);
	return ok;
}
