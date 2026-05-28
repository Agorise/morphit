"""
Build the Morphit vs. competitors comparison table.

Renders an SVG (with real 💚 green-heart emoji via Noto Color Emoji)
then converts to a large PNG via cairosvg.

Output:
  - SVG: scripts/comparison-image/comparison.svg (in the repo)
  - PNG: apps/web/static/morphit-comparison.png (served publicly so
    blog posts can hot-link a stable URL like
    https://morphit.io/morphit-comparison.png)

Run:
  python3 scripts/comparison-image/build_comparison.py
"""

from datetime import date
from pathlib import Path
from xml.sax.saxutils import escape
import shutil
import subprocess
import sys
import hashlib
import cairosvg


# ─── Embedded Morphit wordmark (Ken's edit, preserved verbatim) ──
# This SVG fragment was hand-placed into the column header by Ken
# in Inkscape and lives at x≈894, y≈282 in the 2400x9155 viewBox.
# The wordmark is composed of three paths:
#   - path3 ("fil0", filled with linearGradient id="id0"):
#       the two linked circles (green→teal gradient).
#   - path4 ("fil1", filled with #fefefe):
#       the WHITE letters "morph".
#   - path5 ("fil2", filled with #7fed2d):
#       the GREEN letters "it!".
# DO NOT change those fills or the order of paths.  The build
# script injects this block verbatim, plus the linearGradient
# `<defs>` it references.
WORDMARK_DEFS = """<linearGradient
       id="id0"
       gradientUnits="userSpaceOnUse"
       x1="0"
       y1="369.47"
       x2="1089.5"
       y2="369.47">
   <stop
   offset="0"
   style="stop-opacity:1; stop-color:#8EEF26"
   id="stop1" />

   <stop
   offset="0.501961"
   style="stop-opacity:1; stop-color:#00DA69"
   id="stop2" />

   <stop
   offset="1"
   style="stop-opacity:1; stop-color:#02A6B2"
   id="stop3" />

  </linearGradient>"""

