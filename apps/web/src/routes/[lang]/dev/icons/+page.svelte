<!--
	Morphit — icon gallery (dev route, Item 10).

	Shows every SVG icon Morphit ships, rendered at the sizes
	they actually appear in the UI.  Use this page to spot
	icons that don't render correctly: stroke clipping, off-
	center alignment, dark-mode invisibility, color drift,
	currentColor inheritance bugs, viewBox issues.

	Grouped by purpose:

	  1. Brand (mark + wordmark)
	  2. Asset icons (BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC,
	     DASH, DOGE, YubiKey)
	  3. Alt-network icons (Tor, Lokinet, I2P, Nostr, Blurt)
	  4. UI icon components (in-context samples)

	Each icon is shown at three sizes (16px, 24px, 48px) and
	on both light + dark backgrounds (the dark background is
	the canonical render — Morphit is dark-mode-only — but
	emails and OG embeds often land on light backgrounds, so
	we want to know how the brand reads there too).
-->
<script lang="ts">
	import Head from '$components/Head.svelte';
	import AltNetworkIcon from '$components/AltNetworkIcon.svelte';
	import MorphitMark from '$components/MorphitMark.svelte';
	import StatusLine from '$components/StatusLine.svelte';
	import BusyButton from '$components/BusyButton.svelte';
	import LanguageSwitcher from '$components/LanguageSwitcher.svelte';
	import IdentityLabel from '$components/IdentityLabel.svelte';
	import PriceFreshnessIndicator from '$components/PriceFreshnessIndicator.svelte';

	const ALT_NETWORKS = ['tor', 'lokinet', 'i2p', 'nostr', 'blurt'] as const;
	// Asset icon dev surface.  All 16 tradable assets + the
	// yubikey ancillary icon.  All icons live at
	// /icons/icon-<lower-ticker>.svg per cp115 convention cleanup;
	// an earlier /coins/<ticker>.svg path was vestigial (the files
	// never shipped to disk under that path) and has been folded
	// into the canonical /icons/ form for all 16 entries.
	const ASSETS = [
		{ key: 'btc', path: '/icons/icon-btc.svg' },
		{ key: 'xmr', path: '/icons/icon-xmr.svg' },
		{ key: 'blurt', path: '/icons/icon-blurt.svg' },
		{ key: 'usdt', path: '/icons/icon-usdt.svg' },
		{ key: 'usdc', path: '/icons/icon-usdc.svg' },
		{ key: 'dai', path: '/icons/icon-dai.svg' },
		{ key: 'bch', path: '/icons/icon-bch.svg' },
		{ key: 'ltc', path: '/icons/icon-ltc.svg' },
		{ key: 'dash', path: '/icons/icon-dash.svg' },
		{ key: 'doge', path: '/icons/icon-doge.svg' },
		{ key: 'zec', path: '/icons/icon-zec.svg' },
		{ key: 'arrr', path: '/icons/icon-arrr.svg' },
		{ key: 'dcr', path: '/icons/icon-dcr.svg' },
		{ key: 'sol', path: '/icons/icon-sol.svg' },
		{ key: 'eth', path: '/icons/icon-eth.svg' },
		{ key: 'xrp', path: '/icons/icon-xrp.svg' },
		{ key: 'yubikey', path: '/icons/icon-yubikey.svg' }
	] as const;

	const SIZES = [16, 24, 48] as const;
</script>

<Head routeKey="home" noindex />

