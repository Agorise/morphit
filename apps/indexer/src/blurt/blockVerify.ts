/**
 * Morphit indexer — full block verification, REPORT-ONLY (v1.20.2, E1).
 *
 * WHY. Every block this indexer applies comes from ONE RPC endpoint (the pool
 * picks it). A hostile endpoint can serve a block whose transactions it made
 * up. v1.20.0 bounded the damage (signatures checked where it matters; keys
 * confirmed by two operators; fee-relevant blocks confirmed by two operators),
 * but nothing checks that a block's CONTENT is the block the chain has. The
 * chain itself makes that checkable from the block alone:
 *
 *   1. MERKLE ROOT. Each transaction's digest is sha256 of the SIGNED
 *      transaction (steem/libraries/protocol/transaction.cpp
 *      signed_transaction::merkle_digest); digests are hashed in pairs with
 *      sha256 (an odd last one is carried up unhashed) until one is left, and
 *      the root is ripemd160 of it (block.cpp calculate_merkle_root). An empty
 *      block's root is 20 zero bytes. It must equal the header's
 *      `transaction_merkle_root`.
 *   2. BLOCK ID. sha224 of the signed header (previous, timestamp, witness,
 *      transaction_merkle_root, extensions, witness_signature), first 20 bytes,
 *      with the first 4 replaced by the block number big-endian (block.cpp
 *      signed_block_header::id). It must equal the served `block_id`.
 *   3. LINKS. Block n's `previous` must be the id COMPUTED for block n−1.
 * With 1–3 a window of blocks is one hash chain: anchoring its LAST id with
 * two independent operators then proves every block in it.
 *
 * WHY REPORT-ONLY. The recomputation needs every Blurt operation serialized
 * byte-exactly (dblurt's serializers; Blurt forked Steem 0.23 and changed its
 * operations). That could not be checked against real blocks where this was
 * written, and getting it wrong in ENFORCING mode would make every node refuse
 * real blocks. So v1.20.2 only COUNTS: matches, mismatches by kind, and
 * operations it cannot serialize (by name). A transaction's recomputed id is
 * also compared with the id the node served, which separates "this indexer
 * cannot serialize that operation yet" from a real mismatch. `morphit-ops
 * health` shows the counts; once live nodes show zero mismatches over every
 * kind of block, a later release enforces it (with the two-operator anchor).
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Types } from '@beblurt/dblurt';

import { logger } from '../log/index';

const log = logger('block-verify');

// The same ByteBuffer build dblurt's serializers write into (they call its
// writeVString / writeVarint32 / …), resolved from dblurt's own install rather
// than declared again here.
const requireFromDblurt = createRequire(createRequire(import.meta.url).resolve('@beblurt/dblurt'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ByteBuffer: any = requireFromDblurt('bytebuffer/dist/bytebuffer');

const HEX20 = /^[0-9a-f]{40}$/i;
const HEX65 = /^[0-9a-f]{130}$/i;

function sha256(b: Uint8Array): Buffer {
	return createHash('sha256').update(b).digest();
}

function varint(n: number): Buffer {
	const out: number[] = [];
	let v = n >>> 0;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v >>>= 7;
	}
	out.push(v);
	return Buffer.from(out);
}

interface TxLike {
	readonly ref_block_num?: unknown;
	readonly ref_block_prefix?: unknown;
	readonly expiration?: unknown;
	readonly operations?: unknown;
	readonly extensions?: unknown;
	readonly signatures?: unknown;
}

export class UnsupportedBlockContent extends Error {
	constructor(
		readonly what: string,
		message: string
	) {
		super(message);
		this.name = 'UnsupportedBlockContent';
	}
}

/** The transaction's bytes WITHOUT signatures (what its id hashes). Throws
 *  UnsupportedBlockContent naming the operation dblurt cannot serialize. */
export function transactionBytes(tx: TxLike): Buffer {
	const buf = new ByteBuffer(ByteBuffer.DEFAULT_CAPACITY, ByteBuffer.LITTLE_ENDIAN);
	const ops = Array.isArray(tx.operations) ? (tx.operations as unknown[]) : null;
	if (ops === null) throw new UnsupportedBlockContent('transaction', 'no operations array');
	try {
		Types.Transaction(buf, {
			ref_block_num: tx.ref_block_num,
			ref_block_prefix: tx.ref_block_prefix,
			expiration: tx.expiration,
			operations: ops,
			extensions: Array.isArray(tx.extensions) ? tx.extensions : []
		});
	} catch (err) {
		// dblurt prefixes the failing operation's name ("vote: …", "No
		// serializer for operation: foo").
		const msg = err instanceof Error ? err.message : String(err);
		const m = /No serializer for operation: ([\w]+)/.exec(msg) ?? /^([a-z_]+):/.exec(msg);
		throw new UnsupportedBlockContent(m?.[1] ?? 'transaction', msg);
	}
	buf.flip();
	return Buffer.from(buf.toBuffer());
}

