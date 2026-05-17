/**
 * Morphit indexer — minimal i18n for Web Push payload strings.
 *
 * Part 122 cp14.  The indexer's notification handlers enqueue
 * push_pending rows with pre-localized `title` and `body`
 * (the service worker renders them verbatim; the SW has no i18n
 * runtime).  The indexer reads the recipient's preferred locale
 * from push_subscriptions.locale and looks up the right template
 * here.
 *
 * This module is intentionally tiny and dependency-free:
 *   - Flat dictionary of locale → key → template.
 *   - No fancy interpolation; consumers pass their substitutions
 *     as positional args via `localize(locale, key, [...args])`.
 *   - Unknown locales fall back to 'en'.  Unknown keys throw —
 *     it means a handler asked for a string we haven't added.
 *
 * The locale tags are a STRICT subset of the apps/web client's
 * 10 supported locales (en, es, fr, de, it, pl, ru, fa, zh-CN,
 * zh-HK).  Pre-cp14 subscriptions defaulted to 'en' (via the
 * schema ADD COLUMN default), so existing users keep working.
 *
 * Why not reuse apps/web's i18n bundles?  Two reasons:
 *   (a) Those bundles ship to the browser; importing them into
 *       the indexer would bloat its runtime image with strings
 *       that have nothing to do with chain indexing.
 *   (b) Push payload strings are a tiny, stable subset.  Keeping
 *       them here in plain TS keeps the contract obvious in the
 *       diff and the type system catches missing translations.
 */

/** Supported locales — matches the client's 10. */
export type IndexerPushLocale =
	| 'en'
	| 'es'
	| 'fr'
	| 'de'
	| 'it'
	| 'pl'
	| 'ru'
	| 'fa'
	| 'zh-CN'
	| 'zh-HK';

const KNOWN_LOCALES: readonly IndexerPushLocale[] = [
	'en',
	'es',
	'fr',
	'de',
	'it',
	'pl',
	'ru',
	'fa',
	'zh-CN',
	'zh-HK'
];

/** Push payload string keys.  Adding one here without adding all
 *  10 translations below is a typecheck failure — TS enforces
 *  Record<IndexerPushLocale, ...> completeness. */
export type PushStringKey =
	| 'feedback_title'
	| 'feedback_body_one'
	| 'feedback_body_many'
	| 'chat_title'
	| 'chat_body'
	| 'order_title'
	| 'order_body'
	| 'outbid_title'
	| 'outbid_body';

/** A template is either a plain string or a function that takes
 *  positional substitution args.  Keeping it flexible because
 *  some translations have grammar that wants the sender's name
 *  in the middle, others at the end. */
type Template = string | ((...args: string[]) => string);

