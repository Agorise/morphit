// v1.20.2 — served by the morphit-i18n-sections Vite plugin
// (scripts/vite-i18n-sections.ts): for each locale code, one lazy import per
// part (`core` and each section in ./lazySections.ts).
declare module 'virtual:morphit-i18n-loaders' {
	const parts: Readonly<
		Record<string, Readonly<Record<string, () => Promise<{ default: Record<string, unknown> }>>>>
	>;
	export default parts;
}