WORDMARK_GROUP = """<g
     id="_1197533152"
     style="clip-rule:evenodd;fill-rule:evenodd;image-rendering:optimizeQuality;shape-rendering:geometricPrecision;text-rendering:geometricPrecision"
     transform="matrix(0.05576732,0,0,0.05576732,894.76928,282.47195)">
   <path
   class="fil0"
   d="m 545,74 c 25,-16 52,-29 81,-39 35,-12 72,-18 111,-18 97,0 185,39 249,103 64,64 103,152 103,249 0,98 -39,186 -103,250 -64,63 -152,103 -249,103 -39,0 -76,-6 -111,-18 -29,-10 -56,-23 -81,-39 -25,16 -52,29 -81,39 -35,12 -73,18 -112,18 C 255,722 167,682 103,619 39,555 0,467 0,369 0,272 39,184 103,120 167,56 255,17 352,17 c 39,0 77,6 112,18 29,10 56,23 81,39 z m 101,22 c -18,5 -34,13 -50,22 9,11 18,24 25,38 12,25 20,55 20,85 0,31 -8,61 -21,87 -14,27 -33,50 -57,68 -16,12 -28,27 -37,45 -9,17 -13,36 -13,57 0,20 5,40 13,57 9,18 22,33 38,45 v 0 c 0,0 0,0 0,0 24,19 52,33 82,43 28,10 59,15 91,15 80,0 152,-32 204,-85 52,-52 84,-124 84,-204 0,-79 -32,-151 -84,-203 -52,-53 -124,-85 -204,-85 -32,0 -63,5 -91,15 z m -101,17 v 0 l -14,18 z m 0,513 1,-2 z m -101,17 c 17,-6 34,-13 50,-22 -10,-11 -18,-24 -25,-37 -13,-26 -20,-55 -20,-86 0,-31 7,-59 19,-85 14,-27 33,-50 56,-68 v 0 c 17,-12 30,-28 39,-46 9,-17 14,-37 14,-58 0,-20 -5,-40 -14,-57 -9,-18 -22,-33 -38,-45 h 1 C 501,120 473,106 444,96 415,86 385,81 352,81 273,81 201,113 149,166 96,218 64,290 64,369 c 0,80 32,152 85,204 52,53 124,85 203,85 33,0 63,-5 92,-15 z M 352,124 c 18,0 33,15 33,33 0,17 -15,32 -33,32 -15,0 -29,1 -43,5 -14,3 -28,8 -41,15 -5,3 -10,6 -14,9 -5,3 -9,6 -14,10 -5,4 -9,7 -13,11 -3,3 -7,7 -11,12 -8,9 -15,18 -20,28 -6,10 -11,20 -15,31 -5,17 -24,26 -40,20 -17,-6 -26,-24 -20,-41 5,-15 12,-29 19,-42 8,-14 18,-27 28,-38 4,-5 9,-10 15,-16 6,-6 12,-11 17,-15 6,-5 12,-9 19,-14 6,-4 13,-8 20,-11 17,-9 35,-17 55,-21 19,-5 38,-8 58,-8 z M 110,405 c -2,-18 10,-34 27,-36 18,-3 34,9 36,27 2,11 5,22 8,33 4,10 9,20 14,30 9,16 4,35 -11,44 -16,9 -35,4 -44,-12 -7,-13 -14,-27 -19,-42 -5,-14 -9,-29 -11,-44 z"
   id="path3"
   style="fill:url(#id0)" />

   <path
   class="fil1"
   d="m 1491,540 c 0,12 -4,23 -13,32 -9,9 -20,13 -32,13 h -1 c -12,0 -23,-4 -32,-13 -9,-9 -13,-20 -13,-32 V 334 c 0,-50 17,-92 52,-128 36,-35 78,-52 128,-52 59,0 104,19 134,59 30,-40 75,-59 134,-59 50,0 92,17 128,52 35,36 52,78 52,128 v 206 c 0,12 -4,23 -13,32 -9,9 -19,13 -32,13 h -1 c -12,0 -23,-4 -31,-13 -9,-9 -14,-20 -14,-32 V 334 c 0,-25 -8,-46 -26,-63 -17,-17 -38,-26 -63,-26 -24,0 -45,9 -62,26 -17,17 -26,38 -26,63 v 206 c 0,12 -5,23 -14,32 -8,9 -19,13 -31,13 h -1 c -13,0 -23,-4 -32,-13 -9,-9 -14,-20 -14,-32 V 334 c 0,-25 -8,-46 -26,-63 -17,-17 -38,-26 -62,-26 -25,0 -45,9 -63,26 -17,17 -26,38 -26,63 z m 817,-294 c -35,0 -64,12 -88,36 -24,25 -36,54 -36,88 0,35 12,64 36,88 24,24 53,36 88,36 34,0 63,-12 88,-36 24,-24 36,-53 36,-88 0,-34 -12,-63 -36,-88 -25,-24 -54,-36 -88,-36 z m 0,-92 c 59,0 110,21 152,63 43,42 64,93 64,152 0,60 -21,111 -64,153 -42,42 -93,63 -152,63 -59,0 -110,-21 -153,-63 -42,-42 -63,-93 -63,-153 0,-59 21,-110 63,-152 43,-42 94,-63 153,-63 z m 466,0 c 12,0 23,4 32,13 9,9 13,20 13,32 v 1 c 0,12 -4,23 -13,32 -9,9 -20,13 -32,13 h -22 c -20,0 -37,7 -52,22 -14,14 -21,31 -21,52 v 221 c 0,12 -4,23 -13,32 -9,9 -20,13 -32,13 h -1 c -13,0 -23,-4 -32,-13 -9,-9 -14,-20 -14,-32 V 319 c 1,-46 17,-85 49,-117 32,-32 71,-48 116,-48 z m 271,338 c 35,0 64,-12 88,-36 24,-24 36,-53 36,-87 0,-35 -12,-64 -36,-89 -24,-23 -53,-35 -88,-35 -34,0 -63,12 -88,35 -24,25 -36,54 -36,89 0,34 12,63 36,87 25,24 54,36 88,36 z m -170,247 c -12,0 -23,-5 -32,-13 -9,-10 -13,-20 -13,-32 V 369 c 0,-60 21,-111 63,-153 42,-41 93,-62 152,-62 60,0 111,21 153,63 42,42 63,93 63,152 0,60 -21,111 -63,153 -42,42 -93,63 -153,63 -54,0 -95,-13 -124,-37 v 146 c 0,12 -4,22 -13,32 -9,8 -20,13 -32,13 z M 3371,0 c 13,0 23,4 32,13 9,9 14,20 14,32 v 131 c 19,-15 49,-22 89,-22 50,0 92,17 128,53 35,35 53,78 53,128 v 205 c 0,12 -4,23 -13,32 -9,9 -20,13 -32,13 h -1 c -13,0 -23,-4 -32,-13 -9,-9 -14,-20 -14,-32 V 335 c 0,-25 -8,-46 -26,-63 -17,-18 -38,-27 -63,-27 -25,0 -46,9 -64,27 -17,17 -25,38 -25,63 v 205 c 0,12 -5,23 -14,32 -9,9 -19,13 -32,13 h -1 c -12,0 -23,-4 -32,-13 -9,-9 -13,-20 -13,-32 V 45 c 0,-12 4,-23 13,-32 9,-9 20,-13 32,-13 z"
   id="path4"
   style="fill:#fefefe;fill-rule:nonzero" />

   <path
   class="fil2"
   d="m 3821,154 c 13,0 23,4 32,13 9,9 13,20 13,32 v 341 c 0,12 -4,23 -13,32 -9,9 -19,13 -32,13 h -1 c -12,0 -23,-4 -32,-13 -9,-9 -14,-20 -14,-32 V 199 c 0,-12 5,-23 14,-32 9,-9 20,-13 32,-13 z m 0,-49 c -15,0 -27,-5 -37,-16 -11,-10 -16,-22 -16,-37 0,-14 5,-26 16,-36 10,-11 22,-16 37,-16 14,0 26,5 36,16 11,10 16,22 16,36 0,15 -5,28 -16,37 -10,11 -22,16 -36,16 z M 4002,0 c 12,0 23,4 32,13 9,9 13,20 13,32 v 109 h 56 c 13,0 23,4 32,13 9,9 14,20 14,32 v 1 c 0,13 -5,23 -14,32 -9,9 -19,13 -32,13 h -56 v 222 c 0,8 3,14 8,19 5,5 11,7 18,7 h 30 c 13,0 23,5 32,14 9,9 14,19 14,32 v 1 c 0,12 -5,23 -14,32 -9,9 -19,13 -32,13 h -30 c -32,0 -60,-11 -83,-35 -23,-23 -35,-50 -35,-83 V 45 c 0,-12 5,-23 14,-32 9,-9 19,-13 32,-13 z m 297,267 -13,170 h -65 L 4207,267 V 45 c 0,-12 5,-23 14,-32 9,-9 20,-13 32,-13 h 1 c 12,0 23,4 32,13 9,9 13,20 13,32 z m -45,318 c -15,0 -27,-5 -38,-15 -10,-11 -15,-23 -15,-37 0,-15 5,-27 15,-37 11,-10 23,-15 38,-15 14,0 26,5 36,15 11,10 16,22 16,37 0,14 -5,27 -16,37 -10,10 -22,15 -36,15 z"
   id="path5"
   style="fill:#7fed2d;fill-rule:nonzero" />

  </g>"""


