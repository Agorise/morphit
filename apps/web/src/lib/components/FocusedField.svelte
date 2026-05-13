<script lang="ts">
	/**
	 * FocusedField — visually leads grandma's eye to the field she's
	 * supposed to fill in next.
	 *
	 * Three visual states:
	 *
	 *   focused + not-yet-valid  → thick emerald border + gentle
	 *                              pulse (draws the eye)
	 *   focused + valid          → thick emerald border, solid
	 *                              (shows the field accepted input)
	 *   not-focused              → normal 1px neutral border
	 *                              (recedes once another field is
	 *                              the current one)
	 *
	 * This is a wrapper, not a full input component — the caller
	 * owns the actual <input>/<select>/<textarea> for full control
	 * over binding, autocomplete attrs, etc.
	 *
	 * See docs/UX-STANDARD.md rule #2.
	 */

	import type { Snippet } from 'svelte';

	interface Props {
		/** True when this field is the next expected action. */
		focused: boolean;
		/** True when this field's current value is valid. When
		 *  focused+valid we show solid (no pulse). */
		valid?: boolean;
		children: Snippet;
	}

	let { focused, valid = false, children }: Props = $props();

	const classes = $derived.by(() => {
		if (!focused) {
			return 'border border-ink-200 dark:border-ink-700';
		}
		if (valid) {
			return 'border-2 border-morphit-emerald';
		}
		return 'border-2 border-morphit-emerald animate-pulse-soft-border';
	});
</script>

<div class="rounded-2xl transition-all duration-200 {classes}">
	{@render children()}
</div>

<style>
	/* Soft pulse that draws the eye without being garish. Slower than
	   typical CSS pulse; tuned for calm attention rather than urgency. */
	:global(.animate-pulse-soft-border) {
		animation: pulse-soft-border 2.4s ease-in-out infinite;
	}

	@keyframes pulse-soft-border {
		0%,
		100% {
			box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.35);
		}
		50% {
			box-shadow: 0 0 0 6px rgba(16, 185, 129, 0);
		}
	}
</style>
