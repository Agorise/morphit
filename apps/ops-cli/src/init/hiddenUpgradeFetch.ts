/**
 * hiddenUpgradeFetch — the hidden-only release fetch (v1.15.x stage 3b).
 *
 * A hidden-only node upgrades WITHOUT touching a clearnet host: it pulls the
 * release from federation peers' kubo gateways served over THEIR `.onion`/`.i2p`
 * (`http://<peer-hidden>/ipns/<name>/<path>`), fetched over Tor/I2P. IPNS is a
 * stable pointer ("latest"), so we don't need a per-release CID — but IPNS can
 * serve a STALE (rollback) copy, so the tarball is verified against the
 * on-chain `source_sha256` for the on-chain `version`. Trust the chain for WHICH
 * release; trust a peer only to CARRY the bytes.
 *
 * The five directives, enforced here:
 *   1. anti-rollback — bytes whose SHA-256 != the on-chain expected are rejected
 *      (a validly-old signed tarball can't downgrade you).
 *   2. fail-closed — if no peer yields a matching tarball, THROW; the caller
 *      stays on the current version. NEVER a clearnet fallback (that's the leak).
 *   3. fast + resilient — race several peers at once; first SHA-verified wins,
 *      the rest are aborted. Tor/I2P latency hides behind the quickest peer.
 *   4/5 (Matrix-bot gate, OS caveats) live at the gate + docs, not here.
 *
 * PURE + dependency-injected (peer fetch, sha256, clock) → unit-testable with no
 * network. The real wiring points `fetchTarball` at the fail-closed Tor/I2P
 * dispatcher and `sha256` at node:crypto.
 */

export interface HiddenUpgradeTarget {
	/** On-chain stable IPNS name for the release (distribution.ipns_name). */
	readonly ipnsName: string;
	/** On-chain content-addressed CID for the release dir (distribution.ipfs_cid).
	 *  v1.16.10 — fetching `/ipfs/<cid>/<path>` returns the EXACT canonical bytes
	 *  from any peer that has the CID pinned, regardless of that peer's IPNS
	 *  freshness. This is what makes the hidden upgrade robust to stale / divergent
	 *  peers (the IPNS-only fetch resolved each peer's "latest", which could be an
	 *  old or offline-staged tarball → SHA mismatch → nothing to install). */
	readonly ipfsCid?: string;
	/** On-chain SHA-256 of the release tarball (distribution.source_sha256), lower-hex. */
	readonly expectedSha256: string;
	/** On-chain version string (for logging / the "which release" contract). */
	readonly version: string;
	/** Gateway path under the IPNS name, e.g. 'morphit-latest.tar.gz'. */
	readonly path: string;
}

export interface HiddenUpgradeDeps {
	/** Federation peers' hidden gateway bases (`http://<onion>` / `http://<b32>.b32.i2p`),
	 *  resolved from known_instances over Tor/I2P — order is best-effort; we race. */
	readonly peerGateways: readonly string[];
	/** Fetch the tarball bytes from a full URL. MUST route over Tor/I2P (the
	 *  hidden dispatcher); rejects/aborts on the given signal. Injected. */
	fetchTarball(url: string, signal: AbortSignal): Promise<Uint8Array>;
	/** SHA-256 → lower-hex. Injected (node:crypto in prod). */
	sha256(bytes: Uint8Array): Promise<string> | string;
	/** How many peers to race concurrently (default 4). */
	readonly raceLimit?: number;
	/** Optional progress hook (drive the braille spinner). */
	onProgress?(msg: string): void;
}

export interface HiddenUpgradeResult {
	readonly bytes: Uint8Array;
	/** The peer gateway base that served the winning, verified tarball. */
	readonly peer: string;
}

/** Build the release URL on a peer's hidden IPNS gateway. */
export function hiddenReleaseUrl(gatewayBase: string, target: HiddenUpgradeTarget): string {
	const base = gatewayBase.replace(/\/+$/, '');
	const path = target.path.replace(/^\/+/, '');
	return `${base}/ipns/${encodeURIComponent(target.ipnsName)}/${path}`;
}

/** v1.16.10 — the URLs to try on a peer, in order of preference:
 *  1. the on-chain CID (`/ipfs/<cid>/<path>`) — content-addressed, so it returns
 *     the EXACT canonical bytes regardless of the peer's (possibly stale) IPNS;
 *  2. the IPNS pointer (`/ipns/<name>/<path>`) — the fallback for a peer that has
 *     "latest" but not that specific CID pinned.
 *  A peer serving old / offline-staged content will fail the CID fetch (it doesn't
 *  have those bytes) instead of handing back a wrong tarball that only fails later
 *  at the SHA check — so the canonical peer wins the race faster. */
export function hiddenReleaseUrls(gatewayBase: string, target: HiddenUpgradeTarget): string[] {
	const base = gatewayBase.replace(/\/+$/, '');
	const path = target.path.replace(/^\/+/, '');
	const urls: string[] = [];
	const cid = (target.ipfsCid ?? '').trim();
	if (/^[a-z0-9]{46,}$/i.test(cid)) urls.push(`${base}/ipfs/${cid}/${path}`);
	urls.push(`${base}/ipns/${encodeURIComponent(target.ipnsName)}/${path}`);
	return urls;
}

