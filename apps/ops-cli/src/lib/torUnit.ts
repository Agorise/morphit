/**
 * The systemd unit that IS the Tor daemon.
 *
 * On Ubuntu and Debian `tor.service` is only a placeholder (Type=oneshot,
 * ExecStart=/bin/true, RemainAfterExit=yes): it stays "active" while the real
 * daemon, `tor@default.service`, is dead. Checking `tor` made health and the
 * install review show the .onion ✓ with Tor down (review, 2026-10-12, unit files
 * of tor 0.4.9.11-0ubuntu0.24.04.1). Where there is no tor@default (another
 * distro's packaging), `tor` is the daemon itself.
 */
import { spawnSync } from 'node:child_process';

/** `tor@default` when systemd knows that unit, else `tor`. PURE given `loadState`. */
export function torDaemonUnit(loadState: (unit: string) => string): string {
	const s = loadState('tor@default.service').trim();
	return s === 'loaded' ? 'tor@default' : 'tor';
}

let cached: string | null = null;

/** {@link torDaemonUnit} on this box (asked once). */
export function hostTorDaemonUnit(): string {
	if (cached === null) {
		cached = torDaemonUnit((u) => {
			const r = spawnSync('systemctl', ['show', '-p', 'LoadState', '--value', u], {
				encoding: 'utf8',
				timeout: 3000
			});
			return r.status === 0 ? (r.stdout ?? '') : '';
		});
	}
	return cached;
}
