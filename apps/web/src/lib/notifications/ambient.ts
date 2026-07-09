/**
 * Ambient notification channels.
 *
 * These three channels are always-on (no permission needed) and never
 * alert — they update in the user's peripheral vision:
 *
 *   1. Title-bar prefix — "(3) Morphit — Orderbook"
 *   2. Favicon canvas badge — colored dot + count painted over the
 *      existing favicon and swapped into <link rel="icon">
 *   3. App Badging API — OS-level badge on the PWA icon (installed
 *      PWA only; silent no-op elsewhere)
 *
 * Started once from the root layout; subscribes to unreadCount and
 * updates all three whenever the total changes. Gracefully handles
 * platforms where a channel doesn't work.
 */

import { unreadCount, totalUnread, type UnreadCounts } from './index';
import { startChatUnreadChannel } from './chatUnread';
import {
	containFit,
	FAVICON_INTRINSIC_WIDTH,
	FAVICON_INTRINSIC_HEIGHT
} from './containFit';

/** Holds the original (badge-less) title so we can restore it when
 *  the count goes to zero. Captured on first run. */
let originalTitle: string | null = null;

/** Holds the original favicon href. */
let originalFaviconHref: string | null = null;

/** Cached favicon bitmap so we don't re-fetch on every badge update.
 *  Populated lazily on first badge render. */
let cachedFaviconImage: HTMLImageElement | null = null;

/** Size of the badged favicon — 32×32 is the standard favicon size
 *  and what browsers actually render in the tab. A larger canvas
 *  gets downsampled and looks mushy. */
const FAVICON_SIZE = 32;

function captureOriginals(): void {
	if (originalTitle === null) originalTitle = document.title;

	if (originalFaviconHref === null) {
		const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
		originalFaviconHref = link?.href ?? null;
	}
}

function setTitle(count: number): void {
	if (originalTitle === null) return;
	if (count > 0) {
		// Use (N) prefix — the de facto standard, unambiguous, works
		// in every tab-list rendering.
		document.title = `(${count}) ${originalTitle}`;
	} else {
		document.title = originalTitle;
	}
}

/**
 * Render a badged favicon and swap it into <link rel="icon">.
 *
 * Technique: load the original favicon into an <img>, draw it onto a
 * canvas, paint a filled circle + count text in the upper-right
 * corner, encode as PNG data URI, assign to link.href.
 *
 * Caveats:
 *   - iOS Safari pins favicon at page load; calling this is a no-op
 *     there but also not harmful.
 *   - Chrome bookmarks cache favicons independently of tab favicons,
 *     so a badge here does NOT reach the bookmarks bar (see design
 *     doc).
 *   - SVG favicons: we render the badge over the rasterized version,
 *     so some fidelity is lost. Acceptable tradeoff.
 */
