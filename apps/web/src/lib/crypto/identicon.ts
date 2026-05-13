/**
 * Morphit — heart-style identicon
 *
 * Generates a friendly, sticker-like identicon from a byte array. Pure
 * SVG, no canvas, no runtime dependencies. The output is a deterministic
 * function of the input bytes: same bytes in, same identicon out.
 *
 * ── Visual design ───────────────────────────────────────────────────────
 *
 * Each identicon is a classic heart silhouette — two rounded lobes on
 * top over a diamond-shaped bottom that tapers to a point. Internally,
 * the shape is subdivided into six colored regions:
 *
 *   - Two lobes (left and right half-circles), each a single color
 *   - Four triangles filling the diamond bottom, diagonals crossing
 *     at the diamond's center
 *
 * A small decorative accessory (circle, diamond, leaf, upward triangle,
 * or downward triangle) floats just above the heart, like the shapes
 * in the reference IdentiHeart designs.
 *
 * Rendering strategy: all fills are drawn inside a heart-shaped
 * clip-path, so internal boundaries between regions are crisp without
 * any stroke-doubling along the outer silhouette. A single heart
 * outline is drawn on top of everything else for the clean cut-paper
 * look.
 *
 * Total decision slots driven by input bytes:
 *   - 2 lobe colors
 *   - 4 triangle colors
 *   - 1 accessory color
 *   - 1 accessory shape
 *   = 7 color slots × 12-color palette × 5 accessory shapes
 *   ≈ 180 M distinct identicons — far beyond birthday-collision
 *   threshold for any user's lifetime of Morphit contacts.
 *
 * ── Attribution ─────────────────────────────────────────────────────────
 *
 * Visual design inspired by Guillaume Schlipak's `IdentiHeart` library
 * (https://github.com/Schlipak/IdentiHeart, Apache-2.0). This file is
 * an original SVG reimplementation — no code was copied from that
 * project. Licensed AGPL-3.0-only as part of the Morphit frontend.
 *
 * ── Why bytes, not a string hash ────────────────────────────────────────
 *
 * Morphit generates identicons from high-entropy cryptographic material
 * (33-byte secp256k1 public keys, 32-byte signatures, etc.). Running
 * that through a string hash like FNV-1a would destroy entropy for no
 * benefit. We index into the input bytes directly.
 */

/** Palette — 12 friendly, sticker-saturated colors plus white as a
 *  valid "breathing-room" slot. No neon, no dusty pastels. */
const PALETTE = [
	'#e94b3c', // tomato
	'#f0a93a', // goldenrod
	'#e8b22a', // sun
	'#4fa15e', // sage
	'#2f8f7e', // deep teal
	'#48b4d4', // sky
	'#3069a8', // ocean
	'#2d3e84', // deep navy
	'#7a5d3f', // walnut
	'#6b7b4a', // olive
	'#b8392a', // brick
	'#ffffff' // breathing room
] as const;

/** Accessory shape vocabulary. */
type Accessory = 'circle' | 'diamond' | 'leaf' | 'triangle-up' | 'triangle-down';
const ACCESSORIES: readonly Accessory[] = [
	'circle',
	'diamond',
	'leaf',
	'triangle-up',
	'triangle-down'
];

function pickColor(byte: number, offset = 0): string {
	return PALETTE[(byte + offset) % PALETTE.length]!;
}

function pickAccessory(byte: number): Accessory {
	return ACCESSORIES[byte % ACCESSORIES.length]!;
}

/**
 * Geometry, all in the 100×110 viewBox (10px of headroom above for
 * the accessory):
 *
 *   Heart outline, clockwise from the left tip of the left lobe's
 *   base chord:
 *     start at (2,46)   — left edge of left lobe, at chord height
 *     arc up-and-over to (50,46) — right edge of left lobe
 *         (semicircle radius 24, center (26,46), bulges upward)
 *     arc up-and-over to (98,46) — right edge of right lobe
 *         (semicircle radius 24, center (74,46), bulges upward)
 *     line down to the bottom point (50,96)
 *     close back to (2,46)
 *
 *   Diamond center for triangle subdivision: (50,70)
 *
 *   Accessory: centered at (50,14), ~12×12 footprint, floats above
 *   the heart with a gap between its base (y≈21) and the V-notch
 *   (y≈46).
 */

