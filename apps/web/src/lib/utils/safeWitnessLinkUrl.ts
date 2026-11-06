/**
 * The link a Blurt witness gave (its announcement or site), safe to put in an
 * href (v1.23.0, the /witnesses page): http or https only — never
 * `javascript:`, `data:` or any other scheme — no `user:pass@`, at most 512
 * characters. null otherwise (the page then shows no link). The indexer
 * checks the same (witnessRanking.safeWitnessUrl), but the page does not rely
 * on whichever indexer answered. PURE.
 */
export function safeWitnessLinkUrl(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const s = raw.trim();
	if (s.length === 0 || s.length > 512) return null;
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	if (u.username !== '' || u.password !== '' || u.hostname === '') return null;
	return u.href;
}
