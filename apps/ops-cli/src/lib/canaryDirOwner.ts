/**
 * cp619 (Ken — canary) — decide who should own `apps/web/build` after
 * `morphit-ops upgrade` rebuilds it.
 *
 * The web frontend rebuild runs as root (`sudo morphit-ops`) and vite RECREATES
 * `apps/web/build` root-owned. But that same dir is where a non-root operator
 * uploads their PGP-signed warrant canary (`canary.txt` + `pgp_keys.asc`) over
 * SSH, and in the bind-mount frontend model it is served directly. So after the
 * rebuild the upgrade restores the dir's ownership; this decides to WHAT.
 *
 * Rule (most-specific wins):
 *   1. If build/ already has a NON-ROOT owner, keep it — that is the owner the
 *      operator deliberately set for their canary upload (e.g. `morphit`).
 *   2. Else fall back to the install-dir owner — the app user a standard
 *      (Ansible) install runs Morphit as, which is also the SSH/upload user.
 *   3. Else null → leave it root-owned (the operator uploads as root, or will
 *      set ownership themselves once; we never guess a random uid).
 *
 * root (uid 0) is never a useful target here: the whole point is to make the
 * dir writable by the NON-root upload user, and if the only owner we can find
 * is root there is nothing to restore.
 *
 * Pure + I/O-free so the decision is unit-testable; the caller does the stat()
 * and the chown().
 */

import { join } from 'node:path';

export interface DirOwner {
	uid: number;
	gid: number;
}

export function chooseCanaryDirOwner(
	buildOwner: DirOwner | null,
	installOwner: DirOwner | null
): DirOwner | null {
	if (buildOwner && buildOwner.uid !== 0) return buildOwner;
	if (installOwner && installOwner.uid !== 0) return installOwner;
	return null;
}

/**
 * cp622 (Ken — canary smoothness) — parse a `getent passwd <uid>` line into the
 * canary owner's username + the path to their weekly refresh script. After an
 * upgrade rebuild wipes the served canary, the caller uses this to tell a
 * SAME-BOX operator — one who signs the canary HERE, so their
 * `~/.morphit/update-canary.sh` exists — whose canary can be restored
 * automatically by running that script AS them, apart from a REMOTE operator
 * who signs on a separate laptop (no such script here → manual reminder). Pure;
 * the caller does the getent, the existsSync, and the sudo.
 *
 * passwd format: name:passwd:uid:gid:gecos:home:shell. Returns null if the line
 * is malformed or lacks a username or home directory.
 */
export interface CanaryRefreshTarget {
	user: string;
	home: string;
	refreshScript: string;
}

export function parsePasswdRefreshTarget(passwdLine: string): CanaryRefreshTarget | null {
	const fields = (passwdLine.split('\n')[0] ?? '').split(':');
	const user = (fields[0] ?? '').trim();
	const home = (fields[5] ?? '').trim();
	if (user === '' || home === '') return null;
	return { user, home, refreshScript: join(home, '.morphit', 'update-canary.sh') };
}