async function setFaviconBadge(count: number): Promise<void> {
	const link = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
	if (!link || originalFaviconHref === null) return;

	if (count === 0) {
		link.href = originalFaviconHref;
		return;
	}

	try {
		// Lazy-load the original favicon once.
		if (cachedFaviconImage === null) {
			cachedFaviconImage = new Image();
			cachedFaviconImage.crossOrigin = 'anonymous';
			await new Promise<void>((resolve, reject) => {
				if (!cachedFaviconImage) return reject(new Error('no image'));
				cachedFaviconImage.onload = () => resolve();
				cachedFaviconImage.onerror = () => reject(new Error('favicon load failed'));
				cachedFaviconImage.src = originalFaviconHref as string;
			});
		}

		const canvas = document.createElement('canvas');
		canvas.width = FAVICON_SIZE;
		canvas.height = FAVICON_SIZE;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;

		// Draw the original favicon — CONTAIN-fitted, never stretched.
		//
		// tt.txt #2 — this used to be `drawImage(img, 0, 0, SIZE, SIZE)`. The
		// Morphit mark is wide (viewBox 10.889 × 7.049), so forcing it into a
		// square stretched it vertically. The browser renders the plain SVG
		// correctly, which is why the logo only ever looked squashed at the exact
		// moment a notification arrived — the one moment a user is looking at it.
		//
		// Some engines report no intrinsic size for an SVG without width/height,
		// so fall back to the asset's own viewBox aspect.
		const srcW = cachedFaviconImage.naturalWidth || FAVICON_INTRINSIC_WIDTH;
		const srcH = cachedFaviconImage.naturalHeight || FAVICON_INTRINSIC_HEIGHT;
		const fit = containFit(srcW, srcH, FAVICON_SIZE);
		ctx.drawImage(cachedFaviconImage, fit.dx, fit.dy, fit.dw, fit.dh);

		// Badge circle — upper-right, ~40% of favicon size.
		const badgeR = FAVICON_SIZE * 0.38;
		const badgeCx = FAVICON_SIZE - badgeR;
		const badgeCy = badgeR;

		// Morphit brand emerald for the badge fill. Using #00DA69 (the
		// middle gradient stop) so it reads as "Morphit" color at a
		// glance even at 16×16.
		ctx.fillStyle = '#00DA69';
		ctx.beginPath();
		ctx.arc(badgeCx, badgeCy, badgeR, 0, Math.PI * 2);
		ctx.fill();

		// Badge text — cap visible count at 9+ so two-digit numbers
		// don't blow out the circle.
		const text = count > 9 ? '9+' : String(count);
		ctx.fillStyle = '#0F141C'; // dark ink for contrast on emerald
		const fontSize = count > 9 ? FAVICON_SIZE * 0.36 : FAVICON_SIZE * 0.46;
		ctx.font = `900 ${fontSize}px system-ui, sans-serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		// Nudge text up 1px on the canvas — aligns visually with the
		// center of the circle across most fonts.
		ctx.fillText(text, badgeCx, badgeCy + 1);

		link.href = canvas.toDataURL('image/png');
	} catch {
		// Favicon couldn't be loaded (CORS, 404, etc.). Ambient
		// channels are best-effort; silently keep the original.
	}
}

/**
 * App Badging API — real OS-level badge on the PWA icon. Only works
 * when the user has installed Morphit as a PWA and the platform
 * supports this API. No-op otherwise.
 */
function setAppBadge(count: number): void {
	if (typeof navigator === 'undefined') return;
	// Feature detection — the API is still behind a flag / limited
	// to installed PWAs on some platforms.
	const nav = navigator as Navigator & {
		setAppBadge?: (n: number) => Promise<void>;
		clearAppBadge?: () => Promise<void>;
	};
	try {
		if (count > 0 && typeof nav.setAppBadge === 'function') {
			void nav.setAppBadge(count).catch(() => {
				// Some browsers reject with a permission error if the
				// PWA isn't installed. We ignore — ambient channels
				// are best-effort.
			});
		} else if (count === 0 && typeof nav.clearAppBadge === 'function') {
			void nav.clearAppBadge().catch(() => {});
		}
	} catch {
		// Defensive — some implementations throw synchronously if
		// the user hasn't granted the relevant permission.
	}
}

/** Start the ambient channels. Called once from the root layout's
 *  onMount. Returns a teardown function (for tests / unmount). */
export function startAmbientChannels(): () => void {
	if (typeof document === 'undefined') return () => undefined;

	captureOriginals();

	const unsubscribe = unreadCount.subscribe((c: UnreadCounts) => {
		const total = totalUnread(c);
		setTitle(total);
		void setFaviconBadge(total);
		setAppBadge(total);
	});

	// Feed the chat count into the store the ambient channels above consume.
	// Without this the chat badge never ticks up (only `feedback` was wired).
	const stopChatUnread = startChatUnreadChannel();

	return () => {
		unsubscribe();
		stopChatUnread();
		// Best-effort restore on teardown.
		if (originalTitle !== null) document.title = originalTitle;
	};
}
