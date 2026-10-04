#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/indexer-snapshot-op-smoke.ts
 *
 * Locks the indexer_snapshot_v1 on-chain op contract: the pure validator +
 * builder that decide what may be broadcast as @morphit's canonical indexer-DB
 * snapshot pointer. Unlike chain_snapshot_v1 (block_log, self-verifying), this
 * points at DERIVED state, so the payload MUST carry chain_id + schema_version +
 * last_applied_block for the importer to gate the restore. Fails CLOSED on
 * anything malformed. No network/key/fs.
 */
import {
	INDEXER_SNAPSHOT_OP_ID,
	BLURT_CUSTOM_JSON_MAX_BYTES,
	validateIndexerSnapshotPayload,
	buildIndexerSnapshotOp,
	selectNewestSnapshotOp
} from '../src/blurt/indexerSnapshotOp.ts';

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}`);
	}
}

console.log('\n── indexer_snapshot_v1 op smoke (cp766) ───────────────\n');

const CID = 'bafybeih4awqlztezkzdm57qyycnskxpmmokdxrbadmk6hdobr6vup5lbk4';
const SHA = 'a'.repeat(64);
const good = {
	ipfs_cid: CID,
	sha256: SHA,
	chain_id: '4f8db06fd6f30d90b0d3364b5f6f8f0bfe0e3a3a3f3e3d3c3b3a39383736353',
	schema_version: 40,
	last_applied_block: 63_188_071,
	size_bytes: 4_200_000_000,
	indexer_version: '1.14.0',
	ipns_name: 'k51qzi5uqu5dabc',
	forgejo_url: 'https://git.agorise.net/agorise/indexer-snapshot/releases/download/latest/snap.tar.gz'
};

// ── happy path ────────────────────────────────────────────────────
check('op id is frozen as indexer_snapshot_v1', INDEXER_SNAPSHOT_OP_ID === 'indexer_snapshot_v1');
{
	const r = validateIndexerSnapshotPayload(good);
	check('a well-formed payload validates', r.ok && r.value?.ipfs_cid === CID && r.value?.chain_id === good.chain_id);
}
check('optional ipns_name + forgejo_url may be omitted', validateIndexerSnapshotPayload({
	ipfs_cid: CID, sha256: SHA, chain_id: 'BLURT', schema_version: 1, last_applied_block: 1, size_bytes: 1, indexer_version: '1.0.0'
}).ok);

// ── each required field fails CLOSED ──────────────────────────────
check('non-object is rejected', !validateIndexerSnapshotPayload('nope').ok);
check('bad CID rejected', !validateIndexerSnapshotPayload({ ...good, ipfs_cid: 'http://evil/x' }).ok);
check('sha256 must be 64-hex', !validateIndexerSnapshotPayload({ ...good, sha256: 'xyz' }).ok);
check('uppercase sha256 rejected (lowercase only)', !validateIndexerSnapshotPayload({ ...good, sha256: 'A'.repeat(64) }).ok);
check('chain_id required (empty rejected)', !validateIndexerSnapshotPayload({ ...good, chain_id: '' }).ok);
check('chain_id over 128 chars rejected', !validateIndexerSnapshotPayload({ ...good, chain_id: 'x'.repeat(129) }).ok);
check('schema_version must be a positive int', !validateIndexerSnapshotPayload({ ...good, schema_version: 0 }).ok);
check('schema_version must be integer, not float', !validateIndexerSnapshotPayload({ ...good, schema_version: 1.5 }).ok);
check('last_applied_block must be a positive int', !validateIndexerSnapshotPayload({ ...good, last_applied_block: 0 }).ok);
check('size_bytes must be a positive int', !validateIndexerSnapshotPayload({ ...good, size_bytes: -5 }).ok);
check('indexer_version required (empty rejected)', !validateIndexerSnapshotPayload({ ...good, indexer_version: '' }).ok);
check('indexer_version over 32 chars rejected', !validateIndexerSnapshotPayload({ ...good, indexer_version: 'x'.repeat(33) }).ok);

// ── optional fields validated when present ────────────────────────
check('non-https forgejo_url rejected', !validateIndexerSnapshotPayload({ ...good, forgejo_url: 'http://x' }).ok);
check('empty ipns_name rejected when present', !validateIndexerSnapshotPayload({ ...good, ipns_name: '' }).ok);

// ── builder: shape + size + signer ────────────────────────────────
{
	const op = buildIndexerSnapshotOp(JSON.stringify(good), 'morphit');
	check('builder emits a posting-auth custom_json with the frozen id', op.id === 'indexer_snapshot_v1' && op.required_posting_auths[0] === 'morphit' && op.required_auths.length === 0);
	check('builder preserves the exact trimmed json (dry-run parity)', op.json === JSON.stringify(good));
}
check('builder throws on invalid JSON', (() => { try { buildIndexerSnapshotOp('{'); return false; } catch { return true; } })());
check('builder throws on an invalid payload', (() => { try { buildIndexerSnapshotOp(JSON.stringify({ ...good, sha256: 'bad' })); return false; } catch { return true; } })());
check('builder throws on a bad signer account', (() => { try { buildIndexerSnapshotOp(JSON.stringify(good), 'BadName'); return false; } catch { return true; } })());
check('builder enforces the Blurt custom_json byte limit', (() => {
	const huge = { ...good, forgejo_url: 'https://x/' + 'y'.repeat(BLURT_CUSTOM_JSON_MAX_BYTES) };
	try { buildIndexerSnapshotOp(JSON.stringify(huge)); return false; } catch { return true; }
})());

// ── selectNewestSnapshotOp: pick newest valid trusted-signer op ───
{
	const trusted = new Set(['morphit']);
	const cj = (payload: object, id = INDEXER_SNAPSHOT_OP_ID, auth = 'morphit') => ({
		op: ['custom_json', { required_auths: [], required_posting_auths: [auth], id, json: JSON.stringify(payload) }],
		block: 100,
		trx_id: 'abc'
	});
	const older = { ...good, last_applied_block: 62_000_000 };
	const newer = { ...good, last_applied_block: 63_000_000 };
	// history: [ [seq, body], ... ]; newest = highest seq
	const hist = [
		[10, cj(older)],
		[20, cj(newer)],
		[15, cj({ ...good }, 'some_other_op')], // wrong id → ignored
		[25, cj(good, INDEXER_SNAPSHOT_OP_ID, 'attacker')], // untrusted signer → ignored
		[30, { op: ['custom_json', { required_posting_auths: ['morphit'], id: INDEXER_SNAPSHOT_OP_ID, json: '{bad json' }] }] // malformed → ignored
	];
	const sel = selectNewestSnapshotOp(hist, trusted);
	check('selects the NEWEST valid op (highest seq)', sel !== null && sel.seq === 20 && sel.payload.last_applied_block === 63_000_000);
	check('ignores wrong op id, untrusted signer, and malformed json', sel !== null && sel.signer === 'morphit');
}
check('selectNewestSnapshotOp returns null for empty history', selectNewestSnapshotOp([], new Set(['morphit'])) === null);
check('selectNewestSnapshotOp returns null for non-array input', selectNewestSnapshotOp('nope', new Set(['morphit'])) === null);
{
	// an op that is well-formed but signed only by an untrusted account → null
	const hist = [[1, { op: ['custom_json', { required_posting_auths: ['evil'], id: INDEXER_SNAPSHOT_OP_ID, json: JSON.stringify(good) }] }]];
	check('refuses an op from an untrusted signer (fast path denied)', selectNewestSnapshotOp(hist, new Set(['morphit'])) === null);
}
{
	// garbage entries interleaved must never throw
	const hist = [null, 5, [1], [2, {}], [3, { op: 'x' }], [4, { op: ['custom_json'] }]];
	let threw = false;
	try { selectNewestSnapshotOp(hist, new Set(['morphit'])); } catch { threw = true; }
	check('never throws on garbage history entries (defensive)', !threw);
}

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} indexer-snapshot-op checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} indexer-snapshot-op scenarios passed`);
