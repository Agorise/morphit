<script lang="ts">
	/**
	 * MarkdownGuideModal — a small reference of the exact markdown subset the
	 * order Terms field supports (see TermsText / termsMarkdown.ts): headings,
	 * bold, italics, blockquote, ordered/unordered lists, horizontal rule, and
	 * links. t.txt (v1.4.9 #2). Opened from the subdued icon over the Terms
	 * field's top-right corner.
	 *
	 * The ELEMENT names + the heading are translated; the SYNTAX examples are
	 * literal markdown (code), so they stay as-is in every locale. No {@html}
	 * anywhere — every value is plain text through Svelte's escaping.
	 */
	import { _ } from 'svelte-i18n';

	interface Props {
		open: boolean;
		onClose: () => void;
	}
	let { open, onClose }: Props = $props();

	// Each row: a translated label key + the literal markdown syntax (constant).
	const rows: ReadonlyArray<{ key: string; syntax: string }> = [
		{ key: 'post_order.terms_md_guide.el_heading', syntax: '# H1\n## H2\n### H3' },
		{ key: 'post_order.terms_md_guide.el_bold', syntax: '**bold text**' },
		{ key: 'post_order.terms_md_guide.el_italic', syntax: '*italicized text*' },
		{ key: 'post_order.terms_md_guide.el_blockquote', syntax: '> blockquote' },
		{
			key: 'post_order.terms_md_guide.el_ordered',
			syntax: '1. First item\n2. Second item\n3. Third item'
		},
		{
			key: 'post_order.terms_md_guide.el_unordered',
			syntax: '- First item\n- Second item\n- Third item'
		},
		{ key: 'post_order.terms_md_guide.el_hr', syntax: '---' },
		{ key: 'post_order.terms_md_guide.el_link', syntax: '[title](https://www.example.com)' }
	];

	const titleId = `md-guide-title-${Math.random().toString(36).slice(2, 8)}`;

	function onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Escape') onClose();
	}
</script>

<svelte:window onkeydown={open ? onKeydown : undefined} />

{#if open}
	<!-- Backdrop: click to dismiss. -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
		role="button"
		tabindex="-1"
		aria-label={$_('common.close') as string}
		onclick={onClose}
		onkeydown={(e) => {
			if (e.key === 'Enter' || e.key === ' ') onClose();
		}}
	>
		<!-- Dialog panel. stopPropagation so clicks inside don't dismiss. -->
		<div
			class="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-xl dark:bg-ink-900"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			onclick={(e) => e.stopPropagation()}
			onkeydown={(e) => e.stopPropagation()}
			tabindex="-1"
		>
			<div class="mb-3 flex items-center justify-between gap-3">
				<h2 id={titleId} class="font-display text-lg font-bold">
					{$_('post_order.terms_md_guide.heading')}
				</h2>
				<button
					type="button"
					class="flex h-7 w-7 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700 dark:hover:bg-ink-800 dark:hover:text-ink-200"
					aria-label={$_('common.close') as string}
					title={$_('common.close') as string}
					onclick={onClose}
				>
					✕
				</button>
			</div>

			<table class="w-full border-collapse text-sm">
				<thead>
					<tr class="border-b border-ink-200 text-start dark:border-ink-700">
						<th class="py-2 pe-3 text-start font-semibold text-ink-600 dark:text-ink-300">
							{$_('post_order.terms_md_guide.col_element')}
						</th>
						<th class="py-2 text-start font-semibold text-ink-600 dark:text-ink-300">
							{$_('post_order.terms_md_guide.col_syntax')}
						</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row (row.key)}
						<tr class="border-b border-ink-100 align-top dark:border-ink-800">
							<td class="py-2.5 pe-3 font-medium text-morphit-emerald">
								{$_(row.key)}
							</td>
							<td class="py-2.5">
								<code
									class="whitespace-pre-wrap break-words font-mono text-xs text-ink-700 dark:text-ink-200"
									>{row.syntax}</code
								>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>
{/if}
