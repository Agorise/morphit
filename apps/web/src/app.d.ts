// See https://kit.svelte.dev/docs/types#app
declare global {
	// SvelteKit reads the App namespace declarations during type
	// generation in `.svelte-kit/`. ESLint's no-unused-vars rule
	// can't see those generated consumers, so this trips a false
	// "App is defined but never used" warning. The namespace is
	// required by the framework.
	// eslint-disable-next-line no-unused-vars
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}

	/** Frontend bundle version, injected by Vite's `define` from
	 *  the `version` field of apps/web/package.json at build time.
	 *  Compared against the chain-announced release version by the
	 *  release-trust-anchor store (Batch J). */
	const __MORPHIT_VERSION__: string;

	/** The origin the prerendered pages are built for (vite.config.js
	 *  `define`; morphit.io for the release build). Read only in server-side
	 *  code (src/lib/seo/urls.ts siteOrigin), so it never reaches the client
	 *  bundle; install/upgrade rewrites it to the instance's own origin. */
	const __MORPHIT_SITE_ORIGIN__: string;
}

export {};
