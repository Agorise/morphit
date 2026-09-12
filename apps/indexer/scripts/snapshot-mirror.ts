#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/snapshot-mirror.ts
 *
 * Make THIS instance a mirror of the federation indexer snapshot.
 *
 * WHY
 * Fast-sync is what gets a brand-new node from "empty database" to "live
 * orderbook" in minutes instead of days, and it is on by default. It depends on
 * one artifact: the small (~600 kB) indexer snapshot @morphit anchors on-chain.
 * If that artifact is only reachable from morphit.io and a few public clearnet
 * IPFS gateways, then (a) morphit.io is a single point of failure for every new
 * instance coming online, and (b) a zero-clearnet node — exactly the kind we
 * most want more of — cannot fast-sync at all.
 *
 * THE MODEL: one signer, many mirrors.
 * Only @morphit generates and anchors the snapshot, so there is exactly one
 * signature and no new trust decision for anyone to make. Every other instance
 * just re-serves those bytes. A newcomer proves whatever it downloads against
 * the on-chain SHA-256, so a hostile or broken mirror is caught by arithmetic
 * rather than reputation — which is precisely why it is safe to let the whole
 * federation mirror without vetting anyone.
 *
 * WHAT THIS DOES
 *   1. Read the newest signed indexer_snapshot_v1 op from chain (over whatever
 *      transport this node already uses — hidden RPC included, zero clearnet).
 *   2. Pin that CID to this box's own kubo.
 *   3. VERIFY the bytes against the signed sha256 before keeping the pin.
 *   4. Unpin the snapshot we were mirroring before — one live snapshot per box,
 *      never a growing pile.
 *
 * Serving is free: the frontend already proxies /ipfs/ to the local gateway, so
 * a pinned CID is immediately reachable over this instance's clearnet origin AND
 * its .onion AND its .b32.i2p, with no new routes and no new ports.
 *
 * Best-effort by design. Every failure is reported and exits 0: a box that
 * cannot mirror today is not a broken box, it just is not helping yet, and this
 * runs inside upgrades that must never fail because of it.
 *
 *   node_modules/.bin/tsx --tsconfig tsconfig.smoke.json \
 *     apps/indexer/scripts/snapshot-mirror.ts [--signer morphit]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config/index.ts';
import { BlurtClient } from '../src/blurt/client.ts';
import {
	selectNewestSnapshotOp,
	INDEXER_SNAPSHOT_SIGNER_DEFAULT
} from '../src/blurt/indexerSnapshotOp.ts';

const STATE_PATH = process.env.MORPHIT_SNAPSHOT_MIRROR_STATE ?? '/var/lib/morphit/snapshot-mirror.json';

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const say = (m: string): void => {
	process.stderr.write(`snapshot-mirror: ${m}\n`);
};

/** Run kubo. Never throws; returns stdout (trimmed) or null. */
function ipfs(args: readonly string[], timeoutMs = 120_000): string | null {
	const r = spawnSync('ipfs', [...args], { encoding: 'utf8', timeout: timeoutMs });
	if (r.status !== 0) return null;
	return typeof r.stdout === 'string' ? r.stdout.trim() : '';
}

interface MirrorState {
	cid: string;
	sha256: string;
	lastAppliedBlock: number;
	mirroredAt: string;
}

function readState(): MirrorState | null {
	try {
		if (!existsSync(STATE_PATH)) return null;
		const v = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<MirrorState>;
		if (typeof v.cid !== 'string' || v.cid === '') return null;
		return {
			cid: v.cid,
			sha256: typeof v.sha256 === 'string' ? v.sha256 : '',
			lastAppliedBlock: typeof v.lastAppliedBlock === 'number' ? v.lastAppliedBlock : 0,
			mirroredAt: typeof v.mirroredAt === 'string' ? v.mirroredAt : ''
		};
	} catch {
		return null;
	}
}

function writeState(s: MirrorState): void {
	try {
		mkdirSync(dirname(STATE_PATH), { recursive: true });
		writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
	} catch {
		/* a box that can't record state still mirrors correctly; it just re-pins next run */
	}
}

