<script lang="ts">
	/**
	 * IdentityLabel — the ONE way usernames render in Morphit.
	 *
	 * Project policy (Agorise, confirmed Phase 5 scaffolding):
	 *
	 *     Every place a user's Blurt account name or display name
	 *     appears, the user's avatar (identicon heart, deterministic
	 *     from their identity bytes) MUST appear alongside. There
	 *     are no exceptions.
	 *
	 * The rationale: identicons are the cheapest accessibility win
	 * Morphit can ship — even a brand-new Blurt account is visually
	 * distinguishable from every other brand-new Blurt account, with
	 * zero user effort, zero bandwidth, zero privacy cost (the
	 * identicon is deterministic from on-chain bytes we'd render
	 * anyway). This makes phishing / typosquat attacks measurably
	 * harder: `@morphit` vs `@morph1t` collide textually, but their
	 * identicons cannot.
	 *
	 * How this rule is enforced across the codebase:
	 *
	 *   1. No render site ever writes raw `@{account}` — call sites
	 *      use `<IdentityLabel account={…}>` instead. The @-prefix
	 *      formatting is this component's job.
	 *   2. i18n strings that used to interpolate {account} or
	 *      {author} are refactored to prefix-only (e.g. "Trade with"
	 *      rather than "Trade with {account}"), so the username slot
	 *      can only be filled by a component that renders an avatar.
	 *   3. This component renders the identicon unconditionally
	 *      unless `hideAvatar` is set — which should only ever be
	 *      true when a parent has already rendered a much larger
	 *      avatar (e.g. profile-page hero with a 96px identicon
	 *      plus the username label beneath it).
	 *
	 * If you are reading this because you need to render a username
	 * and you're tempted to hand-roll it: don't. Use this component.
	 * If IdentityLabel doesn't fit your layout, the fix is to
	 * extend this component, not to bypass it.
	 */
	import { _ } from 'svelte-i18n';
	import { onDestroy } from 'svelte';
	import { formatIdentity } from '$crypto/profile';
	import { identiconDataUri } from '$crypto/identicon';
	import AltNetworkIcon from '$components/AltNetworkIcon.svelte';
	import { validateNostrUrlForRender } from '$utils/nostrUrl';
	import { validateBlurtMediaUrlForRender } from '$utils/blurtMediaUrl';
	import { selfProfile } from '$lib/stores/selfProfile';
	import { truncatePublicKey } from '$lib/crypto/publicKeyDisplay';

	interface Props {
		/**
		 * Preferred identity anchor — the user's posting pubkey.
		 * When present, the identicon is seeded from its bytes (the
		 * authoritative cryptographic identity). If absent but
		 * `account` is, the identicon is seeded from the account
		 * name's UTF-8 bytes — still deterministic, same-account
		 * always produces the same identicon, but doesn't have the
		 * cryptographic-identity-binding of the pubkey path.
		 */
		publicKey?: Uint8Array;
		/**
		 * Pre-formatted canonical BLT posting-key STRING (e.g. from the
		 * indexer's /keys proxy — `posting.key_auths[0][0]`). When set, the
		 * truncated key renders under the display name WITHOUT the raw key
		 * bytes or dblurt (no base58 round-trip): it's used directly as the
		 * copy/tooltip value and truncated for display. Bytes (`publicKey`)
		 * take precedence once resolved. Used by surfaces that know an
		 * account's posting key as a string but never hold its bytes (e.g.
		 * the order-detail poster card), so the cryptographic identity is
		 * visible for fraud/impersonation checks without pulling the ~2 MB
		 * signing lib onto the page.
		 */
		publicKeyString?: string;
		/**
		 * The Blurt account name. Used for display (e.g. "@alice")
		 * in call sites that don't have the pubkey available yet,
		 * and as a fallback identicon seed.
		 */
		account?: string;
		/** User-chosen human label. Not authoritative. */
		displayName?: string | null;
		/**
		 * User-populated Nostr profile URL from their json_metadata.
		 * When present (and validly shaped), a Nostr glyph renders
		 * alongside the username so other users can reach their
		 * Nostr identity. Only populated by call sites that have
		 * already fetched the profile (e.g. the profile page,
		 * expanded order detail) — list-view callers that only
		 * have `account` omit this and the glyph silently doesn't
		 * render.
		 */
		nostrUrl?: string | null;
		/**
		 * User-populated Blurt.media profile URL from their
		 * json_metadata. Same treatment as nostrUrl — renders a
		 * glyph next to the username when populated. Host must be
		 * blurt.media exactly; see validateBlurtMediaUrlForRender.
		 */
		blurtMediaUrl?: string | null;
		/**
		 * User-uploaded custom avatar as sanitized SVG text. Takes
		 * precedence over the deterministic heart identicon when
		 * populated. The source MUST have been processed through
		 * $lib/avatar's `sanitizeSvg` — renderer inlines this via
		 * {@html} so unsanitized input would be a live XSS vector.
		 */
		avatarSvg?: string | null;
		/**
		 * User-uploaded custom avatar as a base64 data URI
		 * (image/webp). Takes precedence over the identicon.
		 * Mutually exclusive with avatarSvg.
		 */
		avatarDataUri?: string | null;
		/** Show the label as a link (for profile pages). Defaults to no link. */
		href?: string | null;
		/** Emphasis weight — use 'bold' in order cards and chat, 'normal' for lists. */
		weight?: 'normal' | 'semibold' | 'bold';
		/** Show the copy-full-key affordance. Default true. Set false for very dense lists. */
		showCopy?: boolean;
		/** Pixel size of the identicon. Defaults to 28 (matches the baseline text height). */
		avatarSize?: number;
		/** Hide the identicon entirely (rare — use only in contexts where the avatar is
		 *  already shown by the parent, e.g. a detail page header that renders a 96px
		 *  hero avatar + the username label underneath). */
		hideAvatar?: boolean;
		/** Hide the @handle/displayName text + copy button, keeping only
		 *  the avatar (if shown) and the nostr/blurt.media link glyphs.
		 *  Used where the handle is already shown elsewhere (e.g. the
		 *  profile hero shows the name as an <h1>), so repeating it would
		 *  be redundant — but the link glyphs are still worth surfacing. */
		hideHandle?: boolean;
		class?: string;
	}

	let {
		publicKey,
		publicKeyString,
		account,
		displayName = null,
		nostrUrl = null,
		blurtMediaUrl = null,
		avatarSvg = null,
		avatarDataUri = null,
		href = null,
		weight = 'semibold',
		showCopy = true,
		avatarSize = 28,
		hideAvatar = false,
		hideHandle = false,
		class: cls = ''
	}: Props = $props();

	// When this label's subject is the logged-in user and the caller did
	// NOT pass an explicit avatar, fall back to the shared self-profile
	// avatar so the user's uploaded avatar renders everywhere their
	// identicon would (orderbook rows, chat, feedback, etc.) — not just on
	// their public profile page. selfProfile.account is populated by the
	// always-mounted AvatarMenu, so no auth-store import is needed here.
	const isSelf = $derived(!!account && $selfProfile.account === account);
	const effAvatarSvg = $derived(avatarSvg ?? (isSelf ? $selfProfile.avatarSvg : null));
	const effAvatarDataUri = $derived(avatarDataUri ?? (isSelf ? $selfProfile.avatarDataUri : null));

	/**
	 * Validate + normalize a user-supplied Nostr URL. We accept two
	 * shapes:
	 *   1. `nostr:npub1…` — the canonical scheme per NIP-21
	 *   2. `https://…` links to common Nostr web clients
	 *      (iris.to, primal.net, snort.social, etc.)
	 * Anything else returns null — no href is rendered, and the
	 * glyph is suppressed. We do NOT render non-http(s)/non-nostr
	 * schemes (javascript:, data:, etc.) even if the user put them
	 * on their own profile; the risk of profile-based XSS outweighs
	 * the convenience.
	 */
	const validatedNostrUrl = $derived(validateNostrUrlForRender(nostrUrl));
	const validatedBlurtMediaUrl = $derived(validateBlurtMediaUrlForRender(blurtMediaUrl));

	// Derive identicon seed bytes. The ACCOUNT NAME wins when present: an
	// identicon is a stable visual anchor for an identity, so it should NOT
	// change when a posting key is rotated/recovered, and the name is the
	// only seed available everywhere (profile page, explorer, order rows —
	// many of which never have the pubkey on hand). Seeding from the name
	// keeps every surface that knows the account visually consistent. Falls
	// back to the posting pubkey only when no account name is given (e.g.
	// a mid-onboarding preview before the name exists).
	const seedBytes = $derived.by(() => {
		if (account && account.length > 0) {
			return new TextEncoder().encode(account);
		}
		if (publicKey && publicKey.length > 0) return publicKey;
		// Empty fallback — all-zero bytes produce a consistent but
		// intentionally bland identicon that signals "no identity given".
		return new Uint8Array(8);
	});

	const avatarSrc = $derived(identiconDataUri(seedBytes, avatarSize));

	// The existing formatIdentity() helper returns {name, fingerprint}
	// only — the `full` BLT-canonical key requires dblurt (a 2 MB
	// chunk) and is lazy-loaded.  We expose `fullKey` here as
	// component-local $state, resolving via the async
	// formatPublicKeyBLT helper on first hover, focus, or copy.
	const identity = $derived(
		publicKey && publicKey.length > 0
			? formatIdentity(displayName, publicKey)
			: {
					name: displayName ?? (account ? `@${account}` : ''),
					fingerprint: ''
				}
	);

	const { name, fingerprint } = $derived(identity);

	// Lazy-resolved canonical BLT-prefixed key.  Null until the user
	// hovers / focuses the label or clicks copy.  See ensureFullKey().
	// Falls back to fingerprint for tooltip/copy while unresolved —
	// in practice the resolve completes in <50 ms because the dblurt
	// chunk is already cached after the first use anywhere in the
	// session, and on a brand-new tab the user typically hovers for
	// more than 50 ms before clicking.
	let fullKey: string | null = $state(null);
	let resolving = false;
	async function ensureFullKey(): Promise<void> {
		if (fullKey !== null || resolving) return;
		// Pre-formatted key string path (no bytes, no dblurt): the caller
		// already handed us the canonical BLT key, so use it verbatim for
		// copy/tooltip. Checked BEFORE the bytes path so a string-only
		// caller never falls through to the account-name fallback below.
		if (publicKeyString) {
			fullKey = publicKeyString;
			return;
		}
		if (!publicKey || publicKey.length === 0) {
			fullKey = account ?? '';
			return;
		}
		resolving = true;
		try {
			const { formatPublicKeyBLT } = await import('$crypto/keygen');
			fullKey = await formatPublicKeyBLT(publicKey);
		} catch {
			// dblurt unavailable for any reason — fall back to the
			// hex fingerprint.  Tooltip + clipboard still get
			// SOMETHING usable; rare path.
			fullKey = fingerprint || (account ?? '');
		} finally {
			resolving = false;
		}
	}
	// What the tooltip/clipboard show: the resolved BLT key when
	// available, fingerprint as the synchronous placeholder otherwise.
	const full = $derived(fullKey ?? publicKeyString ?? fingerprint ?? (account ?? ''));

	// What we DISPLAY on screen: a truncation of the SAME value the copy
	// button yields (`full`), so the abbreviation is always a true
	// prefix+suffix of what gets copied — NOT a different encoding. (cp305
	// fix: previously the screen showed `fingerprint()`'s BLT+hex
	// abbreviation while copy gave the base58 canonical key, so e.g.
	// "BLT02cd7c…a6d3" on screen but "BLT6SzDa…" on the clipboard — same
	// pubkey, two encodings, looked like a mismatch.) Before the canonical
	// base58 key resolves, `full` is the short sync placeholder (already
	// abbreviated) and shows as-is; once resolved it's the ~53-char base58
	// BLT key, truncated head(BLT+6)…tail(4) to match the placeholder shape.
	const shown = $derived.by(() => {
		const f = full;
		if (f.length <= 14) return f;
		return truncatePublicKey(f);
	});

	// cp305: eagerly resolve the canonical base58 key as soon as the
	// component mounts WITH a public key, so the displayed truncation
	// matches the copy/tooltip value immediately rather than only after
	// hover. Only three single-identity surfaces pass `publicKey` (the two
	// onboarding recaps + the settings profile preview); none are
	// high-cardinality lists, so this does NOT regress the cp165 first-paint
	// dblurt byte-budget (and the onboarding pages load dblurt anyway).
	// ensureFullKey() is a no-op once resolved/resolving; effects are
	// client-only so this never runs during SSR.
	$effect(() => {
		if (publicKey && publicKey.length > 0) void ensureFullKey();
	});

	const weightCls = $derived(
		weight === 'bold' ? 'font-bold' : weight === 'normal' ? 'font-normal' : 'font-semibold'
	);

	let copied = $state(false);
	let copyTimeout: ReturnType<typeof setTimeout> | null = null;

	async function copyFull(e: Event): Promise<void> {
		e.preventDefault();
		e.stopPropagation();
		// cp165: ensure the canonical BLT key is resolved before
		// copying — otherwise the clipboard would get the
		// fingerprint placeholder.  ensureFullKey is a no-op if
		// already resolved, and lazy-loads dblurt on first call.
		await ensureFullKey();
		try {
			await navigator.clipboard.writeText(full);
			copied = true;
			if (copyTimeout) clearTimeout(copyTimeout);
			copyTimeout = setTimeout(() => (copied = false), 1600);
		} catch {
			// Clipboard API unavailable (very rare — old browsers, some privacy modes).
			// Silent failure is fine: the full key is visible in the hover tooltip
			// so the user can still select it manually.
		}
	}

	// Part 73: clear pending copy timeout on unmount.  Without
	// this, a user who copies a key and immediately navigates
	// away leaves a setTimeout running that fires into a stale
	// state proxy.  Svelte 5's reactive system tolerates the
	// stale write but it's a minor leak we can avoid cheaply.
	onDestroy(() => {
		if (copyTimeout !== null) {
			clearTimeout(copyTimeout);
			copyTimeout = null;
		}
	});
