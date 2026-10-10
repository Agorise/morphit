<script lang="ts">
	import FaqSearch from '$components/FaqSearch.svelte';
	import Head from '$components/Head.svelte';
	import { faqPageSchema } from '$seo/jsonld';
	import { faqEntries } from '$utils/faqIndex';
	import { instance } from '$stores/instance';
	import { visibleFaqEntries } from '$lib/faq/assetGate';

	// FAQPage schema makes entries eligible for Google rich snippets.
	// The schema is built from the live (locale-reactive) FaqEntry list,
	// so the language of the questions/answers always matches the page —
	// and (v1.21.5) it lists the same entries the page shows on this site.
	const jsonLd = $derived([
		faqPageSchema(visibleFaqEntries($faqEntries, $instance.disabled_assets))
	]);
</script>

<Head routeKey="faq" {jsonLd} />

<div class="mx-auto max-w-4xl px-4 py-12 md:py-16">
	<FaqSearch />
</div>
