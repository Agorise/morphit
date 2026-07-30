<script lang="ts">
	/**
	 * VisibilityBadge — says who can see a settings section.
	 *
	 * ─── Why this exists ──────────────────────────────────────────────
	 *
	 * The Settings page writes to THREE different places, and nothing on
	 * screen said which was which:
	 *
	 *   public   → `morphit_profile_v1`, an UNENCRYPTED chain record. Display
	 *              name, avatar, bio and links. Permanent and world-readable —
	 *              that is the point, it is how a counterparty recognises you.
	 *   private  → `morphit_settings_v1`, ENCRYPTED with a posting-key-derived
	 *              key. Notification prefs, hidden/blocked accounts, region.
	 *              The operator stores an opaque blob and can read none of it.
	 *   device   → this browser only. Never leaves the machine.
	 *
	 * Ken hit the confusion directly: he set a screenful of fields, and when I
	 * said "kencode has never broadcast settings" he corrected me — reasonably,
	 * because he HAD saved settings, just to the other record. If the person
	 * who built it is caught out by that boundary, every user will be.
	 *
	 * It matters most for the PUBLIC group. Someone typing a personal detail
	 * into "short bio" deserves to know before they press Broadcast that it is
	 * going to a permanent public ledger — not after. Privacy is priority #1,
	 * and a privacy guarantee nobody can see is not one.
	 *
	 * Deliberately a plain inline badge, not a tooltip: a hover-only
	 * explanation is invisible on touch and to anyone not looking for it,
	 * which is precisely the wrong failure mode for this particular fact.
	 */
	import { t } from '$lib/i18n';

	interface Props {
		/** Where this section's values end up. */
		scope: 'public' | 'private' | 'device';
	}

	const { scope }: Props = $props();

	const label = $derived(
		scope === 'public'
			? $t('settings.visibility.public')
			: scope === 'private'
				? $t('settings.visibility.private')
				: $t('settings.visibility.device')
	);
	const detail = $derived(
		scope === 'public'
			? $t('settings.visibility.public_detail')
			: scope === 'private'
				? $t('settings.visibility.private_detail')
				: $t('settings.visibility.device_detail')
	);

	/** Amber for public — it is the one that can surprise someone. Emerald for
	 *  private/device reads as reassurance, which is accurate for both. */
	const tone = $derived(
		scope === 'public'
			? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
			: 'border-morphit-emerald/30 bg-morphit-emerald/10 text-morphit-emerald'
	);
</script>

<span class="inline-flex flex-col gap-0.5">
	<span
		class="inline-flex w-fit items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium {tone}"
	>
		<!-- Decorative: the label beside it already carries the meaning, so the
		     glyph is hidden from assistive tech rather than read out twice. -->
		<span aria-hidden="true">{scope === 'public' ? '🌐' : '🔒'}</span>
		{label}
	</span>
	<span class="text-xs text-ink-500">{detail}</span>
</span>
