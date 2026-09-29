/**
 * Morphit — per-instance COLOUR THEME, runtime half (docs/BRANDING.md, "Colours").
 *
 * Pure DOM helper, no SvelteKit imports (unit-tested in applyTheme.test.ts).
 * Every brand/surface colour is a CSS custom property (src/theme.css). The SPA
 * shell (index.html — on the on-chain tamper manifest, never rewritten) gets an
 * instance's theme from /brand/brand.json: `ensureBrand()` (./brand.ts) passes
 * its `theme` block here. Prerendered pages already carry the theme as a
 * `<style id="morphit-theme">` written by `morphit-ops branding apply`, so they
 * are left alone.
 */

/** Must match THEME_STYLE_ID in @morphit/operator-config/theme. */
export const THEME_STYLE_ID = 'morphit-theme';

/** A theme token name as brand.json carries it ("brand-1", "surface-950"). */
const THEME_TOKEN_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const THEME_HEX_RE = /^#[0-9a-f]{6}$/i;

/**
 * Apply brand.json's `theme` block to <html> as inline custom properties
 * (`--<name>-rgb: R G B`, `--grid-opacity`) and the theme-color meta. The file
 * is served by this instance, but it is still parsed strictly: only
 * `#rrggbb` values under plain token names are applied, so nothing else can
 * reach the style attribute. A page that already carries the theme <style>
 * (prerendered, themed server-side) is left alone. Returns true if applied.
 */
export function applyTheme(
	theme: unknown,
	root: HTMLElement | null = typeof document === 'undefined' ? null : document.documentElement
): boolean {
	if (root === null || theme === null || typeof theme !== 'object') return false;
	if (root.ownerDocument.getElementById(THEME_STYLE_ID) !== null) return false;
	const tokens = (theme as { tokens?: unknown }).tokens;
	if (tokens === null || typeof tokens !== 'object') return false;
	let n = 0;
	for (const [name, hex] of Object.entries(tokens as Record<string, unknown>)) {
		if (!THEME_TOKEN_NAME_RE.test(name) || typeof hex !== 'string' || !THEME_HEX_RE.test(hex))
			continue;
		const v = parseInt(hex.slice(1), 16);
		root.style.setProperty(`--${name}-rgb`, `${(v >> 16) & 255} ${(v >> 8) & 255} ${v & 255}`);
		n++;
	}
	const grid = (theme as { grid_opacity?: unknown }).grid_opacity;
	if (typeof grid === 'number' && Number.isFinite(grid) && grid >= 0 && grid <= 0.2) {
		root.style.setProperty('--grid-opacity', String(grid));
	}
	const mid = (tokens as Record<string, unknown>)['brand-2'];
	const meta = root.ownerDocument.querySelector('meta[name="theme-color"]');
	if (meta !== null && typeof mid === 'string' && THEME_HEX_RE.test(mid))
		meta.setAttribute('content', mid);
	return n > 0;
}
