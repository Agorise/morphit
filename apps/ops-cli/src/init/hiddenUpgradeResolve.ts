/**
 * hiddenUpgradeResolve — the self-contained hidden-only upgrade resolution
 * (v1.16.1 stage 3). ALL hidden-only decision + fetch logic lives here so the
 * change to the 1141-line `runUpgrade` is five tiny `if (hiddenOnly)` calls, not
 * logic smeared across the critical path. Every function is null/throw-clean:
 *   - not hidden-only → the caller keeps its existing clearnet behaviour.
 *   - hidden-only but a step fails → THROW (fail-closed; the caller aborts and
 *     stays on the current version — NEVER a clearnet fallback).
 *
 * Security note: the fetched tarball is verified against the on-chain
 * `source_sha256` inside `fetchHiddenUpgrade` (it throws on mismatch), so a
 * bad/rolled-back tarball can never be returned from here.
 *
 * Offline-safe: only node built-ins + the dependency-free @morphit/hidden-transport
 * + undici (already bundled). Nothing new to fetch at install time.
 */
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { hiddenServiceProxyConfigFromEnv } from '@morphit/hidden-transport';
import { fetchHiddenUpgrade, resolvePeerGateways, type PeerDirectoryRow } from './hiddenUpgradeFetch.js';
import { makeHiddenTarballFetcher } from './hiddenUpgradeTransport.js';

/** Candidate local-indexer base URLs (loopback first, then the docker bridge —
 *  morphit.io answers on 172.18.0.1, morphitlat on 127.0.0.1). Loopback is a
 *  local address, never clearnet. */
const LOCAL_INDEXER_BASES = ['http://127.0.0.1:8081', 'http://172.18.0.1:8081', 'http://172.17.0.1:8081'];

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
		const val = (m[1] ?? '').trim().replace(/^["']|["']$/g, '').trim();
		return val === ''; // empty clearnet pool ⇒ hidden-only
	}
	return false; // no config found → not hidden-only (safe default)
}

/**
 * Authoritative hidden-only decision (v1.16.6). PRIMARY: the local indexer's
 * `/v1/instance` `clearnet_eliminated` — the SAME seven-leg gate that earns the
 * directory badge, so the upgrade path can never disagree with what the node
 * advertises. FALLBACK (only if the local indexer is unreachable mid-upgrade):
 * the config-file heuristic.
 *
 * This replaces relying on the file heuristic alone, which silently mis-defaulted
 * a hidden-only node to CLEARNET because it read `morphit.config.env` while the
 * RPC pool actually lives in `indexer.env` — the bug that let morphitlat fetch
 * its own upgrade over git.agorise.net (v1.16.6 fix).
 */
export async function isHiddenOnly(
	bases: readonly string[],
	configEnvPaths: readonly string[]
): Promise<boolean> {
	try {
		const inst = await getJson<{ clearnet_eliminated?: unknown }>(bases, '/v1/instance', 4000);
		if (typeof inst.clearnet_eliminated === 'boolean') return inst.clearnet_eliminated;
	} catch {
		// local indexer unreachable — fall through to the config-file heuristic
	}
	return isHiddenOnlyFromEnvFile(configEnvPaths);
}

