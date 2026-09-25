import { readFileSync } from 'node:fs';
import { hiddenHostNetworkOf, isLocalHost } from '@morphit/hidden-transport';
/**
 * clearnetGate — computes the `clearnet_eliminated` flag (v1.15.x stage 4).
 *
 * The single keystone the "Zero use of clearnet internet" claim (frontend brag,
 * Security page, FAQ, blog) hangs on. It is TRUE only when EVERY outbound leg of
 * a hidden-only node is provably private over Tor/I2P — a strict AND, so any one
 * unproven leg keeps it FALSE and the strong claim off. This is what stops the
 * marketing ever outrunning the code.
 *
 * PURE + total → exhaustively unit-tested. Each leg is derived from real runtime
 * facts by the caller (see /v1/instance); this module only combines them.
 */

export interface ClearnetEliminationLegs {
	/** Chain reads go over onion/i2p RPC only — the clearnet RPC pool is empty
	 *  AND at least one hidden RPC endpoint is configured (a truly hidden-only
	 *  node, not merely a misconfigured one with no RPC at all). */
	readonly chainHidden: boolean;
	/** This node runs/publishes a Tor .onion address. */
	readonly transportTor: boolean;
	/** This node runs/publishes an I2P address. Both transports are REQUIRED
	 *  (the maintainer's directive: hidden-only means Tor AND I2P as equals) so a compromise
	 *  or block of one network can't dark the node — and so "zero clearnet" never
	 *  rests on a single hidden network. */
	readonly transportI2p: boolean;
	/** Price comes from the federation over Tor/I2P (federated median primary),
	 *  never a clearnet price API. */
	readonly priceFederated: boolean;
	/** The served frontend auto-loads nothing external (build-time invariant,
	 *  enforced by frontend-local-only-smoke). */
	readonly frontendLocal: boolean;
	/** Upgrades are fetched from federation peers' hidden IPFS gateways over
	 *  Tor/I2P, verified against the on-chain SHA, fail-closed. */
	readonly upgradeHidden: boolean;
	/** No clearnet Matrix: the alert bot is not configured to run (no alert
	 *  MXID in /etc/morphit/matrix-bot.env, or no such file), or its homeserver
	 *  is on this box (loopback). See {@link matrixBotIsClean}. */
	readonly matrixClean: boolean;
	/** v1.18.0 (F32) — this node's RELAY reaches the chain over hidden
	 *  services only, as it reported on its own /v1/health. The relay is a
	 *  separate process with its own endpoint list, and it is the one that
	 *  broadcasts; the other legs are all about the indexer. */
	readonly relayHidden: boolean;
}

/**
 * Compute `clearnet_eliminated`. Strict AND of every leg — a hidden-only node
 * that hasn't proven all of them is NOT "zero clearnet", and the flag stays
 * false so no strong claim renders.
 */
export function computeClearnetEliminated(legs: ClearnetEliminationLegs): boolean {
	return (
		legs.chainHidden &&
		legs.transportTor &&
		legs.transportI2p &&
		legs.priceFederated &&
		legs.frontendLocal &&
		legs.upgradeHidden &&
		legs.matrixClean &&
		legs.relayHidden
	);
}

/** The legs still preventing `clearnet_eliminated` — surfaced on /v1/instance so
 *  an operator can see exactly what to fix (e.g. "add an I2P address", "your
 *  Matrix homeserver is clearnet"). Empty array ⇔ eliminated. PURE. */
export function clearnetEliminationMissing(legs: ClearnetEliminationLegs): (keyof ClearnetEliminationLegs)[] {
	return (Object.keys(legs) as (keyof ClearnetEliminationLegs)[]).filter((k) => !legs[k]);
}

/**
 * Is a Matrix homeserver URL a hidden-service address (so the alert bot doesn't
 * touch clearnet)? PURE. An absent/empty homeserver means the bot isn't wired to
 * one → clean. A clearnet host → not clean.
 */
export function matrixHomeserverIsHidden(homeserverUrl: string | null | undefined): boolean {
	if (!homeserverUrl || homeserverUrl.trim() === '') return true; // no bot / no server → clean
	let host: string;
	try {
		host = new URL(homeserverUrl).hostname.toLowerCase();
	} catch {
		return false; // unparseable → treat as unsafe
	}
	return host.endsWith('.onion') || host.endsWith('.i2p');
}

// ─── the alert bot's real configuration (v1.18.0 deep-deep, M3) ───────────
//
// WHAT WAS WRONG. `matrixClean` read `MORPHIT_INSTANCE_MATRIX_HOMESERVER`, which
// no installer, playbook or ops-cli command sets — so it was always "clean". The
// bot's real settings live in its own env file: it runs when
// `MORPHIT_MATRIX_BOT_ALERT_MXID` is set (apps/matrix-bot/src/main.ts exits 0
// otherwise) and talks to `MORPHIT_MATRIX_BOT_HOMESERVER`, default
// https://matrix.org, with no Tor routing. A tor-only node running the bot
// therefore claimed `clearnet_eliminated: true` while the bot connected to
// matrix.org from the home IP.
//
// The indexer runs as root (ops/systemd/morphit-indexer.service), so it can read
// that 0600 file. When it cannot — any error other than "no such file" — the
// answer is unknown, and unknown is never clean.

