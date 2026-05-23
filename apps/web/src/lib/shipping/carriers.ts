/**
 * Morphit — Shipment-carrier registry (cp120).
 *
 * Top 20 worldwide carriers + an "other" free-text option.
 * Selected by global parcel volume / locale relevance for the 10
 * supported locales (en, es, de, pl, fr, it, ru, fa, zh-CN, zh-HK).
 *
 * Each entry includes a tracking URL template — recipients can
 * click "Track package" in the shipment pill to open the carrier's
 * tracking page pre-populated with the number.  Templates use the
 * literal placeholder `{tracking}` which gets URL-encoded at
 * substitution time.
 *
 * **Best-effort URL templates.**  Carrier tracking URLs occasionally
 * change; the registry is a starting point that operators / users
 * can override via the "Other" entry (free-text carrier name + URL).
 * If a bundled template breaks, file an issue and we'll update.
 *
 * **Privacy posture:** carrier choice IS revealed when the recipient
 * clicks the tracking link (their browser visits the carrier's
 * domain).  The tracking number itself stays in E2E-encrypted chat
 * until the recipient clicks.  Recipients who don't want to ping
 * the carrier directly can copy the tracking number and look it up
 * via Tor or a separate browser.
 *
 * **Order rationale:** alphabetical within the array for
 * deterministic display.  The picker UI may sort by user locale
 * (showing geographically-relevant carriers first); that's a UI
 * concern, not a registry concern.
 */

export interface CarrierEntry {
	/** Stable identifier — used as the on-the-wire `carrier`
	 *  value in `morphit_shipment_v1` payloads.  Lowercase,
	 *  alphanumeric + underscore. */
	readonly key: string;
	/** Display name — shown in pickers and pills.  Kept in the
	 *  carrier's native form (e.g. "Poste Italiane" not
	 *  "Italian Post") so the user recognizes their actual
	 *  service. */
	readonly name: string;
	/** Country/region the carrier primarily serves.  Used by
	 *  the picker UI to surface locale-relevant options first. */
	readonly region: string;
	/** Tracking URL template.  Contains `{tracking}` placeholder
	 *  that gets URL-encoded at substitution time.  Null only
	 *  for the special `other` entry (user supplies URL). */
	readonly trackingUrlTemplate: string | null;
}

/**
 * Top 20 carriers + `other` free-text fallback.
 *
 * Coverage rationale per Morphit locale:
 *  - en: USPS, UPS, FedEx, Royal Mail, Australia Post, Canada Post, India Post
 *  - es: Correos (Spain), plus Aramex serves Latin America via partners
 *  - de: Deutsche Post / DHL Express
 *  - pl: Poczta Polska
 *  - fr: La Poste / Colissimo
 *  - it: Poste Italiane
 *  - ru: Pochta Rossii
 *  - fa: Iran National Post (Post-e Iran); also Aramex serves the region
 *  - zh-CN: China Post / EMS, SF Express
 *  - zh-HK: Hongkong Post
 *  - international: DHL Express, FedEx, UPS, Japan Post
 *
 * Bundled list is intentionally conservative; the "Other" entry
 * accepts any carrier name + URL the user wants to type.
 */
