<script lang="ts">
	/**
	 * ConfirmModal — shadowboxed confirmation dialog for destructive
	 * actions.
	 *
	 * Uses the native HTML <dialog> element with .showModal(), which
	 * gives us for free:
	 *   - Proper focus trap (Tab cycles inside the dialog only)
	 *   - Backdrop rendering via ::backdrop pseudo-element
	 *   - Escape-to-dismiss (we intercept to route through Cancel)
	 *   - Correct aria-modal semantics without manual plumbing
	 *
	 * Visual style: dark semi-transparent backdrop with a subtle
	 * blur — the "shadowbox" effect. Dialog itself is a rounded
	 * card with a danger-tinted top border when variant='destructive'
	 * so the user visually notices this isn't a routine dialog.
	 *
	 * Default focus goes to the Cancel button so a stray Enter press
	 * doesn't trigger the destructive action. Escape routes through
	 * the cancel handler too.
	 */
	import { onMount } from 'svelte';
	import BusyButton from './BusyButton.svelte';

	interface Props {
		/** Controls dialog visibility. Bind with `bind:open`. */
		open: boolean;
		/** Headline of the dialog. Should be a direct statement:
		 *  "Sign out of Morphit?" — not a vague "Are you sure?". */
		title: string;
		/** Body explaining exactly what will happen. */
		body: string;
		/** Label on the confirm (destructive) button. */
		confirmLabel: string;
		/** Label on the cancel (safe) button. */
		cancelLabel: string;
		/** Called when user confirms. Modal doesn't close itself;
		 *  caller closes by setting open=false after handler returns. */
		onConfirm: () => void | Promise<void>;
		/** Called when user cancels (button, Escape, or backdrop click). */
		onCancel: () => void;
		/** Visual variant — 'destructive' tints the top border red
		 *  and gives the confirm button destructive styling. */
		variant?: 'destructive' | 'neutral';
		/** Shown on the confirm button while the confirm handler is
		 *  still running (e.g. for an async sign-out that's doing
		 *  cleanup). */
		busyLabel?: string;
	}

	let {
		open = $bindable(),
		title,
		body,
		confirmLabel,
		cancelLabel,
		onConfirm,
		onCancel,
		variant = 'destructive',
		busyLabel
	}: Props = $props();

	let dialogEl: HTMLDialogElement | undefined;
	let cancelBtn: HTMLButtonElement | undefined;
	let confirming = $state(false);

	// Stable per-instance ID for the title heading; used by
	// `aria-labelledby` on the dialog element so screen
	// readers announce the dialog by its title rather than
	// the generic "dialog".  Generated via crypto.randomUUID
	// when available, falls back to a counter-suffixed string
	// in older runtime contexts (SSR with no crypto, smoke
	// tests).  Stable across re-renders because it's
	// component-instance-scoped (not derived).
	const titleId = `confirm-modal-title-${
		typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
			? crypto.randomUUID()
			: Math.random().toString(36).slice(2, 10)
	}`;

	// Whenever `open` flips to true, call showModal() so the dialog
	// actually displays modally. Flipping to false → close().
	$effect(() => {
		if (!dialogEl) return;
		if (open && !dialogEl.open) {
			dialogEl.showModal();
			// Default focus on Cancel — a stray Enter press here is
			// the wrong thing for a destructive action. User can still
			// Tab once to reach Confirm.
			queueMicrotask(() => cancelBtn?.focus());
		} else if (!open && dialogEl.open) {
			dialogEl.close();
		}
	});

	async function handleConfirm(): Promise<void> {
		if (confirming) return;
		confirming = true;
		try {
			await onConfirm();
		} finally {
			confirming = false;
		}
	}

	/** Wrap cancel so backdrop click, Escape key, and Cancel button
	 *  all route through the same handler. */
	function handleCancel(): void {
		if (confirming) return; // don't cancel mid-confirm
		onCancel();
	}

	// Intercept Escape + backdrop-click — the native <dialog>
	// behavior is to close on Escape, which we want to catch so
	// the caller's onCancel runs (for bookkeeping like clearing
	// pending state).
	function onDialogClose(): void {
		// If the dialog closed without our setter knowing (via
		// Escape), sync the bound state and fire onCancel.
		if (open) {
			open = false;
			handleCancel();
		}
	}

	function onBackdropClick(e: MouseEvent): void {
		// <dialog> click events fire for both the dialog content and
		// the backdrop. The backdrop is the dialog element itself
		// (the content is a child wrapper), so a click whose target
		// is exactly dialogEl = backdrop click.
		if (e.target === dialogEl) handleCancel();
	}

	onMount(() => {
		// Safety: if the component unmounts while open, close the
		// dialog explicitly so it doesn't dangle.
		return () => {
			if (dialogEl?.open) dialogEl.close();
		};
	});
</script>

<!-- Native <dialog> gives us the focus trap + backdrop for free.
     Inline styles on the ::backdrop pseudo-element apply the
     blur + semi-transparent fill for the shadowbox effect. -->
<dialog
	bind:this={dialogEl}
	onclose={onDialogClose}
	onclick={onBackdropClick}
	aria-labelledby={titleId}
	class="max-w-md rounded-2xl border-t-4 bg-white p-0 shadow-morphit-card-hover backdrop:bg-ink-950/60 backdrop:backdrop-blur-sm dark:bg-ink-900 {variant ===
	'destructive'
		? 'border-red-500'
		: 'border-morphit-emerald'}"
>
	<!-- The inner wrapper keeps click events off the backdrop target —
	     clicks inside the wrapper shouldn't trigger the backdrop
	     close path. -->
	<div class="p-6">
		<h2 id={titleId} class="font-display text-xl font-bold">{title}</h2>
		<p class="mt-3 whitespace-pre-line text-ink-700 dark:text-ink-200">{body}</p>
		<div class="mt-6 flex flex-wrap justify-end gap-3">
			<button
				bind:this={cancelBtn}
				type="button"
				onclick={handleCancel}
				disabled={confirming}
				class="rounded-xl border border-ink-300 bg-white px-4 py-2 font-semibold text-ink-700 transition hover:border-morphit-emerald hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald disabled:cursor-not-allowed disabled:opacity-50 dark:border-ink-600 dark:bg-ink-900 dark:text-ink-200"
			>
				{cancelLabel}
			</button>
			{#if variant === 'destructive'}
				<BusyButton
					variant="ghost"
					busy={confirming}
					busyLabel={busyLabel ?? confirmLabel}
					onclick={handleConfirm}
				>
					<span class="text-red-600 dark:text-red-400">
						{confirmLabel}
					</span>
				</BusyButton>
			{:else}
				<BusyButton
					variant="primary"
					busy={confirming}
					busyLabel={busyLabel ?? confirmLabel}
					onclick={handleConfirm}
				>
					{confirmLabel}
				</BusyButton>
			{/if}
		</div>
	</div>
</dialog>