/** The file the bot's systemd unit loads (EnvironmentFile=). */
export const MATRIX_BOT_ENV_PATH = '/etc/morphit/matrix-bot.env';
/** The bot's own default homeserver (apps/matrix-bot/src/config.ts). */
const MATRIX_BOT_DEFAULT_HOMESERVER = 'https://matrix.org';

export type MatrixBotPosture =
	| { readonly state: 'inert' }
	| { readonly state: 'active'; readonly homeserver: string }
	| { readonly state: 'unknown' };

/** Parse the bot's env text the way systemd does (last assignment wins, one
 *  layer of matching quotes stripped). PURE. */
export function matrixBotPostureFromEnvText(text: string): MatrixBotPosture {
	const vals = new Map<string, string>();
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === '' || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq <= 0) continue;
		let v = line.slice(eq + 1).trim();
		if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0]!)) v = v.slice(1, -1);
		vals.set(line.slice(0, eq).replace(/^export\s+/, '').trim(), v);
	}
	if ((vals.get('MORPHIT_MATRIX_BOT_ALERT_MXID') ?? '').trim() === '') return { state: 'inert' };
	const hs = (vals.get('MORPHIT_MATRIX_BOT_HOMESERVER') ?? '').trim();
	return { state: 'active', homeserver: hs === '' ? MATRIX_BOT_DEFAULT_HOMESERVER : hs };
}

/** Does the bot, as configured, stay off clearnet? Only when it will not run,
 *  or when its homeserver is on this box. A `.onion`/`.i2p` homeserver is NOT
 *  clean: the bot has no Tor/I2P route, so it would hand that name to the
 *  system resolver. PURE. */
export function matrixBotIsClean(p: MatrixBotPosture): boolean {
	if (p.state === 'inert') return true;
	if (p.state === 'unknown') return false;
	try {
		return isLocalHost(new URL(p.homeserver).hostname);
	} catch {
		return false;
	}
}

let matrixBotEnvPath = MATRIX_BOT_ENV_PATH;
let matrixBotCache: { at: number; posture: MatrixBotPosture } | null = null;
const MATRIX_BOT_CACHE_MS = 30_000;

/** Read the bot's posture from its env file (cached briefly: /v1/instance and
 *  the poller both ask). */
export function currentMatrixBotPosture(now: number = Date.now()): MatrixBotPosture {
	if (matrixBotCache !== null && now - matrixBotCache.at < MATRIX_BOT_CACHE_MS) {
		return matrixBotCache.posture;
	}
	let posture: MatrixBotPosture;
	try {
		posture = matrixBotPostureFromEnvText(readFileSync(matrixBotEnvPath, 'utf8'));
	} catch (err) {
		posture = (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'inert' } : { state: 'unknown' };
	}
	matrixBotCache = { at: now, posture };
	return posture;
}

/** Tests only: point the reader at another file (null restores the default). */
export function _setMatrixBotEnvPathForTesting(p: string | null): void {
	matrixBotEnvPath = p ?? MATRIX_BOT_ENV_PATH;
	matrixBotCache = null;
}

/** The frontend is local-only by build invariant (frontend-local-only-smoke
 *  fails CI otherwise), so the served bundle a node ships auto-loads nothing
 *  external. Exposed as a constant the runtime gate can trust. */
export const FRONTEND_IS_LOCAL_ONLY = true;

/**
 * Assemble the legs: seven from config, and the relay's from what the relay
 * itself last reported (relayPosture.ts) — passed in, because it is the one leg
 * config cannot answer.
 *
 * Extracted so the SELF row in the federation directory can be scored with the
 * exact same inputs `/v1/instance` serves to peers. Before this, a node's own
 * `cached_clearnet_eliminated` was only ever written by the network probe —
 * which is skipped for self — so the column sat at its `false` default forever
 * and the one instance that had actually earned the badge was the only one that
 * could not see it on its own directory card. (Same defect class as cp311, one
 * column over.)
 */
export function clearnetLegsFromConfig(cfg: {
	blurtRpcEndpoints: readonly unknown[];
	hiddenRpcEndpoints: readonly unknown[];
	instanceTorAddress?: string | null;
	instanceI2pB32Address?: string | null;
	instanceI2pNameAddress?: string | null;
	instanceMatrixHomeserver?: string | null;
}, relayHiddenOnly: boolean, matrixBot: MatrixBotPosture = currentMatrixBotPosture()): ClearnetEliminationLegs {
	return {
		chainHidden: cfg.blurtRpcEndpoints.length === 0 && cfg.hiddenRpcEndpoints.length > 0,
		transportTor: hiddenHostNetworkOf(cfg.instanceTorAddress ?? '') === 'tor',
		transportI2p:
			hiddenHostNetworkOf(cfg.instanceI2pB32Address ?? '') === 'i2p' ||
			hiddenHostNetworkOf(cfg.instanceI2pNameAddress ?? '') === 'i2p',
		priceFederated: cfg.blurtRpcEndpoints.length === 0,
		frontendLocal: FRONTEND_IS_LOCAL_ONLY,
		upgradeHidden: true,
		// The bot's real config decides (M3); the old instance-level variable is
		// still honoured when an operator did set it to a clearnet server.
		matrixClean: matrixBotIsClean(matrixBot) && matrixHomeserverIsHidden(cfg.instanceMatrixHomeserver),
		relayHidden: relayHiddenOnly
	};
}