# ─── Comparison matrix ────────────────────────────────────────────
PLATFORMS = ['Morphit', 'Bisq', 'Haveno / RetoSwap', 'OpenMonero', 'BasicSwap']

# (feature_text, [m, b, h, o, s], optional_icon_id)
# icon_id: None | 'lock' (2FA padlock) | 'key' (YubiKey hardware key)
SECTIONS = [
    ('Privacy & anonymity', [
        ('No KYC, no email, no ID required',                                ['Y','Y','Y','Y','Y'], None),
        ('Anonymous signup — free, no deposit',                             ['Y','Y','Y','Y','-'], None),
        ('Tor (.onion) accessible',                                          ['Y','Y','Y','Y','Y'], None),
        ('I2P accessible',                                                   ['Y','-','-','Y','-'], None),
        ('Lokinet accessible',                                               ['Y','-','-','-','-'], None),
        ('End-to-end encrypted in-app chat',                                 ['Y','Y','Y','-','-'], None),
        ('Real-time streaming chat (no polling)',                            ['Y','-','-','-','-'], None),
        ('Immutable on-chain chat history (operator cannot delete)',         ['Y','-','-','-','-'], None),
        ('Chain-analysis defenses (amount jitter, address-reuse warnings)',  ['Y','-','-','-','-'], None),
        ('Solicitor / spammer-message protection (proof-of-work + caps)',    ['Y','-','-','-','-'], None),
        ('Per-message ephemeral key (X25519 + ChaCha20-Poly1305)',           ['Y','-','-','-','-'], None),
        ('Block explorer built in (no third-party tracking)',                ['Y','-','-','-','-'], None),
        ('No cookies, no cookie banner, nothing to consent to',              ['Y','-','-','-','-'], None),
        ('No third-party analytics or trackers',                             ['Y','-','-','-','Y'], None),
        ('No CDN — every asset served from the operator',                    ['Y','-','-','-','-'], None),
        ('No Google Fonts, no third-party font network',                     ['Y','-','-','-','-'], None),
        ('No reCAPTCHA — proof-of-work instead',                             ['Y','-','-','-','-'], None),
        ('IPs never logged at any layer',                                    ['Y','-','-','-','-'], None),
        ('No fingerprinting via canvas / WebGL / fonts',                     ['Y','-','-','-','-'], None),
        ('All env vars marked secret are validated and redacted in logs',    ['Y','-','-','-','-'], None),
        ('Encrypted nightly backups (age + rsync)',                          ['Y','-','-','-','-'], None),
    ]),
    ('Custody & trade safety', [
        ('Fully non-custodial (no platform holdings)',                       ['Y','Y','Y','-','Y'], None),
        ('Never been hacked — platform holds no funds to drain',             ['Y','-','-','-','Y'], None),
        ('Multi-signature escrow deposit required',                          ['-','Y','Y','-','-'], None),
        ('Trustless cryptographic atomic swaps',                             ['-','-','-','-','Y'], None),
        ('Third-party arbitrators for dispute resolution',                   ['-','Y','Y','Y','-'], None),
        ('On-chain immutable reputation that survives operator shutdown',    ['Y','-','-','-','-'], None),
        ('Immutable feedback (no operator can edit or remove)',              ['Y','-','-','-','-'], None),
        ('Optional TOTP-based 2FA at login',                                 ['Y','-','-','Y','-'], 'lock'),
        ('Optional YubiKey / FIDO2 hardware-key unlock',                     ['Y','-','-','-','-'], 'key'),
        ('Warrant canary (cryptographically signed weekly)',                 ['Y','-','-','-','-'], None),
        ('Operator kill-switch (instance-wide compromise response)',         ['Y','-','-','-','-'], None),
        ('Reproducible builds with on-chain release attestation',            ['Y','-','-','-','-'], None),
        ('Per-IP rate limiting at API edge',                                 ['Y','-','-','-','-'], None),
        ('Argon2id key derivation for keystore unlock',                      ['Y','-','-','-','-'], None),
        ('BIP-39 12-word seed phrase backup',                                ['Y','Y','-','-','Y'], None),
        ('Constant-time HMAC comparison (no timing oracles)',                ['Y','-','-','-','-'], None),
        ('Strict CSP (Content Security Policy) headers',                     ['Y','-','-','-','-'], None),
        ('Subresource Integrity (SRI) on every script tag',                  ['Y','-','-','-','-'], None),
        ('Public report of every fixed security finding',                    ['Y','-','-','-','-'], None),
    ]),
    ('Audits & engineering rigor', [
        ('Public audit log — every finding, every fix, every accepted risk', ['Y','-','-','-','-'], None),
        ('94-task static security audit campaign',                           ['Y','-','-','-','-'], None),
        ('Adversarial red-team narratives + STRIDE threat modeling',         ['Y','-','-','-','-'], None),
        ('Thousands of self-checking smoke tests in the source tree',        ['Y','-','-','-','-'], None),
        ('AGPL-3.0 — modified instances must publish source',                ['Y','-','-','-','-'], None),
        ('Open source under any OSI-approved license',                       ['Y','Y','Y','Y','Y'], None),
        ('42+ public Architecture Decision Records (ADRs)',                  ['Y','-','-','-','-'], None),
        ('No PHP / WordPress / XML-RPC / OAuth attack surface',              ['Y','Y','Y','-','Y'], None),
        ('Zero known unpatched CVEs in shipped dependencies',                ['Y','-','-','-','-'], None),
        ('Dependency hygiene audit documented per release',                  ['Y','-','-','-','-'], None),
        ('Public post-incident retrospectives',                              ['Y','-','-','-','-'], None),
        ('No eval(), no Function(), no dynamic code paths anywhere',         ['Y','-','-','-','-'], None),
        ('Zod-validated request bodies with bounded field lengths',          ['Y','-','-','-','-'], None),
        ('Parameterized SQL — no string concatenation queries',              ['Y','-','-','-','-'], None),
    ]),
    ('Speed & UX', [
        ('~3-second trade-listing confirmation (Blurt block time)',          ['Y','-','-','-','-'], None),
        ('Featured-trade auction system (eBay-style)',                       ['Y','-','-','-','-'], None),
        ('Anti-sniping protection on featured-trade auctions',               ['Y','-','-','-','-'], None),
        ('One-click trade relist when an order expires',                     ['Y','-','-','-','-'], None),
        ('Push notifications with in-app inbox',                             ['Y','-','-','-','-'], None),
        ('100+ interactive tooltips and inline help',                        ['Y','-','-','-','-'], None),
        ('130+ FAQ entries in 10 languages',                                 ['Y','-','-','-','-'], None),
        ('In-app payment QR codes',                                          ['Y','Y','Y','Y','-'], None),
        ('All users earn financial rewards on trading milestones',           ['Y','-','-','-','-'], None),
        ('Instance operators earn 90% of Blurt-paid listing fees',           ['Y','-','-','-','-'], None),
        ('All users earn ~2% interest on staked Blurt',                      ['Y','-','-','-','-'], None),
        ('Saved searches and per-asset alerts',                              ['Y','-','-','-','-'], None),
        ('Orderbook filters by network, payment method, country',            ['Y','-','-','-','-'], None),
        ('Custom amount-range alerts (notify when a $X trade appears)',      ['Y','-','-','-','-'], None),
        ('Dark mode',                                                        ['Y','Y','Y','-','Y'], None),
        ('Offline-first UI (orderbook viewable without network)',            ['Y','-','-','-','-'], None),
        ('Multi-device pairing via signed QR session',                       ['Y','-','-','-','-'], None),
        ('Per-trade encrypted note field',                                   ['Y','-','-','-','-'], None),
        ('Pre-trade calculator (fees, slippage, totals)',                    ['Y','-','-','-','-'], None),
    ]),
    ('Access', [
        ('Works in any modern browser (Firefox / Chromium / Safari / Edge)', ['Y','-','-','Y','-'], None),
        ('No-JavaScript fallback path',                                      ['Y','-','-','Y','-'], None),
        ('Progressive Web App (installable on iPhone & Android)',            ['Y','-','-','-','-'], None),
        ('Desktop application (Windows / Mac / Linux)',                      ['-','Y','Y','-','Y'], None),
        ('Public read-only orderbook (no signup to browse)',                 ['Y','-','-','Y','-'], None),
        ('Free signup — zero deposit required',                              ['Y','Y','Y','Y','-'], None),
        ('Self-host on a $5/month VPS or Raspberry Pi',                      ['Y','-','-','-','-'], None),
        ('Requires user to run a full node (Bitcoin / Monero / per-coin)',   ['-','Y','Y','-','Y'], None),
        ('10 fully localized languages (incl. RTL Persian)',                 ['Y','-','-','-','-'], None),
        ('Public API for wallet developers and third-party tools',           ['Y','-','-','-','-'], None),
        ('Model Context Protocol for orderbook discovery/interactivity',     ['Y','-','-','-','-'], None),
        ('RSS feed of the orderbook',                                        ['Y','-','-','-','-'], None),
        ('Works in Tor Browser at default security settings',                ['Y','-','-','Y','-'], None),
        ('Works on a Raspberry Pi Zero / 4G phone',                          ['Y','-','-','Y','-'], None),
        ('Works on old hardware (iPhone 5 / Android 6 era)',                 ['Y','-','-','Y','-'], None),
        ('Bundle weight under 200 KB on first paint',                        ['Y','-','-','Y','-'], None),
        ('Lazy-loaded images and deferred non-critical CSS',                 ['Y','-','-','-','-'], None),
        ('Server-side rendering for the orderbook',                          ['Y','-','-','Y','-'], None),
    ]),
    ('Assets & fiat', [
        ('Bitcoin (BTC)',                                                    ['Y','Y','Y','-','Y'], None),
        ('Monero (XMR)',                                                     ['Y','Y','Y','Y','Y'], None),
        ('Blurt — the chain Morphit federates over',                         ['Y','-','-','-','-'], None),
        ('Ethereum (ETH)',                                                   ['Y','-','Y','-','-'], None),
        ('Litecoin (LTC)',                                                   ['Y','-','Y','-','Y'], None),
        ('Bitcoin Cash (BCH)',                                               ['Y','-','Y','-','Y'], None),
        ('USD-pegged stablecoin support (USDT, USDC, or DAI)',               ['Y','-','Y','-','-'], None),
        ('Subs (ERC-20 / TRC-20 / BEP-20 / Polygon / Solana / Arbitrum / Base)',['Y','-','-','-','-'], None),
        ('Zcash (ZEC)',                                                      ['Y','-','-','-','-'], None),
        ('Pirate Chain (ARRR)',                                              ['Y','-','-','-','-'], None),
        ('Decred (DCR)',                                                     ['Y','-','-','-','Y'], None),
        ('Dogecoin (DOGE)',                                                  ['Y','-','-','-','Y'], None),
        ('Dash (DASH)',                                                      ['Y','-','-','-','Y'], None),
        ('Solana (SOL)',                                                     ['Y','-','-','-','-'], None),
        ('XRP (XRP)',                                                        ['Y','-','-','-','-'], None),
        ('Fiat (cash, bank transfer, etc.)',                                 ['Y','Y','Y','Y','-'], None),
        ('Barter for goods and services',                                    ['Y','-','-','-','-'], None),
        ('Cash by mail with carrier-tracking workflow',                      ['Y','-','-','-','-'], None),
        ('Precious metals (gold, silver, etc.)',                             ['Y','-','-','-','-'], None),
        ('Gift cards as trade payment',                                      ['Y','-','-','-','-'], None),
    ]),
    ('Decentralization & federation', [
        ('Federated multi-operator network with shared orderbook',           ['Y','-','-','-','-'], None),
        ('Anyone can run an instance without permission',                    ['Y','-','-','-','Y'], None),
        ('No single point of failure — survives any operator shutdown',      ['Y','-','-','-','Y'], None),
        ('Operator can earn revenue from their instance',                    ['Y','-','-','-','-'], None),
        ('Listing fee < $1 USD-equivalent',                                  ['Y','-','-','-','Y'], None),
        ('Cross-instance federation probe (auto-discovery)',                 ['Y','-','-','-','-'], None),
        ('AGPL guarantees source availability of modifications',             ['Y','-','-','-','-'], None),
        ('No central database — chain-replicated state',                     ['Y','-','-','-','Y'], None),
        ('No central API — every endpoint is operator-owned',                ['Y','-','-','-','Y'], None),
        ('Multiple instances visible on .onion, .i2p, .loki AND clearnet',   ['Y','-','-','-','-'], None),
        ('Cross-instance peer-disagreement detection',                       ['Y','-','-','-','-'], None),
    ]),
    ('Community & transparency', [
        ('Public roadmap and ADR backlog',                                   ['Y','-','-','-','-'], None),
        ('Public Matrix room — operators and users hang out together',       ['Y','-','-','-','-'], None),
        ('No NDA required to report bugs',                                   ['Y','Y','Y','Y','Y'], None),
        ('No CLA — copyright stays with contributors',                       ['Y','-','-','-','-'], None),
        ('All commits in a public Forgejo instance (no GitHub dependency)',  ['Y','-','-','-','-'], None),
        ('Public release-signing key with a verifiable provenance trail',    ['Y','-','-','-','-'], None),
        ('GPG-signed release tarballs + on-chain bundle hash manifest',      ['Y','-','-','-','-'], None),
        ('Self-auditing brag list (CI verifies every claim)',                ['Y','-','-','-','-'], None),
        ('Documentation kept in lockstep with code (paired-update rule)',    ['Y','-','-','-','-'], None),
    ]),
]


