<!--
	LazyLoadError — the {:catch} fallback for lazily-imported components
	({#await loadXxx() then Comp}). cp418.

	These lazy imports code-split heavier / interactive UI (forms, pickers,
	modals) so they don't weigh down first paint. The service worker is
	network-first for navigations, so a fresh shell always references chunk
	names that exist on the origin — but a session left open ACROSS a deploy
	can still hold an in-memory shell whose lazily-imported chunk was rotated
	away, and clicking to open the form would then reject the import and (with
	no catch) render nothing — leaving the user staring at a control that did
	nothing.

	This gives that case a visible, actionable fallback instead of silence: a
	one-line message + a Refresh that reloads the page (which, via the
	network-first SW, pulls a fresh shell with valid chunk names). Manual,
	user-initiated — no auto-reload loop.
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';
	function refresh(): void {
		if (typeof location !== 'undefined') location.reload();
	}
</script>

<div
	role="alert"
	class="my-2 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2 text-sm text-ink-600 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-300"
>
	<span>{$_('common.lazy_load_failed')}</span>
	<button
		type="button"
		onclick={refresh}
		class="ml-1 font-semibold text-morphit-emerald underline underline-offset-2 hover:no-underline"
	>
		{$_('common.retry')}
	</button>
</div>
