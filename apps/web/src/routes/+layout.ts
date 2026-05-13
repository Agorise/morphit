// Prerender every route by default. SSR + CSR both on: static HTML is served
// first (so No-JS browsing works for read-only pages), then JS takes over.
export const prerender = true;
export const ssr = true;
export const trailingSlash = 'never';
