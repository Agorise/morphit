/**
 * Morphit relay — operator-actionable kill switch.
 *
 * Background:
 * The `MORPHIT_RELAY_SIGNUP_ENABLED` env var is captured at
 * relay startup and held in process memory.  Changing it
 * requires a service restart.  That's fine for planned
 * maintenance, but it's the wrong tool for incident response —
 * if a paid beta tester reports "the relay is being drained
 * RIGHT NOW," the operator needs to be able to stop new
 * signups within seconds, without hunting for a systemd unit
 * file or remembering env-var syntax.
 *
 * This module adds a SECOND kill switch alongside the env-var:
 * if a sentinel file exists at `${MORPHIT_RELAY_DATA_DIR}/SIGNUPS_DISABLED`,
 * signups are immediately rejected.  The operator's mental
 * model is "if I want to stop signups RIGHT NOW, touch this
 * file.  When the incident is over, delete it."
 *
 * Design:
 *   - Polled, not watched.  Polling every 1s is good enough
 *     for incident response (operator does `touch <file>`,
 *     within a second the next signup fails).  fs.watch has
 *     edge cases on different filesystems (NFS, overlayfs,
 *     containers); a poll is boring and reliable.
 *   - Cached: each request reads the cached flag, not the
 *     filesystem.  Polling thread runs in the background.
 *   - Both gates apply: env-var disable AND file disable both
 *     stop signups.  An operator can flip either independently.
 *   - Logged: the transition (file appears or disappears) is
 *     logged at warn level so postmortems can see "signups
 *     paused at 14:32, resumed at 14:47."
 *
 * Operator usage:
 *   touch /var/lib/morphit/relay/SIGNUPS_DISABLED   # pause
 *   rm /var/lib/morphit/relay/SIGNUPS_DISABLED      # resume
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { logger } from '$log';

const log = logger('kill-switch');

/** Filename of the sentinel inside MORPHIT_RELAY_DATA_DIR.
 *  Caps + underscores so it stands out in a directory listing. */
const KILL_SWITCH_FILENAME = 'SIGNUPS_DISABLED';

/** Poll interval for the kill switch file.  1 second is a good
 *  trade-off: fast enough for incident response, slow enough
 *  that the FS check overhead is negligible (~1µs per poll). */
const POLL_INTERVAL_MS = 1000;

export class KillSwitch {
	private readonly absolutePath: string;
	private active: boolean;
	private timer: NodeJS.Timeout | null = null;

	constructor(dataDir: string) {
		this.absolutePath = path.join(dataDir, KILL_SWITCH_FILENAME);
		// Initial poll synchronously so the first request after
		// startup sees the correct state.
		this.active = this.checkFile();
		if (this.active) {
			log.warn('kill_switch_active_at_startup', {
				path: this.absolutePath,
				note:
					'Signups are paused via the kill-switch file at startup. ' +
					'Remove the file to resume signups.'
			});
		}
		this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
		// Don't keep the event loop alive solely for the poller.
		this.timer.unref?.();
	}

	/** Synchronous read of the cached flag.  This is what the
	 *  request handlers call.  Cheap (just a boolean read). */
	isActive(): boolean {
		return this.active;
	}

	/** Filesystem path the operator touches/removes. */
	getPath(): string {
		return this.absolutePath;
	}

	/** Stop the polling thread on shutdown. */
	close(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private checkFile(): boolean {
		try {
			if (!existsSync(this.absolutePath)) return false;
			// Defensive: existsSync returns true for symlinks too.
			// stat() resolves symlinks; if the target doesn't exist
			// we treat the switch as inactive (stale symlink isn't
			// a "kill" signal).
			statSync(this.absolutePath);
			return true;
		} catch {
			return false;
		}
	}

	private poll(): void {
		const now = this.checkFile();
		if (now !== this.active) {
			this.active = now;
			if (now) {
				log.warn('kill_switch_activated', {
					path: this.absolutePath,
					note: 'Signups paused.  Remove the file to resume.'
				});
			} else {
				log.warn('kill_switch_deactivated', {
					path: this.absolutePath,
					note: 'Signups resumed.'
				});
			}
		}
	}
}
