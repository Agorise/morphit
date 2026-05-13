<!--
	Morphit — responsive audit (dev route, Item 16 phase 1).

	Renders every route in a 380px-wide iframe (canonical phone
	width) and reports horizontal overflow + visual jank.  Use
	this page during a frontend-polish pass to spot pages that
	don't fit a phone screen without horizontally scrolling.

	The detection is simple: each iframe loads same-origin, then
	we read its document.documentElement.scrollWidth and compare
	to the iframe's clientWidth.  If scrollWidth > clientWidth,
	there's horizontal overflow somewhere on that page —
	indicating a fixed-width element (often a table, code block,
	or hardcoded pixel width) that breaks the mobile layout.

	Each tile shows:
	  - The route path
	  - The iframe at 380px
	  - A status pill (overflow Y/N + amount)
	  - A direct link to the page in a new tab

	Click the route path to scroll the iframe to a larger size
	(toggle between 380px and 760px).
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import Head from '$components/Head.svelte';

	interface RouteEntry {
		readonly path: string;
		readonly label: string;
		readonly note?: string;
	}

	const ROUTES: readonly RouteEntry[] = [
		{ path: '/', label: 'Home' },
		{ path: '/orderbook', label: 'Orderbook' },
		{ path: '/post', label: 'Post order' },
		{ path: '/onboarding', label: 'Onboarding' },
		{ path: '/onboarding/import', label: 'Import account' },
		{ path: '/login', label: 'Login' },
		{ path: '/my/orders', label: 'My orders', note: 'Empty state without auth' },
		{ path: '/chat', label: 'Chat inbox' },
		{ path: '/faq', label: 'FAQ' },
		{ path: '/operators', label: 'Operators directory' },
		{ path: '/instances', label: 'Instances' },
		{ path: '/run-a-node', label: 'Run a node' },
		{ path: '/explorer', label: 'Explorer' },
		{ path: '/explorer/activity', label: 'Explorer activity' },
		{ path: '/about-this-instance', label: 'About this instance' },
		{ path: '/security', label: 'Security' },
		{ path: '/privacy-terms', label: 'Privacy / terms' },
		{ path: '/download', label: 'Download' },
		{ path: '/settings', label: 'Settings' },
		{ path: '/support', label: 'Support' },
		{ path: '/backup-keys', label: 'Backup keys' },
		{ path: '/compare', label: 'Compare' },
		{ path: '/plan', label: 'Plan' },
		{ path: '/pair', label: 'Pair (mobile)' },
		{ path: '/pair/desktop', label: 'Pair (desktop view)' }
	];

	type Status =
		| { readonly kind: 'pending' }
		| { readonly kind: 'ok' }
		| { readonly kind: 'overflow'; readonly excessPx: number }
		| { readonly kind: 'error'; readonly message: string };

	const statuses: Map<string, Status> = $state(new Map());
	const expandedRoute: { value: string | null } = $state({ value: null });

	function recordStatus(path: string, status: Status): void {
		statuses.set(path, status);
		// Force reactivity since SvelteKit's Map handling needs a
		// fresh reference.
		statuses.set(path, status);
	}

	function onIframeLoad(path: string, iframe: HTMLIFrameElement): void {
		try {
			const doc = iframe.contentDocument;
			if (!doc || !doc.documentElement) {
				recordStatus(path, { kind: 'error', message: 'no document' });
				return;
			}
			// Wait one frame for layout to settle.
			requestAnimationFrame(() => {
				const html = doc.documentElement;
				const scrollWidth = html.scrollWidth;
				const clientWidth = iframe.clientWidth;
				if (scrollWidth - clientWidth > 1) {
					recordStatus(path, {
						kind: 'overflow',
						excessPx: scrollWidth - clientWidth
					});
				} else {
					recordStatus(path, { kind: 'ok' });
				}
			});
		} catch (err) {
			recordStatus(path, {
				kind: 'error',
				message: err instanceof Error ? err.message : String(err)
			});
		}
	}

	function toggleExpand(path: string): void {
		expandedRoute.value = expandedRoute.value === path ? null : path;
	}

	const summary = $derived.by(() => {
		let ok = 0;
		let overflow = 0;
		let error = 0;
		let pending = 0;
		for (const route of ROUTES) {
			const s = statuses.get(route.path);
			if (!s) {
				pending++;
				continue;
			}
			if (s.kind === 'ok') ok++;
			else if (s.kind === 'overflow') overflow++;
			else if (s.kind === 'error') error++;
			else pending++;
		}
		return { ok, overflow, error, pending };
	});

	onMount(() => {
		// Initialize all routes to pending.
		for (const route of ROUTES) {
			recordStatus(route.path, { kind: 'pending' });
		}
	});
</script>

<Head routeKey="home" noindex />

