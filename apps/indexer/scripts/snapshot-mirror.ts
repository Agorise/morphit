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
import {
	chmodSync,
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { loadConfig } from '../src/config/index.ts';
import { bootChainClient, installChainRouting } from '../src/indexer/bootChainClient.ts';
import { INDEXER_SNAPSHOT_SIGNER_DEFAULT } from '../src/blurt/indexerSnapshotOp.ts';
import { resolveTrustedSnapshotOp } from '../src/blurt/snapshotOpTrust.ts';
import { suppressDblurtConsoleNoise } from '@morphit/rpc-pool';

// The RPC library's own failover chatter ("Didn't failover for error …") is
// noise here as in the indexer: the pool fails over, and this script reports
// its result itself.
suppressDblurtConsoleNoise();

// Root's state, in root's own directory (review G1): it lived in the morphit
// account's home, where root wrote it through any link that account planted.
const STATE_PATH =
	process.env.MORPHIT_SNAPSHOT_MIRROR_STATE ?? '/var/lib/morphit-ops/snapshot-mirror.json';
/** Where v1.21.0 and older kept it: read once, until this run writes the new one. */
const LEGACY_STATE_PATH = '/var/lib/morphit/snapshot-mirror.json';

/** A root-owned regular file's text, never read through a link; else null. */
function readOwnFile(path: string): string | null {
	let fd: number;
	try {
		fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
	} catch {
		return null;
	}
	try {
		const st = fstatSync(fd);
		if (!st.isFile() || st.uid !== (process.getuid?.() ?? 0)) return null;
		return readFileSync(fd, 'utf8');
	} finally {
		closeSync(fd);
	}
}

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const say = (m: string): void => {
	process.stderr.write(`snapshot-mirror: ${m}\n`);
};

/**
 * A slow step's label: at a terminal the braille spinner turns beside it
 * (stderr, where this script reports), cleared when the step ends; from the
 * weekly timer (a systemd unit) the label once, for the journal; piped into
 * `morphit-ops upgrade` nothing — the upgrade's own spinner already shows the
 * mirror is at work. Returns the stopper (idempotent).
 */
function readingChainSpinner(label: string): () => void {
	if (process.stderr.isTTY !== true) {
		if (process.env.INVOCATION_ID) say(label);
		return () => {};
	}
	const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
	let i = 0;
	const draw = (): void => {
		process.stderr.write(`\r  ${frames[i++ % frames.length]} snapshot-mirror: ${label}`);
	};
	draw();
	const timer = setInterval(draw, 80);
	timer.unref();
	let stopped = false;
	return () => {
		if (stopped) return;
		stopped = true;
		clearInterval(timer);
		process.stderr.write('\r\u001b[K');
	};
}

/**
 * Where kubo's repo lives, and who owns it.
 *
 * This job runs as ROOT (systemd User=root, so it can write the state file), but
 * the kubo daemon runs as the `ipfs` user with its repo at /var/lib/ipfs/.ipfs.
 * Invoking a bare `ipfs` as root makes kubo look in /root/.ipfs — a different,
 * empty repo with no daemon behind it — so every command that needs the repo
 * fails while `ipfs --version` (which needs no repo) happily succeeds. That is
 * exactly how this shipped: the startup guard passed and `pin add` then failed
 * on a box that was already serving the very CID it was trying to fetch.
 * Drop to the daemon's own user and point at its repo, as the seeder does.
 */
const IPFS_REPO = process.env.IPFS_PATH ?? '/var/lib/ipfs/.ipfs';
const IPFS_USER = process.env.MORPHIT_IPFS_USER ?? 'ipfs';

/**
 * How to become the kubo user.
 *
 * NOT sudo: it is setuid-root and refuses to run under systemd's
 * NoNewPrivileges=true, failing with "unable to open /etc/sudoers: Operation not
 * permitted". That is invisible when you run the job by hand as root and fatal
 * the moment the timer runs it. `runuser` is not setuid — it only works if you
 * are already root — so dropping privileges with it is unaffected. sudo remains
 * a fallback for hosts without runuser.
 */
const DROP_PRIV: readonly string[] = spawnSync('sh', ['-c', 'command -v runuser'], { encoding: 'utf8' })
	.status === 0
	? ['runuser', '-u', IPFS_USER, '--']
	: ['sudo', '-n', '-u', IPFS_USER];

/** Run kubo as the repo's owner. Never throws; returns stdout (trimmed) or null. */
function ipfs(args: readonly string[], timeoutMs = 120_000): string | null {
	const [cmd, ...pre] = DROP_PRIV;
	const r = spawnSync(
		cmd!,
		[...pre, 'env', `IPFS_PATH=${IPFS_REPO}`, 'ipfs', ...args],
		{ encoding: 'utf8', timeout: timeoutMs }
	);
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
		const text =
			readOwnFile(STATE_PATH) ??
			(process.env.MORPHIT_SNAPSHOT_MIRROR_STATE === undefined ? readOwnFile(LEGACY_STATE_PATH) : null);
		if (text === null) return null;
		const v = JSON.parse(text) as Partial<MirrorState>;
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
		const dir = dirname(STATE_PATH);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const d = lstatSync(dir);
		if (!d.isDirectory() || d.uid !== (process.getuid?.() ?? 0)) return;
		if (process.env.MORPHIT_SNAPSHOT_MIRROR_STATE === undefined) chmodSync(dir, 0o700);
		// A NEW temporary file (O_EXCL, never through a link), then rename():
		// a link at the final name is replaced, not followed.
		const tmp = `${STATE_PATH}.tmp`;
		try {
			unlinkSync(tmp);
		} catch {
			/* not there */
		}
		const fd = openSync(
			tmp,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
			0o600
		);
		try {
			writeSync(fd, JSON.stringify(s, null, 2) + '\n');
		} finally {
			closeSync(fd);
		}
		renameSync(tmp, STATE_PATH);
	} catch {
		/* a box that can't record state still mirrors correctly; it just re-pins next run */
	}
}