# ─── Layout constants ────────────────────────────────────────────
W                = 2400
# Raster output width for the PNG (distinct from the SVG layout
# width W).  The SVG is vector and renders crisply at any size; the
# PNG is what blogs hot-link, so it carries the 512 KB footprint
# budget (priority #4: tiny footprint).  2200px keeps every row +
# the wordmark sharp at typical blog display sizes while landing
# comfortably under budget — 2400px pushed a freshly-added row over
# 512 KB.  Bump this only if legibility at common widths suffers,
# and re-check the budget in comparison-image-freshness-smoke.
PNG_RENDER_WIDTH = 2200
PAD_LR           = 80
PAD_TOP          = 60
PAD_BOTTOM       = 50

TITLE_SIZE       = 60
SUBTITLE_SIZE    = 28
TITLE_GAP        = 70

HEADER_H         = 110
HEADER_FONT      = 30
HEADER_FONT_LG   = 38

SECTION_H        = 60
SECTION_FONT     = 28

ROW_H            = 64
ROW_FONT         = 24
CELL_FONT        = 36
HEART_FONT       = 38   # emoji size for the 💚 character
ICON_SIZE        = 28

FOOTER_GAP       = 35
FOOTER_FONT      = 18

PLATFORM_COL_W   = 290
FEATURE_COL_W    = W - 2*PAD_LR - 5*PLATFORM_COL_W


