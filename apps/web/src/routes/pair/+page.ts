/**
 * /pair page options — mirrors the root `/` redirect shell.
 *
 * `prerender = true`: a static shell ships alongside the locale pages.
 * `ssr = false`: the bounce is pure client-side — it reads the runtime query
 *   (`window.location.search`), which a prerender/SSR pass cannot know.
 * `trailingSlash = 'never'`: keep `/pair` canonical (no `/pair/`).
 */
export const prerender = true;
export const ssr = false;
export const trailingSlash = 'never';
