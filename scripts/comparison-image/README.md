# Comparison image build script

Builds the Morphit-vs-competitors comparison table.

## Run

```bash
apt-get install pngquant cairosvg-cli   # or: pip install cairosvg --break-system-packages
python3 scripts/comparison-image/build_comparison.py
```

This writes:

- `scripts/comparison-image/comparison.svg` — vector source, hand-inspectable.
- `apps/web/static/morphit-comparison.png` — the canonical PNG served at
  `https://morphit.io/morphit-comparison.png` so blog posts and external
  sites can hot-link a single, always-fresh URL.

## File-size budget — under 512 KB, ALWAYS

The PNG is 2400 pixels wide × ~9,155 pixels tall. At full-quality
lossless RGB it would be 4–5 MB; cairosvg alone produces ~1.3 MB.
Both are too heavy for blog hot-linking.

The build script **always** post-processes the PNG with `pngquant`
(`--quality=70-90 --speed=1`) which drops the size to ~465 KB —
visually indistinguishable from the source at this DPI, including
the green-heart emoji and the wordmark gradient.

If `pngquant` is not installed, the build script **fails loudly**
rather than silently committing the heavier PNG. The
`comparison-image-freshness-smoke` ALSO asserts the budget at CI
time (invariant #10), so a forgotten optimization can't sneak past
review.

If a future SVG edit introduces enough new visual complexity that
pngquant at quality 70-90 can't fit under 512 KB, the smoke fails
with an actionable message. Options at that point: (a) reduce
visual complexity (fewer distinct colors / gradients), (b) consider
splitting into multiple images, (c) negotiate a wider budget with
the team and update both this README and the smoke.

## Why both formats?

- **SVG** is the source of truth — easy diffs in code review.
- **PNG** is what external pages embed. Cairo rasterises emoji
  (notably the 💚 green heart) via Noto Color Emoji, which would
  otherwise render as a colorless outline in some browsers. The
  PNG bakes that in, and pngquant shrinks the result without
  visible quality loss.

## Footer "As of YYYY-MM-DD"

The build script auto-stamps the footer with `date.today()` —
every run advances the date. The freshness smoke (invariant #11)
fails if the SVG's footer date is more than 7 days behind the SVG
file's mtime, which catches hand-edits that forgot to re-run the
build script.

## Wordmark — Ken's hand-placed logo

Ken integrated the Morphit wordmark into the column header in
Inkscape. The build script embeds it via two Python constants:

- `WORDMARK_DEFS` — the `<linearGradient id="id0">` block
- `WORDMARK_GROUP` — the `<g>` containing three paths

Color contract — **DO NOT SWAP**:

- `path3` → `fill:url(#id0)` → linked-circle gradient (green→teal)
- `path4` → `fill:#fefefe` → "morph" letters in **WHITE**
- `path5` → `fill:#7fed2d` → "it!" letters in **GREEN**

The freshness smoke (invariants #5–#9) enforces this structurally.

## Updating

When adding a new tradable asset, security feature, or audit milestone:

1. Edit the `SECTIONS` list at the top of `build_comparison.py`.
2. Add a row tuple `(feature_text, [m, b, h, o, s], optional_icon_id)`.
3. Verify each cell against `MORPHIT-BRAG-LIST.md` AND the competitor's
   public docs / recent independent reviews. **Never invent claims.**
4. Re-run the script. The PNG is auto-optimized and the footer
   date auto-updates.
5. Commit both the updated `comparison.svg` and the regenerated PNG.

The `comparison-image-freshness-smoke` enforces this — if the build
script, the SVG, or the brag list is touched without regenerating
the PNG, the smoke fails in CI with a one-line "run this command"
message.

## Per-platform sources (last verified 2026-05-24)

The matrix gathers facts from these public sources. If any cell looks
wrong to a reader, they can open an issue at `git.agorise.net/agorise/morphit`
and we'll either fix the claim or fix the code.

- **Bisq:** `bisq.network`, `github.com/bisq-network/bisq` (dark-mode
  PR #3152 merged 2019; multisig escrow with deposit; arbitration
  marketplace; BIP-39 seed; no I2P/Lokinet; no 2FA on the desktop
  app since each user runs their own node).
- **Haveno / RetoSwap:** `haveno.exchange`, `retoswap.com`,
  `github.com/haveno-dex/haveno` (forked from Bisq, dark mode
  inherited; 2-of-3 XMR multisig; arbitration marketplace; supports
  BTC/XMR/ETH/USDT/LTC/BCH per Koinly review; desktop-only).
- **OpenMonero:** LocalMonero-clone web app (`openmonero.co`).
  Inherits LocalMonero's 2FA settings page (TOTP). Custodial. Web
  UI, no dark mode. Multiple `.onion` and `.i2p` mirrors. Two
  custodial-wallet exploits in 12 months — see brag entry #199.
- **BasicSwap:** `basicswapdex.com`, `github.com/basicswap/basicswap`
  (Particl team; Docker-deployed; user runs full node per coin or
  uses Electrum light-wallet mode for BTC/LTC; atomic swaps via
  HTLC; no fiat; no in-app chat).
