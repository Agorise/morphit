/**
 * The signed-in account's name, for code that is about to make a request
 * naming it.
 *
 * `getUserBlurtAccount()` also answers on a LOCKED visit: a browser that
 * chose "remember me" keeps the name. A request built from that name alone
 * tells the operator which account is visiting before the user has unlocked
 * anything. This returns the name only while a session exists (unlocked, or
 * paired read-only), so such requests wait for the user.
 */
import { get } from 'svelte/store';

import { getUserBlurtAccount } from '$blurt/ops/profile';
import { hasAnySession } from '$stores/identity';

export function sessionAccountName(): string | null {
	return get(hasAnySession) ? getUserBlurtAccount() : null;
}
