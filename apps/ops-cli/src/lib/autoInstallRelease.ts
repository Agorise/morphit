/**
 * v1.24.7: a server installs a new Morphit release by itself early in the
 * morning (05:15 by its clock, after the night's restart window) when it
 * is a SECURITY release (the owner's choice, 2026-11-19), or every release
 * when its admin chose that (MORPHIT_AUTO_INSTALL_RELEASES in
 * /etc/morphit/updates.env: security | all | off).
 *
 * WHY. BunkerWeb and the frontend's nginx are container images each Morphit
 * release pins, so their security fixes reach a server only in a new release —
 * and until now only when its admin ran the upgrade by hand.
 *
 * HOW. `morphit-auto-install.timer` (nightly) runs ops/scripts/
 * morphit-auto-install.sh, which asks `morphit-ops __auto-install-check`
 * (this file) whether to install, and if so runs the ordinary
 * `morphit-ops upgrade --yes`: the same checks as by hand (the tarball's
 * SHA-256 against @morphit's signed on-chain record, a backup first, a
 * rollback when anything fails). The script reports how it ended through the
 * alert bot.
 *
 * WHAT DECIDES "security". Only the release record this server VERIFIED: the
 * transaction in the block, signed by @morphit's pinned posting key
 * (lib/releaseAnchor.ts), carrying `"security": true` — never a field from an
 * RPC node's or the indexer's answer, never the release page. The maintainer
 * sets it with `--security` on the payload builder (ELI5 BLOCK 3).
 */
import { readFileSync, statSync } from 'node:fs';
import type { HealCtx, HealResult } from './healTypes.ts';
import { installAndEnableUnits, type InstallUnitsResult } from './installUnits.ts';
import { join } from 'node:path';
import {
	BLURT_MAINNET_CHAIN_ID,
	MORPHIT_OFFICIAL_POSTING_PUBKEY,
	MORPHIT_RELEASE_ACCOUNT
} from '@morphit/operator-config';
import { parseUpdateSettings, UPDATES_ENV, type ReleaseInstalls } from './autoUpdates.ts';
import {
	findSignedReleaseAnchor,
	RECORD_MAX_PAGES_HIDDEN,
	RECORD_PAGE_SIZE_HIDDEN,
	RECORD_READ_TIMEOUT_HIDDEN_MS,
	type CondenserRead,
	type ReleaseAnchorResult
} from './releaseAnchor.ts';
import { chainRead, directNodeReaders } from './chainAccess.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import { indexerUnitEnvFiles } from '../init/hiddenUpgradeLocalIndexer.ts';
import { readOnchainReleaseTag, readReleaseRecordHint } from '../init/hiddenUpgradeResolve.ts';

export type AutoInstallDecision =
	| { readonly action: 'none'; readonly why: string }
	| {
			readonly action: 'install';
			readonly from: string;
			readonly to: string;
			readonly security: boolean;
	  }
	| { readonly action: 'refused'; readonly why: string };

/** Exit codes of `morphit-ops __auto-install-check`, read by the script. */
export const AUTO_INSTALL_EXIT = { none: 0, install: 10, refused: 11 } as const;

export interface AutoInstallRuntime {
	mode(): ReleaseInstalls;
	/** The installed release tag (`v1.24.7`), or null. */
	current(): string | null;
	/** @morphit's on-chain release tag from this node's own indexer, or null. */
	latest(): Promise<string | null>;
	/** The verified record for `tag` (signature against the pinned key). */
	anchor(tag: string): Promise<ReleaseAnchorResult>;
	isNewer(latest: string, current: string): boolean;
}