/** The chain's transaction id (hex, 40): sha256(transaction bytes)[0..20]. */
export function transactionId(tx: TxLike): string {
	return sha256(transactionBytes(tx)).subarray(0, 20).toString('hex');
}

/** signed_transaction::merkle_digest — sha256 over the transaction bytes, then
 *  the signatures (a vector of 65-byte compact signatures). */
export function transactionMerkleDigest(tx: TxLike): Buffer {
	const sigs = Array.isArray(tx.signatures) ? (tx.signatures as unknown[]) : [];
	const parts: Buffer[] = [transactionBytes(tx), varint(sigs.length)];
	for (const s of sigs) {
		if (typeof s !== 'string' || !HEX65.test(s)) {
			throw new UnsupportedBlockContent('signature', 'a signature is not 65 bytes of hex');
		}
		parts.push(Buffer.from(s, 'hex'));
	}
	return sha256(Buffer.concat(parts));
}

/** block.cpp calculate_merkle_root, over already-computed digests. PURE. */
export function merkleRootOfDigests(digests: readonly Buffer[]): string {
	if (digests.length === 0) return '0'.repeat(40);
	let ids = [...digests];
	let n = ids.length;
	while (n > 1) {
		const iMax = n - (n & 1);
		const next: Buffer[] = [];
		for (let i = 0; i < iMax; i += 2) next.push(sha256(Buffer.concat([ids[i]!, ids[i + 1]!])));
		if (n & 1) next.push(ids[iMax]!);
		ids = next;
		n = next.length;
	}
	return createHash('ripemd160').update(ids[0]!).digest('hex');
}

/** A Steem `version` string ("0.23.0") as its packed uint32. */
function packedVersion(v: unknown): number {
	if (typeof v !== 'string')
		throw new UnsupportedBlockContent('extension', 'version is not a string');
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,5})$/.exec(v);
	if (!m) throw new UnsupportedBlockContent('extension', `version "${v}"`);
	return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | Number(m[3])) >>> 0;
}

function u32(n: number): Buffer {
	const b = Buffer.alloc(4);
	b.writeUInt32LE(n >>> 0);
	return b;
}

function secondsOf(ts: unknown): number {
	if (typeof ts !== 'string')
		throw new UnsupportedBlockContent('header', 'timestamp is not a string');
	const t = Date.parse(ts.endsWith('Z') ? ts : `${ts}Z`);
	if (!Number.isFinite(t)) throw new UnsupportedBlockContent('header', `timestamp "${ts}"`);
	return Math.floor(t / 1000);
}

/** One header extension, condenser form `[index, value]` (static_variant):
 *  0 void_t, 1 version, 2 hardfork_version_vote {hf_version, hf_time}. */
function extensionBytes(e: unknown): Buffer {
	if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'number') {
		throw new UnsupportedBlockContent('extension', 'not an [index, value] pair');
	}
	const [idx, val] = e as [number, unknown];
	if (idx === 0) return varint(0);
	if (idx === 1) return Buffer.concat([varint(1), u32(packedVersion(val))]);
	if (idx === 2) {
		const v = val as { hf_version?: unknown; hf_time?: unknown } | null;
		return Buffer.concat([
			varint(2),
			u32(packedVersion(v?.hf_version)),
			u32(secondsOf(v?.hf_time))
		]);
	}
	throw new UnsupportedBlockContent('extension', `header extension type ${idx}`);
}

export interface BlockLike {
	readonly previous?: unknown;
	readonly timestamp?: unknown;
	readonly witness?: unknown;
	readonly transaction_merkle_root?: unknown;
	readonly extensions?: unknown;
	readonly witness_signature?: unknown;
	readonly block_id?: unknown;
	readonly transactions?: unknown;
	readonly transaction_ids?: unknown;
}