/** A federation directory row as the local indexer exposes it: the peer's
 *  on-chain hidden addresses. */
export interface PeerDirectoryRow {
	readonly tor?: string | null;
	readonly i2p_b32?: string | null;
}

/**
 * Resolve federation peers to hidden IPFS-gateway bases (`http://<hidden-host>`)
 * for the upgrade fetch. PURE. I2P-preferred (Tor-distrust hedge), Tor as the
 * fallback; a peer with neither is dropped (can't be reached privately). The
 * input is the chain-driven directory, so a newly-registered instance that
 * published a hidden address is included automatically — no config anywhere.
 * Deduped, order preserved (I2P-first peers lead so the race favours them).
 */
export function resolvePeerGateways(rows: readonly PeerDirectoryRow[]): string[] {
	const i2p: string[] = [];
	const tor: string[] = [];
	for (const r of rows) {
		const b32 = typeof r.i2p_b32 === 'string' ? r.i2p_b32.trim() : '';
		const onion = typeof r.tor === 'string' ? r.tor.trim() : '';
		if (b32.endsWith('.b32.i2p')) i2p.push(`http://${b32}`);
		else if (onion.endsWith('.onion')) tor.push(`http://${onion}`);
	}
	return [...new Set([...i2p, ...tor])];
}

/**
 * Fetch + verify the release from federation peers over Tor/I2P. Races peers in
 * batches of `raceLimit`; the first tarball whose SHA-256 matches the on-chain
 * `expectedSha256` wins and the rest are aborted. A peer that returns bytes with
 * the WRONG hash (stale/tampered) is discarded and the next peer tried. Throws
 * (fail-closed) if no peer yields a matching tarball — the caller must then stay
 * on the current version and NEVER reach for a clearnet mirror.
 */
export async function fetchHiddenUpgrade(
	target: HiddenUpgradeTarget,
	deps: HiddenUpgradeDeps
): Promise<HiddenUpgradeResult> {
	const expected = target.expectedSha256.trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(expected)) {
		throw new Error(`hidden-upgrade: on-chain expected SHA-256 is not a 64-hex digest (${target.expectedSha256})`);
	}
	const gateways = deps.peerGateways.filter((g) => typeof g === 'string' && g.length > 0);
	if (gateways.length === 0) {
		throw new Error('hidden-upgrade: no federation peer hidden gateways available — staying on current version (fail-closed)');
	}
	const raceLimit = Math.max(1, deps.raceLimit ?? 4);
	const failures: string[] = [];

	// One peer attempt: try the CID URL (exact canonical bytes) then the IPNS
	// fallback; the first that fetches AND matches the on-chain SHA wins. A peer
	// serving stale/divergent content matches neither and is rejected.
	const attempt = async (gw: string, signal: AbortSignal): Promise<HiddenUpgradeResult> => {
		const urls = hiddenReleaseUrls(gw, target);
		let lastErr = '';
		for (const url of urls) {
			try {
				deps.onProgress?.(`fetching release from ${url} over the hidden network…`);
				const bytes = await deps.fetchTarball(url, signal);
				const got = (await deps.sha256(bytes)).trim().toLowerCase();
				if (got === expected) return { bytes, peer: gw };
				lastErr = `sha_mismatch:${url}:${got}`; // stale/tampered → try next url
			} catch (err) {
				if (signal.aborted) throw err; // a sibling won; stop
				lastErr = String(err instanceof Error ? err.message : err);
			}
		}
		throw new Error(lastErr || `no_release:${gw}`);
	};

	// Race peers in batches; first VERIFIED win aborts the rest.
	for (let i = 0; i < gateways.length; i += raceLimit) {
		const batch = gateways.slice(i, i + raceLimit);
		const ac = new AbortController();
		let settled = false;
		const winner = await new Promise<HiddenUpgradeResult | null>((resolve) => {
			let pending = batch.length;
			for (const gw of batch) {
				attempt(gw, ac.signal)
					.then((res) => {
						if (settled) return;
						settled = true;
						ac.abort(); // cancel the rest of the batch
						resolve(res);
					})
					.catch((err) => {
						failures.push(String(err instanceof Error ? err.message : err));
						pending -= 1;
						if (pending === 0 && !settled) resolve(null);
					});
			}
		});
		if (winner) return winner;
	}

	throw new Error(
		`hidden-upgrade: no federation peer served a tarball matching the on-chain SHA-256 for ${target.version} ` +
			`(tried ${gateways.length} peer gateway(s); staying on current version, fail-closed). ` +
			`For hidden-only nodes to upgrade, a federation peer must expose its IPFS gateway over Tor/I2P ` +
			`(that peer: morphit-ops → Web firewall / IPFS gateway). ` +
			`Reasons: ${failures.slice(0, 6).join('; ')}`
	);
}
