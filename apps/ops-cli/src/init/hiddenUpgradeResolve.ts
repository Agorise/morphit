/**
 * hiddenUpgradeResolve — the self-contained hidden-only upgrade resolution
 * (v1.16.1 stage 3). ALL hidden-only decision + fetch logic lives here so the
 * change to the 1141-line `runUpgrade` is five tiny `if (hiddenOnly)` calls, not
 * logic smeared across the critical path. Every function is null/throw-clean:
 *   - not hidden-only → the caller keeps its existing clearnet behaviour.
 *   - hidden-only but a step fails → THROW (fail-closed; the caller aborts and
 *     stays on the current version — NEVER a clearnet fallback).
 *
 * Security note: what to fetch (version, SHA-256, CID, IPNS name) comes from
 * @morphit's `morphit_release_v1` op, read through this node's own indexer and
 * accepted only when its transaction signature recovers to the pinned posting
 * key (lib/releaseAnchor.ts). The indexer's `/v1/release` only says which
 * version to look for. The fetched tarball is checked against that SHA-256
 * inside `fetchHiddenUpgrade` (it throws on mismatch), so a forged or rolled-back
 * tarball can never be returned from here.
 *
 * Offline-safe: only node built-ins + the dependency-free @morphit/hidden-transport
 * + undici (already bundled). Nothing new to fetch at install time.
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { hiddenServiceProxyConfigFromEnv } from '@morphit/hidden-transport';
import {
	fetchHiddenUpgrade,
	resolvePeerGateways,
	type PeerDirectoryRow
} from './hiddenUpgradeFetch.js';
import { makeHiddenTarballFetcher } from './hiddenUpgradeTransport.js';
import { localCondenser } from '../lib/hiddenOnly.ts';
import {
	readSignedReleaseAnchor,
	type CondenserRead,
	type ReleaseAnchor
} from '../lib/releaseAnchor.ts';
import {
	MORPHIT_RELEASE_ACCOUNT,
	MORPHIT_OFFICIAL_POSTING_PUBKEY,
	BLURT_MAINNET_CHAIN_ID
} from '@morphit/operator-config';
import {
	readIndexerConfig,
	locateLocalIndexer,
	getLocalIndexerJson,
	type LocalIndexerOptions
} from './hiddenUpgradeLocalIndexer.ts';

/** A release version as the chain publishes it: X.Y.Z with an optional
 *  prerelease. Anything else is refused before it names a file or reaches the
 *  terminal. */
export const RELEASE_VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Concise, host-only label for a hidden gateway base, tagged with its network,
 *  so the CLI can name EXACTLY which hidden services served the upgrade. */
export function hiddenGatewayLabel(gatewayBase: string): string {
	const host = gatewayBase.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	const net = host.includes('.i2p') ? 'I2P' : host.endsWith('.onion') ? 'Tor' : 'hidden';
	const short = host.length > 24 ? `${host.slice(0, 12)}…${host.slice(-8)}` : host;
	return `${short} (${net})`;
}

/** Read the deployed indexer config env to decide hidden-only, without needing
 *  the indexer to answer. hidden-only ⇔ the clearnet RPC pool is empty. */