export function identiconSvg(bytes: Uint8Array, size = 64): string {
	// Cyclic byte accessor so short inputs (e.g. a 4-byte UI test) still
	// produce distinct-looking identicons.
	const b = (i: number): number => bytes[i % Math.max(1, bytes.length)] ?? 0;

	// Color slots. Offsets chosen so an all-zero input still varies.
	const colorLobeLeft = pickColor(b(0), 0);
	const colorLobeRight = pickColor(b(1), 3);
	const colorTriTop = pickColor(b(2), 5);
	const colorTriRight = pickColor(b(3), 7);
	const colorTriBottom = pickColor(b(4), 11);
	const colorTriLeft = pickColor(b(5), 1);
	const colorAccessory = pickColor(b(7), 9);
	const accessory = pickAccessory(b(6));

	// Heart silhouette path — used twice: once as a clip-path for the
	// internal fills, once as the outer stroked outline.
	const heartPath = 'M 2 46 ' + 'A 24 24 0 0 1 50 46 ' + 'A 24 24 0 0 1 98 46 ' + 'L 50 96 Z';

	// Internal region paths.
	// Lobes are semicircles drawn as arcs over the same chords used
	// by the heart outline, so their shared boundaries coincide exactly
	// with the clip-path.
	const leftLobePath = 'M 2 46 A 24 24 0 0 1 50 46 Z';
	const rightLobePath = 'M 50 46 A 24 24 0 0 1 98 46 Z';

	// The bottom of the heart is a downward-pointing triangle with
	// corners at W(2,46), E(98,46), and S(50,96). We split it into
	// four regions by lines from a central interior point P to each
	// corner plus the midpoint of the top edge. P is at (50, 70) —
	// visually centered in the triangle without any awkward seams.
	const DC = { x: 50, y: 70 };
	const triTopLeft = `M 2 46 L 50 46 L ${DC.x} ${DC.y} Z`;
	const triTopRight = `M 50 46 L 98 46 L ${DC.x} ${DC.y} Z`;
	const triBotRight = `M 98 46 L 50 96 L ${DC.x} ${DC.y} Z`;
	const triBotLeft = `M 50 96 L 2 46 L ${DC.x} ${DC.y} Z`;

	// Accessory shape, centered at (50,14). Base sits at roughly y=21,
	// leaving a ~25px gap above the heart's V-notch (y=46) so the
	// accessory reads as a distinct floating element.
	const ax = 50;
	const ay = 14;
	// Match the heart's outline stroke weight (3px) so the accessory
	// feels like part of the same visual family rather than a separate
	// element from another system.
	const accStroke = 'stroke="#111" stroke-width="3" stroke-linejoin="round"';
	let accessoryMarkup = '';
	switch (accessory) {
		case 'circle':
			accessoryMarkup = `<circle cx="${ax}" cy="${ay}" r="6" fill="${colorAccessory}" ${accStroke} />`;
			break;
		case 'diamond':
			accessoryMarkup = `<path d="M ${ax} ${ay - 7} L ${ax + 6} ${ay} L ${ax} ${ay + 7} L ${ax - 6} ${ay} Z" fill="${colorAccessory}" ${accStroke} />`;
			break;
		case 'leaf':
			accessoryMarkup = `<path d="M ${ax} ${ay - 10} Q ${ax + 5} ${ay}, ${ax} ${ay + 8} Q ${ax - 5} ${ay}, ${ax} ${ay - 10} Z" fill="${colorAccessory}" ${accStroke} />`;
			break;
		case 'triangle-up':
			accessoryMarkup = `<path d="M ${ax} ${ay - 7} L ${ax + 7} ${ay + 5} L ${ax - 7} ${ay + 5} Z" fill="${colorAccessory}" ${accStroke} />`;
			break;
		case 'triangle-down':
			accessoryMarkup = `<path d="M ${ax - 7} ${ay - 5} L ${ax + 7} ${ay - 5} L ${ax} ${ay + 7} Z" fill="${colorAccessory}" ${accStroke} />`;
			break;
	}

	// ── Assembly ────────────────────────────────────────────────────
	// Order matters:
	//   1. Define heart silhouette as a clipPath (by id).
	//   2. Inside a <g> that uses the clip, draw every fill region
	//      with its internal strokes. Outer edges of these regions
	//      get clipped against the heart silhouette.
	//   3. Draw the heart outline on top, no fill, just stroke. This
	//      gives one clean outer line with no doubling.
	//   4. Draw the accessory above everything.
	//
	// A unique clip-path id per identicon isn't strictly necessary —
	// SVGs stay isolated when rendered in <img src="data:..."> — but
	// we add a short nonce so identicons inlined into the same DOM
	// (if that ever happens) don't collide.
	const clipId = `h${hashNonce(bytes)}`;
	const internalStroke = 'stroke="#111" stroke-width="2" stroke-linejoin="round"';
	const outerStroke = 'fill="none" stroke="#111" stroke-width="3" stroke-linejoin="round"';

	return (
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 110" ` +
		`width="${size}" height="${size}" role="img" aria-hidden="true">` +
		`<defs><clipPath id="${clipId}"><path d="${heartPath}" /></clipPath></defs>` +
		`<g clip-path="url(#${clipId})">` +
		`<path d="${leftLobePath}" fill="${colorLobeLeft}" ${internalStroke} />` +
		`<path d="${rightLobePath}" fill="${colorLobeRight}" ${internalStroke} />` +
		`<path d="${triTopLeft}" fill="${colorTriLeft}" ${internalStroke} />` +
		`<path d="${triTopRight}" fill="${colorTriTop}" ${internalStroke} />` +
		`<path d="${triBotRight}" fill="${colorTriRight}" ${internalStroke} />` +
		`<path d="${triBotLeft}" fill="${colorTriBottom}" ${internalStroke} />` +
		`</g>` +
		`<path d="${heartPath}" ${outerStroke} />` +
		accessoryMarkup +
		`</svg>`
	);
}