const TABLE: Record<IndexerPushLocale, Record<PushStringKey, Template>> = {
	en: {
		feedback_title: 'New feedback received',
		feedback_body_one: (reviewer, rating) => `${reviewer} rated you ${rating} star.`,
		feedback_body_many: (reviewer, rating) => `${reviewer} rated you ${rating} stars.`,
		chat_title: 'New chat message',
		chat_body: (sender) => `${sender} sent you a message.`,
		order_title: 'New trade message',
		order_body: (sender) => `${sender} sent a message about one of your orders.`,
		outbid_title: 'You\'ve been outbid',
		outbid_body: (bidder, permlink) => `${bidder} placed a higher featured bid on ${permlink}.`
	},
	es: {
		feedback_title: 'Nueva valoración recibida',
		feedback_body_one: (reviewer, rating) => `${reviewer} te dio ${rating} estrella.`,
		feedback_body_many: (reviewer, rating) => `${reviewer} te dio ${rating} estrellas.`,
		chat_title: 'Nuevo mensaje de chat',
		chat_body: (sender) => `${sender} te envió un mensaje.`,
		order_title: 'Nuevo mensaje de operación',
		order_body: (sender) => `${sender} envió un mensaje sobre una de tus órdenes.`,
		outbid_title: 'Te superaron la puja',
		outbid_body: (bidder, permlink) => `${bidder} puso una puja destacada más alta en ${permlink}.`
	},
	fr: {
		feedback_title: 'Nouvelle évaluation reçue',
		feedback_body_one: (reviewer, rating) => `${reviewer} vous a noté ${rating} étoile.`,
		feedback_body_many: (reviewer, rating) => `${reviewer} vous a noté ${rating} étoiles.`,
		chat_title: 'Nouveau message de chat',
		chat_body: (sender) => `${sender} vous a envoyé un message.`,
		order_title: 'Nouveau message d’échange',
		order_body: (sender) => `${sender} a envoyé un message à propos d’une de vos commandes.`,
		outbid_title: 'Vous avez été dépassé',
		outbid_body: (bidder, permlink) => `${bidder} a placé une enchère plus élevée sur ${permlink}.`
	},
	de: {
		feedback_title: 'Neue Bewertung erhalten',
		feedback_body_one: (reviewer, rating) => `${reviewer} hat dich mit ${rating} Stern bewertet.`,
		feedback_body_many: (reviewer, rating) => `${reviewer} hat dich mit ${rating} Sternen bewertet.`,
		chat_title: 'Neue Chat-Nachricht',
		chat_body: (sender) => `${sender} hat dir eine Nachricht geschickt.`,
		order_title: 'Neue Handelsnachricht',
		order_body: (sender) => `${sender} hat eine Nachricht zu einer deiner Bestellungen geschickt.`,
		outbid_title: 'Du wurdest überboten',
		outbid_body: (bidder, permlink) => `${bidder} hat ein höheres Featured-Gebot auf ${permlink} abgegeben.`
	},
	it: {
		feedback_title: 'Nuova valutazione ricevuta',
		feedback_body_one: (reviewer, rating) => `${reviewer} ti ha dato ${rating} stella.`,
		feedback_body_many: (reviewer, rating) => `${reviewer} ti ha dato ${rating} stelle.`,
		chat_title: 'Nuovo messaggio in chat',
		chat_body: (sender) => `${sender} ti ha inviato un messaggio.`,
		order_title: 'Nuovo messaggio di scambio',
		order_body: (sender) => `${sender} ha inviato un messaggio su uno dei tuoi ordini.`,
		outbid_title: 'Sei stato superato',
		outbid_body: (bidder, permlink) => `${bidder} ha fatto un\'offerta in evidenza più alta su ${permlink}.`
	},
	pl: {
		feedback_title: 'Nowa opinia',
		feedback_body_one: (reviewer, rating) => `${reviewer} ocenił/a cię na ${rating} gwiazdkę.`,
		feedback_body_many: (reviewer, rating) => `${reviewer} ocenił/a cię na ${rating} gwiazdek.`,
		chat_title: 'Nowa wiadomość czatu',
		chat_body: (sender) => `${sender} wysłał/a ci wiadomość.`,
		order_title: 'Nowa wiadomość transakcyjna',
		order_body: (sender) => `${sender} wysłał/a wiadomość dotyczącą jednej z twoich ofert.`,
		outbid_title: 'Twoja oferta została przebita',
		outbid_body: (bidder, permlink) => `${bidder} złożył/a wyższą ofertę wyróżnioną na ${permlink}.`
	},
	ru: {
		feedback_title: 'Получен новый отзыв',
		feedback_body_one: (reviewer, rating) => `${reviewer} поставил(а) вам ${rating} звезду.`,
		feedback_body_many: (reviewer, rating) => `${reviewer} поставил(а) вам ${rating} звёзд.`,
		chat_title: 'Новое сообщение в чате',
		chat_body: (sender) => `${sender} отправил(а) вам сообщение.`,
		order_title: 'Новое сообщение по сделке',
		order_body: (sender) => `${sender} отправил(а) сообщение об одной из ваших ордеров.`,
		outbid_title: 'Вашу ставку перебили',
		outbid_body: (bidder, permlink) => `${bidder} разместил(а) более высокую ставку на ${permlink}.`
	},
	fa: {
		feedback_title: 'بازخورد جدید دریافت شد',
		feedback_body_one: (reviewer, rating) => `${reviewer} به شما ${rating} ستاره داد.`,
		feedback_body_many: (reviewer, rating) => `${reviewer} به شما ${rating} ستاره داد.`,
		chat_title: 'پیام چت جدید',
		chat_body: (sender) => `${sender} برای شما یک پیام فرستاد.`,
		order_title: 'پیام معاملاتی جدید',
		order_body: (sender) => `${sender} درباره یکی از سفارش‌های شما پیام فرستاد.`,
		outbid_title: 'پیشنهاد شما رد شد',
		outbid_body: (bidder, permlink) => `${bidder} پیشنهاد برجسته بالاتری روی ${permlink} ارائه داد.`
	},
	'zh-CN': {
		feedback_title: '收到新评价',
		feedback_body_one: (reviewer, rating) => `${reviewer} 给你打了 ${rating} 星。`,
		feedback_body_many: (reviewer, rating) => `${reviewer} 给你打了 ${rating} 星。`,
		chat_title: '新聊天消息',
		chat_body: (sender) => `${sender} 给你发了一条消息。`,
		order_title: '新交易消息',
		order_body: (sender) => `${sender} 关于你的一个订单发来了消息。`,
		outbid_title: '你的竞价已被超越',
		outbid_body: (bidder, permlink) => `${bidder} 在 ${permlink} 上提交了更高的精选竞价。`
	},
	'zh-HK': {
		feedback_title: '收到新評價',
		feedback_body_one: (reviewer, rating) => `${reviewer} 俾咗 ${rating} 粒星畀你。`,
		feedback_body_many: (reviewer, rating) => `${reviewer} 俾咗 ${rating} 粒星畀你。`,
		chat_title: '新聊天訊息',
		chat_body: (sender) => `${sender} 發咗條訊息畀你。`,
		order_title: '新交易訊息',
		order_body: (sender) => `${sender} 就你嘅一張訂單發咗條訊息。`,
		outbid_title: '你嘅競價已被超越',
		outbid_body: (bidder, permlink) => `${bidder} 喺 ${permlink} 上提交咗更高嘅精選競價。`
	}
};

