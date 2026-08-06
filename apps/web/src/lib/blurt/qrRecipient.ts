/**
 * Morphit — extract a candidate Blurt recipient from a scanned QR payload.
 *
 * Morphit's own BLURT payment QR is a BARE account name (see
 * `buildPaymentUri` in `$lib/chat/payload`), but a QR produced by another
 * wallet may wrap the account in a URI scheme (e.g. `blurt:alice`,
 * `blurt://alice?amount=5`). This pulls out ONLY the account name.
 *
 * Deliberately NOT extracted: any amount or memo a URI might carry. A
 * scanned QR is UNTRUSTED, so the money fields stay entirely under the
 * user's control — the scan only pre-fills the recipient, which the Send
 * modal then validates (format + on-chain existence) exactly like a typed
 * name. The worst a hostile QR can do is pre-fill a recipient the user
 * still has to eyeball and that still has to resolve to a real account.
 *
 * Returns '' when nothing plausible is present.
 */
export function extractRecipientFromQr(raw: string): string {
	let s = (raw ?? '').trim();
	if (s.length === 0) return '';
	// Strip a leading URI scheme if present: "scheme:rest" or
	// "scheme://rest". Blurt account names never contain ':' or '/', so
	// this can't mangle a bare name.
	const scheme = s.match(/^[a-z][a-z0-9+.-]*:(?:\/\/)?(.+)$/i);
	if (scheme) s = scheme[1] ?? s;
	// Keep only the account portion — cut at the first path / query /
	// fragment separator.
	s = s.split(/[/?#]/)[0] ?? '';
	// Users habitually include the '@' handle form; accounts are lowercase.
	return s.trim().replace(/^@+/, '').toLowerCase();
}