def col_x(i):
    return PAD_LR + FEATURE_COL_W + PLATFORM_COL_W//2 + i*PLATFORM_COL_W


# ─── Colors — zebra contrast pushed wider per Ken's request ─────
BG          = '#0a0d12'
BG_HEADER   = '#161b22'
BG_SECTION  = '#1a212c'
# Increased contrast between zebra A/B so the eye can follow rows:
BG_ROW_A    = '#0d1119'   # darker
BG_ROW_B    = '#161c25'   # noticeably lighter
BG_MORPHIT  = '#0f1f15'
BG_MORPHIT_HEADER = '#143d28'

TEXT        = '#e6edf3'
TEXT_DIM    = '#8b949e'
TEXT_HEADER = '#f0f6fc'
TEXT_MORPHIT = '#3fb950'
TEXT_SECTION = '#79c0ff'

LINE        = '#21262d'
HYPHEN      = '#484f58'
ICON_COLOR  = '#79c0ff'

# Stack with Noto Color Emoji first so 💚 renders as a colored bitmap
# via Cairo; fall back to DejaVu Sans for the literal Unicode glyph.
EMOJI_FONT  = 'Noto Color Emoji, Apple Color Emoji, Segoe UI Emoji, DejaVu Sans'


# ─── Inline SVG icons (2FA padlock + YubiKey) ────────────────────
def icon_lock(cx, cy, size=ICON_SIZE):
    s = size / 2.0
    body_x = cx - s
    body_y = cy - s * 0.15
    body_w = s * 2
    body_h = s * 1.45
    sh_r = s * 0.62
    sh_cx = cx
    sh_cy = body_y
    return (
        f'<g stroke="{ICON_COLOR}" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round">'
        f'<path d="M {sh_cx - sh_r} {sh_cy} L {sh_cx - sh_r} {sh_cy - sh_r*0.45} '
        f'A {sh_r} {sh_r} 0 0 1 {sh_cx + sh_r} {sh_cy - sh_r*0.45} L {sh_cx + sh_r} {sh_cy}"/>'
        f'<rect x="{body_x}" y="{body_y}" width="{body_w}" height="{body_h}" rx="3.5" ry="3.5" fill="{ICON_COLOR}" fill-opacity="0.18"/>'
        f'<circle cx="{cx}" cy="{body_y + body_h * 0.45}" r="2.5" fill="{ICON_COLOR}" stroke="none"/>'
        f'<line x1="{cx}" y1="{body_y + body_h * 0.55}" x2="{cx}" y2="{body_y + body_h * 0.85}"/>'
        f'</g>'
    )