</script>

{#snippet label()}
	{#if name && (fingerprint || publicKeyString)}
		<!-- cp397: the truncated posting key sits on its own line directly
		     under the (bold) display name, in tiny muted text — so the
		     human label and the cryptographic identity read as a stacked
		     pair rather than a long inline run. -->
		<span class="inline-flex min-w-0 flex-col leading-tight">
			<span class={weightCls}>{name}</span>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<bdi
				class="ltr-in-rtl font-mono text-[0.7em] text-ink-500 dark:text-ink-400"
				title={full}
				onpointerenter={ensureFullKey}
				onfocus={ensureFullKey}>({shown})</bdi
			>
		</span>
	{:else if name}
		<span class={weightCls}>{name}</span>
	{:else}
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<bdi
			class="ltr-in-rtl font-mono {weightCls} text-ink-700 dark:text-ink-200"
			title={full}
			onpointerenter={ensureFullKey}
			onfocus={ensureFullKey}>{shown}</bdi
		>
	{/if}
{/snippet}

<span class="group inline-flex items-center gap-1.5 {cls}">
	<!--
		Identicon avatar. Always rendered unless hideAvatar is set (rare).
		The image is a data-URI SVG generated locally from the seed bytes —
		nothing fetched over the network, no privacy leak, no layout shift.
		The rounded-full class gives it the profile-picture aesthetic even
		though the underlying SVG is a heart shape; the circle crop softens
		the composition and keeps alignment clean next to inline text.
	-->
	<!--
		Avatar. Priority:
		  1. User-uploaded sanitized SVG (inline via {@html}; the
		     sanitizer in $lib/avatar is the contract — this render
		     path trusts that contract).
		  2. User-uploaded raster data URI (<img src="data:...">).
		  3. Deterministic heart identicon from the seed bytes.
		All three render at the same size and circular crop so the
		surrounding layout doesn't shift based on which avatar the
		user has set.
	-->
	{#if !hideAvatar}
		{#if effAvatarSvg && effAvatarSvg.length > 0}
			<span
				class="flex flex-none items-center justify-center overflow-hidden rounded-full bg-ink-200/50 ring-1 ring-ink-300 dark:bg-ink-800/50 dark:ring-ink-700"
				style:width="{avatarSize}px"
				style:height="{avatarSize}px"
				aria-hidden="true"
			>
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				{@html effAvatarSvg}
			</span>
		{:else if effAvatarDataUri && effAvatarDataUri.length > 0}
			<img
				src={effAvatarDataUri}
				alt=""
				width={avatarSize}
				height={avatarSize}
				loading="lazy"
				decoding="async"
				class="flex-none rounded-full bg-ink-200/50 object-cover ring-1 ring-ink-300 dark:bg-ink-800/50 dark:ring-ink-700"
				aria-hidden="true"
			/>
		{:else}
			<img
				src={avatarSrc}
				alt=""
				width={avatarSize}
				height={avatarSize}
				loading="lazy"
				decoding="async"
				class="flex-none rounded-full bg-ink-200/50 ring-1 ring-ink-300 dark:bg-ink-800/50 dark:ring-ink-700"
				aria-hidden="true"
			/>
		{/if}
	{/if}

	{#if !hideHandle}
		{#if href}
			<a
				{href}
				class="inline-flex items-baseline rounded-md hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald"
			>
				{@render label()}
			</a>
		{:else}
			<span class="inline-flex items-baseline">
				{@render label()}
			</span>
		{/if}
	{/if}

	{#if validatedBlurtMediaUrl}
		<a
			href={validatedBlurtMediaUrl}
			target="_blank"
			rel="noopener noreferrer external"
			aria-label={$_('identity.blurt_media_link_aria')}
			title={$_('identity.blurt_media_link_tooltip')}
			class="inline-flex h-5 w-5 flex-none items-center justify-center rounded text-ink-500 transition hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-400"
			onclick={(e) => e.stopPropagation()}
		>
			<AltNetworkIcon network="blurt" size={14} class="h-3.5 w-3.5" />
		</a>
	{/if}

	{#if validatedNostrUrl}
		<a
			href={validatedNostrUrl}
			target="_blank"
			rel="noopener noreferrer external"
			aria-label={$_('identity.nostr_link_aria')}
			title={$_('identity.nostr_link_tooltip')}
			class="inline-flex h-5 w-5 flex-none items-center justify-center rounded text-ink-500 transition hover:text-morphit-emerald focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald dark:text-ink-400"
			onclick={(e) => e.stopPropagation()}
		>
			<AltNetworkIcon network="nostr" size={14} class="h-3.5 w-3.5" />
		</a>
	{/if}

	{#if showCopy && full && !hideHandle}
		<button
			type="button"
			onclick={copyFull}
			onpointerenter={ensureFullKey}
			onfocus={ensureFullKey}
			aria-label={$_('identity.copy_full_key_aria')}
			title={full}
			class="ms-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded text-ink-500 opacity-0 transition hover:bg-ink-100 hover:text-morphit-emerald focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald group-hover:opacity-100 dark:text-ink-400 dark:hover:bg-ink-800"
		>
			{#if copied}
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="3"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
					class="text-morphit-emerald"
				>
					<path d="M20 6 9 17l-5-5" />
				</svg>
			{:else}
				<svg
					xmlns="http://www.w3.org/2000/svg"
					width="12"
					height="12"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="2"
					stroke-linecap="round"
					stroke-linejoin="round"
					aria-hidden="true"
				>
					<rect x="9" y="9" width="13" height="13" rx="2" />
					<path d="M5 15V5a2 2 0 0 1 2-2h10" />
				</svg>
			{/if}
		</button>
	{/if}
</span>
