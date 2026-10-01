/**
 * v1.20.1 — the relay must never END quietly.
 *
 * On morphitir (2026-09-27) the relay's boot awaited a chain call whose
 * promise never settled. With no timer or socket left, Node emptied its event
 * loop and exited with status 0 — which systemd's Restart=on-failure treats as
 * a deliberate stop. The relay stayed down for three days; sign-ups and every
 * relayed broadcast on that instance failed.
 *
 * installDrainGuard: any exit that is not a requested shutdown becomes a
 * logged failure (status 1). The unit now also restarts on ANY exit.
 * withBootTimeout: a boot-time chain call cannot hold the boot forever.
 */

export interface DrainGuard {
	/** Call from the SIGTERM/SIGINT handler: an empty loop is now intended. */
	shuttingDown(): void;
}

export function installDrainGuard(
	log: (note: string) => void,
	exit: (code: number) => never = (c) => process.exit(c)
): DrainGuard {
	let stopping = false;
	process.on('beforeExit', () => {
		if (stopping) return;
		log(
			'the relay had nothing left to run and was about to exit without being asked to; exiting 1 so systemd restarts it'
		);
		exit(1);
	});
	return {
		shuttingDown: () => {
			stopping = true;
		}
	};
}

export async function withBootTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			p,
			new Promise<T>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)),
					ms
				);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
