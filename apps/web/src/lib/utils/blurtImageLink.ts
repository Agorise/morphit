/**
 * blurtImageLink — strict allowlist + linkifier for Blurt-blog image
 * URLs that appear in user-authored free text (order `terms`, shown
 * publicly on the order-detail / orderbook / account / my-orders
 * views). cp388.
 *
 * WHY THIS EXISTS
 * Order terms are public, on-chain, attacker-controllable free text.
 * Linkifying *arbitrary* URLs there would turn every order into a
 * phishing / malware-link billboard, and rendering any remote <img>
 * inline would leak the viewer's IP to whatever host the poster
 * chose. So terms render as PLAIN TEXT by default.
 *
 * The one carve-out Ken asked for: a trader bartering goods wants to
 * show a picture of the item. The privacy-preserving way to do that
 * is a *link* (not an inline image) to an image that already lives on
 * Blurt's own image infrastructure — `img.blurt.blog` (the imagehoster
 * store) or `imgp.blurt.blog` (its resize/optimize proxy) — which strip
 * EXIF geolocation and shield the uploader's and viewer's IPs (verified:
 * blurt.blog posts carry
 * `og:image=https://img.blurt.blog/blurtimage/<account>/<hash>.png`,
 * and the proxy is the host behind Blurt's documented image proxy).
 * Clicking the link opens that host in a fresh tab — the viewer's
 * browser never silently fetches the image, and when they do click,
 * they hit Blurt's privacy proxy, not an arbitrary attacker host.
 *
 * SECURITY MODEL (every check is load-bearing — see the smoke):
 *   - https ONLY (no http → no downgrade; no javascript:/data:/etc.).
 *   - EXACT host match (`img.blurt.blog` or `imgp.blurt.blog`) via
 *     hostname comparison, so `img.blurt.blog.evil.com` and
 *     `imgpXblurt.blog` are rejected; `new URL` lowercases the host so
 *     case tricks fail too.
 *   - No userinfo (`user:pass@`) — a legit image URL never has it,
 *     and it's a classic host-spoofing-by-eyeball vector.
 *   - Default port only ('' or 443) — reject `img.blurt.blog:8080`.
 *   - Path must end in a real image extension.
 *   - The result is rendered as an `href` attribute value via Svelte
 *     (auto-escaped), NEVER via `{@html}`, so even a string that
 *     slips through cannot inject markup.
 *
 * Mirrors the chat linkifier's segment shape so the rendering site
 * stays a dumb `{#each}` with no `{@html}`.
 */

// Blurt serves user post images from two exact hosts: `img.blurt.blog`
// (the canonical imagehoster store, `/blurtimage/<account>/<hash>.png`)
// and `imgp.blurt.blog` (the resize/optimize proxy, whose URLs in the
// Hive-condenser lineage still end in the source image's extension,
// e.g. `/768x0/https://img.blurt.blog/blurtimage/<account>/<hash>.png`).
// Exact hostname match only — no subdomain/suffix tricks.
const BLURT_IMAGE_HOSTS = new Set(['img.blurt.blog', 'imgp.blurt.blog']);
const IMAGE_EXT = /\.(?:jpe?g|png|gif|webp)$/i;

/**
 * Return the normalized URL string iff `raw` is a safe, https,
 * Blurt-image-host, image-extension URL; null otherwise.
 */
export function safeBlurtImageUrl(raw: string | null | undefined): string | null {
	if (raw === null || raw === undefined) return null;
	const trimmed = raw.trim();
	if (trimmed.length === 0) return null;
	let u: URL;
	try {
		u = new URL(trimmed);
	} catch {
		return null;
	}
	if (u.protocol !== 'https:') return null;
	if (!BLURT_IMAGE_HOSTS.has(u.hostname)) return null;
	if (u.username !== '' || u.password !== '') return null;
	if (u.port !== '' && u.port !== '443') return null;
	if (!IMAGE_EXT.test(u.pathname)) return null;
	return u.toString();
}

export interface TermsSegment {
	/** True when this segment is a validated Blurt-image URL that should
	 *  render as a clickable link. The render site binds the href via
	 *  `safeBlurtImageUrl(value)` (a recognized safe builder), mirroring
	 *  the chat linkifier, so the static href-xss smoke can prove it. */
	link: boolean;
	/** Display text (always rendered escaped, never as HTML). */
	value: string;
}

/**
 * Split free text into plain-text and Blurt-image-link segments.
 *
 * ONLY URLs that pass `safeBlurtImageUrl` are flagged `link: true`;
 * every other URL-shaped run (and all other text) is emitted as a
 * plain-text segment, so a non-Blurt or non-image link stays inert
 * text — never a clickable external link in public terms.
 */
export function linkifyBlurtImageSegments(text: string): TermsSegment[] {
	const out: TermsSegment[] = [];
	if (!text) return out;
	// Candidate URL runs: http(s):// up to the next whitespace. http is
	// matched only so the validator can reject it (→ stays plain text).
	const re = /https?:\/\/[^\s]+/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		let url = m[0];
		// Peel trailing sentence punctuation so "see https://…/a.png." links cleanly.
		let trail = '';
		const tm = /[).,;:!?'"\]}>]+$/.exec(url);
		if (tm) {
			trail = tm[0];
			url = url.slice(0, url.length - trail.length);
		}
		if (m.index > last) out.push({ link: false, value: text.slice(last, m.index) });
		const isLink = url.length > 0 && safeBlurtImageUrl(url) !== null;
		if (url.length > 0) out.push({ link: isLink, value: url });
		if (trail.length > 0) out.push({ link: false, value: trail });
		last = re.lastIndex;
	}
	if (last < text.length) out.push({ link: false, value: text.slice(last) });
	return out;
}
