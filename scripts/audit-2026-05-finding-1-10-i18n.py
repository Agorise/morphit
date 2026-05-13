#!/usr/bin/env python3
"""Audit 2026-05 finding 1-10: add typed-error i18n keys."""
import json
from pathlib import Path

ROOT = Path("/home/claude/morphit/apps/web/src/lib/i18n/locales")

NEW_KEYS = {
    "en": {
        "login.unlock.envelope_corrupt": "Your stored keystore appears damaged. Re-import from your seed or keyfile.",
        "login.unlock.yubikey_required": "This keystore is locked to a hardware key. Use Unlock with YubiKey.",
        "login.unlock.unsupported_envelope": "This keystore was created by a newer version of Morphit. Update before unlocking.",
        "login.unlock.generic_error": "Unable to unlock right now. Try again, or sign in with your seed.",
    },
    "es": {
        "login.unlock.envelope_corrupt": "Tu llavero almacenado parece dañado. Vuelve a importarlo desde tu semilla o archivo de claves.",
        "login.unlock.yubikey_required": "Este llavero está bloqueado con una llave de hardware. Usa Desbloquear con YubiKey.",
        "login.unlock.unsupported_envelope": "Este llavero fue creado por una versión más reciente de Morphit. Actualiza antes de desbloquear.",
        "login.unlock.generic_error": "No se puede desbloquear ahora. Inténtalo de nuevo o inicia sesión con tu semilla.",
    },
    "fr": {
        "login.unlock.envelope_corrupt": "Votre trousseau semble endommagé. Réimporte-le depuis ta phrase de récupération ou fichier de clé.",
        "login.unlock.yubikey_required": "Ce trousseau est verrouillé sur une clé matérielle. Utilise Déverrouiller avec YubiKey.",
        "login.unlock.unsupported_envelope": "Ce trousseau a été créé par une version plus récente de Morphit. Mets à jour avant de déverrouiller.",
        "login.unlock.generic_error": "Impossible de déverrouiller pour le moment. Réessaie ou connecte-toi avec ta phrase.",
    },
    "de": {
        "login.unlock.envelope_corrupt": "Dein gespeicherter Schlüsselbund scheint beschädigt. Importiere ihn aus deinem Seed oder Keyfile neu.",
        "login.unlock.yubikey_required": "Dieser Schlüsselbund ist an einen Hardware-Schlüssel gebunden. Nutze „Mit YubiKey entsperren\".",
        "login.unlock.unsupported_envelope": "Dieser Schlüsselbund wurde mit einer neueren Morphit-Version erstellt. Aktualisiere vor dem Entsperren.",
        "login.unlock.generic_error": "Entsperren derzeit nicht möglich. Versuche es erneut oder melde dich mit Seed an.",
    },
    "it": {
        "login.unlock.envelope_corrupt": "Il tuo keystore archiviato sembra danneggiato. Reimportalo dal seed o dal file chiave.",
        "login.unlock.yubikey_required": "Questo keystore è bloccato su una chiave hardware. Usa Sblocca con YubiKey.",
        "login.unlock.unsupported_envelope": "Questo keystore è stato creato da una versione più recente di Morphit. Aggiorna prima di sbloccare.",
        "login.unlock.generic_error": "Impossibile sbloccare ora. Riprova o accedi con il seed.",
    },
    "pl": {
        "login.unlock.envelope_corrupt": "Twój zapisany keystore wydaje się uszkodzony. Zaimportuj go ponownie z seeda lub pliku klucza.",
        "login.unlock.yubikey_required": "Ten keystore jest zablokowany kluczem sprzętowym. Użyj Odblokuj z YubiKey.",
        "login.unlock.unsupported_envelope": "Ten keystore został utworzony przez nowszą wersję Morphit. Zaktualizuj przed odblokowaniem.",
        "login.unlock.generic_error": "Nie można teraz odblokować. Spróbuj ponownie lub zaloguj się z seedem.",
    },
    "ru": {
        "login.unlock.envelope_corrupt": "Сохранённое хранилище повреждено. Импортируй заново из сид-фразы или файла ключа.",
        "login.unlock.yubikey_required": "Это хранилище привязано к аппаратному ключу. Используй Разблокировать с YubiKey.",
        "login.unlock.unsupported_envelope": "Это хранилище создано более новой версией Morphit. Обнови приложение перед разблокировкой.",
        "login.unlock.generic_error": "Разблокировка сейчас невозможна. Попробуй снова или войди по сид-фразе.",
    },
    "fa": {
        "login.unlock.envelope_corrupt": "کلید نگهداری ذخیره شده آسیب دیده است. از سید یا فایل کلید دوباره وارد کن.",
        "login.unlock.yubikey_required": "این کلید نگهداری به کلید سخت‌افزاری قفل شده است. از باز کردن با YubiKey استفاده کن.",
        "login.unlock.unsupported_envelope": "این کلید نگهداری با نسخه جدیدتر Morphit ساخته شده. قبل از باز کردن، به‌روزرسانی کن.",
        "login.unlock.generic_error": "اکنون امکان باز کردن نیست. دوباره تلاش کن یا با سید وارد شو.",
    },
    "zh-CN": {
        "login.unlock.envelope_corrupt": "你存储的密钥库似乎已损坏。请从助记词或密钥文件重新导入。",
        "login.unlock.yubikey_required": "此密钥库已锁定到硬件密钥。请使用 YubiKey 解锁。",
        "login.unlock.unsupported_envelope": "此密钥库由较新版本的 Morphit 创建。请在解锁前更新。",
        "login.unlock.generic_error": "目前无法解锁。请重试或使用助记词登录。",
    },
    "zh-HK": {
        "login.unlock.envelope_corrupt": "你儲存的金鑰庫似乎已損壞。請從助記詞或金鑰檔案重新匯入。",
        "login.unlock.yubikey_required": "此金鑰庫已鎖定到硬體金鑰。請使用 YubiKey 解鎖。",
        "login.unlock.unsupported_envelope": "此金鑰庫由較新版本的 Morphit 建立。請在解鎖前更新。",
        "login.unlock.generic_error": "目前無法解鎖。請重試或使用助記詞登入。",
    },
}


def expand_dotted(flat):
    out = {}
    for top, val in flat.items():
        parts = top.split(".")
        c = out
        for p in parts[:-1]:
            c = c.setdefault(p, {})
        c[parts[-1]] = val
    return out


def deep_merge(dst, src):
    for k, v in src.items():
        if isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = v


def list_keys(d, prefix=""):
    out = []
    if isinstance(d, dict):
        for k, v in d.items():
            p = f"{prefix}.{k}" if prefix else k
            if isinstance(v, dict):
                out.extend(list_keys(v, p))
            else:
                out.append(p)
    return out


for loc in ["en", "es", "fr", "de", "it", "pl", "ru", "fa", "zh-CN", "zh-HK"]:
    p = ROOT / f"{loc}.json"
    d = json.load(open(p))
    before = len(list_keys(d))
    deep_merge(d, expand_dotted(NEW_KEYS[loc]))
    after = len(list_keys(d))
    with open(p, "w") as f:
        json.dump(d, f, ensure_ascii=False, indent="\t")
        f.write("\n")
    print(f"{loc}: {before} -> {after} (+{after - before})")

# Drift check
counts = {}
for loc in ["en", "es", "fr", "de", "it", "pl", "ru", "fa", "zh-CN", "zh-HK"]:
    counts[loc] = len(list_keys(json.load(open(ROOT / f"{loc}.json"))))
print("counts:", counts)
print("drift:", "OK" if all(c == counts["en"] for c in counts.values()) else "MISMATCH")
