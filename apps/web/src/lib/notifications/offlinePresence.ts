/**
 * Settings → Offline Notifications: while she is signed in with offline
 * notices on, tell this site's relay once a minute that the site is open, so
 * it does not send her a notice about a message she can see arrive (memory
 * only on the relay). The layout calls {@link offlinePresenceWhileUnlocked}
 * from an effect that runs while she is unlocked, and returns what it gives
 * back, so the heartbeat stops on lock or sign-out — also when that happens
 * while its first answers are still on their way. The requests' code is
 * loaded only then.
 */
type Loader = () => Promise<{ watchOfflinePresence(): () => void }>;

export function offlinePresenceWhileUnlocked(
	load: Loader = () => import('./offlineNotify')
): () => void {
	let ended = false;
	let stop: (() => void) | null = null;
	void load().then(
		(m) => {
			if (!ended) stop = m.watchOfflinePresence();
		},
		() => undefined
	);
	return () => {
		ended = true;
		stop?.();
	};
}
