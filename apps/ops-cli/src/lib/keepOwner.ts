import { chmodSync, chownSync, statSync } from 'node:fs';

/**
 * Give `tmp` the owner, group and permission bits of `original`, when
 * `original` exists — so an atomic replace (write `tmp`, rename over
 * `original`) does not turn a root:morphit 0640 file the unprivileged services
 * read into root:root 0600. The owner is copied only when running as root.
 * Throws only if the copy itself fails.
 */
export function keepOwnerAndMode(original: string, tmp: string): void {
	let st;
	try {
		st = statSync(original);
	} catch {
		return;
	}
	chmodSync(tmp, st.mode & 0o777);
	if (typeof process.getuid === 'function' && process.getuid() === 0)
		chownSync(tmp, st.uid, st.gid);
}
