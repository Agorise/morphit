<script lang="ts">
	/**
	 * MessageIcon — a clean speech-bubble glyph used wherever we
	 * offer "message this person" / show a conversation count.
	 * Replaces the bare 💬 emoji so the affordance renders crisply
	 * and consistently across platforms (emoji rendering varies
	 * wildly by OS/font).  Inherits color via `currentColor` and
	 * sizes via the `class` prop (default 1rem square).
	 */
	interface Props {
		/** Tailwind sizing/extra classes. Defaults to a 1rem square. */
		class?: string;
	}
	let { class: cls = 'h-4 w-4 shrink-0' }: Props = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={cls}
	aria-hidden="true"
>
	<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
</svg>
