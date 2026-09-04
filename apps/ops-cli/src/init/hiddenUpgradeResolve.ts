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
		const m = text.match(/^\s*MORPHIT_INDEXER_RPC_ENDPOINTS\s*=\s*(.*)$/m);
		if (!m) return false; // key absent → treat as clearnet (safe default)
		const val = (m[1] ?? '').trim().replace(/^["']|["']$/g, '').trim();
		return val === ''; // empty clearnet pool ⇒ hidden-only
	}
	return false; // no config found → not hidden-only (safe default)
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
	instances?: Array<{ reg_alt_networks?: unknown; tor?: string | null; i2p_b32?: string | null }>;
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
	if (!isHiddenOnlyFromEnvFile(opts.configEnvPaths)) return null;

	const bases = opts.indexerBases ?? LOCAL_INDEXER_BASES;
	opts.onProgress?.('hidden-only node — resolving the release from the federation over Tor/I2P…');

	// 1. Target: version + on-chain SHA + IPNS name, from the LOCAL indexer.
	const rel = await getJson<ReleaseTargetResponse>(bases, '/v1/release');
	const sha = rel.distribution?.source_sha256?.trim() ?? '';
	const ipns = rel.distribution?.ipns_name?.trim() ?? '';
	if (!/^[0-9a-f]{64}$/i.test(sha) || ipns === '') {
		throw new Error('hidden upgrade: on-chain release has no source_sha256 / ipns_name yet — cannot verify; staying put (fail-closed)');
	}

	// 2. Peers: federation directory → hidden gateway bases (auto-discovered).
	const dir = await getJson<DirectoryResponse>(bases, '/v1/instances');
	const rows: PeerDirectoryRow[] = (dir.instances ?? []).map((i) => {
		const alt = (i.reg_alt_networks ?? {}) as { tor?: unknown; i2p_b32?: unknown };
		return {
			tor: typeof i.tor === 'string' ? i.tor : typeof alt.tor === 'string' ? alt.tor : null,
			i2p_b32: typeof i.i2p_b32 === 'string' ? i.i2p_b32 : typeof alt.i2p_b32 === 'string' ? alt.i2p_b32 : null
		};
	});
	const peerGateways = resolvePeerGateways(rows);
	if (peerGateways.length === 0) {
		throw new Error('hidden upgrade: no federation peer exposes a hidden IPFS gateway yet — staying put (fail-closed)');
	}

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
	opts.onProgress?.(`verified release fetched from ${result.peer} — applying`);
	return { tarballPath, version: rel.version, servedBy: result.peer };
}
