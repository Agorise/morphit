<script lang="ts">
	/**
	 * PrivateKeyWarningModal — first-line defense when a user pastes
	 * a private key into a field that would send it somewhere
	 * (feedback comment, reply, chat message).
	 *
	 * Bright red, loud, impossible to miss. Shows the TRUNCATED form
	 * of each detected key (6+…+4) so the user can see which string
	 * in their input triggered the warning without the modal itself
	 * leaking the secret.
	 *
	 * The user has two choices:
	 *   (1) Dismiss and edit — field retains focus, they can delete it
	 *   (2) Send anyway — the parent component redacts the payload
	 *       via redactPrivateKeys() before broadcast
	 *
	 * Accessibility:
	 *   - role="alertdialog" (vs "dialog" — this is urgent)
	 *   - focus trap within the modal
	 *   - Escape dismisses (treated as "edit" — safer default)
	 *   - Primary CTA on the "edit" side, not "send anyway"
	 */

	import { _ } from 'svelte-i18n';
	import { onMount, onDestroy } from 'svelte';
	import { truncateKey, type PrivateKeyMatch } from '$lib/security/privateKeyDetector';

	interface Props {
		/** The matches that triggered the warning. Shown as a list
		 *  of truncated + labeled items in the modal body. */
		matches: readonly PrivateKeyMatch[];
		/** User wants to edit — dismiss modal, focus returns to
		 *  field. Safer default. */
		onEdit: () => void;
		/** User explicitly chose to send anyway. The parent's
		 *  submit path should still run redactPrivateKeys() on
		 *  the outgoing text. */
		onSendAnyway: () => void;
	}

	let { matches, onEdit, onSendAnyway }: Props = $props();

	let editButtonEl = $state<HTMLButtonElement | null>(null);
	let modalEl = $state<HTMLDivElement | null>(null);

	function kindLabel(kind: PrivateKeyMatch['kind']): string {
		switch (kind) {
			case 'wif':
				return $_('privkey_warn.kind_wif') as string;
			case 'hex_64':
				return $_('privkey_warn.kind_hex_64') as string;
			case 'mnemonic':
				return $_('privkey_warn.kind_mnemonic') as string;
		}
	}

	function onKeydown(ev: KeyboardEvent): void {
		if (ev.key === 'Escape') {
			ev.preventDefault();
			onEdit();
			return;
		}
		// Simple focus trap: Tab / Shift+Tab cycle within the modal.
		if (ev.key === 'Tab' && modalEl) {
			const focusables = modalEl.querySelectorAll<HTMLElement>(
				'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])'
			);
			if (focusables.length === 0) return;
			const first = focusables[0]!;
			const last = focusables[focusables.length - 1]!;
			if (ev.shiftKey && document.activeElement === first) {
				ev.preventDefault();
				last.focus();
			} else if (!ev.shiftKey && document.activeElement === last) {
				ev.preventDefault();
				first.focus();
			}
		}
	}

	onMount(() => {
		// Snap focus to the safe action button.
		editButtonEl?.focus();
		document.addEventListener('keydown', onKeydown);
	});

	onDestroy(() => {
		document.removeEventListener('keydown', onKeydown);
	});
</script>

<!-- Backdrop + modal. Click outside = same as "edit" (safer). -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
	onclick={(e) => {
		// Only handle clicks on the backdrop itself, not on the
		// modal content.
		if (e.target === e.currentTarget) onEdit();
	}}
	onkeydown={(e) => {
		// Let backdrop swallow Enter/Space presses targeted at it
		// to avoid accidental submissions.
		if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
			e.preventDefault();
			onEdit();
		}
	}}
	role="presentation"
>
	<div
		bind:this={modalEl}
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="privkey-warn-title"
		aria-describedby="privkey-warn-body"
		class="max-w-md rounded-2xl border-4 border-red-500 bg-white p-5 shadow-2xl dark:bg-ink-900"
	>
		<h2
			id="privkey-warn-title"
			class="mb-2 flex items-center gap-2 font-display text-xl font-extrabold text-red-700 dark:text-red-300"
		>
			<span aria-hidden="true" class="text-2xl">⚠️</span>
			{$_('privkey_warn.title')}
		</h2>
		<p id="privkey-warn-body" class="mb-3 text-sm font-semibold text-ink-900 dark:text-ink-100">
			{$_('privkey_warn.body')}
		</p>

		<!-- What we detected, truncated. -->
		<div
			class="mb-4 rounded-xl border border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-950"
		>
			<p class="mb-2 text-xs font-semibold uppercase tracking-wide text-red-800 dark:text-red-200">
				{$_('privkey_warn.detected_heading')}
			</p>
			<ul class="space-y-1 text-sm">
				{#each matches as m}
					<li class="flex items-baseline gap-2">
						<span
							class="rounded bg-red-200 px-1.5 py-0.5 text-xs font-semibold text-red-900 dark:bg-red-800 dark:text-red-100"
						>
							{kindLabel(m.kind)}
						</span>
						<code class="font-mono text-red-900 dark:text-red-100">
							{truncateKey(m.text)}
						</code>
					</li>
				{/each}
			</ul>
		</div>

		<p class="mb-4 text-xs text-ink-600 dark:text-ink-300">
			{$_('privkey_warn.explain')}
		</p>

		<div class="flex flex-col gap-2 sm:flex-row-reverse">
			<!-- Primary action is EDIT — safer default. Placed on
			     the right in reversed flex for LTR visual priority. -->
			<button
				bind:this={editButtonEl}
				type="button"
				onclick={onEdit}
				class="rounded-xl bg-morphit-emerald px-4 py-2 font-semibold text-ink-900 transition hover:brightness-110 active:scale-[0.98]"
			>
				{$_('privkey_warn.edit_cta')}
			</button>
			<button
				type="button"
				onclick={onSendAnyway}
				class="rounded-xl border-2 border-ink-200 px-4 py-2 text-ink-700 transition hover:border-ink-300 active:scale-[0.98] dark:border-ink-700 dark:text-ink-300"
			>
				{$_('privkey_warn.send_anyway_cta')}
			</button>
		</div>
	</div>
</div>
