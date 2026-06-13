#!/usr/bin/env python3
"""Inject the missing block_explorer FAQ Q/A across 10 locales.
Translations from Batch K transcript.

NOTE: This is a SPENT one-off migration. Its keys are already present in the
locale files; re-running it would overwrite them (including any later
translator revisions). Kept only as a record of how the keys were added.
"""
import json
from pathlib import Path

# Repo root is two levels up from this script (scripts/ -> repo root).
ROOT = Path(__file__).resolve().parent.parent / "apps/web/src/lib/i18n/locales"

DATA = {
    "en": {
        "q": "Is there a block explorer for Morphit?",
        "a": "Yes — visit /explorer to look up any Blurt account, transaction, or block. The explorer is public and works without an account. Completed trades on Morphit are visible there with rich Morphit-aware decoration on each operation. For BTC and XMR transactions, Morphit links out to the appropriate external explorer (mempool.space for Bitcoin, xmrchain.net for Monero).",
    },
    "es": {
        "q": "¿Hay un explorador de bloques para Morphit?",
        "a": "Sí — visita /explorer para buscar cualquier cuenta, transacción o bloque de Blurt. El explorador es público y funciona sin cuenta. Las operaciones completadas en Morphit son visibles allí con decoración rica específica de Morphit en cada operación. Para transacciones BTC y XMR, Morphit enlaza al explorador externo apropiado (mempool.space para Bitcoin, xmrchain.net para Monero).",
    },
    "fr": {
        "q": "Y a-t-il un explorateur de blocs pour Morphit ?",
        "a": "Oui — visite /explorer pour rechercher n'importe quel compte, transaction ou bloc Blurt. L'explorateur est public et fonctionne sans compte. Les échanges complétés sur Morphit y sont visibles avec une décoration riche spécifique à Morphit pour chaque opération. Pour les transactions BTC et XMR, Morphit renvoie vers l'explorateur externe approprié (mempool.space pour Bitcoin, xmrchain.net pour Monero).",
    },
    "de": {
        "q": "Gibt es einen Block-Explorer für Morphit?",
        "a": "Ja — besuche /explorer, um beliebige Blurt-Konten, -Transaktionen oder -Blöcke nachzuschlagen. Der Explorer ist öffentlich und funktioniert ohne Konto. Abgeschlossene Trades auf Morphit sind dort mit reichhaltiger Morphit-spezifischer Dekoration für jede Operation sichtbar. Für BTC- und XMR-Transaktionen verlinkt Morphit auf den passenden externen Explorer (mempool.space für Bitcoin, xmrchain.net für Monero).",
    },
    "it": {
        "q": "C'è un explorer dei blocchi per Morphit?",
        "a": "Sì — visita /explorer per cercare qualsiasi account, transazione o blocco Blurt. L'explorer è pubblico e funziona senza account. I trade completati su Morphit sono visibili lì con decorazione ricca specifica di Morphit su ogni operazione. Per le transazioni BTC e XMR, Morphit collega all'explorer esterno appropriato (mempool.space per Bitcoin, xmrchain.net per Monero).",
    },
    "pl": {
        "q": "Czy Morphit ma eksplorator bloków?",
        "a": "Tak — odwiedź /explorer, aby wyszukać dowolne konto, transakcję lub blok Blurt. Eksplorator jest publiczny i działa bez konta. Zrealizowane transakcje na Morphit są tam widoczne z bogatą dekoracją specyficzną dla Morphit przy każdej operacji. Dla transakcji BTC i XMR Morphit linkuje do odpowiedniego zewnętrznego eksploratora (mempool.space dla Bitcoin, xmrchain.net dla Monero).",
    },
    "ru": {
        "q": "Есть ли у Morphit обозреватель блоков?",
        "a": "Да — открой /explorer, чтобы найти любой Blurt-аккаунт, транзакцию или блок. Обозреватель публичный, работает без аккаунта. Завершённые сделки на Morphit отображаются с расширенной Morphit-специфичной декорацией каждой операции. Для транзакций BTC и XMR Morphit ссылается на соответствующий внешний обозреватель (mempool.space для Bitcoin, xmrchain.net для Monero).",
    },
    "fa": {
        "q": "آیا Morphit کاوشگر بلاک دارد؟",
        "a": "بله — به /explorer برو تا هر حساب، تراکنش یا بلاک Blurt را پیدا کنی. کاوشگر عمومی است و بدون حساب کار می‌کند. معاملات تکمیل‌شده در Morphit با تزئین Morphit-آگاه برای هر عملیات قابل مشاهده هستند. برای تراکنش‌های BTC و XMR، Morphit به کاوشگر خارجی مناسب لینک می‌دهد (mempool.space برای بیت‌کوین، xmrchain.net برای مونرو).",
    },
    "zh-CN": {
        "q": "Morphit 有区块浏览器吗?",
        "a": "有 — 访问 /explorer 可以查找任何 Blurt 账户、交易或区块。浏览器是公开的,无需账户即可使用。Morphit 上的已完成交易在那里可见,每个操作都有 Morphit 特定的丰富装饰。对于 BTC 和 XMR 交易,Morphit 链接到适当的外部浏览器(mempool.space 用于比特币,xmrchain.net 用于门罗币)。",
    },
    "zh-HK": {
        "q": "Morphit 有區塊瀏覽器嗎?",
        "a": "有 — 存取 /explorer 可以查找任何 Blurt 帳號、交易或區塊。瀏覽器是公開的,無需帳號即可使用。Morphit 上的已完成交易在那裡可見,每個操作都有 Morphit 特定的豐富裝飾。對於 BTC 和 XMR 交易,Morphit 連結到適當的外部瀏覽器(mempool.space 用於比特幣,xmrchain.net 用於門羅幣)。",
    },
}

for locale, qa in DATA.items():
    path = ROOT / f"{locale}.json"
    with open(path) as f:
        d = json.load(f)
    d.setdefault("faq", {}).setdefault("entries", {})["block_explorer"] = qa
    with open(path, "w") as f:
        json.dump(d, f, ensure_ascii=False, indent="\t")
        f.write("\n")
    print(f"  + {locale}")
print("done")