export function isHiddenOnlyFromEnvFile(candidatePaths: readonly string[]): boolean {
	for (const p of candidatePaths) {
		if (!existsSync(p)) continue;
		let text: string;
		try {
			text = readFileSync(p, 'utf8');
		} catch {
			continue;
		}
		// [ \t]* (NOT \s*) around/after '=' — \s* matches newlines, so an empty
		// `MORPHIT_INDEXER_RPC_ENDPOINTS=` would greedily capture the NEXT line and
		// read as non-empty, mis-detecting a hidden-only node as clearnet (v1.16.6).
		const m = text.match(/^[ \t]*MORPHIT_INDEXER_RPC_ENDPOINTS[ \t]*=[ \t]*(.*)$/m);
		if (!m) return false; // key absent → treat as clearnet (safe default)
		const val = (m[1] ?? '')
			.trim()
			.replace(/^["']|["']$/g, '')
			.trim();
		return val === ''; // empty clearnet pool ⇒ hidden-only
	}
	return false; // no config found → not hidden-only (safe default)
}

/** What decides hidden-only, and how the local indexer is found. */
export interface HiddenOnlyOptions extends LocalIndexerOptions {
	/** The legacy candidate files (first existing one is read). */
	readonly configEnvPaths: readonly string[];
}

/**
 * Is this node hidden-only?
 *
 * WHAT WAS WRONG. The answer came first from whatever answered plain HTTP on
 * port 8081 (`/v1/instance` `clearnet_eliminated`). Any local process could
 * give it, so it could switch a clearnet node onto the hidden path and pick the
 * release root installs. And `clearnet_eliminated` is an eight-leg AND: a node
 * whose chain reads ARE hidden-only but which, say, publishes no I2P address
 * read as "not hidden-only" and fetched its upgrade from git.agorise.net over
 * clearnet, four times a day through the release monitor.
 *
 * NOW. The root-owned config decides: an empty clearnet RPC pool is
 * hidden-only, in either the unit's effective environment or the legacy file
 * list (if they disagree, hidden-only wins — the private answer). Only when that
 * config cannot be read at all (the unprivileged release monitor) is the
 * indexer asked, after its listener has been authenticated, and then only about
 * the chain leg (`chainHidden`), never the full AND. If it cannot be asked, this
 * throws: the caller stops without touching clearnet.
 */
export async function isHiddenOnly(opts: HiddenOnlyOptions): Promise<boolean> {
	if (isHiddenOnlyFromEnvFile(opts.configEnvPaths)) return true;
	if (opts.unitEnvFiles === undefined) return false;
	const cfg = readIndexerConfig(opts.unitEnvFiles);
	if (cfg.readable) {
		// Unset means the built-in default pool, which is clearnet.
		return (
			cfg.rpcEndpoints !== undefined && cfg.rpcEndpoints.split(',').every((x) => x.trim() === '')
		);
	}
	const base = locateLocalIndexer(opts);
	const inst = await getLocalIndexerJson<{
		clearnet_eliminated?: unknown;
		clearnet_eliminated_missing?: unknown;
	}>(base, '/v1/instance', 4000);
	if (inst.clearnet_eliminated === true) return true;
	if (Array.isArray(inst.clearnet_eliminated_missing)) {
		return !inst.clearnet_eliminated_missing.includes('chainHidden');
	}
	throw new Error(
		'could not tell whether this node reads the chain over hidden services only: its config is ' +
			'readable only by root, and its indexer did not say. Run the command with sudo.'
	);
}

interface ReleaseTargetResponse {
	version: string;
	distribution: { source_sha256?: string; ipns_name?: string; ipfs_cid?: string } | null;
}
interface DirectoryResponse {
	instances?: Array<{
		alt_networks?: { tor?: string | null; i2p_b32?: string | null } | null;
		reg_alt_networks?: unknown;
		tor?: string | null;
		i2p_b32?: string | null;
	}>;
}

/** v1.20.3 — the CID pattern the peer URL builder accepts. */
const CID_RE = /^[a-z0-9]{46,}$/i;

/**
 * What the on-chain release must carry before a zero-clearnet node fetches
 * anything (null = enough). The SHA-256 is the trust anchor and always
 * required. The bytes are located by the CID (tried first) or the IPNS name
 * (fallback): either one is enough. v1.20.2 went out with a CID but no name,
 * and the old rule (the name required) left morphitlat unable to upgrade.
 */
export function hiddenReleaseTargetProblem(sha: string, ipns: string, cid: string): string | null {
	if (!/^[0-9a-f]{64}$/i.test(sha)) {
		return 'hidden upgrade: on-chain release has no source_sha256 yet — cannot verify; staying put (fail-closed)';
	}
	if (ipns === '' && !CID_RE.test(cid)) {
		return 'hidden upgrade: on-chain release has neither an ipfs_cid nor an ipns_name — nothing to fetch it by; staying put (fail-closed)';
	}
	return null;
}

export interface HiddenUpgradeResolution {
	readonly tarballPath: string;
	readonly version: string;
	readonly servedBy: string;
	/** The verified on-chain release record the tarball matched. */
	readonly anchor: ReleaseAnchor;
}

/**
 * v1.18.0 review (O10). What `upgrade --check-only` needs on a hidden-only
 * node: the version the chain says is current, read from THIS node's own
 * indexer — and nothing else. Returns null when the node is not hidden-only.
 *
 * The check used to run the whole hidden resolution, which DOWNLOADS the
 * release tarball over Tor/I2P from a federation peer just to learn a version
 * number. The release monitor runs the check every six hours under a 30-second
 * limit, so on every tor-only node it either timed out or fetched a full
 * release four times a day, and the operator was never told a release existed.
 * The version comes from the same on-chain record the real upgrade verifies
 * against; nothing is fetched from a peer, and nothing leaves the box.
 */
export async function readHiddenReleaseTarget(
	opts: HiddenOnlyOptions
): Promise<{ readonly tag: string } | null> {
	if (!(await isHiddenOnly(opts))) return null;
	// only the authenticated indexer is asked, and
	// only the first address with a listener — never the next one after it.
	const rel = await getLocalIndexerJson<ReleaseTargetResponse>(
		locateLocalIndexer(opts),
		'/v1/release'
	);
	const version = typeof rel.version === 'string' ? rel.version.trim() : '';
	if (version === '')
		throw new Error('hidden upgrade: the local indexer returned no release version');
	if (!RELEASE_VERSION_RE.test(version)) {
		throw new Error(
			'hidden upgrade: the local indexer returned a release version that is not a version number'
		);
	}
	return { tag: version.startsWith('v') ? version : `v${version}` };
}

/**
 * If this node is hidden-only, fetch + verify the release tarball over Tor/I2P
 * from a federation peer and return its local path + version. Returns null when
 * NOT hidden-only (caller proceeds on its normal clearnet path). Throws
 * (fail-closed) when hidden-only but the release can't be privately obtained.
 */
export async function tryResolveHiddenUpgrade(
	opts: HiddenOnlyOptions & {
		onProgress?: (msg: string) => void;
		/** Tests only: the pinned posting key and the chain reader. */
		postingPubkey?: string;
		chainRead?: CondenserRead;
	}
): Promise<HiddenUpgradeResolution | null> {
	if (!(await isHiddenOnly(opts))) return null;
	// every answer below comes from ONE authenticated
	// listener — the indexer's own process, found at its configured address.
	const base = locateLocalIndexer(opts);

	opts.onProgress?.(
		'hidden-only node — resolving the release from the federation over Tor/I2P (zero clearnet)…'
	);

	// 1. Target. The local indexer says which version is current; the hashes and
	//    the CID come from @morphit's signed op for that version, verified here.
	const rel = await getLocalIndexerJson<ReleaseTargetResponse>(base, '/v1/release');
	if (typeof rel.version !== 'string' || !RELEASE_VERSION_RE.test(rel.version.trim())) {
		throw new Error(
			'hidden upgrade: the on-chain release has no valid version number — staying put (fail-closed)'
		);
	}
	const version = rel.version.trim().replace(/^v/, '');
	opts.onProgress?.(
		`checking @${MORPHIT_RELEASE_ACCOUNT}'s signed release record for v${version} (through this node's own indexer)…`
	);
	const read: CondenserRead =
		opts.chainRead ??
		((method, params) => localCondenser(method, params, { bases: [base], timeoutMs: 60_000 }));
	const verified = await readSignedReleaseAnchor(read, {
		tag: version,
		signer: MORPHIT_RELEASE_ACCOUNT,
		pinnedPubkey: opts.postingPubkey ?? MORPHIT_OFFICIAL_POSTING_PUBKEY,
		chainId: BLURT_MAINNET_CHAIN_ID
	});
	if (!verified.ok) {
		// (`in`, not the ok flag: the smoke typecheck runs without strictNullChecks.)
		const why = 'reason' in verified ? verified.reason : 'unknown';
		throw new Error(
			`hidden upgrade: no signed release record for v${version} could be verified (${why}) — staying put (fail-closed)`
		);
	}
	const anchor = verified.anchor;
	const sha = anchor.sourceSha256;
	const ipns = anchor.ipnsName ?? '';
	const cid = anchor.ipfsCid ?? '';
	const problem = hiddenReleaseTargetProblem(sha, ipns, cid);
	if (problem !== null) throw new Error(problem);
	opts.onProgress?.(
		`target v${version}, ${CID_RE.test(cid) ? `CID ${cid}` : `IPNS ${ipns}`} — verifying against the on-chain SHA-256 (no clearnet)`
	);

	// 2. Peers: federation directory → hidden gateway bases (auto-discovered).
	const dir = await getLocalIndexerJson<DirectoryResponse>(base, '/v1/instances');
	const rows: PeerDirectoryRow[] = (dir.instances ?? []).map((i) => {
		// /v1/instances nests the hidden addresses under `alt_networks` (v1.16.8
		// fix — the v1.16.6 resolver read `i.tor`/`i.reg_alt_networks`, which don't
		// exist on the response, so it found ZERO peers and always reported
		// "no hidden gateway"). Read alt_networks first; keep the others as fallbacks.
		const an = (i.alt_networks ?? {}) as { tor?: unknown; i2p_b32?: unknown };
		const ra = (i.reg_alt_networks ?? {}) as { tor?: unknown; i2p_b32?: unknown };
		const pick = (...vals: unknown[]): string | null => {
			for (const v of vals) if (typeof v === 'string' && v.trim() !== '') return v.trim();
			return null;
		};
		return {
			tor: pick(an.tor, ra.tor, i.tor),
			i2p_b32: pick(an.i2p_b32, ra.i2p_b32, i.i2p_b32)
		};
	});
	const peerGateways = resolvePeerGateways(rows);
	if (peerGateways.length === 0) {
		throw new Error(
			'hidden upgrade: no federation peer advertises a Tor/I2P address in the directory yet — staying put (fail-closed)'
		);
	}
	// Tell the operator EXACTLY which hidden services are in play — a zero-clearnet
	// node should never be left guessing where its bytes came from.
	const shown = peerGateways
		.slice(0, 4)
		.map((g) => hiddenGatewayLabel(g))
		.join(', ');
	opts.onProgress?.(
		`fetching over ${peerGateways.length} hidden gateway${peerGateways.length === 1 ? '' : 's'} (Tor/I2P): ${shown}${peerGateways.length > 4 ? ', …' : ''}`
	);

	// 3. Fetch + verify (raced, SHA-checked, fail-closed) over Tor/I2P.
	const fetchTarball = makeHiddenTarballFetcher({ proxy: hiddenServiceProxyConfigFromEnv() });
	const result = await fetchHiddenUpgrade(
		{ ipnsName: ipns, ipfsCid: cid, expectedSha256: sha, version, path: 'morphit-latest.tar.gz' },
		{
			peerGateways,
			fetchTarball,
			sha256: (b) => createHash('sha256').update(b).digest('hex'),
			onProgress: opts.onProgress
		}
	);

	// 4. Write to a resolver-owned temp dir + a sibling .sha256, so the existing
	//    offline apply path can treat it like any local tarball. (Already verified.)
	const tdir = mkdtempSync(join(tmpdir(), 'morphit-hidden-upgrade-'));
	const name = `morphit-${version}.tar.gz`;
	const tarballPath = join(tdir, name);
	writeFileSync(tarballPath, result.bytes);
	writeFileSync(`${tarballPath}.sha256`, `${sha}  ${name}\n`);
	opts.onProgress?.(
		`verified release fetched over Tor/I2P from ${hiddenGatewayLabel(result.peer)} — applying (zero clearnet, no git.agorise.net / mirrors touched)`
	);
	return { tarballPath, version, servedBy: result.peer, anchor };
}
