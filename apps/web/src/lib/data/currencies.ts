/**
 * Morphit — circulating-currency reference list (ISO 4217).
 *
 * LAZY-LOADED ON PURPOSE.  This module is ~150 entries; it is NOT
 * part of the orderbook's initial bundle.  FiatCurrencySelect
 * `await import()`s it the first time the field gets focus, so Vite
 * code-splits it into its own chunk — minified by the build, gzipped
 * by nginx on the wire, and never sent to a visitor who doesn't touch
 * the fiat filter (priorities #1/#4: tiny footprint, fast first paint).
 *
 * Source: Wikipedia "List of circulating currencies" (the circulating
 * fiat set ≈ ISO 4217 active codes).  Entries with no ISO code
 * (e.g. the Abkhazian apsar) are omitted — you can't filter on a code
 * that doesn't exist.  A few display names are lightly enriched for
 * search recognizability (GBP "Pound sterling", CNY adds "Chinese
 * yuan", VES simplified) so typing the common name finds them.
 */

export interface Currency {
	/** ISO 4217 alphabetic code, uppercase (e.g. "USD"). */
	readonly code: string;
	/** Human display name (e.g. "United States dollar"). */
	readonly name: string;
}

/** Sorted by name so the unfiltered dropdown reads alphabetically. */
export const CURRENCIES: readonly Currency[] = [
	{ code: 'AFN', name: 'Afghan afghani' },
	{ code: 'ALL', name: 'Albanian lek' },
	{ code: 'DZD', name: 'Algerian dinar' },
	{ code: 'AOA', name: 'Angolan kwanza' },
	{ code: 'ARS', name: 'Argentine peso' },
	{ code: 'AMD', name: 'Armenian dram' },
	{ code: 'AWG', name: 'Aruban florin' },
	{ code: 'AUD', name: 'Australian dollar' },
	{ code: 'AZN', name: 'Azerbaijani manat' },
	{ code: 'BSD', name: 'Bahamian dollar' },
	{ code: 'BHD', name: 'Bahraini dinar' },
	{ code: 'BDT', name: 'Bangladeshi taka' },
	{ code: 'BBD', name: 'Barbadian dollar' },
	{ code: 'BYN', name: 'Belarusian ruble' },
	{ code: 'BZD', name: 'Belize dollar' },
	{ code: 'BMD', name: 'Bermudian dollar' },
	{ code: 'BTN', name: 'Bhutanese ngultrum' },
	{ code: 'BOB', name: 'Bolivian boliviano' },
	{ code: 'BAM', name: 'Bosnia and Herzegovina convertible mark' },
	{ code: 'BWP', name: 'Botswana pula' },
	{ code: 'BRL', name: 'Brazilian real' },
	{ code: 'BND', name: 'Brunei dollar' },
	{ code: 'MMK', name: 'Burmese kyat' },
	{ code: 'BIF', name: 'Burundian franc' },
	{ code: 'KHR', name: 'Cambodian riel' },
	{ code: 'CAD', name: 'Canadian dollar' },
	{ code: 'CVE', name: 'Cape Verdean escudo' },
	{ code: 'XCG', name: 'Caribbean guilder' },
	{ code: 'KYD', name: 'Cayman Islands dollar' },
	{ code: 'XAF', name: 'Central African CFA franc' },
	{ code: 'XPF', name: 'CFP franc' },
	{ code: 'CLP', name: 'Chilean peso' },
	{ code: 'COP', name: 'Colombian peso' },
	{ code: 'KMF', name: 'Comorian franc' },
	{ code: 'CDF', name: 'Congolese franc' },
	{ code: 'CRC', name: 'Costa Rican colón' },
	{ code: 'CUP', name: 'Cuban peso' },
	{ code: 'CZK', name: 'Czech koruna' },
	{ code: 'DKK', name: 'Danish krone' },
	{ code: 'DJF', name: 'Djiboutian franc' },
	{ code: 'DOP', name: 'Dominican peso' },
	{ code: 'XCD', name: 'Eastern Caribbean dollar' },
	{ code: 'EGP', name: 'Egyptian pound' },
	{ code: 'ERN', name: 'Eritrean nakfa' },
	{ code: 'ETB', name: 'Ethiopian birr' },
	{ code: 'EUR', name: 'Euro' },
	{ code: 'FKP', name: 'Falkland Islands pound' },
	{ code: 'FJD', name: 'Fijian dollar' },
	{ code: 'GMD', name: 'Gambian dalasi' },
	{ code: 'GEL', name: 'Georgian lari' },
	{ code: 'GHS', name: 'Ghanaian cedi' },
	{ code: 'GIP', name: 'Gibraltar pound' },
	{ code: 'GTQ', name: 'Guatemalan quetzal' },
	{ code: 'GNF', name: 'Guinean franc' },
	{ code: 'GYD', name: 'Guyanese dollar' },
	{ code: 'HTG', name: 'Haitian gourde' },
	{ code: 'HNL', name: 'Honduran lempira' },
	{ code: 'HKD', name: 'Hong Kong dollar' },
	{ code: 'HUF', name: 'Hungarian forint' },
	{ code: 'ISK', name: 'Icelandic króna' },
	{ code: 'INR', name: 'Indian rupee' },
	{ code: 'IDR', name: 'Indonesian rupiah' },
	{ code: 'IRR', name: 'Iranian rial' },
	{ code: 'IQD', name: 'Iraqi dinar' },
	{ code: 'ILS', name: 'Israeli new shekel' },
	{ code: 'JMD', name: 'Jamaican dollar' },
	{ code: 'JPY', name: 'Japanese yen' },
	{ code: 'JOD', name: 'Jordanian dinar' },
	{ code: 'KZT', name: 'Kazakhstani tenge' },
	{ code: 'KES', name: 'Kenyan shilling' },
	{ code: 'KWD', name: 'Kuwaiti dinar' },
	{ code: 'KGS', name: 'Kyrgyz som' },
	{ code: 'LAK', name: 'Lao kip' },
	{ code: 'LBP', name: 'Lebanese pound' },
	{ code: 'LSL', name: 'Lesotho loti' },
	{ code: 'LRD', name: 'Liberian dollar' },
	{ code: 'LYD', name: 'Libyan dinar' },
	{ code: 'MOP', name: 'Macanese pataca' },
	{ code: 'MKD', name: 'Macedonian denar' },
	{ code: 'MGA', name: 'Malagasy ariary' },
	{ code: 'MWK', name: 'Malawian kwacha' },
	{ code: 'MYR', name: 'Malaysian ringgit' },
	{ code: 'MVR', name: 'Maldivian rufiyaa' },
	{ code: 'MRU', name: 'Mauritanian ouguiya' },
	{ code: 'MUR', name: 'Mauritian rupee' },
	{ code: 'MXN', name: 'Mexican peso' },
	{ code: 'MDL', name: 'Moldovan leu' },
	{ code: 'MNT', name: 'Mongolian tögrög' },
	{ code: 'MAD', name: 'Moroccan dirham' },
	{ code: 'MZN', name: 'Mozambican metical' },
	{ code: 'NAD', name: 'Namibian dollar' },
	{ code: 'NPR', name: 'Nepalese rupee' },
	{ code: 'TWD', name: 'New Taiwan dollar' },
	{ code: 'NZD', name: 'New Zealand dollar' },
	{ code: 'NIO', name: 'Nicaraguan córdoba' },
	{ code: 'NGN', name: 'Nigerian naira' },
	{ code: 'KPW', name: 'North Korean won' },
	{ code: 'NOK', name: 'Norwegian krone' },
	{ code: 'OMR', name: 'Omani rial' },
	{ code: 'PKR', name: 'Pakistani rupee' },
	{ code: 'PAB', name: 'Panamanian balboa' },
	{ code: 'PGK', name: 'Papua New Guinean kina' },
	{ code: 'PYG', name: 'Paraguayan guaraní' },
	{ code: 'PEN', name: 'Peruvian sol' },
	{ code: 'PHP', name: 'Philippine peso' },
	{ code: 'PLN', name: 'Polish złoty' },
	{ code: 'GBP', name: 'Pound sterling' },
	{ code: 'QAR', name: 'Qatari riyal' },
	{ code: 'CNY', name: 'Renminbi (Chinese yuan)' },
	{ code: 'RON', name: 'Romanian leu' },
	{ code: 'RUB', name: 'Russian ruble' },
	{ code: 'RWF', name: 'Rwandan franc' },
	{ code: 'SHP', name: 'Saint Helena pound' },
	{ code: 'WST', name: 'Samoan tālā' },
	{ code: 'STN', name: 'São Tomé and Príncipe dobra' },
	{ code: 'SAR', name: 'Saudi riyal' },
	{ code: 'RSD', name: 'Serbian dinar' },
	{ code: 'SCR', name: 'Seychellois rupee' },
	{ code: 'SLE', name: 'Sierra Leonean leone' },
	{ code: 'SGD', name: 'Singapore dollar' },
	{ code: 'SBD', name: 'Solomon Islands dollar' },
	{ code: 'SOS', name: 'Somali shilling' },
	{ code: 'ZAR', name: 'South African rand' },
	{ code: 'KRW', name: 'South Korean won' },
	{ code: 'SSP', name: 'South Sudanese pound' },
	{ code: 'LKR', name: 'Sri Lankan rupee' },
	{ code: 'SDG', name: 'Sudanese pound' },
	{ code: 'SRD', name: 'Surinamese dollar' },
	{ code: 'SZL', name: 'Swazi lilangeni' },
	{ code: 'SEK', name: 'Swedish krona' },
	{ code: 'CHF', name: 'Swiss franc' },
	{ code: 'SYP', name: 'Syrian pound' },
	{ code: 'TJS', name: 'Tajikistani somoni' },
	{ code: 'TZS', name: 'Tanzanian shilling' },
	{ code: 'THB', name: 'Thai baht' },
	{ code: 'TOP', name: 'Tongan paʻanga' },
	{ code: 'TTD', name: 'Trinidad and Tobago dollar' },
	{ code: 'TND', name: 'Tunisian dinar' },
	{ code: 'TRY', name: 'Turkish lira' },
	{ code: 'TMT', name: 'Turkmenistani manat' },
	{ code: 'UGX', name: 'Ugandan shilling' },
	{ code: 'UAH', name: 'Ukrainian hryvnia' },
	{ code: 'AED', name: 'United Arab Emirates dirham' },
	{ code: 'USD', name: 'United States dollar' },
	{ code: 'UYU', name: 'Uruguayan peso' },
	{ code: 'UZS', name: 'Uzbekistani sum' },
	{ code: 'VUV', name: 'Vanuatu vatu' },
	{ code: 'VED', name: 'Venezuelan digital bolívar' },
	{ code: 'VES', name: 'Venezuelan bolívar' },
	{ code: 'VND', name: 'Vietnamese đồng' },
	{ code: 'XOF', name: 'West African CFA franc' },
	{ code: 'YER', name: 'Yemeni rial' },
	{ code: 'ZMW', name: 'Zambian kwacha' },
	{ code: 'ZWG', name: 'Zimbabwe gold' }
];

/** Uppercased set of valid codes — for O(1) validation of a typed code. */
export const CURRENCY_CODES: ReadonlySet<string> = new Set(CURRENCIES.map((c) => c.code));

/**
 * Filter currencies by a free-text query matching the ISO code OR the
 * name (case-insensitive substring).  Code-prefix matches rank first
 * (so "us" surfaces USD before "Australian dollar"), then name
 * matches.  Returns at most `limit` results; an empty query returns
 * the first `limit` alphabetically.
 */
export function searchCurrencies(query: string, limit = 8): Currency[] {
	const q = query.trim().toLowerCase();
	if (q === '') return CURRENCIES.slice(0, limit);
	const codePrefix: Currency[] = [];
	const codeOther: Currency[] = [];
	const nameMatch: Currency[] = [];
	for (const c of CURRENCIES) {
		const code = c.code.toLowerCase();
		const name = c.name.toLowerCase();
		if (code.startsWith(q)) codePrefix.push(c);
		else if (code.includes(q)) codeOther.push(c);
		else if (name.includes(q)) nameMatch.push(c);
	}
	return [...codePrefix, ...codeOther, ...nameMatch].slice(0, limit);
}
