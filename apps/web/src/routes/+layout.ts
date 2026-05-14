/**
 * Root +layout.ts — detection-redirect shell config.
 *
 * Part 121 cp7 (per-locale prerendering, ADR-0024).
 *
 * The root route serves a minimal HTML shell whose only job is to
 * detect the user's preferred locale and redirect to the
 * appropriate `[lang]/*` route subtree.  All real content lives
 * under `[lang]/`.
 *
 * Prerender posture:
 *
 *   - `prerender = true` — the root `/` page IS prerendered as a
 *     static HTML file with a tiny inline script that does the
 *     redirect at first paint.  Pre-rendering is fine because the
 *     shell carries NO localized content; the script reads
 *     `navigator.languages` and replaces window.location at
 *     runtime.
 *
 *   - The `[lang]/+layout.ts` `prerender = true` + `entries()`
 *     produce one HTML per (route × locale) pair; this root
 *     layout is the redirect entry point that ships alongside
 *     them.
 *
 *   - `ssr = false` for the root shell ONLY — the shell's job is
 *     pure client-side detection.  SSR would prerender a "best
 *     guess" locale that the client would then re-detect; better
 *     to ship a blank shell and let the script run.
 */

export const prerender = true;
export const ssr = false;
export const trailingSlash = 'never';
