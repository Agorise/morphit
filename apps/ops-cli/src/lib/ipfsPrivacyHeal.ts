/**
 * Post-upgrade self-heal: bring an EXISTING node's Kubo to the privacy settings
 * a fresh install now gets.
 *
 * WHY A HEAL. `morphit-ops upgrade` does not re-run Ansible, so the new ipfs-role
 * settings would reach only new installs. Every existing tor-only node would
 * keep a Kubo that joins the public IPFS DHT from its home IP, opens a UPnP port
 * on the home router and announces itself as a Morphit release host, and every
 * node would keep Kubo's telemetry POSTing to a third party.
 *
 * WHAT IT CHANGES. Exactly the settings in ops/ipfs/morphit-ipfs-privacy.sh, the
 * same script the Ansible role runs: the hidden-only set on a hidden-only node
 * (empty clearnet RPC pool in indexer.env), the every-node set (telemetry off)
 * elsewhere. Nothing when they are already in place.
 *
 * VERIFY, THEN FALL BACK. Kubo reads its config at start, so a running ipfs is
 * restarted and must come back and answer. If it does not, the previous config
 * file is put back byte for byte and ipfs restarted on it, so the heal never
 * leaves the service down. A service that was not running is not started.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHiddenOnlyNode } from './hiddenOnly.ts';

export interface IpfsPrivacyRuntime {
	/** Kubo installed and a repo present. */
	kuboPresent(): boolean;
	/** Run the privacy script in a mode; its exit status. */
	runPrivacy(mode: 'check-hidden' | 'apply-hidden' | 'check-base' | 'apply-base'): number;
	/** The repo config file, raw; null when unreadable. */
	readConfig(): string | null;
	/** Put a config file back, raw. */
	writeConfig(text: string): boolean;
	isActive(): boolean;
	restart(): boolean;
	/** The daemon answers on its API. */
	answers(): boolean;
	/** Peers in the WAN DHT routing table (`ipfs stats dht wan`); null when the command fails. */
	dhtPeers(): number | null;
	sleep(ms: number): Promise<void>;
	spinner(label: string): () => void;
}

export type IpfsPrivacyOutcome =
	| { kind: 'no-kubo' }
	| { kind: 'already-private'; mode: 'hidden' | 'base' }
	| { kind: 'no-config' }
	| { kind: 'apply-failed' }
	| { kind: 'applied-not-running'; mode: 'hidden' | 'base' }
	| { kind: 'applied'; mode: 'hidden' }
	| { kind: 'applied'; mode: 'base'; dhtPeers: number }
	| { kind: 'rolled-back' }
	| { kind: 'down-after-rollback' };

const IPFS_REPO = '/var/lib/ipfs/.ipfs';
const IPFS_USER = 'ipfs';
const DHT_WAIT_MS = 60_000;
const DHT_POLL_MS = 3_000;

async function cameBack(rt: IpfsPrivacyRuntime, tries: number, waitMs: number): Promise<boolean> {
	for (let i = 0; i < tries; i++) {
		if (rt.isActive() && rt.answers()) return true;
		await rt.sleep(waitMs);
	}
	return false;
}

export async function applyAndVerifyIpfsPrivacy(opts: {
	readonly hiddenOnly: boolean;
	readonly runtime: IpfsPrivacyRuntime;
	readonly info: (m: string) => void;
	readonly warn: (m: string) => void;
	readonly tries?: number;
	readonly waitMs?: number;
}): Promise<IpfsPrivacyOutcome> {
	const rt = opts.runtime;
	const mode = opts.hiddenOnly ? 'hidden' : 'base';
	const tries = opts.tries ?? 20;
	const waitMs = opts.waitMs ?? 1500;
	if (!rt.kuboPresent()) return { kind: 'no-kubo' };
	// Each run of the privacy script (as the ipfs user, up to 60 s) is a wait.
	const spun = <T>(label: string, fn: () => T): T => {
		const s = rt.spinner(label);
		try {
			return fn();
		} finally {
			s();
		}
	};
	if (spun('Checking the IPFS privacy settings…', () => rt.runPrivacy(`check-${mode}`)) === 0)
		return { kind: 'already-private', mode };

	const backup = rt.readConfig();
	if (backup === null) {
		opts.warn(
			'Skipped the IPFS privacy settings: could not read the IPFS config to keep a copy first.'
		);
		return { kind: 'no-config' };
	}
	const wasActive = rt.isActive();
	if (spun('Applying the IPFS privacy settings…', () => rt.runPrivacy(`apply-${mode}`)) !== 0) {
		// Undo any part that did get written; the running daemon never saw it.
		rt.writeConfig(backup);
		opts.warn('Could not apply the IPFS privacy settings; IPFS keeps its previous settings.');
		return { kind: 'apply-failed' };
	}
	const what =
		mode === 'hidden'
			? 'IPFS now stays off the public IPFS network (hidden-only node); it still serves the release over Tor/I2P.'
			: 'IPFS now uses only its own settings (no AutoConf fetch from conf.ipfs-mainnet.org, no HTTP routers such as ' +
				'cid.contact) and seeds the release over the public DHT.';
	if (!wasActive) {
		opts.info(`${what} (IPFS is not running; the settings apply when it starts.)`);
		return { kind: 'applied-not-running', mode };
	}

	let stop = rt.spinner('Restarting IPFS with the new privacy settings…');
	rt.restart();
	const up = await cameBack(rt, tries, waitMs);
	stop();
	if (up && rt.runPrivacy(`check-${mode}`) === 0) {
		opts.info(what);
		if (mode === 'hidden') return { kind: 'applied', mode };
		// The node now finds peers only through the DHT: see that it joined it.
		// No roll-back when it has not yet — the settings check out, and peers
		// can be slow to answer.
		stop = rt.spinner('Checking that IPFS has joined the public DHT…');
		let peers = 0;
		try {
			for (let waited = 0; ; waited += DHT_POLL_MS) {
				peers = rt.dhtPeers() ?? 0;
				if (peers > 0 || waited + DHT_POLL_MS >= DHT_WAIT_MS) break;
				await rt.sleep(DHT_POLL_MS);
			}
		} finally {
			stop();
		}
		if (peers > 0)
			opts.info(`\u2713 IPFS is on the public DHT (${peers} peers in its routing table).`);
		else
			opts.warn(
				'IPFS has its new settings but has not found DHT peers yet; on this server check later with: ' +
					`sudo -u ${IPFS_USER} env IPFS_PATH=${IPFS_REPO} ipfs stats dht wan`
			);
		return { kind: 'applied', mode, dhtPeers: peers };
	}

	// Fall back: the previous file, byte for byte, and the service back up.
	rt.writeConfig(backup);
	stop = rt.spinner('IPFS did not come back cleanly; restoring its previous settings…');
	rt.restart();
	const upAgain = await cameBack(rt, tries, waitMs);
	stop();
	if (upAgain) {
		opts.warn(
			'IPFS did not come back with the new privacy settings, so its previous settings were restored ' +
				'and it is running again. Check `sudo systemctl status ipfs` and re-run the upgrade.'
		);
		return { kind: 'rolled-back' };
	}
	opts.warn(
		'IPFS is not running after restoring its previous settings. Release hosting is paused; ' +
			'the marketplace is unaffected. Check `sudo systemctl status ipfs`.'
	);
	return { kind: 'down-after-rollback' };
}

