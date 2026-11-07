<script lang="ts">
	/**
	 * /witnesses — "Blurt Nodes" (v1.23.0).
	 *
	 * Every Blurt witness, ordered by STARS by default: how long it has produced
	 * blocks, how few it has missed, and whether its version is current — not by
	 * vote rank (the owner: "it is smarter to encourage people to vote for
	 * witnesses that have been successfully running a witness node for the
	 * longest, with the least number of blocks missed"). The rules live in the
	 * indexer (apps/indexer/src/indexer/witnessRanking.ts); this page shows them.
	 *
	 *   - Columns, in the owner's order: avatar (+ name), producer for
	 *     (+ announcement), blocks missed (since when), rank + stars, needs (to
	 *     level up), running (version); then the vote button. Every header
	 *     re-sorts; a second click reverses. The table needs room: below `lg` the
	 *     page shows one compact block per witness instead (a tablet in portrait
	 *     cut the vote column off).
	 *   - Avatars: a plain head in a 1px circle by default, exactly as tall as the
	 *     row's lines of text. "display" shows the pictures, which THIS instance
	 *     fetches and serves (owner, 2026-11-05: through the instance, so the
	 *     browser still contacts nothing else); a zero-clearnet instance fetches
	 *     nothing from clearnet, so it offers no "display" link at all.
	 *   - A flag for blocks missed in the last day.
	 *   - Version in amber only a whole version behind (0.8.x); 0.9.0 and 0.9.1
	 *     are "nearly the same thing" (owner).
	 *   - Vote buttons are lit for a signed-in visitor once their votes are known;
	 *     a signed-out one is sent to sign in and comes straight back (`?next=`).
	 */
	import { onMount } from 'svelte';
	import { _ } from 'svelte-i18n';
	import { page } from '$app/stores';
	import Head from '$components/Head.svelte';
	import PartialStars from '$components/PartialStars.svelte';
	import WitnessVoteModal from '$components/WitnessVoteModal.svelte';
	import {
		accountPictureUrl,
		getWitnesses,
		getWitnessVotes,
		witnessAvatarUrl
	} from '$indexer/client';
	import type { WitnessRow, WitnessesResponse } from '@morphit/indexer-client';
	import { hasAnySession, pairedReadOnly } from '$stores/identity';
	import { blurtAccountName } from '$blurt/ops/profile';
	import { gotoLocale } from '$i18n/navigate';
	import { localePath } from '$i18n/path';
	import { DEFAULT_LOCALE, isRtlLocale, type LocaleCode } from '$i18n/locales';
	import { formatCount, formatCountCompact, formatMonthYearShort } from '$lib/i18n/formatters';
	import { safeWitnessLinkUrl } from '$lib/utils/safeWitnessLinkUrl';
	import { showToast } from '$lib/stores/toast';
	import { stickyBannerBottom } from '$lib/stores/stickyBanner';
	import { stickyTableHead } from '$lib/utils/stickyTableHead';
	import { setShowBlurtPictures, showBlurtPictures } from '$lib/stores/blurtPictures';
	import { getProfilesBatch } from '$lib/indexer/profileCache';
	import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';
	import { svgAvatarImgSrc } from '$lib/avatar/imgSrc';

	type SortKey = 'name' | 'stars' | 'weeks' | 'missed' | 'rank' | 'needs' | 'version' | 'vote';
	/** Each column's natural first direction: best first. */
	const FIRST_DESC: Record<SortKey, boolean> = {
		name: false,
		stars: true,
		weeks: true,
		missed: false,
		rank: false,
		needs: false,
		version: true,
		vote: true
	};

	let data = $state<WitnessesResponse | null>(null);
	let loadFailed = $state(false);
	let sortKey = $state<SortKey>('stars');
	let sortDesc = $state(true);
	// v1.23.3: the site-wide choice (stores/blurtPictures.ts) — "display" here
	// turns the Blurt pictures on for every page, and Settings can too.
	const showAvatars = $derived($showBlurtPictures);
	function toggleAvatars(): void {
		setShowBlurtPictures(!$showBlurtPictures);
	}

	// v1.23.3: a witness's Morphit avatar (its on-chain Morphit profile) shows
	// always, like on every page, and wins over the Blurt picture. Read from
	// this instance in batches once the list is in.
	let morphitAvatars = $state(new Map<string, string>());
	let morphitAvatarsFor = '';
	// The batch for the current list has been answered (or failed): only then
	// do Blurt pictures show (review, v1.23.3: before it, a witness with a
	// Morphit avatar showed his Blurt picture first, then switched).
	let morphitAvatarsReady = $state(false);
	let brokenMorphit = $state(new Set<string>());
	$effect(() => {
		const owners = (data?.witnesses ?? []).map((w) => w.owner);
		const key = owners.join(',');
		if (owners.length === 0 || key === morphitAvatarsFor) return;
		morphitAvatarsFor = key;
		morphitAvatarsReady = false;
		void getProfilesBatch(owners)
			.then((profiles) => {
				const next = new Map<string, string>();
				for (const [owner, profile] of profiles) {
					const p = extractLabelPropsFromProfile(profile);
					if (p.avatarSvg) next.set(owner, svgAvatarImgSrc(p.avatarSvg));
					else if (p.avatarDataUri) next.set(owner, p.avatarDataUri);
				}
				morphitAvatars = next;
			})
			.catch(() => {
				// No Morphit avatars known: the Blurt pictures (when on) or heads.
			})
			.finally(() => {
				if (morphitAvatarsFor === key) morphitAvatarsReady = true;
			});
	});

	// The table's header row sticks just under the site's sticky main menu (or
	// the notification banner below it, while that shows) as the rows scroll
	// beneath it. The menu's height changes with the language, a branded logo
	// and zoom, so it is measured, not hard-coded; and keyboard focus is kept
	// clear of the stuck row (utils/stickyTableHead.ts, v1.23.2 review).
	let tableCard = $state<HTMLElement>();
	$effect(() => {
		const card = tableCard;
		const bannerBottom = $stickyBannerBottom;
		const menu = document.querySelector<HTMLElement>('[data-site-header]');
		if (!card || !menu) return;
		const head = card.querySelector<HTMLElement>('thead');
		const root = document.documentElement;
		const place = () => {
			const r = stickyTableHead({
				menuHeight: menu.getBoundingClientRect().height,
				bannerBottom,
				rowHeight: head?.getBoundingClientRect().height ?? 0
			});
			card.style.setProperty('--wit-sticky-top', `${r.top}px`);
			root.style.scrollPaddingTop = r.scrollPaddingTop === null ? '' : `${r.scrollPaddingTop}px`;
		};
		place();
		const ro = new ResizeObserver(place);
		ro.observe(menu);
		if (head) ro.observe(head);
		return () => {
			ro.disconnect();
			root.style.scrollPaddingTop = '';
		};
	});
	let showOthers = $state(false);
	/** Pictures that failed to load fall back to the plain head. */
	let brokenAvatars = $state(new Set<string>());
	/** The signed-in account's votes: buttons wait until they are known, so a
	 *  witness already voted for is never sent a second "vote". */
	let votes = $state<
		| { status: 'none' }
		| { status: 'loading'; account: string }
		| { status: 'failed'; account: string }
		| { status: 'ready'; account: string; set: Set<string>; proxy: string | null; max: number }
	>({ status: 'none' });
	let voting = $state<{ witness: string; approve: boolean } | null>(null);
	/** Answers to an older request (another account, a retry) are ignored. */
	let votesRequest = 0;

	const lang = $derived(($page.params.lang ?? DEFAULT_LOCALE) as LocaleCode);
	const rtl = $derived(isRtlLocale(lang));
	const lp = (path: string): string => localePath(path, lang);

	const account = $derived($blurtAccountName ?? $pairedReadOnly?.account ?? null);
	const signedIn = $derived($hasAnySession && account !== null);
	const votesReady = $derived(votes.status === 'ready' && votes.account === account ? votes : null);
	const votesLeft = $derived(
		votesReady === null ? null : Math.max(0, votesReady.max - votesReady.set.size)
	);

	function versionKey(v: string): number {
		const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
		return m ? Number(m[1]) * 1e8 + Number(m[2]) * 1e4 + Number(m[3]) : -1;
	}

	const producing = $derived((data?.witnesses ?? []).filter((w) => w.producing));
	const others = $derived((data?.witnesses ?? []).filter((w) => !w.producing));

	const rows = $derived.by(() => {
		const list = showOthers ? [...producing, ...others] : [...producing];
		if (sortKey === 'stars' && sortDesc) return list; // the indexer's own order
		const mine = votesReady?.set;
		const val = (w: WitnessRow): number => {
			switch (sortKey) {
				case 'stars':
					return w.score;
				case 'weeks':
					return w.weeks;
				case 'missed':
					return w.total_missed;
				case 'rank':
					return w.rank;
				case 'needs':
					return w.needs_bp ?? 0;
				case 'version':
					return versionKey(w.version);
				case 'vote':
					return mine?.has(w.owner) ? 1 : 0;
				case 'name':
					return 0;
			}
		};
		return list.sort((a, b) => {
			// Stars, either way: a witness that is not producing has none, and stays
			// below every producing one.
			if (sortKey === 'stars' && a.producing !== b.producing) return a.producing ? -1 : 1;
			const d = sortKey === 'name' ? a.owner.localeCompare(b.owner) : val(a) - val(b);
			return (sortDesc ? -d : d) || a.rank - b.rank;
		});
	});

	function sortBy(key: SortKey): void {
		if (sortKey === key) sortDesc = !sortDesc;
		else {
			sortKey = key;
			sortDesc = FIRST_DESC[key];
		}
	}

	function ariaSort(...keys: SortKey[]): 'ascending' | 'descending' | 'none' {
		return keys.includes(sortKey) ? (sortDesc ? 'descending' : 'ascending') : 'none';
	}

	/** Chain times carry no zone: they are UTC. '' when the chain gave none. */
	function createdDate(w: WitnessRow): string {
		if (!w.created) return '';
		return formatMonthYearShort(/[zZ]$/.test(w.created) ? w.created : `${w.created}Z`);
	}

	function starsText(v: number): string {
		const whole = Math.floor(v + 1e-9);
		const thirds = Math.round((v - whole) * 3);
		return `${formatCount(whole)}${thirds === 1 ? '⅓' : thirds === 2 ? '⅔' : ''}`;
	}

	function versionText(w: WitnessRow): string {
		return w.version ? `v${w.version}` : '—';
	}

	async function load(): Promise<void> {
		const r = await getWitnesses();
		if (r.ok) {
			data = r.data;
			loadFailed = false;
		} else if (data === null) {
			loadFailed = true;
		}
	}

	async function loadVotes(forAccount: string): Promise<void> {
		const req = ++votesRequest;
		votes = { status: 'loading', account: forAccount };
		const r = await getWitnessVotes(forAccount);
		if (req !== votesRequest) return; // a newer request (or another account) won
		votes = r.ok
			? {
					status: 'ready',
					account: forAccount,
					set: new Set(r.data.votes),
					proxy: r.data.proxy,
					max: r.data.max_votes
				}
			: { status: 'failed', account: forAccount };
	}

	onMount(() => {
		void load();
	});

	// The signed-in account's votes, read again whenever the account changes.
	$effect(() => {
		const a = signedIn ? account : null;
		if (a !== null) void loadVotes(a);
		else {
			votesRequest++;
			votes = { status: 'none' };
		}
	});

	function vote(w: WitnessRow): void {
		if (!signedIn) {
			if ($hasAnySession) {
				// Unlocked, but this device does not know the account's name yet:
				// the settings page asks for it.
				void gotoLocale('/settings#account-name-heading');
				return;
			}
			const here = $page.url.pathname + $page.url.search;
			void gotoLocale('/login?next=' + encodeURIComponent(here));
			return;
		}
		if (votesReady === null) return; // still loading, or failed (the banner offers a retry)
		if (votesReady.proxy !== null) {
			showToast(
				$_('witnesses.proxy_note', { values: { proxy: votesReady.proxy } }) as string,
				'info'
			);
			return;
		}
		const voted = votesReady.set.has(w.owner);
		if (!voted && votesReady.set.size >= votesReady.max) {
			showToast(
				$_('witnesses.max_reached', { values: { max: formatCount(votesReady.max) } }) as string,
				'info'
			);
			return;
		}
		voting = { witness: w.owner, approve: !voted };
	}

	function voteDone(): void {
		if (voting === null) return;
		if (votesReady !== null) {
			const next = new Set(votesReady.set);
			if (voting.approve) next.add(voting.witness);
			else next.delete(voting.witness);
			votes = { ...votesReady, set: next };
		}
		voting = null;
	}

	/** Missed-in-the-last-day text ("2 missed in 24 h"). */
	function missedText(w: WitnessRow): string {
		return $_('witnesses.missed_recent', {
			values: { count: w.missed_recent ?? 0, hours: formatCount(w.missed_window_hours ?? 24) }
		}) as string;
	}

	/** The row highlight: the brand's dim tint, and a bar on the reading side. */
	const hoverRow =
		'transition-colors duration-150 ease-out hover:bg-emerald-50/30 dark:hover:bg-morphit-emerald/[0.05] ltr:hover:shadow-[inset_3px_0_0_rgb(var(--brand-primary-rgb))] rtl:hover:shadow-[inset_-3px_0_0_rgb(var(--brand-primary-rgb))]';
