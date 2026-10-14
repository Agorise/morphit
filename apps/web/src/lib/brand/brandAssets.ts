/**
 * The URLs the pages load the operator-replaceable logos from (v1.21.8).
 *
 * They carry `?fresh=1` (BRAND_FRESH_PARAM in $lib/net/dynamicPaths) for ONE
 * reason: the service worker of v1.21.7, which a visitor's browser still runs
 * on the first page after the site upgrades, served brand files from its
 * stored copy — Morphit's logo, if the visitor saw the site before it was
 * branded — except a read carrying `?fresh=1`, which it fetched from the
 * network. This release's worker serves these like any brand file
 * (network-first, the stored copy when offline). The server ignores the query.
 * app.html preloads SITE_LOGO_SRC under the same URL, so one download serves
 * the preload, the <img> and the shine's mask.
 */
export const SITE_LOGO_SRC = '/brand/site-logo.svg?fresh=1';
export const SITE_LOGO_FOOTER_SRC = '/brand/site-logo-footer.svg?fresh=1';
