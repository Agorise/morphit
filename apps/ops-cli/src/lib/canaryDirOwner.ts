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
