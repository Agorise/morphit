/**
 * Morphit — onion-location helper (Item 5).
 *
 * Pure: takes the configured Tor alt-network address from the
 * instance store, plus the current page URL, and returns the
 * `onion-location` meta tag value (or null if none should be
 * emitted).
 *
 * Tor Browser auto-detects the meta tag and shows a ".onion
 * available" pill in its address bar with a one-click switch
 * button.  Spec:
 *   https://community.torproject.org/onion-services/advanced/onion-location/
 *
 * Returns null when:
 *   - No tor address is configured for this instance.
 *   - The current page is already on a .onion host.
 *
 * Returns a fully-qualified URL otherwise, preserving the
 * current path / search / hash so the user lands on the same
 * page on the .onion mirror.
 */

/** Strip optional `http://` / `https://` prefix and any
 *  trailing slash from an alt-network address.  Operators
 *  may configure the address with or without a scheme. */
function normalizeOnionHost(raw: string): string {
	return raw.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export interface OnionLocationInput {
	readonly torAddress: string | null | undefined;
	readonly currentHostname: string;
	readonly currentPathname: string;
	readonly currentSearch?: string;
	readonly currentHash?: string;
}

/** Compute the `onion-location` value for the meta tag.
 *  Returns null when no value should be emitted. */
export function computeOnionLocation(input: OnionLocationInput): string | null {
	const tor = input.torAddress;
	if (typeof tor !== 'string' || tor.length === 0) return null;
	if (input.currentHostname.endsWith('.onion')) return null;

	const torHost = normalizeOnionHost(tor);
	if (torHost.length === 0) return null;
	// Defensive: the spec accepts only `.onion` hostnames.  If
	// the operator misconfigured a non-.onion address (e.g. a
	// clearnet domain), don't emit — emitting would be a silent
	// open-redirect surface in the Tor Browser address bar.
	if (!torHost.endsWith('.onion')) return null;

	const path = input.currentPathname || '/';
	const search = input.currentSearch ?? '';
	const hash = input.currentHash ?? '';
	return `http://${torHost}${path}${search}${hash}`;
}
