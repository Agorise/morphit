/**
 * Morphit — fit a source image inside a square box WITHOUT distorting it.
 *
 * tt.txt #2: the favicon badge is painted by drawing the logo into a 32×32
 * canvas and stamping a dot on it. The draw was:
 *
 *     ctx.drawImage(img, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
 *
 * The Morphit mark is `viewBox="0 0 10.889 7.049"` — a WIDE logo. Forcing it
 * into a square stretches it vertically. The browser renders the plain SVG
 * correctly (it scales to fit, preserving aspect), so the logo looked right
 * until the moment a notification arrived — then it squashed. Ken: "our logo on
 * the browser tab should always look perfect and its dimensions should never
 * change."
 *
 * `containFit` reproduces what the browser does for us: scale by the smaller of
 * the two ratios, centre the result, letterbox the rest.
 */

export interface FitBox {
	readonly dx: number;
	readonly dy: number;
	readonly dw: number;
	readonly dh: number;
}

/**
 * Aspect-preserving "contain" fit of `srcW × srcH` inside a `box × box` square.
 *
 * Returns the destination rect to pass to `drawImage(img, dx, dy, dw, dh)`.
 * Falls back to filling the box when the source dimensions are unusable (a
 * zero/NaN `naturalWidth` — which some engines report for an SVG with no
 * intrinsic size), because a square logo is better than no logo.
 */
export function containFit(srcW: number, srcH: number, box: number): FitBox {
	if (!Number.isFinite(srcW) || !Number.isFinite(srcH) || srcW <= 0 || srcH <= 0) {
		return { dx: 0, dy: 0, dw: box, dh: box };
	}
	const scale = Math.min(box / srcW, box / srcH);
	const dw = srcW * scale;
	const dh = srcH * scale;
	return { dx: (box - dw) / 2, dy: (box - dh) / 2, dw, dh };
}

/**
 * The Morphit mark's intrinsic aspect, read from `static/favicon.svg`'s
 * `viewBox`. Used when the browser reports no intrinsic size for the SVG.
 *
 * `favicon-aspect-smoke` fails if these drift from the asset.
 */
export const FAVICON_INTRINSIC_WIDTH = 10.889;
export const FAVICON_INTRINSIC_HEIGHT = 7.049;