async function main(): Promise<void> {
	// kubo is optional on a Morphit box. No kubo, nothing to mirror — and that is
	// a normal configuration, not an error.
	if (ipfs(['--version'], 10_000) === null) {
		say('this box does not run IPFS — nothing to mirror. (Optional: morphit-ops harden → "Set up IPFS release hosting".)');
		return;
	}

	const config = loadConfig();
	const signer = (flag('signer') ?? INDEXER_SNAPSHOT_SIGNER_DEFAULT).toLowerCase();
	const limit = Math.max(1, Math.min(10_000, parseInt(flag('history-limit') ?? '1000', 10) || 1000));

	say(`reading @${signer}'s chain history for the newest indexer_snapshot_v1 …`);
	const blurt = new BlurtClient(config);
	let history: unknown;
	try {
		history = await blurt.callCondenser('get_account_history', [signer, -1, limit]);
	} catch (e) {
		say(`could not read the chain right now (${e instanceof Error ? e.message : String(e)}) — will retry on the next run.`);
		return;
	}

	const sel = selectNewestSnapshotOp(history, new Set([signer]));
	if (!sel) {
		say(`no snapshot has been anchored by @${signer} yet — nothing to mirror.`);
		return;
	}
	const op = sel.payload;

	// Chain gate. Mirroring another chain's state would hand newcomers a snapshot
	// their own node must reject — refuse rather than waste everyone's time.
	if (op.chain_id !== config.chainId) {
		say(`the anchored snapshot is for chain '${op.chain_id}' but this node indexes '${config.chainId}' — refusing to mirror.`);
		return;
	}

	const prev = readState();
	if (prev && prev.cid === op.ipfs_cid) {
		// Re-assert the pin anyway: a kubo repo can be GC'd or rebuilt between
		// runs, so trusting our own state file without checking would silently
		// leave the box advertising a snapshot it no longer holds.
		const pinned = ipfs(['pin', 'ls', '--type=recursive', op.ipfs_cid], 30_000);
		if (pinned !== null && pinned.includes(op.ipfs_cid)) {
			say(`already mirroring the newest snapshot (block ${op.last_applied_block.toLocaleString()}) — nothing to do.`);
			return;
		}
		say('state says we mirror this snapshot but kubo does not hold it — re-pinning.');
	}

	say(
		`newest snapshot: block ${op.last_applied_block.toLocaleString()} · schema v${op.schema_version} · ` +
			`indexer v${op.indexer_version} · ${Math.max(1, Math.round(op.size_bytes / 1024))} kB · CID ${op.ipfs_cid}`
	);

	// Pin it. This is the fetch: kubo pulls the block from whoever has it.
	say('pinning to this box\u2019s IPFS node …');
	if (ipfs(['pin', 'add', '--progress=false', op.ipfs_cid], 600_000) === null) {
		say('could not fetch/pin the snapshot right now — will retry on the next run. (Nothing is broken; this box just is not a mirror yet.)');
		return;
	}

	// VERIFY before we advertise it. `pin add` proves we hold SOME bytes for that
	// CID; it does not prove they are the bytes @morphit signed. Check the inner
	// dump against the on-chain sha256 exactly as a fresh node would, so this box
	// can never become a mirror that serves something a newcomer will reject.
	const tar = spawnSync('sh', ['-c', `ipfs cat ${op.ipfs_cid} 2>/dev/null | tar -xzO indexer.sql.gz 2>/dev/null`], {
		encoding: 'buffer',
		timeout: 300_000,
		maxBuffer: 512 * 1024 * 1024
	});
	const body = tar.status === 0 && Buffer.isBuffer(tar.stdout) ? tar.stdout : null;
	if (!body || body.length === 0) {
		say('could not read the pinned snapshot back to verify it — unpinning rather than serving unverified bytes.');
		ipfs(['pin', 'rm', op.ipfs_cid], 60_000);
		return;
	}
	const got = createHash('sha256').update(body).digest('hex');
	if (got !== op.sha256) {
		say(`sha256 MISMATCH: pinned content hashes ${got}, the signed op says ${op.sha256}. Unpinning — this box will not serve it.`);
		ipfs(['pin', 'rm', op.ipfs_cid], 60_000);
		return;
	}
	say('\u2713 verified against the on-chain sha256.');

	// Replace, never accumulate: drop the snapshot we were serving before. Old
	// snapshots have no readers — a newcomer always wants the newest — so keeping
	// them would cost disk for nothing.
	if (prev && prev.cid !== op.ipfs_cid) {
		if (ipfs(['pin', 'rm', prev.cid], 60_000) !== null) {
			say(`unpinned the superseded snapshot (${prev.cid}).`);
		}
		// Reclaim the space now rather than waiting for kubo's own schedule.
		ipfs(['repo', 'gc'], 300_000);
	}

	writeState({
		cid: op.ipfs_cid,
		sha256: op.sha256,
		lastAppliedBlock: op.last_applied_block,
		mirroredAt: new Date().toISOString()
	});

	say('\u2713 this instance now mirrors the federation snapshot.');
	say('  Served over this instance\u2019s clearnet origin, .onion and .b32.i2p alike,');
	say('  so a new node \u2014 including a zero-clearnet one \u2014 can fast-sync from you.');
}

main().catch((err) => {
	// Never fail: this runs inside upgrades and on a timer.
	say(`unexpected error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
	process.exit(0);
});
