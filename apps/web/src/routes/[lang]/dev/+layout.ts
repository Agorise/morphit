/**
 * /dev/+layout.ts — production gate for the maintainer-only /dev subtree.
 *
 * The /dev routes — the icon catalog, the responsive-viewport preview,
 * and the WebHID YubiKey transport probe — are CONTRIBUTOR / MAINTAINER
 * diagnostics, never meant for end users.  Each page's own header says
 * as much (the yubikey-probe is literally labelled "DEV ONLY"), and the
 * subtree carries no telemetry / auth / chain calls — but it was still
 * reachable in production through the SPA fallback (`fallback:
 * index.html`): a visitor (or a probe) hitting `/<lang>/dev/...` would
 * get the tool rendered, which is mild attack surface and a confusing
 * "what is this page" dead end against the grandma-friendly goal.
 *
 * This gate closes that.  Vite statically replaces `import.meta.env.DEV`
 * with the literal `false` in a production build, so this load throws a
 * 404 for EVERY /dev route at runtime in prod, while leaving the whole
 * subtree fully available under `npm run dev` (where `import.meta.env.DEV`
 * is `true`).  No route is removed from the source tree — the tools stay
 * one `npm run dev` away for contributors.
 *
 * `prerender = false`: the /dev routes aren't linked from anywhere (the
 * sitemap marks `/dev` `indexable: false`), so the prerender crawler
 * never visits them, but we state it explicitly — these dev-only pages
 * must never be emitted as prerendered HTML in a release build.
 */

import { error } from '@sveltejs/kit';

export const prerender = false;

export function load(): void {
	if (!import.meta.env.DEV) {
		throw error(404, 'Not found');
	}
}
