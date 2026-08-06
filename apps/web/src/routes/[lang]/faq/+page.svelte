<script lang="ts">
	import FaqSearch from '$components/FaqSearch.svelte';
	import Head from '$components/Head.svelte';
	import { faqPageSchema } from '$seo/jsonld';
	import { faqEntries } from '$utils/faqIndex';

	// FAQPage schema makes entries eligible for Google rich snippets.
	// The schema is built from the live (locale-reactive) FaqEntry list,
	// so the language of the questions/answers always matches the page.
	const jsonLd = $derived([faqPageSchema($faqEntries)]);
</script>

<Head routeKey="faq" {jsonLd} />

<div class="mx-auto max-w-4xl px-4 py-12 md:py-16">
	<FaqSearch />
</div>