<div class="mx-auto max-w-[1400px] px-4 py-12 md:py-16">
	<header class="mb-8">
		<h1 class="font-display text-4xl font-extrabold">Responsive audit</h1>
		<p class="mt-3 max-w-3xl text-ink-600 dark:text-ink-300">
			Every route rendered at 380px (canonical phone width). Look for: pages with horizontal
			overflow, broken layouts, text running off the screen, oversized tables, fixed-width elements
			not wrapping.
		</p>
		<p class="mt-2 text-sm text-ink-500">
			Dev-only route. Not indexed. Click a tile to expand to 760px (tablet width) for comparison.
		</p>

		<!-- Summary pills -->
		<div class="mt-6 flex flex-wrap gap-3 text-sm">
			<span class="rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-300">
				✓ {summary.ok} OK
			</span>
			<span class="rounded-full bg-amber-500/15 px-3 py-1 text-amber-300">
				⚠ {summary.overflow} overflow
			</span>
			{#if summary.error > 0}
				<span class="rounded-full bg-red-500/15 px-3 py-1 text-red-300">
					✗ {summary.error} error
				</span>
			{/if}
			{#if summary.pending > 0}
				<span class="rounded-full bg-ink-500/15 px-3 py-1 text-ink-300">
					⋯ {summary.pending} pending
				</span>
			{/if}
		</div>
	</header>

	<div class="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
		{#each ROUTES as route (route.path)}
			{@const status = statuses.get(route.path) ?? { kind: 'pending' }}
			{@const expanded = expandedRoute.value === route.path}
			<div
				class="rounded-xl border bg-ink-950 p-3 transition {status.kind === 'overflow'
					? 'border-amber-700/60'
					: status.kind === 'error'
						? 'border-red-700/60'
						: status.kind === 'ok'
							? 'border-emerald-700/40'
							: 'border-ink-800'} {expanded ? 'sm:col-span-2 xl:col-span-3' : ''}"
			>
				<div class="mb-2 flex items-center justify-between gap-2">
					<button
						type="button"
						class="text-left font-mono text-xs font-semibold text-ink-200 hover:text-emerald-300"
						onclick={() => toggleExpand(route.path)}
					>
						{route.path}
					</button>
					<div class="flex items-center gap-2">
						{#if status.kind === 'ok'}
							<span class="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300">
								✓
							</span>
						{:else if status.kind === 'overflow'}
							<span class="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs text-amber-300">
								+{status.excessPx}px
							</span>
						{:else if status.kind === 'error'}
							<span class="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-300"> err </span>
						{:else}
							<span class="rounded-full bg-ink-500/15 px-2 py-0.5 text-xs text-ink-400"> ⋯ </span>
						{/if}
						<a
							href={route.path}
							target="_blank"
							rel="noopener"
							class="text-xs text-ink-400 hover:text-emerald-300"
							title="Open in new tab"
						>
							↗
						</a>
					</div>
				</div>

				<p class="mb-2 text-xs text-ink-400">
					{route.label}{route.note ? ` · ${route.note}` : ''}
				</p>

				<div class="overflow-hidden rounded-lg bg-ink-900">
					<iframe
						title={route.label}
						src={route.path}
						width={expanded ? 760 : 380}
						height={expanded ? 800 : 500}
						class="block bg-ink-950"
						onload={(e) => onIframeLoad(route.path, e.currentTarget as HTMLIFrameElement)}
					></iframe>
				</div>
			</div>
		{/each}
	</div>

	<section class="mt-12 rounded-xl border border-ink-800 bg-ink-950 p-6">
		<h2 class="mb-3 font-display text-xl font-bold">How to read this page</h2>
		<ul class="list-disc space-y-2 pl-6 text-sm text-ink-300">
			<li>
				<strong class="text-emerald-300">✓ OK</strong> means the page fits in 380px without horizontal
				scrolling.
			</li>
			<li>
				<strong class="text-amber-300">⚠ +Npx</strong> means the page has N pixels of horizontal overflow
				at 380px width. Overflow > 5px usually indicates a fixed-width element (table, code block, image,
				or hardcoded pixel value) that won't wrap.
			</li>
			<li>
				<strong class="text-red-300">✗ err</strong> means the iframe couldn't be inspected — usually
				a same-origin exception or the page errored during render.
			</li>
			<li>
				<strong>Click a route path</strong> to expand the iframe to 760px (tablet width) for comparison.
			</li>
			<li>
				<strong>↗</strong> opens the route in a new tab so you can interact with it.
			</li>
		</ul>
		<p class="mt-4 text-xs text-ink-400">
			Note: pages requiring authentication will render their "please sign in" empty state. That's
			the right thing to audit — it's what an unauthenticated visitor sees first.
		</p>
	</section>
</div>
