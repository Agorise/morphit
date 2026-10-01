import { loadI18nSections } from '$i18n';
import type { PageLoad } from './$types';

/** v1.20.2 — this page's own locale section ('run_a_node') is not in the bundle every
 *  page loads; it loads here, before the page renders (src/lib/i18n/lazySections.ts). */
export const load: PageLoad = async ({ parent }) => {
	const { lang } = await parent();
	await loadI18nSections(lang, 'run_a_node');
};