/** signed_block_header::id, computed. Throws UnsupportedBlockContent. */
export function computeBlockId(block: BlockLike): string {
	const prev = block.previous;
	const root = block.transaction_merkle_root;
	const sig = block.witness_signature;
	if (typeof prev !== 'string' || !HEX20.test(prev)) {
		throw new UnsupportedBlockContent('header', 'previous is not 20 bytes of hex');
	}
	if (typeof root !== 'string' || !HEX20.test(root)) {
		throw new UnsupportedBlockContent('header', 'transaction_merkle_root is not 20 bytes of hex');
	}
	if (typeof sig !== 'string' || !HEX65.test(sig)) {
		throw new UnsupportedBlockContent('header', 'witness_signature is not 65 bytes of hex');
	}
	if (typeof block.witness !== 'string') throw new UnsupportedBlockContent('header', 'no witness');
	const exts = Array.isArray(block.extensions) ? (block.extensions as unknown[]) : [];
	const witness = Buffer.from(block.witness, 'utf8');
	const bytes = Buffer.concat([
		Buffer.from(prev, 'hex'),
		u32(secondsOf(block.timestamp)),
		varint(witness.length),
		witness,
		Buffer.from(root, 'hex'),
		varint(exts.length),
		...exts.map(extensionBytes),
		Buffer.from(sig, 'hex')
	]);
	const h = createHash('sha224').update(bytes).digest().subarray(0, 20);
	const num = Buffer.from(prev, 'hex').readUInt32BE(0) + 1;
	h.writeUInt32BE(num >>> 0, 0);
	return h.toString('hex');
}

export type BlockCheck =
	| { readonly kind: 'match'; readonly id: string }
	| {
			readonly kind: 'merkle_mismatch' | 'id_mismatch';
			readonly id: string | null;
			readonly detail: string;
	  }
	/** The node's transaction ids differ from the ones recomputed here: this
	 *  indexer's serialization, not (necessarily) the block, is at fault. */
	| { readonly kind: 'txid_mismatch'; readonly index: number; readonly ops: readonly string[] }
	| { readonly kind: 'unsupported'; readonly what: string; readonly detail: string };

/** Check one block on its own (1 + 2 of the header). PURE (hashing only). */
export function checkBlock(block: BlockLike): BlockCheck {
	try {
		const txs = Array.isArray(block.transactions) ? (block.transactions as TxLike[]) : [];
		const served = Array.isArray(block.transaction_ids)
			? (block.transaction_ids as unknown[])
			: null;
		const digests: Buffer[] = [];
		for (let i = 0; i < txs.length; i++) {
			const tx = txs[i]!;
			if (served !== null) {
				const want = served[i];
				if (typeof want === 'string' && transactionId(tx) !== want.toLowerCase()) {
					const ops = Array.isArray(tx.operations)
						? (tx.operations as unknown[]).map((o) =>
								Array.isArray(o) && typeof o[0] === 'string' ? o[0] : '?'
							)
						: [];
					return { kind: 'txid_mismatch', index: i, ops };
				}
			}
			digests.push(transactionMerkleDigest(tx));
		}
		const root = merkleRootOfDigests(digests);
		const servedRoot =
			typeof block.transaction_merkle_root === 'string'
				? block.transaction_merkle_root.toLowerCase()
				: '';
		if (root !== servedRoot) {
			return {
				kind: 'merkle_mismatch',
				id: null,
				detail: `computed ${root}, header says ${servedRoot}`
			};
		}
		const id = computeBlockId(block);
		const servedId = typeof block.block_id === 'string' ? block.block_id.toLowerCase() : '';
		if (servedId !== '' && id !== servedId) {
			return { kind: 'id_mismatch', id, detail: `computed ${id}, node says ${servedId}` };
		}
		return { kind: 'match', id };
	} catch (err) {
		if (err instanceof UnsupportedBlockContent) {
			return { kind: 'unsupported', what: err.what, detail: err.message };
		}
		return {
			kind: 'unsupported',
			what: 'unknown',
			detail: err instanceof Error ? err.message : String(err)
		};
	}
}

export interface BlockVerifyStats {
	readonly mode: 'report-only';
	readonly since: string;
	readonly checked: number;
	readonly matched: number;
	readonly merkleMismatch: number;
	readonly idMismatch: number;
	readonly linkMismatch: number;
	readonly linksChecked: number;
	/** Transactions whose recomputed id differs from the node's, by the
	 *  operation names they carry (a serializer gap here, not a forgery). */
	readonly txidMismatch: Readonly<Record<string, number>>;
	/** Content this indexer cannot serialize yet, by operation / part. */
	readonly unsupported: Readonly<Record<string, number>>;
	readonly lastBlock: number | null;
	/** The first few problems, for the journal and `morphit-ops health`. */
	readonly firstProblems: readonly { block: number; kind: string; detail: string }[];
}

