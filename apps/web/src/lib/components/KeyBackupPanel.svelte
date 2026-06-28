<script lang="ts">
	import { _ } from 'svelte-i18n';
	import type { BackupKey } from '$crypto/keyExport';

	let { keys, accountName = '' }: { keys: readonly BackupKey[]; accountName?: string } = $props();

	// Per-line "just copied" flash, keyed by `${role}:${which}`. Only one
	// line shows the flash at a time. Clipboard failures (insecure context,
	// blocked permission) fail silently — the value is on screen for manual
	// selection, so there's nothing the user can't recover from.
	let copiedId = $state<string | null>(null);
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	async function copyValue(id: string, value: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			copiedId = id;
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => (copiedId = null), 2000);
		} catch {
			/* clipboard unavailable — value is visible for manual copy */
		}
	}

	let downloaded = $state(false);
	let downloadTimer: ReturnType<typeof setTimeout> | undefined;
	function downloadTxt(): void {
		const date = new Date().toISOString().slice(0, 10);
		const lines: string[] = [];
		lines.push('Morphit / Blurt account keys');
		if (accountName) lines.push(`Account: @${accountName}`);
		lines.push(`Saved: ${date}`);
		lines.push('');
		lines.push($_('backup_keys_panel.txt_warning'));
		lines.push('');
		for (const k of keys) {
			lines.push($_(`backup_keys_panel.role.${k.role}`));
			lines.push(`  ${$_('backup_keys_panel.public_label')}: ${k.pub}`);
			lines.push(`  ${$_('backup_keys_panel.private_label')}: ${k.wif}`);
			lines.push('');
		}
		lines.push($_('backup_keys_panel.txt_footer'));
		const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `morphit-keys-${accountName || date}.txt`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		URL.revokeObjectURL(url);
		downloaded = true;
		clearTimeout(downloadTimer);
		downloadTimer = setTimeout(() => (downloaded = false), 3000);
	}
</script>

{#snippet keyLine(id: string, label: string, value: string, secret: boolean)}
	<div class="mt-2 flex items-center gap-2">
		<div class="min-w-0 flex-1">
			<div class="text-xs font-medium text-ink-500 dark:text-ink-400">{label}</div>
			<div
				class="break-all font-mono text-sm {secret
					? 'text-ink-900 dark:text-ink-100'
					: 'text-ink-600 dark:text-ink-300'}"
			>
				{value}
			</div>
		</div>
		<button
			type="button"
			onclick={() => copyValue(id, value)}
			aria-label={copiedId === id ? $_('common.copied') : $_('common.copy')}
			title={copiedId === id ? $_('common.copied') : $_('common.copy')}
			class="inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-ink-300 bg-white text-ink-700 transition hover:bg-ink-50 dark:border-ink-600 dark:bg-ink-800 dark:text-ink-100 dark:hover:bg-ink-700"
		>
			{#if copiedId === id}
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="3"
					stroke-linecap="round"
					stroke-linejoin="round"
					class="text-morphit-emerald"
					aria-hidden="true"
				>
					<path d="M20 6 9 17l-5-5" />
				</svg>
			{:else}
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
					<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
				</svg>
			{/if}
		</button>
	</div>
{/snippet}

<section aria-labelledby="backup-keys-panel-heading">
	<!-- Don't-share warning, prominent and plain-language (grandma). -->
	<div
		class="flex items-start gap-3 rounded-2xl border-2 border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-950"
	>
		<svg
			class="mt-0.5 h-6 w-6 flex-none text-amber-600 dark:text-amber-400"
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
			<line x1="12" y1="9" x2="12" y2="13" />
			<line x1="12" y1="17" x2="12.01" y2="17" />
		</svg>
		<div>
			<p id="backup-keys-panel-heading" class="font-semibold text-amber-900 dark:text-amber-100">
				{$_('backup_keys_panel.warning_title')}
			</p>
			<p class="mt-1 text-sm text-amber-900/90 dark:text-amber-100/90">
				{$_('backup_keys_panel.warning_body')}
			</p>
		</div>
	</div>

	<p class="mt-4 text-sm text-ink-600 dark:text-ink-300">{$_('backup_keys_panel.intro')}</p>

	<div class="mt-3 space-y-3">
		{#each keys as k (k.role)}
			<div class="rounded-xl border border-ink-200 bg-white p-3 dark:border-ink-700 dark:bg-ink-900">
				<div class="flex items-baseline justify-between gap-2">
					<span class="font-semibold">{$_(`backup_keys_panel.role.${k.role}`)}</span>
					<span class="text-xs text-ink-500 dark:text-ink-400"
						>{$_(`backup_keys_panel.role_hint.${k.role}`)}</span
					>
				</div>
				{@render keyLine(`${k.role}:pub`, $_('backup_keys_panel.public_label'), k.pub, false)}
				{@render keyLine(`${k.role}:wif`, `🔒 ${$_('backup_keys_panel.private_label')}`, k.wif, true)}
			</div>
		{/each}
	</div>

	<div class="mt-4">
		<button
			type="button"
			onclick={downloadTxt}
			class="inline-flex items-center gap-2 rounded-lg bg-morphit-btn px-4 py-2 font-semibold text-white transition hover:brightness-110"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="16"
				height="16"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"
			>
				<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
				<polyline points="7 10 12 15 17 10" />
				<line x1="12" y1="15" x2="12" y2="3" />
			</svg>
			{downloaded ? $_('backup_keys_panel.downloaded') : $_('backup_keys_panel.download')}
		</button>
	</div>

	<p class="mt-3 text-xs text-ink-500 dark:text-ink-400">{$_('backup_keys_panel.no_master_password')}</p>
</section>