</script>

<Head routeKey="witnesses" />

{#snippet avatar(w: WitnessRow, size: number)}
	{@const morphit = brokenMorphit.has(w.owner) ? undefined : morphitAvatars.get(w.owner)}
	{@const src =
		morphit ??
		(showAvatars && data?.avatars && morphitAvatarsReady && !brokenAvatars.has(w.owner)
			? w.avatar !== null
				? witnessAvatarUrl(w.avatar)
				: accountPictureUrl(w.owner)
			: undefined)}
	{#if src !== undefined}
		<img
			{src}
			alt=""
			width={size}
			height={size}
			loading="lazy"
			decoding="async"
			onerror={() => {
				if (morphit !== undefined) brokenMorphit = new Set([...brokenMorphit, w.owner]);
				else brokenAvatars = new Set([...brokenAvatars, w.owner]);
			}}
			class="flex-none rounded-full object-cover ring-1 ring-ink-300 dark:ring-ink-700"
			style="width:{size}px;height:{size}px"
		/>
	{:else}
		<span
			class="flex flex-none items-end justify-center overflow-hidden rounded-full border border-ink-300 bg-ink-100 dark:border-ink-600 dark:bg-ink-900"
			style="width:{size}px;height:{size}px"
			aria-hidden="true"
		>
			<svg
				viewBox="0 0 24 24"
				width={size * 0.78}
				height={size * 0.78}
				class="text-ink-300 dark:text-ink-600"
			>
				<circle cx="12" cy="8.6" r="4.6" fill="currentColor" />
				<path d="M2.8 24c.6-5.6 4.5-8.6 9.2-8.6s8.6 3 9.2 8.6z" fill="currentColor" />
			</svg>
		</span>
	{/if}
{/snippet}

{#snippet voteButton(w: WitnessRow)}
	{@const voted = votesReady?.set.has(w.owner) ?? false}
	{@const waiting = signedIn && votesReady === null}
	{@const lit = signedIn && votesReady !== null}
	{@const label = !signedIn
		? ($_('witnesses.sign_in_to_vote_for', { values: { owner: w.owner } }) as string)
		: voted
			? ($_('witnesses.unvote_aria', { values: { owner: w.owner } }) as string)
			: ($_('witnesses.vote_aria', { values: { owner: w.owner } }) as string)}
	<button
		type="button"
		onclick={() => vote(w)}
		disabled={waiting}
		class="group/vote relative grid h-8 w-8 flex-none place-items-center rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-morphit-emerald disabled:cursor-wait disabled:opacity-50 {!lit
			? 'border-ink-300 text-ink-400 dark:border-ink-700 dark:text-ink-600'
			: voted
				? 'border-morphit-emerald bg-morphit-emerald text-ink-950'
				: 'border-morphit-emerald/60 text-morphit-emerald hover:bg-morphit-emerald/10'}"
		title={label}
		aria-label={label}
	>
		{#if lit && voted}
			<!-- Voted: the arrow points up; on hover or keyboard focus it turns down ("remove"). -->
			<svg
				viewBox="0 0 24 24"
				width="16"
				height="16"
				fill="none"
				stroke="currentColor"
				stroke-width="2.6"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="group-hover/vote:hidden group-focus-visible/vote:hidden"
				aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg
			>
			<svg
				viewBox="0 0 24 24"
				width="16"
				height="16"
				fill="none"
				stroke="currentColor"
				stroke-width="2.6"
				stroke-linecap="round"
				stroke-linejoin="round"
				class="hidden group-hover/vote:block group-focus-visible/vote:block"
				aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg
			>
		{:else}
			<svg
				viewBox="0 0 24 24"
				width="16"
				height="16"
				fill="none"
				stroke="currentColor"
				stroke-width="2.6"
				stroke-linecap="round"
				stroke-linejoin="round"
				aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg
			>
		{/if}
	</button>
{/snippet}

{#snippet missedFlag(w: WitnessRow, compact: boolean)}
	{#if w.missed_recent !== null && w.missed_recent > 0}
		<span
			class="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-full bg-red-500/10 px-2 py-px text-[11px] font-semibold leading-4 text-red-700 ring-1 ring-red-500/40 dark:text-red-300"
			title={missedText(w)}
		>
			<svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor" aria-hidden="true"
				><path d="M5 21V4h9l1 2h5v9h-7l-1-2H7v8z" /></svg
			>
			{#if compact}
				<span aria-hidden="true">{formatCount(w.missed_recent)}</span>
				<span class="sr-only">{missedText(w)}</span>
			{:else}
				{missedText(w)}
			{/if}
		</span>
	{/if}
{/snippet}

{#snippet sortHead(key: SortKey, label: string, aria?: string)}
	<button
		type="button"
		onclick={() => sortBy(key)}
		aria-label={aria}
		class="inline-flex items-center gap-1 uppercase tracking-wider transition-colors hover:text-ink-800 focus:outline-none focus-visible:text-morphit-emerald dark:hover:text-ink-200 {sortKey ===
		key
			? 'text-morphit-teal dark:text-morphit-emerald'
			: ''}"
	>
		{label}
		<svg
			viewBox="0 0 24 24"
			width="12"
			height="12"
			fill="none"
			stroke="currentColor"
			stroke-width="2.4"
			stroke-linecap="round"
			stroke-linejoin="round"
			class={sortKey === key ? '' : 'opacity-40'}
			aria-hidden="true"
		>
			{#if sortKey !== key}<path d="M8 9l4-4 4 4M8 15l4 4 4-4" />{:else if sortDesc}<path
					d="M6 9l6 6 6-6"
				/>{:else}<path d="M6 15l6-6 6 6" />{/if}
		</svg>
	</button>
{/snippet}

{#snippet rankStars(w: WitnessRow, size: number)}
	{#if w.producing}
		<PartialStars
			value={w.stars}
			{size}
			{rtl}
			label={$_('witnesses.stars_aria', { values: { stars: starsText(w.stars) } }) as string}
		/>
	{:else}
		<span class="text-xs text-ink-600 dark:text-ink-400"
			>{w.disabled ? $_('witnesses.switched_off') : $_('witnesses.not_producing')}</span
		>
	{/if}
{/snippet}

{#snippet needsText(w: WitnessRow, short: boolean)}
	{#if w.needs_bp === null}
		{$_('witnesses.number_one')}
	{:else if w.needs_bp === 0}
		{$_('witnesses.tied_with', { values: { rank: formatCount(w.rank - 1) } })}
	{:else if short}
		{$_('witnesses.needs_short', { values: { amount: formatCountCompact(w.needs_bp) } })}
	{:else}
		{$_('witnesses.to_level_up')}
	{/if}
{/snippet}

<section class="mx-auto max-w-6xl px-4 py-12 md:px-6 md:py-14">
	<header class="text-center">
		<h1 class="font-display text-3xl font-extrabold tracking-tight md:text-5xl">
			<span class="brand-gradient-text">{$_('witnesses.title')}</span>
		</h1>
		<p class="mx-auto mt-4 max-w-3xl text-ink-700 dark:text-ink-300">{$_('witnesses.intro')}</p>
	</header>

	{#if signedIn && votes.status === 'failed'}
		<p
			class="mx-auto mt-8 flex max-w-3xl flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-400/50 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/40 dark:bg-amber-950/40 dark:text-amber-200"
			role="status"
		>
			<span>{$_('witnesses.votes_load_error')}</span>
			<button
				type="button"
				class="font-semibold underline underline-offset-2"
				onclick={() => account !== null && void loadVotes(account)}>{$_('common.retry')}</button
			>
		</p>
	{/if}

	{#if data === null && !loadFailed}
		<p class="mt-10 text-center text-ink-600 dark:text-ink-400" role="status">
			{$_('witnesses.loading')}
		</p>
	{:else if data === null}
		<div
			class="mx-auto mt-10 max-w-2xl rounded-2xl border border-dashed border-red-300 bg-red-50 p-8 text-center text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
			role="alert"
		>
			{$_('witnesses.load_error')}
		</div>
	{:else}
		<!-- Desktop: the table (it needs about 1000 px; below that the compact list). -->
		<div bind:this={tableCard} class="card mt-10 hidden overflow-clip p-0 lg:block">
			<table class="w-full text-start text-sm leading-5">
				<caption class="sr-only">{$_('witnesses.table_caption')}</caption>
				<thead
					class="bg-ink-50 text-[11px] font-semibold text-ink-600 dark:bg-ink-950/40 dark:text-ink-500"
				>
					<tr>
						<th
							scope="col"
							class="wit-th py-3 pe-3 ps-5 text-start font-semibold"
							aria-sort={ariaSort('name')}
						>
							{@render sortHead(
								'name',
								$_('witnesses.col_avatar') as string,
								$_('witnesses.sort_name_aria') as string
							)}
							{#if data.avatars}
								<span class="mx-1 text-ink-300 dark:text-ink-700" aria-hidden="true">·</span>
								<button
									type="button"
									class="font-semibold normal-case tracking-normal text-morphit-teal underline decoration-morphit-teal/40 underline-offset-2 hover:decoration-current dark:text-morphit-emerald dark:decoration-morphit-emerald/40"
									onclick={toggleAvatars}
									aria-pressed={showAvatars}
								>
									{showAvatars ? $_('witnesses.hide') : $_('witnesses.display')}
								</button>
							{/if}
						</th>
						<th
							scope="col"
							class="wit-th px-3 py-3 text-start font-semibold"
							aria-sort={ariaSort('weeks')}
							>{@render sortHead('weeks', $_('witnesses.col_producer_for') as string)}</th
						>
						<th
							scope="col"
							class="wit-th px-3 py-3 text-start font-semibold"
							aria-sort={ariaSort('missed')}
							>{@render sortHead('missed', $_('witnesses.col_missed') as string)}</th
						>
						<th
							scope="col"
							class="wit-th px-3 py-3 text-start font-semibold"
							aria-sort={ariaSort('rank', 'stars')}
						>
							{@render sortHead('rank', $_('witnesses.col_rank') as string)}
							<span class="mx-1 text-ink-300 dark:text-ink-700" aria-hidden="true">·</span>
							{@render sortHead('stars', '★', $_('witnesses.sort_stars_aria') as string)}
						</th>
						<th
							scope="col"
							class="wit-th px-3 py-3 text-start font-semibold"
							aria-sort={ariaSort('needs')}
							>{@render sortHead('needs', $_('witnesses.col_needs') as string)}</th
						>
						<th
							scope="col"
							class="wit-th px-3 py-3 text-start font-semibold"
							aria-sort={ariaSort('version')}
							>{@render sortHead('version', $_('witnesses.col_running') as string)}</th
						>
						<th
							scope="col"
							class="wit-th py-3 pe-5 ps-3 text-end font-semibold"
							aria-sort={ariaSort('vote')}
						>
							{@render sortHead(
								'vote',
								$_('witnesses.col_vote') as string,
								signedIn ? ($_('witnesses.sort_votes_aria') as string) : undefined
							)}
							{#if signedIn && votesLeft !== null}
								<span
									class="ms-1 whitespace-nowrap font-normal normal-case tracking-normal text-ink-500"
									>· {$_('witnesses.votes_left', { values: { count: votesLeft } })}</span
								>
							{/if}
						</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as w (w.owner)}
						{@const link = safeWitnessLinkUrl(w.url)}
						{@const since = createdDate(w)}
						<tr class="border-t border-ink-100 first:border-t-0 dark:border-ink-800/80 {hoverRow}">
							<td class="py-3 pe-3 ps-5">
								<div class="flex items-center gap-3">
									{@render avatar(w, 40)}
									<div class="flex h-10 min-w-0 flex-col justify-center">
										<a
											href={lp(`/@${w.owner}`)}
											class="block truncate font-semibold text-ink-900 hover:text-morphit-teal dark:text-ink-100 dark:hover:text-morphit-emerald"
											><bdi>{w.owner}</bdi></a
										>
										{#if w.missed_recent !== null && w.missed_recent > 0}<div class="h-5">
												{@render missedFlag(w, false)}
											</div>{/if}
									</div>
								</div>
							</td>
							<td class="whitespace-nowrap px-3 py-3">
								<div class="font-semibold tabular-nums text-ink-900 dark:text-ink-100">
									{$_('witnesses.weeks', { values: { count: w.weeks } })}
								</div>
								{#if link}
									<a
										href={safeWitnessLinkUrl(link)}
										target="_blank"
										rel="noopener noreferrer nofollow"
										class="inline-flex items-center gap-1 text-xs leading-5 text-morphit-teal hover:underline dark:text-morphit-emerald"
										aria-label={$_('witnesses.announcement_aria', {
											values: { owner: w.owner }
										}) as string}
									>
										{$_('witnesses.announcement')}
										<svg
											viewBox="0 0 24 24"
											width="11"
											height="11"
											fill="none"
											stroke="currentColor"
											stroke-width="2.4"
											stroke-linecap="round"
											stroke-linejoin="round"
											aria-hidden="true"
											><path
												d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"
											/></svg
										>
									</a>
								{/if}
							</td>
							<td class="whitespace-nowrap px-3 py-3">
								<div class="font-semibold tabular-nums text-ink-900 dark:text-ink-100">
									{formatCount(w.total_missed)}
								</div>
								{#if since}
									<div class="text-xs leading-5 text-ink-600 dark:text-ink-500">
										{$_('witnesses.since', { values: { date: since } })}
									</div>
								{/if}
							</td>
							<td class="whitespace-nowrap px-3 py-3">
								<div class="font-semibold tabular-nums text-ink-900 dark:text-ink-100">
									{formatCount(w.rank)}
								</div>
								<div class="-mt-px leading-5">{@render rankStars(w, 15)}</div>
							</td>
							<td class="whitespace-nowrap px-3 py-3">
								<div class="font-semibold tabular-nums text-ink-900 dark:text-ink-100">
									{w.needs_bp === null || w.needs_bp === 0 ? '—' : formatCountCompact(w.needs_bp)}
								</div>
								<div class="text-xs leading-5 text-ink-600 dark:text-ink-500">
									{@render needsText(w, false)}
								</div>
							</td>
							<td class="whitespace-nowrap px-3 py-3">
								<div
									class="font-semibold {w.version_behind
										? 'text-amber-700 dark:text-amber-400'
										: 'text-ink-900 dark:text-ink-100'}"
								>
									<bdi>{versionText(w)}</bdi>
								</div>
							</td>
							<td class="py-3 pe-5 ps-3"
								><div class="flex justify-end">{@render voteButton(w)}</div></td
							>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if others.length > 0}
				<div
					class="flex flex-wrap items-center justify-between gap-2 border-t border-ink-200 px-5 py-3 text-xs text-ink-600 dark:border-ink-800 dark:text-ink-500"
				>
					<span>{$_('witnesses.producing_count', { values: { count: producing.length } })}</span>
					<button
						type="button"
						class="font-semibold text-morphit-teal hover:underline dark:text-morphit-emerald"
						onclick={() => (showOthers = !showOthers)}
						aria-expanded={showOthers}
					>
						{showOthers
							? $_('witnesses.hide_others', { values: { count: others.length } })
							: $_('witnesses.show_others', { values: { count: others.length } })}
					</button>
				</div>
			{/if}
		</div>

		<!-- Phone and tablet: one compact block per witness, three lines next to a picture as tall. -->
		<div class="mt-8 lg:hidden">
			<div
				class="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-600 dark:text-ink-500"
			>
				{#if data.avatars}
					<span class="uppercase tracking-wider">
						{$_('witnesses.col_avatar')} ·
						<button
							type="button"
							class="font-semibold normal-case tracking-normal text-morphit-teal underline underline-offset-2 dark:text-morphit-emerald"
							onclick={toggleAvatars}
							aria-pressed={showAvatars}
						>
							{showAvatars ? $_('witnesses.hide') : $_('witnesses.display')}
						</button>
					</span>
				{:else}
					<span></span>
				{/if}
				<span class="flex items-center gap-1.5">
					<label class="flex items-center gap-1.5">
						{$_('witnesses.sort_label')}
						<select
							class="rounded-lg border border-ink-300 bg-white px-2 py-1 text-xs text-ink-900 dark:border-ink-700 dark:bg-ink-900 dark:text-ink-100"
							value={sortKey}
							onchange={(e) => {
								const k = (e.currentTarget as HTMLSelectElement).value as SortKey;
								sortKey = k;
								sortDesc = FIRST_DESC[k];
							}}
						>
							<option value="stars">{$_('witnesses.sort_stars')}</option>
							<option value="weeks">{$_('witnesses.col_producer_for')}</option>
							<option value="missed">{$_('witnesses.col_missed')}</option>
							<option value="rank">{$_('witnesses.col_rank')}</option>
							<option value="needs">{$_('witnesses.col_needs')}</option>
							<option value="version">{$_('witnesses.col_running')}</option>
							<option value="name">{$_('witnesses.sort_name')}</option>
							{#if signedIn}<option value="vote">{$_('witnesses.sort_votes')}</option>{/if}
						</select>
					</label>
					<button
						type="button"
						class="grid h-8 w-8 place-items-center rounded-lg border border-ink-300 text-ink-700 dark:border-ink-700 dark:text-ink-200"
						onclick={() => (sortDesc = !sortDesc)}
						aria-label={$_('witnesses.sort_reverse') as string}
						title={$_('witnesses.sort_reverse') as string}
					>
						<svg
							viewBox="0 0 24 24"
							width="14"
							height="14"
							fill="none"
							stroke="currentColor"
							stroke-width="2.2"
							stroke-linecap="round"
							stroke-linejoin="round"
							aria-hidden="true"><path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4" /></svg
						>
					</button>
				</span>
			</div>
			<ul class="card divide-y divide-ink-100 overflow-hidden p-0 dark:divide-ink-800/80">
				{#each rows as w (w.owner)}
					{@const link = safeWitnessLinkUrl(w.url)}
					{@const since = createdDate(w)}
					<li class="flex items-center gap-3 px-4 py-3 {hoverRow}">
						{@render avatar(w, 60)}
						<div class="min-w-0 flex-1 text-xs leading-5 text-ink-600 dark:text-ink-400">
							<div class="flex h-5 items-center justify-between gap-2 text-sm">
								<span class="flex min-w-0 items-center gap-1.5">
									<a
										href={lp(`/@${w.owner}`)}
										class="min-w-[5ch] truncate font-semibold text-ink-900 dark:text-ink-100"
										><bdi>{w.owner}</bdi></a
									>
									{@render missedFlag(w, true)}
								</span>
								<span class="-my-1 flex-none">{@render voteButton(w)}</span>
							</div>
							<div class="truncate">
								<span class="text-ink-800 dark:text-ink-200"
									>{$_('witnesses.weeks_short', { values: { count: w.weeks } })}</span
								>
								{#if link}
									<a
										href={safeWitnessLinkUrl(link)}
										target="_blank"
										rel="noopener noreferrer nofollow"
										class="-m-1.5 inline-block p-1.5 text-morphit-teal dark:text-morphit-emerald"
										aria-label={$_('witnesses.announcement_aria', {
											values: { owner: w.owner }
										}) as string}><span aria-hidden="true">↗</span></a
									>
								{/if}
								·
								<!-- Under 400 px wide the date goes, so the count is never cut off. -->
								{#if since}<span class="max-[399px]:hidden"
										>{$_('witnesses.missed_since', {
											values: { count: w.total_missed, date: since }
										})}</span
									>{/if}<span class={since ? 'min-[400px]:hidden' : ''}
									>{$_('witnesses.missed_short', { values: { count: w.total_missed } })}</span
								>
							</div>
							<div class="flex min-w-0 items-center gap-1">
								<span class="flex-none text-ink-800 dark:text-ink-200">#{formatCount(w.rank)}</span>
								<span class="flex-none">{@render rankStars(w, 12)}</span>
								<span class="min-w-0 truncate max-[399px]:hidden"
									>· {@render needsText(w, true)}</span
								>
								<!-- 360–399 px wide: just "↑568K" (the full sentence as its title); under 360 px
								     there is room only for rank, stars and version. It may shrink; the
								     version never does. -->
								<span class="min-w-0 truncate max-[359px]:hidden min-[400px]:hidden">
									·
									{#if w.needs_bp === null || w.needs_bp === 0}
										{@render needsText(w, true)}
									{:else}
										<span
											title={$_('witnesses.needs_short', {
												values: { amount: formatCountCompact(w.needs_bp) }
											}) as string}
											><span aria-hidden="true">↑{formatCountCompact(w.needs_bp)}</span><span
												class="sr-only"
												>{$_('witnesses.needs_short', {
													values: { amount: formatCountCompact(w.needs_bp) }
												})}</span
											></span
										>
									{/if}
								</span>
								<span
									class="flex-none {w.version_behind
										? 'text-amber-700 dark:text-amber-400'
										: 'text-ink-800 dark:text-ink-200'}">· <bdi>{versionText(w)}</bdi></span
								>
							</div>
						</div>
					</li>
				{/each}
			</ul>
			{#if others.length > 0}
				<button
					type="button"
					class="mt-3 w-full py-2 text-center text-xs font-semibold text-morphit-teal hover:underline dark:text-morphit-emerald"
					onclick={() => (showOthers = !showOthers)}
					aria-expanded={showOthers}
				>
					{showOthers
						? $_('witnesses.hide_others', { values: { count: others.length } })
						: $_('witnesses.show_others', { values: { count: others.length } })}
				</button>
			{/if}
		</div>
	{/if}
</section>

{#if voting !== null && account !== null}
	<WitnessVoteModal
		{account}
		witness={voting.witness}
		approve={voting.approve}
		onDone={voteDone}
		onCancel={() => (voting = null)}
	/>
{/if}

<style>
	/* The header row of the table: sticks just under the main menu
	   (--wit-sticky-top, measured above) while the rows scroll beneath it, and
	   settles back into the table when the page is scrolled back up. Each cell
	   sticks (a sticky <thead> is not supported everywhere), so each needs an
	   opaque background the rows can pass under: the same colours the header
	   row has always had, made solid. Theme tokens, so branded instances keep
	   their own colours. */
	.wit-th {
		position: sticky;
		top: var(--wit-sticky-top, 0px);
		z-index: 10;
		background-color: rgb(var(--surface-50-rgb));
		box-shadow: inset 0 -1px 0 rgb(var(--surface-200-rgb));
	}
	:global(.dark) .wit-th {
		background-color: rgb(var(--surface-900-rgb));
		background-image: linear-gradient(
			rgb(var(--surface-950-rgb) / 0.4),
			rgb(var(--surface-950-rgb) / 0.4)
		);
		box-shadow: inset 0 -1px 0 rgb(var(--surface-800-rgb));
	}
	/* High-contrast (forced colours) drops box shadows: keep a visible line
	   under the heading row. */
	@media (forced-colors: active) {
		.wit-th {
			outline: 1px solid CanvasText;
			outline-offset: -1px;
		}
	}
	/* A browser without overflow: clip (Safari before 16) does not round the
	   card's corners off the cells: round the corner cells themselves. */
	@supports not (overflow: clip) {
		.wit-th:first-child {
			border-start-start-radius: 1rem;
		}
		.wit-th:last-child {
			border-start-end-radius: 1rem;
		}
		tbody tr:last-child > td:first-child {
			border-end-start-radius: 1rem;
		}
		tbody tr:last-child > td:last-child {
			border-end-end-radius: 1rem;
		}
	}
</style>