/** Normalize a locale string from the DB to one of the known
 *  tags.  Unknown locales fall back to 'en'.  Handles common
 *  variants (`en-US` → `en`, `zh-Hant-HK` → `zh-HK`, etc.). */
export function normalizeLocale(raw: string | null | undefined): IndexerPushLocale {
	if (!raw) return 'en';
	// Exact match wins.
	if (KNOWN_LOCALES.includes(raw as IndexerPushLocale)) {
		return raw as IndexerPushLocale;
	}
	// Strip BCP-47 region/variant suffixes and try again.
	const head = raw.split('-')[0]!;
	if (KNOWN_LOCALES.includes(head as IndexerPushLocale)) {
		return head as IndexerPushLocale;
	}
	// Special-case Chinese tags: 'zh-Hant', 'zh-TW' → 'zh-HK'
	// (closest traditional-Chinese variant we ship).
	if (head === 'zh') {
		if (raw.includes('Hant') || raw.includes('TW') || raw.includes('HK')) return 'zh-HK';
		return 'zh-CN';
	}
	return 'en';
}

/** Look up and render a localized push string.  Throws on unknown
 *  key — that's a programmer error, not a runtime input. */
export function localize(
	locale: IndexerPushLocale,
	key: PushStringKey,
	...args: string[]
): string {
	const tmpl = TABLE[locale][key];
	return typeof tmpl === 'string' ? tmpl : tmpl(...args);
}
