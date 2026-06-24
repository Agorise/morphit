<script lang="ts">
	/**
	 * FocusedField — visually leads grandma's eye to the field she's
	 * supposed to fill in next.
	 *
	 * Visual states:
	 *
	 *   focused + not-yet-valid  → thick emerald border + gentle
	 *                              pulse (draws the eye)
	 *   focused + valid          → thick emerald border, solid
	 *                              (shows the field accepted input)
	 *   invalid                  → thick red border (persists even
	 *                              while focused; the global focus
	 *                              ring still indicates focus on top)
	 *   not-focused              → normal 1px neutral border
	 *
	 * The emerald "attention" border RECEDES once the field is actually
	 * focused (`:focus-within`): app.css already draws a brand-green
	 * `:focus-visible` ring on the inner control, so keeping the emerald
	 * border too produced a redundant SECOND green outline on click. On
	 * focus we drop back to a neutral 1px border + no pulse and let that
	 * single focus ring do the work. (The red `invalid` border is exempt
	 * — it must stay visible while the user fixes the value.)
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
		/** True when this field's current value is invalid (e.g. a taken
		 *  or rejected account name). Shows a red border that persists
		 *  even while focused. Takes priority over focused/valid. */
		invalid?: boolean;
		children: Snippet;
	}

	let { focused, valid = false, invalid = false, children }: Props = $props();

	const classes = $derived.by(() => {
		if (invalid) {
			// Red border stays put even on focus (no focus-within recede) —
			// the global :focus-visible ring still indicates focus on top.
			return 'border-2 border-red-500 dark:border-red-500';
		}
		// Non-invalid: the emerald attention border recedes on focus so it
		// doesn't double up with the global green focus ring.
		const recede =
			'focus-within:border focus-within:border-ink-200 focus-within:animate-none dark:focus-within:border-ink-700';
		if (!focused) {
			return `border border-ink-200 dark:border-ink-700 ${recede}`;
		}
		if (valid) {
			return `border-2 border-morphit-emerald ${recede}`;
		}
		return `border-2 border-morphit-emerald animate-pulse-soft-border ${recede}`;
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