def icon_key(cx, cy, size=ICON_SIZE):
    s = size / 2.0
    width = s * 1.05
    head_h = s * 0.7
    body_h = s * 1.55
    x = cx - width / 2
    y_head = cy - s
    y_body = y_head + head_h
    return (
        f'<g stroke="{ICON_COLOR}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round">'
        f'<rect x="{x}" y="{y_head}" width="{width}" height="{head_h}" rx="1.5" fill="{ICON_COLOR}" fill-opacity="0.20"/>'
        f'<rect x="{x - 2}" y="{y_body}" width="{width + 4}" height="{body_h}" rx="3" fill="{ICON_COLOR}" fill-opacity="0.10"/>'
        f'<line x1="{x + 3}" y1="{y_head + head_h * 0.5}" x2="{x + width - 3}" y2="{y_head + head_h * 0.5}"/>'
        f'<circle cx="{cx}" cy="{y_body + body_h - 6}" r="2" fill="{ICON_COLOR}" stroke="none"/>'
        f'</g>'
    )


ICONS = {'lock': icon_lock, 'key': icon_key}


# ─── Total height ────────────────────────────────────────────────
total_rows = sum(len(rows) for _, rows in SECTIONS)
total_sections = len(SECTIONS)

H = (PAD_TOP
     + TITLE_SIZE + 30 + SUBTITLE_SIZE + TITLE_GAP
     + HEADER_H
     + total_sections * SECTION_H
     + total_rows * ROW_H
     + FOOTER_GAP + 22 + FOOTER_FONT
     + PAD_BOTTOM)


# ─── Render SVG ──────────────────────────────────────────────────
out = []
out.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
# Inject Ken's linearGradient defs (the green→teal gradient used by the
# wordmark's linked-circle motif).  See WORDMARK_DEFS constant above.
out.append(f'<defs>{WORDMARK_DEFS}</defs>')
out.append(f'<rect width="{W}" height="{H}" fill="{BG}"/>')

table_top = PAD_TOP + TITLE_SIZE + 30 + SUBTITLE_SIZE + TITLE_GAP
table_bottom = H - PAD_BOTTOM - FOOTER_GAP - FOOTER_FONT - 22
morphit_col_x = PAD_LR + FEATURE_COL_W
out.append(f'<rect x="{morphit_col_x}" y="{table_top}" width="{PLATFORM_COL_W}" '
           f'height="{table_bottom - table_top}" fill="{BG_MORPHIT}"/>')

# Title block
y = PAD_TOP + TITLE_SIZE
out.append(f'<text x="{W//2}" y="{y}" text-anchor="middle" '
           f'font-family="DejaVu Sans, sans-serif" font-size="{TITLE_SIZE}" '
           f'font-weight="700" fill="{TEXT_HEADER}">'
           f'P2P Cryptocurrency Marketplaces — feature-by-feature</text>')
y += 35 + SUBTITLE_SIZE - 8
out.append(f'<text x="{W//2}" y="{y}" text-anchor="middle" '
           f'font-family="DejaVu Sans, sans-serif" font-size="{SUBTITLE_SIZE}" '
           f'font-weight="400" fill="{TEXT_DIM}">'
           f'Every project here is doing important work for cryptocurrency freedom. '
           f'This table just shows where each one shines.</text>')

# Table header
y_top = table_top
out.append(f'<rect x="{PAD_LR}" y="{y_top}" width="{W - 2*PAD_LR}" '
           f'height="{HEADER_H}" fill="{BG_HEADER}"/>')
out.append(f'<rect x="{morphit_col_x}" y="{y_top}" width="{PLATFORM_COL_W}" '
           f'height="{HEADER_H}" fill="{BG_MORPHIT_HEADER}"/>')

header_y = y_top + HEADER_H//2 + HEADER_FONT//3
out.append(f'<text x="{PAD_LR + 30}" y="{header_y}" '
           f'font-family="DejaVu Sans, sans-serif" font-size="{HEADER_FONT}" '
           f'font-weight="700" fill="{TEXT_DIM}">Feature</text>')

for i, name in enumerate(PLATFORMS):
    cx = col_x(i)
    if i == 0:
        # Morphit column header: inject Ken's hand-placed wordmark
        # (linked green circles + "morph" in white + "it!" in green)
        # instead of plain text.  WORDMARK_GROUP positions itself
        # via its own transform matrix (x≈894, y≈282 in the 2400x9155
        # viewBox).
        out.append(WORDMARK_GROUP)
    else:
        if '/' in name:
            parts = name.split(' / ')
            line1, line2 = parts[0], parts[1]
            out.append(f'<text x="{cx}" y="{header_y - 14}" text-anchor="middle" '
                       f'font-family="DejaVu Sans, sans-serif" font-size="{HEADER_FONT}" '
                       f'font-weight="600" fill="{TEXT_HEADER}">{escape(line1)}  /</text>')
            out.append(f'<text x="{cx}" y="{header_y + 22}" text-anchor="middle" '
                       f'font-family="DejaVu Sans, sans-serif" font-size="{HEADER_FONT}" '
                       f'font-weight="600" fill="{TEXT_HEADER}">{escape(line2)}</text>')
        else:
            out.append(f'<text x="{cx}" y="{header_y}" text-anchor="middle" '
                       f'font-family="DejaVu Sans, sans-serif" font-size="{HEADER_FONT}" '
                       f'font-weight="600" fill="{TEXT_HEADER}">{escape(name)}</text>')