/** Decide; never throws. */
export async function decideAutoInstall(rt: AutoInstallRuntime): Promise<AutoInstallDecision> {
	const mode = rt.mode();
	if (mode === 'off')
		return {
			action: 'none',
			why: `automatic release installs are off (MORPHIT_AUTO_INSTALL_RELEASES=off in ${UPDATES_ENV})`
		};
	const current = rt.current();
	if (current === null)
		return { action: 'none', why: 'the installed release is not known (no release-info.json)' };
	const latest = await rt.latest();
	if (latest === null)
		return {
			action: 'none',
			why: "this node's indexer did not name @morphit's on-chain release (it may be starting); the next run asks again"
		};
	if (!rt.isNewer(latest, current))
		return { action: 'none', why: `${current} is the newest release` };
	if (mode === 'all') return { action: 'install', from: current, to: latest, security: false };
	const a = await rt.anchor(latest);
	if (!a.ok) {
		// A record that fails its check (signed by another key, no valid hash) is
		// a fault the operator must hear about; one not readable yet is a wait.
		const fault = !('notListed' in a && a.notListed) && !('unreadable' in a && a.unreadable);
		return fault
			? {
					action: 'refused',
					why: `the on-chain release record for ${latest} did not pass its check: ${a.reason}`
				}
			: {
					action: 'none',
					why: `the on-chain release record for ${latest} could not be read yet (${a.reason}); the next run asks again`
				};
	}
	if (!a.anchor.security)
		return {
			action: 'none',
			why: `${latest} is not marked as a security release, so it waits for you (sudo morphit-ops, option 2); MORPHIT_AUTO_INSTALL_RELEASES=all in ${UPDATES_ENV} installs every release`
		};
	return { action: 'install', from: current, to: latest, security: true };
}

/** One line of JSON for the script (no newline inside), and its exit code. */
export function decisionOutput(d: AutoInstallDecision): { json: string; code: number } {
	return { json: JSON.stringify(d), code: AUTO_INSTALL_EXIT[d.action] };
}

// ── the real server ───────────────────────────────────────────────────────

export function realAutoInstallRuntime(deps: {
	readonly isNewer: (latest: string, current: string) => boolean;
}): AutoInstallRuntime {
	const installDir = (process.env.MORPHIT_INSTALL_DIR ?? '').trim() || '/opt/morphit';
	const etcDir = process.env.MORPHIT_ETC_DIR ?? '/etc/morphit';
	const local = { unitEnvFiles: indexerUnitEnvFiles(installDir, etcDir) };
	const read = (p: string): string | null => {
		try {
			return readFileSync(p, 'utf8');
		} catch {
			return null;
		}
	};
	return {
		mode: () => parseUpdateSettings(read(UPDATES_ENV)).settings.installReleases,
		current: () => {
			try {
				const tag = (
					JSON.parse(read(join(installDir, 'release-info.json')) ?? 'null') as { tag?: unknown }
				)?.tag;
				return typeof tag === 'string' && /^v?\d+\.\d+\.\d+/.test(tag) ? tag : null;
			} catch {
				return null;
			}
		},
		latest: () => readOnchainReleaseTag(local, 15_000),
		anchor: async (tag) => {
			const hidden = isHiddenOnlyNode();
			const viaIndexer: CondenserRead = (method, params) =>
				chainRead(method, params, {
					hiddenOnly: () => hidden,
					hiddenReadTimeoutMs: RECORD_READ_TIMEOUT_HIDDEN_MS
				});
			return findSignedReleaseAnchor(
				{ sources: [viaIndexer, ...directNodeReaders({ hiddenOnly: () => hidden })] },
				{
					tag,
					signer: MORPHIT_RELEASE_ACCOUNT,
					pinnedPubkey: MORPHIT_OFFICIAL_POSTING_PUBKEY,
					chainId: BLURT_MAINNET_CHAIN_ID,
					...(hidden
						? { pageSize: RECORD_PAGE_SIZE_HIDDEN, maxPages: RECORD_MAX_PAGES_HIDDEN }
						: {}),
					hint: await readReleaseRecordHint(local, tag)
				}
			);
		},
		isNewer: deps.isNewer
	};
}

// ── the heal that turns it on (every upgrade) ─────────────────────────────

