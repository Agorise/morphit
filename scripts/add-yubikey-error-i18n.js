#!/usr/bin/env node
// Adds new hardware_key.error.* keys to non-English locales for
// audit 2026-05 finding 7-1 hardening. Translations are
// human-quality for the target audience but written by Claude;
// project standard is to accept these as-is and treat any
// improvements as ordinary i18n edits.

const fs = require('node:fs');
const path = require('node:path');

const TRANSLATIONS = {
	es: {
		unknown: 'Algo salió mal. Inténtalo de nuevo y, si el problema persiste, recarga la página.',
		label_too_long: 'La etiqueta que has introducido es demasiado larga.',
		wrap_limit_reached: 'Este almacén ya tiene el número máximo de envoltorios YubiKey. Elimina uno antes de añadir otro.',
		duplicate_yubikey_label: 'Este almacén ya tiene un YubiKey inscrito. Elimina el existente primero para añadir uno diferente.',
		not_layered: 'Este almacén aún no está listo para operaciones de llave física. Inscribe un YubiKey primero.',
		no_yubikey_wrap: 'Este almacén no tiene ningún YubiKey inscrito.',
		wrap_index_out_of_range: 'No se encontró ese envoltorio de YubiKey. Recarga la página e inténtalo de nuevo.',
		cannot_unenroll_last_wrap: 'Eliminar esto dejaría tu almacén irrecuperable. Añade otro método de desbloqueo primero.'
	},
	fr: {
		unknown: "Une erreur est survenue. Réessayez ; si le problème persiste, rechargez la page.",
		label_too_long: "L'étiquette saisie est trop longue.",
		wrap_limit_reached: "Ce trousseau a déjà le nombre maximum d'enveloppes YubiKey. Supprimez-en une avant d'en ajouter une autre.",
		duplicate_yubikey_label: "Ce trousseau a déjà un YubiKey enregistré. Supprimez-le d'abord pour en ajouter un autre.",
		not_layered: "Ce trousseau n'est pas prêt pour les opérations de clé matérielle. Enregistrez d'abord un YubiKey.",
		no_yubikey_wrap: "Ce trousseau n'a aucun YubiKey enregistré.",
		wrap_index_out_of_range: "Cette enveloppe YubiKey est introuvable. Rechargez la page et réessayez.",
		cannot_unenroll_last_wrap: "La supprimer rendrait votre trousseau irrécupérable. Ajoutez d'abord une autre méthode de déverrouillage."
	},
	de: {
		unknown: 'Etwas ist schiefgelaufen. Versuche es erneut; falls das Problem bestehen bleibt, lade die Seite neu.',
		label_too_long: 'Die eingegebene Bezeichnung ist zu lang.',
		wrap_limit_reached: 'Dieser Schlüsselspeicher hat bereits die maximale Anzahl an YubiKey-Wraps. Entferne einen, bevor du einen weiteren hinzufügst.',
		duplicate_yubikey_label: 'Dieser Schlüsselspeicher hat bereits einen YubiKey registriert. Entferne den bestehenden, um einen anderen hinzuzufügen.',
		not_layered: 'Dieser Schlüsselspeicher ist noch nicht bereit für Hardware-Schlüsseloperationen. Registriere zuerst einen YubiKey.',
		no_yubikey_wrap: 'In diesem Schlüsselspeicher ist kein YubiKey registriert.',
		wrap_index_out_of_range: 'Dieser YubiKey-Wrap wurde nicht gefunden. Lade die Seite neu und versuche es erneut.',
		cannot_unenroll_last_wrap: 'Das Entfernen würde deinen Schlüsselspeicher unwiederbringlich machen. Füge zuerst eine andere Entsperrmethode hinzu.'
	},
	it: {
		unknown: 'Qualcosa è andato storto. Riprova; se il problema persiste, ricarica la pagina.',
		label_too_long: "L'etichetta inserita è troppo lunga.",
		wrap_limit_reached: 'Questo portachiavi ha già il numero massimo di wrap YubiKey. Rimuovine uno prima di aggiungerne un altro.',
		duplicate_yubikey_label: 'Questo portachiavi ha già un YubiKey registrato. Rimuovi quello esistente per aggiungerne un altro.',
		not_layered: 'Questo portachiavi non è pronto per le operazioni con chiave hardware. Registra prima un YubiKey.',
		no_yubikey_wrap: 'Questo portachiavi non ha alcun YubiKey registrato.',
		wrap_index_out_of_range: 'Quel wrap YubiKey non è stato trovato. Ricarica la pagina e riprova.',
		cannot_unenroll_last_wrap: 'Rimuoverlo renderebbe il tuo portachiavi irrecuperabile. Aggiungi prima un altro metodo di sblocco.'
	},
	pl: {
		unknown: 'Coś poszło nie tak. Spróbuj ponownie; jeśli problem nie ustąpi, odśwież stronę.',
		label_too_long: 'Wpisana etykieta jest za długa.',
		wrap_limit_reached: 'Ten magazyn kluczy ma już maksymalną liczbę opakowań YubiKey. Usuń jedno przed dodaniem nowego.',
		duplicate_yubikey_label: 'W tym magazynie kluczy jest już zarejestrowany YubiKey. Najpierw usuń istniejący, aby dodać inny.',
		not_layered: 'Ten magazyn kluczy nie jest jeszcze gotowy na operacje z kluczem sprzętowym. Najpierw zarejestruj YubiKey.',
		no_yubikey_wrap: 'W tym magazynie kluczy nie zarejestrowano żadnego YubiKey.',
		wrap_index_out_of_range: 'Nie znaleziono tego opakowania YubiKey. Odśwież stronę i spróbuj ponownie.',
		cannot_unenroll_last_wrap: 'Usunięcie tego sprawi, że Twój magazyn kluczy będzie nie do odzyskania. Najpierw dodaj inną metodę odblokowywania.'
	},
	ru: {
		unknown: 'Что-то пошло не так. Попробуйте ещё раз; если проблема не исчезает, перезагрузите страницу.',
		label_too_long: 'Введённая метка слишком длинная.',
		wrap_limit_reached: 'В этом хранилище уже максимальное число обёрток YubiKey. Удалите одну, прежде чем добавлять новую.',
		duplicate_yubikey_label: 'В этом хранилище уже зарегистрирован YubiKey. Сначала удалите существующий, чтобы добавить другой.',
		not_layered: 'Это хранилище ещё не готово к операциям с аппаратным ключом. Сначала зарегистрируйте YubiKey.',
		no_yubikey_wrap: 'В этом хранилище нет зарегистрированного YubiKey.',
		wrap_index_out_of_range: 'Эта обёртка YubiKey не найдена. Перезагрузите страницу и повторите попытку.',
		cannot_unenroll_last_wrap: 'Её удаление сделает хранилище невосстановимым. Сначала добавьте другой способ разблокировки.'
	},
	fa: {
		unknown: 'مشکلی پیش آمد. دوباره تلاش کنید؛ اگر مشکل ادامه داشت، صفحه را دوباره بارگذاری کنید.',
		label_too_long: 'برچسبی که وارد کرده‌اید بیش از حد طولانی است.',
		wrap_limit_reached: 'این کلیددان از قبل حداکثر تعداد بسته‌های YubiKey را دارد. قبل از افزودن یکی دیگر، یکی را حذف کنید.',
		duplicate_yubikey_label: 'این کلیددان از قبل یک YubiKey ثبت شده دارد. ابتدا موجود را حذف کنید تا بتوانید YubiKey دیگری اضافه کنید.',
		not_layered: 'این کلیددان آماده عملیات کلید سخت‌افزاری نیست. ابتدا یک YubiKey ثبت کنید.',
		no_yubikey_wrap: 'هیچ YubiKey ای در این کلیددان ثبت نشده است.',
		wrap_index_out_of_range: 'آن بسته YubiKey پیدا نشد. صفحه را دوباره بارگذاری کنید و دوباره تلاش کنید.',
		cannot_unenroll_last_wrap: 'حذف این مورد باعث می‌شود کلیددان شما غیرقابل بازیابی شود. ابتدا یک روش بازگشایی دیگر اضافه کنید.'
	},
	'zh-CN': {
		unknown: '出错了。请重试；如果问题仍然存在，请刷新页面。',
		label_too_long: '您输入的标签过长。',
		wrap_limit_reached: '此密钥库已达到 YubiKey 包装的最大数量。请先删除一个再添加新的。',
		duplicate_yubikey_label: '此密钥库已注册了 YubiKey。请先删除现有的，再添加其他 YubiKey。',
		not_layered: '此密钥库尚未准备好进行硬件密钥操作。请先注册一个 YubiKey。',
		no_yubikey_wrap: '此密钥库未注册任何 YubiKey。',
		wrap_index_out_of_range: '找不到该 YubiKey 包装。请刷新页面后重试。',
		cannot_unenroll_last_wrap: '删除此项将使您的密钥库无法恢复。请先添加其他解锁方式。'
	},
	'zh-HK': {
		unknown: '出錯了。請重試；如果問題仍然存在,請重新載入頁面。',
		label_too_long: '您輸入的標籤過長。',
		wrap_limit_reached: '此密鑰庫已達到 YubiKey 包裝的最大數量。請先刪除一個再新增新的。',
		duplicate_yubikey_label: '此密鑰庫已註冊了 YubiKey。請先刪除現有的,再新增其他 YubiKey。',
		not_layered: '此密鑰庫尚未準備好進行硬件密鑰操作。請先註冊一個 YubiKey。',
		no_yubikey_wrap: '此密鑰庫未註冊任何 YubiKey。',
		wrap_index_out_of_range: '找不到該 YubiKey 包裝。請重新載入頁面後重試。',
		cannot_unenroll_last_wrap: '刪除此項將使您的密鑰庫無法復原。請先新增其他解鎖方式。'
	}
};

const localesDir = '/home/claude/morphit/apps/web/src/lib/i18n/locales';

for (const [code, t] of Object.entries(TRANSLATIONS)) {
	const filepath = path.join(localesDir, `${code}.json`);
	const raw = fs.readFileSync(filepath, 'utf-8');
	const data = JSON.parse(raw);
	const errBlock = data.settings.hardware_key.error;
	for (const [key, value] of Object.entries(t)) {
		errBlock[key] = value;
	}
	const out = JSON.stringify(data, null, '\t') + '\n';
	fs.writeFileSync(filepath, out);
	console.log(`updated ${code}.json (+${Object.keys(t).length} keys)`);
}