/** Peer lines in `ipfs stats dht wan` output (one per peer, under the
 *  `Bucket` headers); 0 when there is no bucket. PURE. */
export function countDhtPeers(out: string): number {
	if (!/^\s*Bucket\b/m.test(out)) return 0;
	return out.split('\n').filter((l) => /^\s+@?\s*(?:12D3Koo|Qm)[1-9A-HJ-NP-Za-km-z]+/.test(l))
		.length;
}

/** The privacy script from the tree this binary belongs to, falling back to
 *  the copy Ansible installs. */
function privacyScript(): string | null {
	const self = process.argv[1] ?? '';
	const m = /^(.*)\/apps\/ops-cli\/dist\//.exec(self);
	const candidates = [
		...(m && m[1] ? [join(m[1], 'ops', 'ipfs', 'morphit-ipfs-privacy.sh')] : []),
		'/opt/morphit/ops/ipfs/morphit-ipfs-privacy.sh',
		'/usr/local/lib/morphit/morphit-ipfs-privacy.sh'
	];
	return candidates.find((p) => existsSync(p)) ?? null;
}

/** The real entry point, run from runSelfHeals. */
export async function healIpfsPrivacy(deps: {
	readonly info: (m: string) => void;
	readonly warn: (m: string) => void;
	readonly spinner: (label: string) => () => void;
}): Promise<IpfsPrivacyOutcome> {
	const script = privacyScript();
	const cfg = join(IPFS_REPO, 'config');
	const asIpfs = (args: string[], timeout: number): number =>
		spawnSync('sudo', ['-u', IPFS_USER, 'env', `IPFS_PATH=${IPFS_REPO}`, ...args], {
			stdio: 'ignore',
			timeout
		}).status ?? 1;
	return applyAndVerifyIpfsPrivacy({
		hiddenOnly: isHiddenOnlyNode(),
		info: deps.info,
		warn: deps.warn,
		runtime: {
			kuboPresent: () =>
				script !== null &&
				existsSync(cfg) &&
				spawnSync('sh', ['-c', 'command -v ipfs'], { stdio: 'ignore' }).status === 0,
			runPrivacy: (mode) => asIpfs(['sh', script!, mode], 60_000),
			readConfig: () => {
				try {
					return readFileSync(cfg, 'utf8');
				} catch {
					return null;
				}
			},
			// Rewrites the existing file in place, so its owner and mode stay.
			writeConfig: (text) => {
				try {
					writeFileSync(cfg, text);
					return true;
				} catch {
					return false;
				}
			},
			isActive: () => spawnSync('systemctl', ['is-active', '--quiet', 'ipfs']).status === 0,
			restart: () => spawnSync('systemctl', ['restart', 'ipfs'], { timeout: 90_000 }).status === 0,
			answers: () => asIpfs(['ipfs', '--timeout=5s', 'id'], 15_000) === 0,
			dhtPeers: () => {
				const r = spawnSync(
					'sudo',
					[
						'-u',
						IPFS_USER,
						'env',
						`IPFS_PATH=${IPFS_REPO}`,
						'ipfs',
						'--timeout=10s',
						'stats',
						'dht',
						'wan'
					],
					{ encoding: 'utf8', timeout: 20_000 }
				);
				return r.status === 0 ? countDhtPeers(r.stdout ?? '') : null;
			},
			sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
			spinner: deps.spinner
		}
	});
}