async function getJson<T>(bases: readonly string[], path: string, timeoutMs = 5000): Promise<T> {
	let lastErr: unknown = null;
	for (const base of bases) {
		const ctrl = new AbortController();
		const t = setTimeout(() => ctrl.abort(), timeoutMs);
		try {
			const res = await fetch(`${base}${path}`, { signal: ctrl.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return (await res.json()) as T;
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(t);
		}
	}
	throw new Error(`hidden upgrade: local indexer unreachable for ${path}: ${String(lastErr)}`);
}

interface ReleaseTargetResponse {
	version: string;
	distribution: { source_sha256?: string; ipns_name?: string } | null;
}
interface DirectoryResponse {
	instances?: Array<{
		alt_networks?: { tor?: string | null; i2p_b32?: string | null } | null;
		reg_alt_networks?: unknown;
		tor?: string | null;
		i2p_b32?: string | null;
	}>;
}

export interface HiddenUpgradeResolution {
	readonly tarballPath: string;
	readonly version: string;
	readonly servedBy: string;
}

/**
 * If this node is hidden-only, fetch + verify the release tarball over Tor/I2P
 * from a federation peer and return its local path + version. Returns null when
 * NOT hidden-only (caller proceeds on its normal clearnet path). Throws
 * (fail-closed) when hidden-only but the release can't be privately obtained.
 */
export async function tryResolveHiddenUpgrade(opts: {
	readonly configEnvPaths: readonly string[];
	readonly indexerBases?: readonly string[];
	onProgress?: (msg: string) => void;
}): Promise<HiddenUpgradeResolution | null> {
	const bases = opts.indexerBases ?? LOCAL_INDEXER_BASES;
	if (!(await isHiddenOnly(bases, opts.configEnvPaths))) return null;

	opts.onProgress?.('hidden-only node — resolving the release from the federation over Tor/I2P (zero clearnet)…');

	// 1. Target: version + on-chain SHA + IPNS name, from the LOCAL indexer.
	const rel = await getJson<ReleaseTargetResponse>(bases, '/v1/release');
	const sha = rel.distribution?.source_sha256?.trim() ?? '';
	const ipns = rel.distribution?.ipns_name?.trim() ?? '';
	if (!/^[0-9a-f]{64}$/i.test(sha) || ipns === '') {
		throw new Error('hidden upgrade: on-chain release has no source_sha256 / ipns_name yet — cannot verify; staying put (fail-closed)');
	}
	opts.onProgress?.(`target v${rel.version}, IPNS ${ipns} — verifying against the on-chain SHA-256 (no clearnet)`);

	// 2. Peers: federation directory → hidden gateway bases (auto-discovered).
	const dir = await getJson<DirectoryResponse>(bases, '/v1/instances');
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
		throw new Error('hidden upgrade: no federation peer advertises a Tor/I2P address in the directory yet — staying put (fail-closed)');
	}
	// Tell the operator EXACTLY which hidden services are in play — a zero-clearnet
	// node should never be left guessing where its bytes came from.
	const shown = peerGateways.slice(0, 4).map((g) => hiddenGatewayLabel(g)).join(', ');
	opts.onProgress?.(
		`fetching over ${peerGateways.length} hidden gateway${peerGateways.length === 1 ? '' : 's'} (Tor/I2P): ${shown}${peerGateways.length > 4 ? ', …' : ''}`
	);

	// 3. Fetch + verify (raced, SHA-checked, fail-closed) over Tor/I2P.
	const fetchTarball = makeHiddenTarballFetcher({ proxy: hiddenServiceProxyConfigFromEnv() });
	const result = await fetchHiddenUpgrade(
		{ ipnsName: ipns, expectedSha256: sha, version: rel.version, path: 'morphit-latest.tar.gz' },
		{ peerGateways, fetchTarball, sha256: (b) => createHash('sha256').update(b).digest('hex'), onProgress: opts.onProgress }
	);

	// 4. Write to a resolver-owned temp dir + a sibling .sha256, so the existing
	//    offline apply path can treat it like any local tarball. (Already verified.)
	const tdir = mkdtempSync(join(tmpdir(), 'morphit-hidden-upgrade-'));
	const name = `morphit-${rel.version}.tar.gz`;
	const tarballPath = join(tdir, name);
	writeFileSync(tarballPath, result.bytes);
	writeFileSync(`${tarballPath}.sha256`, `${sha}  ${name}\n`);
	opts.onProgress?.(
		`verified release fetched over Tor/I2P from ${hiddenGatewayLabel(result.peer)} — applying (zero clearnet, no git.agorise.net / mirrors touched)`
	);
	return { tarballPath, version: rel.version, servedBy: result.peer };
}
