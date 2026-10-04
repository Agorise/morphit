/**
 * Morphit relay — which file permissions the active-key keystore may have.
 *
 * Two shapes are accepted:
 *
 *   1. Owner only: 0400 / 0600 (no group or other bits). The relay reads the
 *      file as its owner.
 *   2. root:<the relay's group>, 0440 / 0640: owned by root, readable by one
 *      group the relay process is a member of, nothing for others, and the
 *      group can only read. This is what the installer and
 *      ops/scripts/morphit-service-perms.sh set (root:morphit-relay 0640) so
 *      the relay can run as an unprivileged user that cannot change, replace
 *      or chmod its own key file.
 *
 * Everything looser is refused: any bit for others, group write or execute,
 * group read when the owner is not root (the owner could then hand the key
 * to the group), and group read for a group the process is not in (its
 * members, not the relay, are who the bit serves).
 */

import { statSync } from 'node:fs';

export interface KeystoreStat {
	/** st_mode (only the permission bits are used). */
	readonly mode: number;
	readonly uid: number;
	readonly gid: number;
}

export interface ProcessIdentity {
	readonly uid: number;
	/** Primary and supplementary group ids of the process. */
	readonly gids: readonly number[];
}

/** Why `st` is not an accepted keystore shape for `who`, or null when it is.
 *  PURE. */
export function keystorePermissionProblem(st: KeystoreStat, who: ProcessIdentity): string | null {
	const mode = st.mode & 0o777;
	const shown = `0${mode.toString(8).padStart(3, '0')}`;
	if ((mode & 0o077) === 0) return null;
	if ((mode & 0o007) !== 0) return `has permissions ${shown}: others have access`;
	if ((mode & 0o030) !== 0) return `has permissions ${shown}: the group may write or execute it`;
	if (st.uid !== 0) {
		return `has permissions ${shown} and is owned by uid ${st.uid}: a group-readable keystore must be owned by root`;
	}
	if (!who.gids.includes(st.gid)) {
		return `has permissions ${shown} for group ${st.gid}, which this process (uid ${who.uid}) is not a member of`;
	}
	return null;
}

/** The running process's identity (POSIX). */
export function currentProcessIdentity(): ProcessIdentity {
	const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
	const gids = new Set<number>();
	if (typeof process.getgid === 'function') gids.add(process.getgid());
	if (typeof process.getegid === 'function') gids.add(process.getegid());
	if (typeof process.getgroups === 'function') for (const g of process.getgroups()) gids.add(g);
	return { uid, gids: [...gids] };
}

/** Throw unless the keystore at `path` has an accepted shape for `who`. */
export function assertKeystorePermissions(
	path: string,
	who: ProcessIdentity = currentProcessIdentity(),
	st: KeystoreStat = statSync(path)
): void {
	const problem = keystorePermissionProblem(st, who);
	if (problem === null) return;
	throw new Error(
		`MORPHIT_RELAY_ACTIVE_KEY_FILE ${JSON.stringify(path)} ${problem}; it must be 0400/0600 (owner only) ` +
			`or root:morphit-relay 0640/0440 (run: chown root:morphit-relay ${path} && chmod 0640 ${path})`
	);
}
