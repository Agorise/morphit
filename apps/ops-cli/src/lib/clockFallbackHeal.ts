/**
 * Post-upgrade self-heal (v1.21.15): the CLOCK FALLBACK on a node that keeps
 * clearnet NTP.
 *
 * WHY. The owner's rule: when a clearnet source does not answer, the hidden
 * ones are tried. A node's clock comes from public NTP pools (chrony, or
 * systemd-timesyncd); where UDP 123 is blocked or the pools cannot be reached,
 * nothing set it, and a wrong clock breaks TLS, chat timestamps and the chain
 * head checks. A tor-only node already sets its clock from onion services
 * (morphit-tor-timesync.timer, lib/torOnlyOsHeal.ts).
 *
 * WHAT. On a node that is NOT hidden-only: root-owned copies of
 * morphit-clock-fallback.sh and morphit-tor-timesync.sh, and
 * morphit-clock-fallback.service/.timer, which run the first every 6 hours:
 * while the NTP client reports the clock synchronised it does nothing;
 * otherwise it runs the second, which sets the clock from the onion time
 * sources over Tor — only when at least three agree it is more than 30 s off.
 * Verified: the timer must be seen enabled and active.
 *
 * A hidden-only node has its own timer (morphit-tor-timesync.timer) doing this
 * all the time; one that was switched to hidden-only after the fallback was
 * installed has the fallback units REMOVED (stopped, disabled, files gone), so
 * the two never run side by side.
 */
import { join } from 'node:path';
import type { HealCtx, HealResult } from './healTypes.ts';
import { isHiddenOnlyNode } from './hiddenOnly.ts';
import {
	disableAndRemoveUnits,
	installAndEnableUnits,
	type InstallUnitsResult,
	type RemoveUnitsResult
} from './installUnits.ts';
import { DEFAULT_HELPER_DIR, installHelperScript } from './refreshHelperScripts.ts';

export const CLOCK_FALLBACK_UNITS = [
	'morphit-clock-fallback.service',
	'morphit-clock-fallback.timer'
] as const;
export const CLOCK_FALLBACK_TIMER = 'morphit-clock-fallback.timer';

export interface ClockFallbackRuntime {
	hiddenOnly(): boolean;
	/** Install the root-owned copies of both scripts; false when either could not be. */
	installScripts(): boolean;
	installUnits(): InstallUnitsResult;
	/** Hidden-only: stop, disable and remove the fallback units if present. */
	removeUnits(): RemoveUnitsResult;
}

export function healClockFallback(_ctx: HealCtx, rt: ClockFallbackRuntime): HealResult {
	if (rt.hiddenOnly()) {
		const rm = rt.removeUnits();
		if (!rm.ok) {
			return {
				strategy: 'left-alone',
				verified: false,
				detail:
					`Clock fallback: this server is hidden-only, but its clearnet-node clock fallback could not be removed (${rm.detail ?? 'unknown reason'}). ` +
					'On this server: sudo systemctl disable --now morphit-clock-fallback.timer && ' +
					'sudo rm /etc/systemd/system/morphit-clock-fallback.service /etc/systemd/system/morphit-clock-fallback.timer'
			};
		}
		if (rm.removed.length > 0) {
			return {
				strategy: 'removed-hidden-only',
				verified: true,
				detail:
					'Clock fallback: removed — this server is hidden-only now, and its own Tor time check keeps the clock.'
			};
		}
		return { strategy: 'skipped-hidden-only', verified: true, detail: '', routine: true };
	}
	if (!rt.installScripts()) {
		return {
			strategy: 'left-alone',
			verified: false,
			detail:
				"Clock fallback: its script could not be installed, so if NTP cannot keep this server's clock nothing sets it. " +
				'Run `sudo morphit-ops upgrade --heals` again on this server.'
		};
	}
	const inst = rt.installUnits();
	if (!inst.ok) {
		return {
			strategy: 'left-alone',
			verified: false,
			detail:
				`Clock fallback: could not turn it on (${inst.detail ?? 'unknown reason'}). ` +
				`On this server: sudo systemctl enable --now ${CLOCK_FALLBACK_TIMER}`
		};
	}
	if (inst.written.length === 0)
		return { strategy: 'already', verified: true, detail: '', routine: true };
	return {
		strategy: 'installed',
		verified: inst.timerRunning,
		detail:
			"Clock fallback: turned on. While NTP keeps this server's clock it does nothing; if NTP cannot (blocked or " +
			'unreachable), the clock is set from onion time sources over Tor, every 6 hours.'
	};
}

/** The real runtime. `installDir` is the release the self-heal runs from. */
export function realClockFallbackRuntime(installDir: string): ClockFallbackRuntime {
	const systemdDir = process.env.MORPHIT_SYSTEMD_DIR ?? '/etc/systemd/system';
	const helperDir = process.env.MORPHIT_HELPER_DIR ?? DEFAULT_HELPER_DIR;
	const noSystemd = process.env.MORPHIT_HEAL_NO_SYSTEMD === '1';
	return {
		hiddenOnly: () => isHiddenOnlyNode(),
		// The time check first: the fallback script runs it.
		installScripts: () =>
			['morphit-tor-timesync.sh', 'morphit-clock-fallback.sh'].every(
				(name) => installHelperScript({ releaseRoot: installDir, name, helperDir }) !== null
			),
		installUnits: () =>
			installAndEnableUnits({
				templateDir: join(installDir, 'ops', 'systemd'),
				systemdDir,
				units: CLOCK_FALLBACK_UNITS,
				timer: CLOCK_FALLBACK_TIMER,
				noSystemd
			}),
		removeUnits: () =>
			disableAndRemoveUnits({
				systemdDir,
				units: CLOCK_FALLBACK_UNITS,
				timer: CLOCK_FALLBACK_TIMER,
				noSystemd
			})
	};
}