# Body
y_cur = y_top + HEADER_H
counts = [0, 0, 0, 0, 0]
total_features = 0

for sect_title, rows in SECTIONS:
    # Section header
    out.append(f'<rect x="{PAD_LR}" y="{y_cur}" width="{W - 2*PAD_LR}" '
               f'height="{SECTION_H}" fill="{BG_SECTION}"/>')
    sec_text_y = y_cur + SECTION_H // 2 + SECTION_FONT // 3
    out.append(f'<text x="{PAD_LR + 30}" y="{sec_text_y}" '
               f'font-family="DejaVu Sans, sans-serif" font-size="{SECTION_FONT}" '
               f'font-weight="700" fill="{TEXT_SECTION}">{escape(sect_title)}</text>')
    y_cur += SECTION_H

    for row_idx, (feat_text, marks, icon_id) in enumerate(rows):
        total_features += 1
        for plat_idx, m in enumerate(marks):
            if m == 'Y':
                counts[plat_idx] += 1
        bg_row = BG_ROW_A if row_idx % 2 == 0 else BG_ROW_B
        out.append(f'<rect x="{PAD_LR}" y="{y_cur}" width="{W - 2*PAD_LR}" '
                   f'height="{ROW_H}" fill="{bg_row}"/>')
        out.append(f'<rect x="{morphit_col_x}" y="{y_cur}" width="{PLATFORM_COL_W}" '
                   f'height="{ROW_H}" fill="{BG_MORPHIT}" fill-opacity="0.4"/>')

        feat_text_y = y_cur + ROW_H // 2 + ROW_FONT // 3
        text_x = PAD_LR + 30
        if icon_id and icon_id in ICONS:
            icon_cx = text_x + ICON_SIZE // 2
            icon_cy = y_cur + ROW_H // 2
            out.append(ICONS[icon_id](icon_cx, icon_cy))
            text_x += ICON_SIZE + 14
        out.append(f'<text x="{text_x}" y="{feat_text_y}" '
                   f'font-family="DejaVu Sans, sans-serif" font-size="{ROW_FONT}" '
                   f'fill="{TEXT}">{escape(feat_text)}</text>')

        for plat_idx, m in enumerate(marks):
            cx = col_x(plat_idx)
            cy = y_cur + ROW_H // 2
            if m == 'Y':
                # Real 💚 green-heart emoji centered in cell.
                # Cairo's emoji baseline is slightly above text baseline;
                # the +HEART_FONT/2.7 offset centers it visually.
                heart_y = cy + HEART_FONT / 2.7
                out.append(f'<text x="{cx}" y="{heart_y}" text-anchor="middle" '
                           f'font-family="{EMOJI_FONT}" font-size="{HEART_FONT}">'
                           f'\U0001F49A</text>')
            else:
                out.append(f'<text x="{cx}" y="{cy + 12}" text-anchor="middle" '
                           f'font-family="DejaVu Sans, sans-serif" font-size="{CELL_FONT}" '
                           f'fill="{HYPHEN}">—</text>')
        y_cur += ROW_H

# Footer: per-platform totals
y_footer = H - PAD_BOTTOM - FOOTER_FONT
counts_str = ' · '.join(
    f'{name}: {counts[i]}/{total_features}'
    for i, name in enumerate(['Morphit', 'Bisq', 'Haveno', 'OpenMonero', 'BasicSwap'])
)
out.append(f'<text x="{W//2}" y="{y_footer - 22}" text-anchor="middle" '
           f'font-family="DejaVu Sans, sans-serif" font-size="20" '
           f'font-weight="600" fill="{TEXT_DIM}">{escape(counts_str)}</text>')
# cp137 G-6 — determinism: derive the footer date from the brag-list
# trailer's "Last updated" date rather than `date.today()`, so a
# rebuild produces byte-identical SVG output regardless of the
# wall-clock day it ran on.  Pre-cp137 used `date.today()`, which
# meant rebuilding on a new UTC day silently changed the SVG hash
# (and therefore the .png.fingerprint sidecar).  Harmless for the
# current CI pattern (smoke compares committed bytes, doesn't
# regenerate) but a footgun if anyone ever wires
# `build_comparison.py` into CI on every push — every UTC midnight
# would fail the comparison-image-freshness smoke until somebody
# committed a fresh PNG.  Deriving from the brag-list trailer also
# means the displayed date moves only when the brag list moves,
# which is semantically what "As of X" actually means here (the
# comparison data, not today's wall clock).
def _read_brag_trailer_date(brag_path: Path) -> str:
    """Find the most-recent ISO date in the trailer line of the brag
    list.  The trailer format is canonical and pinned by the
    brag-list-trailer-invariants smoke; we look for `Last updated
    YYYY-MM-DD`.  Falls back to today() ONLY if the trailer is
    missing or malformed, with a stderr warning so the operator
    sees the regression."""
    import re
    try:
        text = brag_path.read_text(encoding='utf-8')
        m = re.search(r'Last updated (\d{4}-\d{2}-\d{2})', text)
        if m:
            return m.group(1)
        sys.stderr.write(f'WARNING: brag-list trailer "Last updated YYYY-MM-DD" not found at {brag_path}; falling back to date.today()\n')
    except OSError as e:
        sys.stderr.write(f'WARNING: cannot read brag list at {brag_path}: {e}; falling back to date.today()\n')
    return date.today().isoformat()

