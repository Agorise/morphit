<!--
  ExplorerLink.svelte — cp167 progressive-disclosure UI for multiple
  block-explorer alternatives.

  Why this exists:
    Each non-BLURT chain (BTC, XMR, ETH, etc.) has multiple public
    block explorers.  Different users trust different explorers
    (privacy posture, jurisdiction, JavaScript-required-or-not,
    censorship resistance).  Before cp167 the frontend picked one
    URL for the user — either the operator's configured override
    or a bundled default.  Grandma got exactly one link.

    After cp167, urls.externalExplorerUrls(asset, txid) returns the
    ORDERED list of all available URLs (operator override first if
    set, then bundled best→worst).  This component renders that
    list grandma-friendly:

      - urls.length === 0:  renders nothing (returns null)
      - urls.length === 1:  renders exactly the same single link
                            that ChatMessage used pre-cp167; no
                            visual change for users who don't have
                            multiple options.
      - urls.length > 1:    primary link renders identically; a
                            small "+N more" toggle reveals the
                            alternatives in a details/summary
                            popover below the primary link.

    Click target on the primary link is unchanged from before — one
    click goes to the operator's preferred explorer.  Grandma sees
    no difference unless she explicitly explores the "+N more"
    affordance.

  Accessibility:
    - <details> for the disclosure (native, no JS state)
    - host name from URL parsed at component level (no innerHTML)
    - target="_blank" + rel="noopener noreferrer" on every link
    - keyboard: <details>/<summary> is tab-stoppable + Enter/Space
      toggleable per the HTML spec
-->
<script lang="ts">
	import { _ } from 'svelte-i18n';

	interface Props {
		/** Ordered URL list, best→worst.  Pass the output of
		 *  externalExplorerUrls(asset, txid) verbatim. */
		urls: readonly string[];
		/** Label for the primary link.  Defaults to the i18n
		 *  key chat.funds_sent.view_on_explorer for in-chat use,
		 *  but callers in other contexts (order detail, etc.)
		 *  can pass their own. */
		primaryLabel?: string;
		/** Compact mode: no host name shown next to alternatives,
		 *  just the count.  Defaults to false (full host names
		 *  for clarity). */
		compact?: boolean;
	}

	const { urls, primaryLabel, compact = false }: Props = $props();

	/** Pull `host` from a URL without crashing on malformed input.
	 *  Returns the empty string on parse failure.  Used as the
	 *  visible label for each alternative so the user can tell
	 *  which explorer they're about to open. */
	function hostOf(url: string): string {
		try {
			return new URL(url).host;
		} catch {
			return '';
		}
	}

	const primaryUrl = $derived(urls.length > 0 ? urls[0] : null);
	const alternatives = $derived(urls.slice(1));
	const label = $derived(primaryLabel ?? ($_('chat.funds_sent.view_on_explorer') as string));
</script>

{#if primaryUrl !== null}
	<span class="inline-flex flex-wrap items-center gap-2">
		<a
			href={primaryUrl}
			target="_blank"
			rel="noopener noreferrer"
			class="text-xs underline-offset-2 opacity-70 hover:underline hover:opacity-100"
		>
			{label}
			↗
		</a>
		{#if alternatives.length > 0}
			<details class="inline-block">
				<summary
					class="inline-flex cursor-pointer items-center gap-0.5 text-xs opacity-50 hover:opacity-80"
					aria-label={$_('explorer.more_explorers_aria', {
						values: { count: alternatives.length }
					}) as string}
				>
					{#if compact}
						+{alternatives.length} ▾
					{:else}
						{$_('explorer.more_explorers', {
							values: { count: alternatives.length }
						})}
						▾
					{/if}
				</summary>
				<ul
					class="mt-1 flex flex-col gap-0.5 rounded border border-ink-200 bg-white p-2 text-xs shadow-sm dark:border-ink-700 dark:bg-ink-900"
				>
					{#each alternatives as altUrl, idx (altUrl)}
						<li>
							<a
								href={altUrl}
								target="_blank"
								rel="noopener noreferrer"
								class="block px-1 py-0.5 underline-offset-2 hover:underline hover:opacity-80"
								data-rank={idx + 2}
							>
								{hostOf(altUrl)}
								↗
							</a>
						</li>
					{/each}
				</ul>
			</details>
		{/if}
	</span>
{/if}