export const AUTO_INSTALL_UNITS = [
	'morphit-auto-install.service',
	'morphit-auto-install.timer'
] as const;
export const AUTO_INSTALL_TIMER = 'morphit-auto-install.timer';

export interface AutoInstallHealRuntime {
	/** Install the units and turn the timer on (reads back enabled + active). */
	install(): InstallUnitsResult;
	/** The script the unit runs is there and executable. */
	scriptReady(): boolean;
	/** Tonight's decision, asked now (installs nothing). */
	decide(): Promise<AutoInstallDecision>;
	mode(): ReleaseInstalls;
}

/**
 * Installed-box heal (v1.24.7): the nightly timer is installed and on, and its
 * check works — asked once now, which installs nothing. Never throws.
 */
export async function healAutoInstall(
	ctx: HealCtx,
	rt: AutoInstallHealRuntime
): Promise<HealResult> {
	if (!rt.scriptReady())
		return {
			strategy: 'left-alone',
			verified: false,
			detail:
				'Automatic release installs: ops/scripts/morphit-auto-install.sh is missing from this install or not executable, so the nightly check was not turned on. On this server: sudo morphit-ops upgrade --heals'
		};
	const inst = rt.install();
	if (!inst.ok)
		return {
			strategy: 'left-alone',
			verified: false,
			detail: `Automatic release installs: the nightly check could not be turned on (${inst.detail ?? 'unknown reason'}). On this server: sudo systemctl enable --now ${AUTO_INSTALL_TIMER}`
		};
	const mode = rt.mode();
	const stop = ctx.spinner(
		'Asking once whether the next early-morning check would install a newer release…'
	);
	let d: AutoInstallDecision;
	try {
		d = await rt.decide();
	} finally {
		stop();
	}
	const what =
		mode === 'off'
			? `off (MORPHIT_AUTO_INSTALL_RELEASES=off in ${UPDATES_ENV}): new releases wait for you`
			: mode === 'all'
				? "every new Morphit release installs itself early in the morning (05:15–06:00 by the server's clock), checked against @morphit's on-chain record first and rolled back if a step fails"
				: "a new Morphit release marked as a security release installs itself early in the morning (05:15–06:00 by the server's clock), checked against @morphit's on-chain record first and rolled back if a step fails; other releases wait for you";
	if (d.action === 'refused')
		return {
			strategy: 'record-refused',
			verified: false,
			detail: `Automatic release installs: ${what}. Asked now: ${d.why}; nothing will be installed from it. On this server: sudo morphit-ops upgrade --check-only`
		};
	const now =
		d.action === 'install'
			? `${d.to} will be installed at the next early-morning check (${d.security ? 'a security release' : 'MORPHIT_AUTO_INSTALL_RELEASES=all'})`
			: d.why;
	return {
		strategy: inst.written.length > 0 ? 'installed' : 'already',
		// installAndEnableUnits read the timer back enabled and active.
		verified: true,
		routine: inst.written.length === 0 && d.action === 'none',
		detail: `Automatic release installs: ${what} (the timer is on, checked). Asked now: ${now}.`
	};
}

export function realAutoInstallHealRuntime(
	installDir: string,
	deps: {
		readonly isNewer: (latest: string, current: string) => boolean;
	}
): AutoInstallHealRuntime {
	const systemdDir = process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system';
	const noSystemd = process.env.MORPHIT_HEAL_NO_SYSTEMD === '1';
	const runtime = realAutoInstallRuntime(deps);
	return {
		install: () =>
			installAndEnableUnits({
				templateDir: join(installDir, 'ops', 'systemd'),
				systemdDir,
				units: AUTO_INSTALL_UNITS,
				timer: AUTO_INSTALL_TIMER,
				noSystemd
			}),
		scriptReady: () => {
			try {
				const st = statSync(join(installDir, 'ops', 'scripts', 'morphit-auto-install.sh'));
				return st.isFile() && (st.mode & 0o111) !== 0;
			} catch {
				return false;
			}
		},
		decide: () => decideAutoInstall(runtime),
		mode: runtime.mode
	};
}