async function main(): Promise<void> {
	// kubo is optional on a Morphit box. No kubo, nothing to mirror — and that is
	// a normal configuration, not an error.
	// `--version` needs no repo, so it cannot tell "no kubo" from "wrong repo".
	// Ask for something that requires a reachable daemon instead.
	if (ipfs(['id', '-f=<id>'], 15_000) === null) {
		say(`could not reach the kubo daemon as user '${IPFS_USER}' with IPFS_PATH=${IPFS_REPO}.`);
		say('  If this box hosts IPFS, check: systemctl status ipfs');
		say('  If it does not, nothing to mirror — this is fine.');
		return;
	}

	const config = loadConfig();
	// Route .onion / .b32.i2p through Tor and i2pd, and refuse clearnet on a
	// hidden-only node, before any request (bootChainClient.ts). Throws if the
	// router cannot be installed: never read the chain unrouted.
	installChainRouting(config);
	const signer = (flag('signer') ?? INDEXER_SNAPSHOT_SIGNER_DEFAULT).toLowerCase();
	const limit = Math.max(1, Math.min(10_000, parseInt(flag('history-limit') ?? '1000', 10) || 1000));

	// the op was read from ONE RPC endpoint and
	// accepted on the strength of naming @signer — so one hostile node could make
	// every instance pin and re-serve a CID of its choosing. Now two independent
	// RPC operators must agree on the op and its block, and its signature must
	// recover to the pinned posting key, exactly as fast-sync requires.
	const pinnedPubkey =
		flag('signer-pubkey') ??
		(signer === config.officialAccountName.toLowerCase() ? config.officialPostingPubkey : undefined);
	if (pinnedPubkey === undefined || pinnedPubkey === '') {
		say(`@${signer} is not the official account, so its key is not pinned — pass --signer-pubkey <BLT…>. Nothing to do.`);
		return;
	}
	const blurt = bootChainClient(config);
	let resolved: Awaited<ReturnType<typeof resolveTrustedSnapshotOp>>;
	// A slow read (two RPC operators, over Tor on a hidden node): never a
	// silent pause. At a terminal a spinner; from the weekly timer one line;
	// piped into `morphit-ops upgrade` nothing (its own spinner shows it).
	const stopReading = readingChainSpinner(`reading @${signer}'s chain history for the newest indexer_snapshot_v1…`);
	try {
		resolved = await resolveTrustedSnapshotOp(blurt, {
			signer,
			pinnedPubkey,
			chainId: config.chainId,
			historyLimit: limit,
			minAgree: 2
		});
	} catch (e) {
		stopReading();
		say(`could not read the chain right now (${e instanceof Error ? e.message : String(e)}) — will retry on the next run.`);
		return;
	}
	stopReading();
	if (!resolved.ok) {
		say(`${resolved.reason} Nothing was pinned; will retry on the next run.`);
		return;
	}
	const op = resolved.selected.payload;

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
	// Wait for PEERS, not just for the API. `ipfs id` answers seconds after the
	// daemon starts, but fetching content needs a populated swarm — and this
	// script runs right after an upgrade that restarts kubo. On morphitir the
	// swarm was literally 0 peers at this point, so `pin add` sat through its full
	// 10-minute budget waiting on a DHT that did not exist yet, then gave up. One
	// manual connect took it from 0 to 466, which is what proved the cause.
	let peers = 0;
	for (let i = 0; i < 30; i++) {
		const out = ipfs(['swarm', 'peers'], 20_000);
		peers = out === null || out === '' ? 0 : out.split('\n').filter((l) => l.trim() !== '').length;
		if (peers > 0) break;
		if (i === 0) say('kubo has no peers yet (it may have just restarted) — waiting before fetching …');
		await new Promise((r) => setTimeout(r, 2000));
	}
	if (peers === 0) {
		say('kubo still has no swarm peers after 60s — cannot fetch the snapshot yet. Will retry on the next run.');
		say('  (Nothing is broken; this box just is not a mirror yet. Check: systemctl status ipfs)');
		return;
	}

	say(`pinning to this box\u2019s IPFS node (${peers} peer${peers === 1 ? '' : 's'}) …`);
	if (ipfs(['pin', 'add', '--progress=false', op.ipfs_cid], 600_000) === null) {
		say('could not fetch/pin the snapshot right now — will retry on the next run. (Nothing is broken; this box just is not a mirror yet.)');
		return;
	}

	// VERIFY before we advertise it. `pin add` proves we hold SOME bytes for that
	// CID; it does not prove they are the bytes @morphit signed. Check the inner
	// dump against the on-chain sha256 exactly as a fresh node would, so this box
	// can never become a mirror that serves something a newcomer will reject.
	const catCmd =
		`${DROP_PRIV.join(' ')} env IPFS_PATH=${IPFS_REPO} ipfs cat ${op.ipfs_cid} 2>/dev/null` +
		` | tar -xzO indexer.sql.gz 2>/dev/null`;
	const tar = spawnSync('sh', ['-c', catCmd], {
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

// Exit as soon as the work is done. The chain
// reads are now quorum reads: once two operators agree, the others still in
// flight are abandoned, but an abandoned RPC call keeps retrying in the
// background until its own timeout (a minute for .onion/.i2p), holding the
// process open for nothing.
main().then(() => process.exit(0), (err) => {
	// Never fail: this runs inside upgrades and on a timer.
	say(`unexpected error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
	process.exit(0);
});
