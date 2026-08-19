#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/chain-snapshot-op-smoke.ts (cp765)
 *
 * Locks the chain_snapshot_v1 on-chain op contract: the pure validator + builder
 * that decide what may be broadcast as @morphit's canonical block_log pointer.
 * Fails CLOSED on anything malformed. No network/key/fs.
 */
import {
	CHAIN_SNAPSHOT_OP_ID,
	BLURT_CUSTOM_JSON_MAX_BYTES,
	validateChainSnapshotPayload,
	buildChainSnapshotOp
} from '../src/blurt/chainSnapshotOp.ts';

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

console.log('\n── chain_snapshot_v1 op smoke (cp765) ─────────────────\n');

const CID = 'bafybeih4awqlztezkzdm57qyycnskxpmmokdxrbadmk6hdobr6vup5lbk4';
const SHA = 'a'.repeat(64);
const good = {
	ipfs_cid: CID,
	sha256: SHA,
	block_height: 62_874_615,
	size_bytes: 27_000_000_000,
	blurtd_version: '0.1.5',
	ipns_name: 'k51qzi5uqu5dabc',
	forgejo_url: 'https://git.agorise.net/agorise/chain-snapshot/releases/download/latest/block_log.tar'
};

// ── happy path ────────────────────────────────────────────────────
check('op id is frozen as chain_snapshot_v1', CHAIN_SNAPSHOT_OP_ID === 'chain_snapshot_v1');
{
	const r = validateChainSnapshotPayload(good);
	check('a well-formed payload validates', r.ok && r.value?.ipfs_cid === CID);
}
check('optional ipns_name + forgejo_url may be omitted', validateChainSnapshotPayload({
	ipfs_cid: CID, sha256: SHA, block_height: 1, size_bytes: 1, blurtd_version: '0.1.5'
}).ok);

// ── each required field fails CLOSED ──────────────────────────────
check('non-object is rejected', !validateChainSnapshotPayload('nope').ok);
check('bad CID rejected', !validateChainSnapshotPayload({ ...good, ipfs_cid: 'http://evil/x' }).ok);
check('sha256 must be 64-hex', !validateChainSnapshotPayload({ ...good, sha256: 'xyz' }).ok);
check('uppercase sha256 rejected (lowercase only)', !validateChainSnapshotPayload({ ...good, sha256: 'A'.repeat(64) }).ok);
check('block_height must be a positive int', !validateChainSnapshotPayload({ ...good, block_height: 0 }).ok);
check('size_bytes must be a positive int', !validateChainSnapshotPayload({ ...good, size_bytes: -5 }).ok);
check('block_height must be integer, not float', !validateChainSnapshotPayload({ ...good, block_height: 1.5 }).ok);
check('blurtd_version required', !validateChainSnapshotPayload({ ...good, blurtd_version: '' }).ok);

// ── optional fields validated when present ────────────────────────
check('non-https forgejo_url rejected', !validateChainSnapshotPayload({ ...good, forgejo_url: 'http://x' }).ok);
check('empty ipns_name rejected when present', !validateChainSnapshotPayload({ ...good, ipns_name: '' }).ok);

// ── builder: shape + size + signer ────────────────────────────────
{
	const op = buildChainSnapshotOp(JSON.stringify(good), 'morphit');
	check('builder emits a posting-auth custom_json with the frozen id', op.id === 'chain_snapshot_v1' && op.required_posting_auths[0] === 'morphit' && op.required_auths.length === 0);
	check('builder preserves the exact trimmed json (dry-run parity)', op.json === JSON.stringify(good));
}
check('builder throws on invalid JSON', (() => { try { buildChainSnapshotOp('{'); return false; } catch { return true; } })());
check('builder throws on an invalid payload', (() => { try { buildChainSnapshotOp(JSON.stringify({ ...good, sha256: 'bad' })); return false; } catch { return true; } })());
check('builder throws on a bad signer account', (() => { try { buildChainSnapshotOp(JSON.stringify(good), 'BadName'); return false; } catch { return true; } })());
check('builder enforces the Blurt custom_json byte limit', (() => {
	const huge = { ...good, blurtd_version: 'x'.repeat(30), forgejo_url: 'https://x/' + 'y'.repeat(BLURT_CUSTOM_JSON_MAX_BYTES) };
	try { buildChainSnapshotOp(JSON.stringify(huge)); return false; } catch { return true; }
})());

const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} chain-snapshot-op checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} chain-snapshot-op scenarios passed`);