/**
 * Short, deterministic nonce derived from the input bytes. Used as
 * the clip-path id suffix so multiple identicons in the same DOM
 * don't share an id. No crypto security properties needed — just
 * avoiding accidental collisions.
 */
function hashNonce(bytes: Uint8Array): string {
	let h = 0;
	for (let i = 0; i < bytes.length; i++) {
		h = ((h * 31) ^ (bytes[i] ?? 0)) | 0;
	}
	return (h >>> 0).toString(36);
}

/**
 * Return the identicon as a URL-encoded data URI suitable for use
 * in an `<img src>`. URL encoding (vs base64) produces a smaller
 * string and works in every browser that supports SVG in data URIs.
 */
export function identiconDataUri(bytes: Uint8Array, size = 64): string {
	const svg = identiconSvg(bytes, size);
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Convenience: identicon data URI seeded by a string instead of raw
 * bytes.  Hashes the UTF-8 bytes of the string and feeds the result
 * to identiconDataUri.  Used for paired-readonly sessions (ADR-0022
 * QR-pair, Option A) where the desktop has no posting pubkey to seed
 * the avatar from — the account name is the next-best deterministic
 * seed for a consistent visual identity across reloads.
 *
 * Note: the resulting identicon is NOT the same as the identicon a
 * fully-unlocked session would render for the same account, because
 * the seeds differ (posting pubkey bytes vs UTF-8 account name).
 * That's a known property: the AvatarMenu chooses paired-vs-unlocked
 * deliberately, and the visual mismatch IS a useful signal that the
 * session shape changed.
 */
export function identiconDataUriFromString(seed: string, size = 64): string {
	// TextEncoder is universally available in browsers + Node 18+.
	// We only seed identicons in browser contexts (SSR avoids
	// identicon generation entirely), so this is safe.
	const bytes = new TextEncoder().encode(seed);
	return identiconDataUri(bytes, size);
}
