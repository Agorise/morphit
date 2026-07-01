#!/usr/bin/env python3
# SPENT one-off migration: these keys are already in the locale files;
# re-running overwrites them (incl. later translator revisions). Kept as a record.
import json, os, sys
from pathlib import Path
# Repo root is two levels up from this script (scripts/ -> repo root).
LOCALE_DIR = str(Path(__file__).resolve().parent.parent / "apps/web/src/lib/i18n/locales")

IDENTITY_MISMATCH = {
    "en": "Couldn't sign — your account session looks out of sync. Sign out, then sign back in to fix this.",
    "es": "No se pudo firmar — la sesión de tu cuenta parece desincronizada. Cierra sesión y vuelve a iniciarla.",
    "fr": "Signature impossible — la session de ton compte semble désynchronisée. Déconnecte-toi puis reconnecte-toi.",
    "de": "Signieren fehlgeschlagen — deine Kontositzung scheint nicht synchron zu sein. Melde dich ab und wieder an.",
    "it": "Impossibile firmare — la sessione del tuo account sembra non sincronizzata. Esci e accedi di nuovo.",
    "pl": "Nie udało się podpisać — sesja Twojego konta jest niezsynchronizowana. Wyloguj się i zaloguj ponownie.",
    "ru": "Не удалось подписать — сессия аккаунта рассинхронизирована. Выйдите и войдите заново.",
    "fa": "امضا انجام نشد — جلسه حسابتان همگام نیست. خارج شوید و دوباره وارد شوید.",
    "zh-CN": "签名失败——账户会话不同步。请退出后重新登录。",
    "zh-HK": "簽署失敗——帳戶工作階段不同步。請登出後重新登入。",
}

TAG_RESERVED = {
    "en": "That tag is reserved for the Morphit project. Please choose a different tag.",
    "es": "Ese identificador está reservado para el proyecto Morphit. Por favor, elige otro.",
    "fr": "Cet identifiant est réservé au projet Morphit. Choisis-en un autre.",
    "de": "Dieser Tag ist für das Morphit-Projekt reserviert. Bitte wähle einen anderen.",
    "it": "Quel tag è riservato al progetto Morphit. Scegli un tag diverso.",
    "pl": "Ten tag jest zastrzeżony dla projektu Morphit. Wybierz inny.",
    "ru": "Этот тег зарезервирован для проекта Morphit. Пожалуйста, выберите другой.",
    "fa": "این برچسب برای پروژه‌ی Morphit رزرو شده است. لطفاً برچسب دیگری انتخاب کنید.",
    "zh-CN": "该标签已为 Morphit 项目保留。请选择其他标签。",
    "zh-HK": "該標籤已為 Morphit 專案保留。請選擇其他標籤。",
}

for f in sorted(os.listdir(LOCALE_DIR)):
    if not f.endswith(".json"): continue
    code = f[:-5]
    path = os.path.join(LOCALE_DIR, f)
    with open(path) as fh: d = json.load(fh)
    d.setdefault("crypto", {}).setdefault("error", {})["identity_mismatch"] = IDENTITY_MISMATCH[code]
    if "run_a_node" in d and "register" in d["run_a_node"]:
        d["run_a_node"]["register"]["err_tag_reserved"] = TAG_RESERVED[code]
    with open(path, "w") as fh:
        json.dump(d, fh, ensure_ascii=False, indent="\t")
        fh.write("\n")
    print(f"  + {code}")
print("done")
