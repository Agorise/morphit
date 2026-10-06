/**
 * Whether Docker can be asked on this server: not installed at all, installed
 * but not answering, or answering. A heal that finds "nothing here" must only
 * say so when Docker answered (or does not exist): Docker that does not answer
 * is a problem for the operator, never "nothing to change". IMPURE.
 */
import { spawnSync } from 'node:child_process';

export type DockerStatus = 'missing' | 'down' | 'up';

export function dockerStatus(): DockerStatus {
	try {
		const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
			stdio: 'ignore',
			timeout: 15_000
		});
		if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return 'missing';
		return r.status === 0 ? 'up' : 'down';
	} catch {
		return 'down';
	}
}
