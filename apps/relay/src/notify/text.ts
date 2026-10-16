/**
 * Offline notices — what is sent, in each supported language. PURE.
 *
 * The notice never names the sender or quotes the message (the chat is
 * end-to-end encrypted; the instance cannot read it, and the mail, Matrix,
 * XMPP, Telegram or Session servers that carry the notice must not learn who
 * is writing to her). It names the SITE — the instance's own brand name, never
 * "Morphit" unless that is the site's name — and links straight to the
 * conversation.
 *
 * `{site}`, `{link}` and `{code}` are filled in by {@link render}; nothing else
 * is interpolated, and the site name has its line breaks removed first.
 */

export type NoticeLocale =
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

interface Strings {
	/** The notice. */
	readonly notice: string;
	/** Email subject of the notice. */
	readonly notice_subject: string;
	/** The code that confirms an address. */
	readonly code: string;
	/** Email subject of the code. */
	readonly code_subject: string;
	/** Telegram: after she sent the right code to the bot. */
	readonly telegram_linked: string;
}

const STRINGS: Record<NoticeLocale, Strings> = {
	en: {
		notice:
			'Someone just sent you a chat message on {site}. Open it here to read it and reply: {link}',
		notice_subject: 'New chat message on {site}',
		code: 'Your {site} code is {code}. Type it in Settings → Offline Notifications to turn these notes on. If you did not ask for it, just ignore this message.',
		code_subject: 'Your {site} code: {code}',
		telegram_linked:
			'Done! You will get a note here when someone sends you a chat message on {site}.'
	},
	es: {
		notice:
			'Alguien acaba de enviarte un mensaje de chat en {site}. Ábrelo aquí para leerlo y responder: {link}',
		notice_subject: 'Nuevo mensaje de chat en {site}',
		code: 'Tu código de {site} es {code}. Escríbelo en Ajustes → Avisos sin conexión para activar estos avisos. Si no lo pediste, ignora este mensaje.',
		code_subject: 'Tu código de {site}: {code}',
		telegram_linked:
			'¡Listo! Recibirás un aviso aquí cuando alguien te envíe un mensaje de chat en {site}.'
	},
	fr: {
		notice:
			"Quelqu'un vient de vous envoyer un message de chat sur {site}. Ouvrez-le ici pour le lire et répondre : {link}",
		notice_subject: 'Nouveau message de chat sur {site}',
		code: "Votre code {site} est {code}. Saisissez-le dans Paramètres → Notifications hors ligne pour activer ces notifications. Si vous ne l'avez pas demandé, ignorez ce message.",
		code_subject: 'Votre code {site} : {code}',
		telegram_linked:
			"C'est fait ! Vous recevrez une notification ici quand quelqu'un vous enverra un message de chat sur {site}."
	},
	de: {
		notice:
			'Jemand hat dir gerade eine Chat-Nachricht auf {site} geschickt. Öffne sie hier, um sie zu lesen und zu antworten: {link}',
		notice_subject: 'Neue Chat-Nachricht auf {site}',
		code: 'Dein Code für {site} ist {code}. Gib ihn unter Einstellungen → Offline-Benachrichtigungen ein, um diese Hinweise einzuschalten. Wenn du ihn nicht angefordert hast, ignoriere diese Nachricht einfach.',
		code_subject: 'Dein Code für {site}: {code}',
		telegram_linked:
			'Fertig! Du bekommst hier einen Hinweis, wenn dir jemand auf {site} eine Chat-Nachricht schickt.'
	},
	it: {
		notice:
			'Qualcuno ti ha appena inviato un messaggio in chat su {site}. Aprilo qui per leggerlo e rispondere: {link}',
		notice_subject: 'Nuovo messaggio in chat su {site}',
		code: 'Il tuo codice {site} è {code}. Inseriscilo in Impostazioni → Notifiche offline per attivare questi avvisi. Se non lo hai richiesto, ignora questo messaggio.',
		code_subject: 'Il tuo codice {site}: {code}',
		telegram_linked:
			'Fatto! Riceverai un avviso qui quando qualcuno ti invia un messaggio in chat su {site}.'
	},
	pl: {
		notice:
			'Ktoś właśnie wysłał Ci wiadomość na czacie w {site}. Otwórz ją tutaj, aby przeczytać i odpowiedzieć: {link}',
		notice_subject: 'Nowa wiadomość na czacie w {site}',
		code: 'Twój kod {site} to {code}. Wpisz go w Ustawienia → Powiadomienia offline, aby włączyć te powiadomienia. Jeśli o niego nie prosiłeś, zignoruj tę wiadomość.',
		code_subject: 'Twój kod {site}: {code}',
		telegram_linked:
			'Gotowe! Dostaniesz tu powiadomienie, gdy ktoś wyśle Ci wiadomość na czacie w {site}.'
	},
	ru: {
		notice:
			'Кто-то только что отправил вам сообщение в чате на {site}. Откройте его здесь, чтобы прочитать и ответить: {link}',
		notice_subject: 'Новое сообщение в чате на {site}',
		code: 'Ваш код {site}: {code}. Введите его в разделе Настройки → Уведомления вне сайта, чтобы включить эти уведомления. Если вы его не запрашивали, просто проигнорируйте это сообщение.',
		code_subject: 'Ваш код {site}: {code}',
		telegram_linked:
			'Готово! Вы получите здесь уведомление, когда кто-то отправит вам сообщение в чате на {site}.'
	},
	fa: {
		notice:
			'کسی همین الان در {site} برای شما پیام گفتگو فرستاد. برای خواندن و پاسخ دادن، آن را اینجا باز کنید: {link}',
		notice_subject: 'پیام گفتگوی تازه در {site}',
		code: 'کد {site} شما {code} است. آن را در تنظیمات ← اعلان‌های آفلاین وارد کنید تا این اعلان‌ها روشن شوند. اگر آن را درخواست نکرده‌اید، این پیام را نادیده بگیرید.',
		code_subject: 'کد {site} شما: {code}',
		telegram_linked:
			'انجام شد! هر وقت کسی در {site} برای شما پیام گفتگو بفرستد، اینجا اعلانی دریافت می‌کنید.'
	},
	'zh-CN': {
		notice: '有人刚刚在 {site} 上给你发了一条聊天消息。在这里打开阅读并回复：{link}',
		notice_subject: '{site} 上有新的聊天消息',
		code: '你的 {site} 验证码是 {code}。请在 设置 → 离线通知 中输入它，开启这些提醒。如果不是你本人申请的，请忽略这条消息。',
		code_subject: '你的 {site} 验证码：{code}',
		telegram_linked: '完成！以后有人在 {site} 上给你发聊天消息时，你会在这里收到提醒。'
	},
	'zh-HK': {
		notice: '有人剛剛在 {site} 傳送了一條聊天訊息給你。請在這裡打開閱讀並回覆：{link}',
		notice_subject: '{site} 上有新的聊天訊息',
		code: '你的 {site} 驗證碼是 {code}。請在 設定 → 離線通知 中輸入它，開啟這些提醒。如果不是你本人申請的，請忽略這條訊息。',
		code_subject: '你的 {site} 驗證碼：{code}',
		telegram_linked: '完成！以後有人在 {site} 傳送聊天訊息給你時，你會在這裡收到提醒。'
	}
};

export const NOTICE_LOCALES = Object.keys(STRINGS) as readonly NoticeLocale[];

function pick(locale: string): Strings {
	return (STRINGS as Record<string, Strings>)[locale] ?? STRINGS.en;
}

/** One line, no control characters: what may stand for {site}. */
export function cleanSiteName(name: string): string {
	return name
		.replace(/[\u0000-\u001f\u007f]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 64);
}

export function render(
	locale: string,
	key: keyof Strings,
	vars: { site: string; link?: string; code?: string }
): string {
	const site = cleanSiteName(vars.site);
	return pick(locale)[key].replace(/\{(site|link|code)\}/g, (_m, k: 'site' | 'link' | 'code') =>
		k === 'site' ? site : (vars[k] ?? '')
	);
}