export const CARRIERS: readonly CarrierEntry[] = [
	{
		key: 'aramex',
		name: 'Aramex',
		region: 'Middle East / global',
		trackingUrlTemplate: 'https://www.aramex.com/track/results?ShipmentNumber={tracking}'
	},
	{
		key: 'australia_post',
		name: 'Australia Post',
		region: 'Australia',
		trackingUrlTemplate: 'https://auspost.com.au/mypost/track/details/{tracking}'
	},
	{
		key: 'canada_post',
		name: 'Canada Post',
		region: 'Canada',
		trackingUrlTemplate:
			'https://www.canadapost-postescanada.ca/track-reperage/en#/details/{tracking}'
	},
	{
		key: 'china_post_ems',
		name: 'China Post / EMS',
		region: 'China',
		trackingUrlTemplate: 'https://www.ems.com.cn/english_track/?mailNum={tracking}'
	},
	{
		key: 'correos',
		name: 'Correos',
		region: 'Spain',
		trackingUrlTemplate:
			'https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number={tracking}'
	},
	{
		key: 'deutsche_post',
		name: 'Deutsche Post / DHL Germany',
		region: 'Germany',
		trackingUrlTemplate:
			'https://www.dhl.de/de/privatkunden/dhl-sendungsverfolgung.html?piececode={tracking}'
	},
	{
		key: 'dhl_express',
		name: 'DHL Express',
		region: 'Global',
		trackingUrlTemplate: 'https://www.dhl.com/en/express/tracking.html?AWB={tracking}'
	},
	{
		key: 'fedex',
		name: 'FedEx',
		region: 'Global',
		trackingUrlTemplate: 'https://www.fedex.com/fedextrack/?trknbr={tracking}'
	},
	{
		key: 'hongkong_post',
		name: 'Hongkong Post',
		region: 'Hong Kong',
		trackingUrlTemplate: 'https://app3.hongkongpost.hk/CGI/mt/enquiry.jsp?tracknbr={tracking}'
	},
	{
		key: 'india_post',
		name: 'India Post',
		region: 'India',
		trackingUrlTemplate:
			'https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspx?CN={tracking}'
	},
	{
		key: 'iran_post',
		name: 'Iran National Post',
		region: 'Iran',
		trackingUrlTemplate: 'https://tracking.post.ir/?id={tracking}'
	},
	{
		key: 'japan_post',
		name: 'Japan Post',
		region: 'Japan',
		trackingUrlTemplate:
			'https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1={tracking}&locale=en'
	},
	{
		key: 'la_poste',
		name: 'La Poste / Colissimo',
		region: 'France',
		trackingUrlTemplate: 'https://www.laposte.fr/outils/suivre-vos-envois?code={tracking}'
	},
	{
		key: 'pochta_rossii',
		name: 'Pochta Rossii',
		region: 'Russia',
		trackingUrlTemplate: 'https://www.pochta.ru/tracking#{tracking}'
	},
	{
		key: 'poczta_polska',
		name: 'Poczta Polska',
		region: 'Poland',
		trackingUrlTemplate: 'https://emonitoring.poczta-polska.pl/?numer={tracking}'
	},
	{
		key: 'poste_italiane',
		name: 'Poste Italiane',
		region: 'Italy',
		trackingUrlTemplate: 'https://www.poste.it/cerca/index.html?spedizione={tracking}'
	},
	{
		key: 'royal_mail',
		name: 'Royal Mail',
		region: 'United Kingdom',
		trackingUrlTemplate:
			'https://www.royalmail.com/track-your-item#/tracking-results/{tracking}'
	},
	{
		key: 'sf_express',
		name: 'SF Express',
		region: 'China / Asia-Pacific',
		trackingUrlTemplate:
			'https://www.sf-international.com/en/dynamic_function/waybill/#search/bill-number/{tracking}'
	},
	{
		key: 'ups',
		name: 'UPS',
		region: 'Global',
		trackingUrlTemplate: 'https://www.ups.com/track?tracknum={tracking}'
	},
	{
		key: 'usps',
		name: 'USPS',
		region: 'United States',
		trackingUrlTemplate:
			'https://tools.usps.com/go/TrackConfirmAction?qtc_tLabels1={tracking}'
	},
	// `other` is special: caller supplies its own name + tracking URL
	// via the shipment payload's optional `customCarrierName` and
	// `customTrackingUrl` fields.  See $lib/chat/payload.ts.
	{
		key: 'other',
		name: 'Other (specify carrier)',
		region: 'Free text',
		trackingUrlTemplate: null
	}
] as const;

/** Set of canonical keys for O(1) lookup. */
export const CARRIER_KEYS: ReadonlySet<string> = new Set(CARRIERS.map((c) => c.key));

/** Find a carrier by key.  Returns undefined for unknown keys. */
export function getCarrier(key: string): CarrierEntry | undefined {
	return CARRIERS.find((c) => c.key === key);
}

/**
 * Substitute `{tracking}` in a template with a URL-encoded tracking
 * number.  Returns null if template is null (i.e. the `other`
 * carrier — caller should use the user-supplied `customTrackingUrl`
 * field).
 *
 * Tracking numbers can technically contain spaces, dashes, and
 * alphanumeric chars.  We URL-encode to be safe — every carrier's
 * URL parser tolerates encoded forms.
 */
export function buildTrackingUrl(template: string | null, tracking: string): string | null {
	if (!template) return null;
	return template.replace('{tracking}', encodeURIComponent(tracking));
}