/**
 * Watches every block the poller applies, in order. Never throws and never
 * changes what is applied: it counts.
 */
export class BlockVerifyMonitor {
	private checked = 0;
	private matched = 0;
	private merkleMismatch = 0;
	private idMismatch = 0;
	private linkMismatch = 0;
	private linksChecked = 0;
	private readonly txidMismatch = new Map<string, number>();
	private readonly unsupported = new Map<string, number>();
	private readonly problems: { block: number; kind: string; detail: string }[] = [];
	private lastBlock: number | null = null;
	private lastId: string | null = null;
	private readonly since = new Date().toISOString();
	private lastSummaryAt = Date.now();

	constructor(
		private readonly opts: {
			readonly summaryEveryBlocks?: number;
			readonly summaryEveryMs?: number;
		} = {}
	) {}

	private problem(block: number, kind: string, detail: string): void {
		if (this.problems.length < 10) {
			this.problems.push({ block, kind, detail: detail.slice(0, 300) });
			log.warn('block_verify_problem', { block, kind, detail: detail.slice(0, 300) });
		}
	}

	observe(n: number, block: BlockLike | null | undefined): void {
		try {
			if (block === null || block === undefined) return;
			this.checked++;
			const r = checkBlock(block);
			// 3. the link to the block before, when this monitor saw it
			const prev = typeof block.previous === 'string' ? block.previous.toLowerCase() : null;
			if (this.lastBlock === n - 1 && this.lastId !== null && prev !== null) {
				this.linksChecked++;
				if (prev !== this.lastId) {
					this.linkMismatch++;
					this.problem(
						n,
						'link_mismatch',
						`previous ${prev}, computed id of ${n - 1} is ${this.lastId}`
					);
				}
			}
			switch (r.kind) {
				case 'match':
					this.matched++;
					break;
				case 'merkle_mismatch':
					this.merkleMismatch++;
					this.problem(n, r.kind, r.detail);
					break;
				case 'id_mismatch':
					this.idMismatch++;
					this.problem(n, r.kind, r.detail);
					break;
				case 'txid_mismatch': {
					const key = [...new Set(r.ops)].sort().join('+') || '?';
					this.txidMismatch.set(key, (this.txidMismatch.get(key) ?? 0) + 1);
					this.problem(n, r.kind, `transaction ${r.index} (${key})`);
					break;
				}
				case 'unsupported':
					this.unsupported.set(r.what, (this.unsupported.get(r.what) ?? 0) + 1);
					if ((this.unsupported.get(r.what) ?? 0) === 1)
						this.problem(n, 'unsupported', `${r.what}: ${r.detail}`);
					break;
			}
			// Link the NEXT block to the id this one should have: the computed id
			// when there is one, else the id the node served (unchecked).
			this.lastBlock = n;
			this.lastId =
				r.kind === 'match' || (r.kind === 'id_mismatch' && r.id !== null)
					? (r as { id: string }).id
					: typeof block.block_id === 'string'
						? block.block_id.toLowerCase()
						: null;
			this.maybeSummarize();
		} catch {
			/* report-only: never in the way of indexing */
		}
	}

	private maybeSummarize(): void {
		const everyBlocks = this.opts.summaryEveryBlocks ?? 20_000;
		const everyMs = this.opts.summaryEveryMs ?? 6 * 60 * 60 * 1000;
		if (this.checked % everyBlocks !== 0 && Date.now() - this.lastSummaryAt < everyMs) return;
		this.lastSummaryAt = Date.now();
		log.info('block_verify_summary', { ...this.stats(), firstProblems: undefined });
	}

	stats(): BlockVerifyStats {
		return {
			mode: 'report-only',
			since: this.since,
			checked: this.checked,
			matched: this.matched,
			merkleMismatch: this.merkleMismatch,
			idMismatch: this.idMismatch,
			linkMismatch: this.linkMismatch,
			linksChecked: this.linksChecked,
			txidMismatch: Object.fromEntries(this.txidMismatch),
			unsupported: Object.fromEntries(this.unsupported),
			lastBlock: this.lastBlock,
			firstProblems: [...this.problems]
		};
	}
}