<div class="mx-auto max-w-5xl px-4 py-12 md:py-16">
	<header class="mb-10">
		<h1 class="font-display text-4xl font-extrabold">Icon gallery</h1>
		<p class="mt-3 max-w-2xl text-ink-600 dark:text-ink-300">
			Every SVG Morphit ships, rendered as it appears in the UI. Look for: stroke clipping,
			off-center alignment, color drift in dark mode, missed currentColor inheritance, viewBox
			issues. Three sizes to surface size-dependent problems.
		</p>
		<p class="mt-2 text-sm text-ink-500">Dev-only route. Not indexed.</p>
	</header>

	<!-- ─── Brand ─────────────────────────────────────────────── -->
	<section class="mb-12">
		<h2 class="mb-4 font-display text-2xl font-bold">1. Brand</h2>
		<div class="grid gap-6 md:grid-cols-2">
			<div class="rounded-xl border border-ink-200 bg-ink-950 p-6 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-400">Mark · dark surface</p>
				<div class="flex items-center gap-6">
					<MorphitMark size={16} />
					<MorphitMark size={24} />
					<MorphitMark size={48} />
					<MorphitMark size={96} />
				</div>
			</div>
			<div class="rounded-xl border border-ink-200 bg-white p-6 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-500">Mark · light surface</p>
				<div class="flex items-center gap-6">
					<MorphitMark size={16} />
					<MorphitMark size={24} />
					<MorphitMark size={48} />
					<MorphitMark size={96} />
				</div>
			</div>
			<div class="rounded-xl border border-ink-200 bg-ink-950 p-6 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-400">Wordmark · dark surface</p>
				<img src="/brand/morphit-wordmark.svg" alt="Morphit wordmark" class="h-10" loading="lazy" decoding="async" />
			</div>
			<div class="rounded-xl border border-ink-200 bg-white p-6 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-500">Wordmark · light surface</p>
				<img src="/brand/morphit-wordmark.svg" alt="Morphit wordmark" class="h-10" loading="lazy" decoding="async" />
			</div>
		</div>
	</section>

	<!-- ─── Favicon + PWA app icons ───────────────────────────── -->
	<section class="mb-12">
		<h2 class="mb-4 font-display text-2xl font-bold">1b. Favicon &amp; PWA app icons</h2>
		<p class="mb-4 text-sm text-ink-500">
			How the icon renders in three contexts: the browser tab favicon (transparent
			background, mark only), the PWA app icon (dark ink-950 canvas, mark centered),
			and the maskable variant (Android adaptive icon mask preserves the mark inside
			the inner 40% safe radius).
		</p>
		<div class="grid gap-4 md:grid-cols-3">
			<!-- favicon.svg — transparent -->
			<div class="rounded-xl border border-ink-200 bg-white p-4 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-500">
					favicon.svg · transparent on light
				</p>
				<div class="flex items-center justify-around gap-2">
					<img src="/favicon.svg" alt="Morphit favicon" width="16" height="16" loading="lazy" decoding="async" />
					<img src="/favicon.svg" alt="Morphit favicon" width="32" height="32" loading="lazy" decoding="async" />
					<img src="/favicon.svg" alt="Morphit favicon" width="64" height="64" loading="lazy" decoding="async" />
				</div>
			</div>
			<div class="rounded-xl border border-ink-200 bg-ink-950 p-4 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-400">
					favicon.svg · transparent on dark
				</p>
				<div class="flex items-center justify-around gap-2">
					<img src="/favicon.svg" alt="Morphit favicon" width="16" height="16" loading="lazy" decoding="async" />
					<img src="/favicon.svg" alt="Morphit favicon" width="32" height="32" loading="lazy" decoding="async" />
					<img src="/favicon.svg" alt="Morphit favicon" width="64" height="64" loading="lazy" decoding="async" />
				</div>
			</div>
			<!-- app-icon.svg — dark background, default PWA icon -->
			<div class="rounded-xl border border-ink-200 bg-ink-100 p-4 dark:border-ink-800 dark:bg-ink-100">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-700">
					app-icon.svg · PWA launcher
				</p>
				<div class="flex items-center justify-around gap-2">
					<img
						src="/app-icon.svg"
						alt="Morphit app icon"
						width="48"
						height="48"
						class="rounded-lg"
						loading="lazy"
						decoding="async"
					/>
					<img
						src="/app-icon.svg"
						alt="Morphit app icon"
						width="72"
						height="72"
						class="rounded-lg"
						loading="lazy"
						decoding="async"
					/>
					<img
						src="/app-icon.svg"
						alt="Morphit app icon"
						width="96"
						height="96"
						class="rounded-lg"
						loading="lazy"
						decoding="async"
					/>
				</div>
			</div>
			<!-- app-icon-maskable.svg with simulated Android masks -->
			<div class="rounded-xl border border-ink-200 bg-ink-100 p-4 dark:border-ink-800 dark:bg-ink-100">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-700">
					app-icon-maskable.svg · circle mask
				</p>
				<div class="flex items-center justify-around gap-2">
					<img
						src="/app-icon-maskable.svg"
						alt="Morphit maskable icon, circle"
						width="48"
						height="48"
						class="rounded-full"
						loading="lazy"
						decoding="async"
					/>
					<img
						src="/app-icon-maskable.svg"
						alt="Morphit maskable icon, circle"
						width="72"
						height="72"
						class="rounded-full"
						loading="lazy"
						decoding="async"
					/>
					<img
						src="/app-icon-maskable.svg"
						alt="Morphit maskable icon, circle"
						width="96"
						height="96"
						class="rounded-full"
						loading="lazy"
						decoding="async"
					/>
				</div>
			</div>
			<div class="rounded-xl border border-ink-200 bg-ink-100 p-4 dark:border-ink-800 dark:bg-ink-100">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-700">
					app-icon-maskable.svg · squircle mask
				</p>
				<div class="flex items-center justify-around gap-2">
					<img
						src="/app-icon-maskable.svg"
						alt="Morphit maskable icon, squircle"
						width="48"
						height="48"
						style="border-radius: 25%"
						loading="lazy"
						decoding="async"
					/>
					<img
						src="/app-icon-maskable.svg"
						alt="Morphit maskable icon, squircle"
						width="72"
						height="72"
						style="border-radius: 25%"
						loading="lazy"
						decoding="async"
					/>
					<img
						src="/app-icon-maskable.svg"
						alt="Morphit maskable icon, squircle"
						width="96"
						height="96"
						style="border-radius: 25%"
						loading="lazy"
						decoding="async"
					/>
				</div>
			</div>
			<div class="rounded-xl border border-ink-200 bg-ink-100 p-4 dark:border-ink-800 dark:bg-ink-100">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-700">
					app-icon-maskable.svg · rounded square
				</p>
				<div class="flex items-center justify-around gap-2">
					<img
						src="/app-icon-maskable.svg"
						alt="Morphit maskable icon, rounded square"
						width="48"
						height="48"
						class="rounded-lg"
						loading="lazy"
						decoding="async"
					/>
					<img
						src="/app-icon-maskable.svg"
						alt="Morphit maskable icon, rounded square"
						width="72"
						height="72"
						class="rounded-lg"
						loading="lazy"
						decoding="async"
					/>
					<img
						src="/app-icon-maskable.svg"
						alt="Morphit maskable icon, rounded square"
						width="96"
						height="96"
						class="rounded-lg"
						loading="lazy"
						decoding="async"
					/>
				</div>
			</div>
		</div>
	</section>

	<!-- ─── Assets ────────────────────────────────────────────── -->
	<section class="mb-12">
		<h2 class="mb-4 font-display text-2xl font-bold">2. Asset icons</h2>
		<p class="mb-4 text-sm text-ink-500">Each shown at 16, 24, 48 px on a dark surface.</p>
		<div class="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
			{#each ASSETS as asset (asset.key)}
				<div class="rounded-xl border border-ink-200 bg-ink-950 p-4 dark:border-ink-800">
					<p class="mb-2 text-xs uppercase tracking-widest text-ink-400">
						{asset.path}
					</p>
					<div class="flex items-center justify-around">
						{#each SIZES as sz (sz)}
							<img src={asset.path} alt={asset.key} width={sz} height={sz} loading="lazy" decoding="async" />
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</section>

	<!-- ─── Alt-network icons ─────────────────────────────────── -->
	<section class="mb-12">
		<h2 class="mb-4 font-display text-2xl font-bold">3. Alt-network icons</h2>
		<p class="mb-4 text-sm text-ink-500">
			Default state is grayscale (calm); hover lifts to full color. Hover any tile to verify the
			hover transition.
		</p>
		<div class="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
			{#each ALT_NETWORKS as net (net)}
				<div class="rounded-xl border border-ink-200 bg-ink-950 p-4 dark:border-ink-800">
					<p class="mb-2 text-xs uppercase tracking-widest text-ink-400">
						{net}
					</p>
					<div class="flex items-center justify-around">
						{#each SIZES as sz (sz)}
							<AltNetworkIcon network={net} size={sz} />
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</section>


	<!-- ─── In-component UI icons ─────────────────────────────── -->
	<section class="mb-12">
		<h2 class="mb-4 font-display text-2xl font-bold">4. UI components with inline SVGs</h2>
		<p class="mb-4 text-sm text-ink-500">
			Components that include their own glyphs. Inspect for alignment with surrounding text +
			correct contextual color (success/warn/error).
		</p>

		<div class="space-y-6">
			<div class="rounded-xl border border-ink-200 bg-ink-950 p-6 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-400">StatusLine</p>
				<div class="space-y-2">
					<StatusLine kind="idle">Idle status — no icon</StatusLine>
					<StatusLine kind="loading">Loading status — spinner should rotate smoothly</StatusLine>
					<StatusLine kind="ok">Success status — emerald check should align with text</StatusLine>
					<StatusLine kind="warn">Warn status — amber triangle</StatusLine>
					<StatusLine kind="error">Error status — red X, must read at 16px</StatusLine>
				</div>
			</div>

			<div class="rounded-xl border border-ink-200 bg-ink-950 p-6 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-400">
					BusyButton (static + busy)
				</p>
				<div class="flex flex-wrap gap-3">
					<BusyButton variant="primary">Primary idle</BusyButton>
					<BusyButton variant="secondary">Secondary idle</BusyButton>
					<BusyButton variant="primary" busy>Primary busy</BusyButton>
				</div>
				<p class="mt-3 text-xs text-ink-500">
					Verify the spinner is a perfect circle, doesn't squish into an oval at 16px.
				</p>
			</div>

			<div class="rounded-xl border border-ink-200 bg-ink-950 p-6 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-400">LanguageSwitcher</p>
				<div class="flex justify-start">
					<LanguageSwitcher />
				</div>
				<p class="mt-3 text-xs text-ink-500">
					Globe icon must align vertically with chevron and label.
				</p>
			</div>

			<div class="rounded-xl border border-ink-200 bg-ink-950 p-6 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-400">IdentityLabel</p>
				<div class="flex flex-col gap-2">
					<IdentityLabel account="alice" />
					<IdentityLabel account="bob" displayName="Bob the Builder" />
				</div>
				<p class="mt-3 text-xs text-ink-500">
					Identicon SVG must be square + match the row's text baseline.
				</p>
			</div>

			<div class="rounded-xl border border-ink-200 bg-ink-950 p-6 dark:border-ink-800">
				<p class="mb-3 text-xs uppercase tracking-widest text-ink-400">PriceFreshnessIndicator</p>
				<div class="flex flex-wrap gap-4">
					<PriceFreshnessIndicator />
					<PriceFreshnessIndicator symbol="BTC" />
					<PriceFreshnessIndicator symbol="XMR" />
					<PriceFreshnessIndicator symbol="BLURT" />
				</div>
			</div>
		</div>
	</section>

	<!-- ─── Notes ─────────────────────────────────────────────── -->
	<section class="mt-16 rounded-xl border border-ink-200 bg-ink-950 p-6 dark:border-ink-800">
		<h2 class="mb-3 font-display text-xl font-bold">Things to watch for</h2>
		<ul class="list-disc space-y-2 pl-6 text-sm text-ink-300">
			<li>
				<strong>Alignment.</strong> Icon next to text should center on the text's x-height, not the cap-height.
				If icons sit too high, the SVG's viewBox needs vertical padding.
			</li>
			<li>
				<strong>Stroke width.</strong> SVGs with stroke-based paths render too thin at 16px and too thick
				at 48px. Use scaled stroke (`vector-effect="non-scaling-stroke"`) or fill-based paths.
			</li>
			<li>
				<strong>currentColor.</strong> Glyph SVGs should use `fill="currentColor"` not hard-coded hex.
				Verify by placing inside a colored parent — the icon should follow.
			</li>
			<li>
				<strong>Hover transitions.</strong> Alt-network icons go from grayscale to full color on hover.
				If the transition is jumpy, the source SVG may have a mismatched colorspace.
			</li>
			<li>
				<strong>Dark mode.</strong> Brand mark on dark surface: the gradient should still read as emerald-to-teal
				without disappearing. Wordmark on dark: any black strokes should switch to white via dark-mode
				CSS.
			</li>
			<li>
				<strong>Mobile pixel-snap.</strong> SVGs at 16px on high-DPI screens occasionally fall on a half-pixel
				and blur. Try 17px or 18px if a 16px icon looks fuzzy.
			</li>
		</ul>
	</section>
</div>