_brag_path = Path(__file__).resolve().parent.parent.parent / 'MORPHIT-BRAG-LIST.md'
_footer_date = _read_brag_trailer_date(_brag_path)
out.append(f'<text x="{W//2}" y="{y_footer}" text-anchor="middle" '
           f'font-family="DejaVu Sans, sans-serif" font-size="{FOOTER_FONT}" '
           f'fill="{TEXT_DIM}">'
           f'As of {_footer_date}. Information about other platforms gathered from their public docs and recent independent reviews; corrections welcome via Matrix #agorise:matrix.org.'
           f'</text>')

out.append('</svg>')
svg_str = '\n'.join(out)

# ─── Write outputs ───────────────────────────────────────────────
# 1. SVG into the repo (script-adjacent for hand-inspection)
script_dir = Path(__file__).resolve().parent
svg_path = script_dir / 'comparison.svg'
svg_path.write_text(svg_str)


# Target PNG size budget.  The image is 2400 pixels wide and ~9,155
# pixels tall — at lossless RGB it would be 4-5 MB.  We aim for under
# 512 KB so blog posts hot-linking the URL don't blow the page budget.
# pngquant @ quality 70-90 with speed=1 (slowest/best) is the right
# tradeoff: visually indistinguishable from the source at this DPI,
# but ~64% smaller.  See the comparison-image-freshness-smoke for the
# budget assertion that fails CI if a future change blows past it.
PNG_BUDGET_BYTES = 512 * 1024


def optimize_png(path: Path) -> None:
    """Shrink the PNG in-place via pngquant (palette quantization).

    Falls back to a clear error if pngquant is missing — we never
    silently ship the unoptimized 1.3 MB version.  Re-runs are
    idempotent (pngquant skips already-optimized output).
    """
    pngquant = shutil.which('pngquant')
    if pngquant is None:
        print(
            f'ERROR: pngquant is required to keep {path.name} under the '
            f'{PNG_BUDGET_BYTES // 1024} KB budget. Install it with:\n'
            f'  apt-get install pngquant     # Debian / Ubuntu\n'
            f'  brew install pngquant        # macOS\n'
            f'  pacman -S pngquant           # Arch\n',
            file=sys.stderr,
        )
        sys.exit(2)

    before = path.stat().st_size
    # --quality=70-90: pngquant will refuse the result if it can't hit
    #   the 70-quality floor, which is well above visual-distinguishability
    #   at this DPI.  --speed=1 spends more CPU finding a better palette.
    # --strip: drop ancillary chunks (timestamps, color profiles) for
    #   determinism so the same SVG produces a byte-identical PNG.
    # --force: overwrite the input in-place.
    subprocess.run(
        [
            pngquant,
            '--quality=70-90',
            '--speed=1',
            '--strip',
            '--force',
            '--output', str(path),
            str(path),
        ],
        check=True,
    )
    after = path.stat().st_size
    pct = (1 - after / before) * 100
    print(f'  optimized {path.name}: {before:,} -> {after:,} bytes ({pct:.1f}% smaller)')

    if after > PNG_BUDGET_BYTES:
        print(
            f'WARNING: {path.name} ({after:,} bytes) is over the '
            f'{PNG_BUDGET_BYTES:,}-byte budget.  This means a future SVG edit '
            f'introduced more visual complexity (more distinct colors) than '
            f'pngquant\'s palette can fit.  Investigate before committing.',
            file=sys.stderr,
        )


# 2. PNG into the public static folder so blogs can hot-link
#    https://morphit.io/morphit-comparison.png
repo_root = script_dir.parent.parent  # .../morphit
static_png = repo_root / 'apps' / 'web' / 'static' / 'morphit-comparison.png'
static_png.parent.mkdir(parents=True, exist_ok=True)
cairosvg.svg2png(
    bytestring=svg_str.encode('utf-8'),
    write_to=str(static_png),
    output_width=PNG_RENDER_WIDTH,
)
optimize_png(static_png)

# Content fingerprint sidecar (F-5 / cp137).
#
# Git checkout resets every file's mtime to checkout time in
# filesystem-walk order, so an mtime-based "PNG newer than build
# script" check is non-deterministic in CI even when the repo is
# byte-perfect.  Replace it with a content fingerprint: SHA-256 of
# the rendered SVG, written to a sidecar file the smoke can verify
# against the current SVG.  If the SVG changes without re-running
# the build, the sidecar hash mismatches → smoke fails with a clear
# "re-run build_comparison.py" message.
#
# Why hash the SVG and not the PNG itself: pngquant output can vary
# slightly between versions of the encoder, so hashing the PNG would
# trip on benign upgrades.  The SVG is deterministic from the build
# script's inputs, so hashing it precisely captures "is the output
# in-sync with the source."
svg_hash = hashlib.sha256(svg_str.encode('utf-8')).hexdigest()
fingerprint_path = static_png.with_suffix('.png.fingerprint')
fingerprint_path.write_text(svg_hash + '\n')

# 3. ALSO write to /mnt/user-data/outputs so the chat can preview it
outputs_png = Path('/mnt/user-data/outputs/morphit-comparison.png')
if outputs_png.parent.exists():
    cairosvg.svg2png(
        bytestring=svg_str.encode('utf-8'),
        write_to=str(outputs_png),
        output_width=PNG_RENDER_WIDTH,
    )
    optimize_png(outputs_png)

# ─── Stats ───────────────────────────────────────────────────────
print(f'Canvas:           {W} x {H} px')
print(f'Sections:         {total_sections}')
print(f'Feature rows:     {total_features}')
print(f'SVG:              {svg_path}')
print(f'Static PNG:       {static_png}')
print(f'Outputs PNG:      {outputs_png}')
print('Per-platform heart counts:')
for i, name in enumerate(['Morphit', 'Bisq', 'Haveno/RetoSwap', 'OpenMonero', 'BasicSwap']):
    print(f'  {name}: {counts[i]}/{total_features}')
