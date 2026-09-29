<script lang="ts">
	/**
	 * InsecureContextNotice — a calm, dismissible note shown ONLY when the
	 * browser reports that this page is not a secure context. In practice that
	 * is a plain-HTTP I2P address (`http://….b32.i2p`, e.g. Firefox with an I2P
	 * proxy); https:// pages and Tor Browser's .onion pages are secure contexts
	 * and never see it.
	 *
	 * On such a page the browser switches off WebCrypto, the clipboard and
	 * service workers, so authenticator (2FA) codes, copy buttons, the peer
	 * safety-number check, offline mode and notifications do not work. Keys,
	 * signing, trading and chat do. (v1.20.0 review, F-9.) Dismissed for the
	 * rest of the browser session.
	 */
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { isInsecureContext } from '$lib/security/secureContext';
	import { safeSession } from '$lib/utils/safeStorage';

	const DISMISS_KEY = 'morphit.insecureContextNotice.dismissed';
	let show = $state(false);

	onMount(() => {
		show = isInsecureContext() && safeSession.get(DISMISS_KEY) !== '1';
	});

	function dismiss(): void {
		show = false;
		safeSession.set(DISMISS_KEY, '1');
	}
</script>

{#if show}
	<div
		class="border-b border-sky-400/30 bg-sky-400/10 text-ink-800 dark:text-ink-100"
		role="status"
	>
		<div
			class="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-xs md:text-sm"
		>
			<span>{$_('insecure_context.notice')}</span>
			<button type="button" class="underline hover:no-underline" onclick={dismiss}>
				{$_('insecure_context.dismiss')}
			</button>
		</div>
	</div>
{/if}
