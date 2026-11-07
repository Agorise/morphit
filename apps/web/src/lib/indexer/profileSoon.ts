/**
 * One account's profile, read together with every other account asked for in
 * the same moment (v1.23.3). A label that reads its own account's profile
 * (IdentityLabel `hydrate`) may be one of dozens on a page — a list of chat
 * peers, say — and each asking alone would be one request each. These are
 * gathered for a moment and asked in one `getProfilesBatch` (which itself
 * serves what it has cached and splits large batches).
 */
import type { ProfileResponse } from '@morphit/indexer-client';

import { getProfilesBatch } from './profileCache';

const WAIT_MS = 10;
let pending = new Map<string, Array<(p: ProfileResponse | null) => void>>();
let timer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
	const batch = pending;
	pending = new Map();
	timer = null;
	const accounts = [...batch.keys()];
	getProfilesBatch(accounts)
		.then((profiles) => {
			for (const [a, waiters] of batch) for (const w of waiters) w(profiles.get(a) ?? null);
		})
		.catch(() => {
			for (const waiters of batch.values()) for (const w of waiters) w(null);
		});
}

/** The account's profile (null: none, or it could not be read now). */
export function profileSoon(account: string): Promise<ProfileResponse | null> {
	return new Promise((resolve) => {
		const waiters = pending.get(account);
		if (waiters) waiters.push(resolve);
		else pending.set(account, [resolve]);
		if (timer === null) timer = setTimeout(flush, WAIT_MS);
	});
}
