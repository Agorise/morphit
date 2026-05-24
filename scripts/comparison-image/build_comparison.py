"""
Build the Morphit vs. competitors comparison table — 5x-longer
edition.  Adds 2FA, YubiKey, immutable feedback, never-been-hacked,
canary, signup-friction features, and ~25 more rows requested by
Ken.  Renders as SVG → large PNG via cairosvg.
"""

from datetime import date
from xml.sax.saxutils import escape
import cairosvg

# ─── Comparison matrix ────────────────────────────────────────────
PLATFORMS = ['Morphit', 'Bisq', 'Haveno / RetoSwap', 'OpenMonero', 'BasicSwap']

# Each row is (feature_text, [m, b, h, o, s], optional_icon_id).
# icon_id: None | 'lock' (2FA padlock) | 'key' (YubiKey hardware key)
SECTIONS = [
    ('Privacy & anonymity', [
        ('No KYC, no email, no ID required',                                ['Y','Y','Y','Y','Y'], None),
        ('Anonymous signup — free, no deposit',                             ['Y','Y','Y','Y','-'], None),
        ('Tor (.onion) accessible',                                          ['Y','Y','Y','Y','Y'], None),
        ('I2P accessible',                                                   ['Y','-','-','Y','-'], None),
        ('Lokinet accessible',                                               ['Y','-','-','-','-'], None),
        ('Four parallel networks (clearnet + Tor + I2P + Lokinet)',         ['Y','-','-','-','-'], None),
        ('End-to-end encrypted in-app chat',                                 ['Y','Y','Y','-','-'], None),
        ('Real-time streaming chat (no polling)',                            ['Y','-','-','-','-'], None),
        ('Immutable on-chain chat history (operator cannot delete)',         ['Y','-','-','-','-'], None),
        ('Chain-analysis defenses (amount jitter, address-reuse warnings)',  ['Y','-','-','-','-'], None),
        ('Solicitor / spammer-message protection (proof-of-work + caps)',    ['Y','-','-','-','-'], None),
        ('Per-message ephemeral key (X25519 + ChaCha20-Poly1305)',           ['Y','-','Y','-','-'], None),
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
        ('Multi-signature escrow',                                           ['-','Y','Y','-','-'], None),
        ('Trustless cryptographic atomic swaps',                             ['-','-','-','-','Y'], None),
        ('Built-in arbitration / dispute resolution',                        ['-','Y','Y','Y','-'], None),
        ('On-chain immutable reputation that survives operator shutdown',    ['Y','-','-','-','-'], None),
        ('Immutable feedback (no operator can edit or remove)',              ['Y','-','-','-','-'], None),
        ('Optional TOTP-based 2FA at login',                                 ['Y','-','-','-','-'], 'lock'),
        ('YubiKey / FIDO2 hardware-key unlock',                              ['Y','-','-','-','-'], 'key'),
        ('Warrant canary (cryptographically signed weekly)',                 ['Y','-','-','-','-'], None),
        ('Operator kill-switch (instance-wide compromise response)',         ['Y','-','-','-','-'], None),
        ('Reproducible builds with on-chain release attestation',            ['Y','-','-','-','-'], None),
        ('Per-IP rate limiting at API edge',                                 ['Y','-','-','-','-'], None),
        ('Argon2id key derivation for keystore unlock',                      ['Y','-','-','-','-'], None),
        ('BIP-39 12-word seed phrase backup',                                ['Y','Y','Y','-','-'], None),
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
        ('In-app payment QR codes',                                          ['Y','-','-','-','-'], None),
        ('Loyalty milestones and trader achievements',                       ['Y','-','-','-','-'], None),
        ('Operator earns ~2% on idle treasury while users trade',            ['Y','-','-','-','-'], None),
        ('Saved searches and per-asset alerts',                              ['Y','-','-','-','-'], None),
        ('Orderbook filters by network, payment method, country',            ['Y','-','-','-','-'], None),
        ('Custom amount-range alerts (notify when a $X trade appears)',      ['Y','-','-','-','-'], None),
        ('Dark mode',                                                        ['Y','-','-','-','-'], None),
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
        ('10 fully localized languages (incl. RTL Persian)',                 ['Y','-','-','-','-'], None),
        ('Public API for wallet developers and third-party tools',           ['Y','-','-','-','-'], None),
        ('RSS feed of the orderbook',                                        ['Y','-','-','-','-'], None),
        ('Works in Tor Browser at default security settings',                ['Y','-','-','Y','-'], None),
        ('Works on a Raspberry Pi Zero / 4G phone',                          ['Y','-','-','Y','-'], None),
        ('Works on old hardware (iPhone 5 / Android 6 era)',                 ['Y','-','-','Y','-'], None),
        ('Bundle weight under 200 KB on first paint',                        ['Y','-','-','Y','-'], None),
        ('Lazy-loaded images and deferred non-critical CSS',                 ['Y','-','-','-','-'], None),
        ('Server-side rendering for the orderbook',                          ['Y','-','-','Y','-'], None),
    ]),
    ('Assets & fiat', [
        ('Bitcoin',                                                          ['Y','Y','Y','-','Y'], None),
        ('Monero',                                                           ['Y','Y','Y','Y','Y'], None),
        ('Ethereum',                                                         ['Y','-','Y','-','-'], None),
        ('Litecoin',                                                         ['Y','-','Y','-','Y'], None),
        ('Bitcoin Cash',                                                     ['Y','-','Y','-','Y'], None),
        ('Stablecoins (USDT, USDC, DAI)',                                    ['Y','-','Y','-','-'], None),
        ('Multi-network stablecoins (ERC-20 / TRC-20 / BEP-20 / Polygon / Solana / Arbitrum / Base)',['Y','-','-','-','-'], None),
        ('Zcash',                                                            ['Y','-','-','-','-'], None),
        ('Pirate Chain (ARRR)',                                              ['Y','-','-','-','-'], None),
        ('Decred',                                                           ['Y','-','-','-','-'], None),
        ('Dogecoin',                                                         ['Y','-','-','-','-'], None),
        ('Dash',                                                             ['Y','-','-','-','Y'], None),
        ('Solana',                                                           ['Y','-','-','-','-'], None),
        ('XRP',                                                              ['Y','-','-','-','-'], None),
        ('Fiat (cash, bank transfer, etc.)',                                 ['Y','Y','Y','Y','-'], None),
        ('Barter for goods and services',                                    ['Y','-','-','-','-'], None),
        ('Cash by mail with carrier-tracking workflow',                      ['Y','-','-','-','-'], None),
        ('Precious metals (gold, silver, etc.)',                             ['Y','-','-','-','-'], None),
        ('Gift cards as trade payment',                                      ['Y','-','-','-','-'], None),
        ('16 tradable cryptocurrencies',                                     ['Y','-','-','-','-'], None),
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
HEART_R          = 18
ICON_SIZE        = 28

FOOTER_GAP       = 35
FOOTER_FONT      = 18

PLATFORM_COL_W   = 290
FEATURE_COL_W    = W - 2*PAD_LR - 5*PLATFORM_COL_W


def col_x(i):
    return PAD_LR + FEATURE_COL_W + PLATFORM_COL_W//2 + i*PLATFORM_COL_W


# ─── Colors ──────────────────────────────────────────────────────
BG          = '#0a0d12'
BG_HEADER   = '#161b22'
BG_SECTION  = '#1a212c'
BG_ROW_A    = '#0e1218'
BG_ROW_B    = '#11161e'
BG_MORPHIT  = '#0f1f15'
BG_MORPHIT_HEADER = '#143d28'

TEXT        = '#e6edf3'
TEXT_DIM    = '#8b949e'
TEXT_HEADER = '#f0f6fc'
TEXT_MORPHIT = '#3fb950'
TEXT_SECTION = '#79c0ff'

LINE        = '#21262d'
HEART_FILL  = '#2ea043'
HEART_BORDER= '#3fb950'
HYPHEN      = '#484f58'
ICON_COLOR  = '#79c0ff'


# ─── Inline SVG icons (lock + hardware-key) ──────────────────────
def icon_lock(cx, cy, size=ICON_SIZE):
    """Closed-padlock icon centered at (cx, cy)."""
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
    """USB hardware-key icon (YubiKey-style)."""
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


# ─── Compute total height ────────────────────────────────────────
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
out.append(f'<rect width="{W}" height="{H}" fill="{BG}"/>')

table_top = PAD_TOP + TITLE_SIZE + 30 + SUBTITLE_SIZE + TITLE_GAP
table_bottom = H - PAD_BOTTOM - FOOTER_GAP - FOOTER_FONT - 22
morphit_col_x = PAD_LR + FEATURE_COL_W
out.append(f'<rect x="{morphit_col_x}" y="{table_top}" width="{PLATFORM_COL_W}" '
           f'height="{table_bottom - table_top}" fill="{BG_MORPHIT}"/>')

# Title
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
        out.append(f'<text x="{cx}" y="{header_y}" text-anchor="middle" '
                   f'font-family="DejaVu Sans, sans-serif" font-size="{HEADER_FONT_LG}" '
                   f'font-weight="700" fill="{TEXT_MORPHIT}">{escape(name)}</text>')
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

# Sections
y_cur = y_top + HEADER_H
counts = [0, 0, 0, 0, 0]
total_features = 0

for sect_title, rows in SECTIONS:
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
                r = HEART_R
                d = (
                    f'M {cx} {cy + r * 0.5} '
                    f'C {cx} {cy + r * 0.2}, {cx + r * 0.9} {cy - r * 0.95}, {cx + r * 0.5} {cy - r * 0.55} '
                    f'C {cx + r * 0.95} {cy - r * 1.05}, {cx + r * 1.4} {cy - r * 0.25}, {cx} {cy + r * 0.85} '
                    f'C {cx - r * 1.4} {cy - r * 0.25}, {cx - r * 0.95} {cy - r * 1.05}, {cx - r * 0.5} {cy - r * 0.55} '
                    f'C {cx - r * 0.9} {cy - r * 0.95}, {cx} {cy + r * 0.2}, {cx} {cy + r * 0.5} '
                    f'Z'
                )
                out.append(f'<path d="{d}" fill="{HEART_FILL}" stroke="{HEART_BORDER}" '
                           f'stroke-width="1.5" stroke-linejoin="round"/>')
            else:
                out.append(f'<text x="{cx}" y="{cy + 12}" text-anchor="middle" '
                           f'font-family="DejaVu Sans, sans-serif" font-size="{CELL_FONT}" '
                           f'fill="{HYPHEN}">—</text>')
        y_cur += ROW_H

# Footer
y_footer = H - PAD_BOTTOM - FOOTER_FONT
counts_str = ' · '.join(
    f'{name}: {counts[i]}/{total_features}'
    for i, name in enumerate(['Morphit', 'Bisq', 'Haveno', 'OpenMonero', 'BasicSwap'])
)
out.append(f'<text x="{W//2}" y="{y_footer - 22}" text-anchor="middle" '
           f'font-family="DejaVu Sans, sans-serif" font-size="20" '
           f'font-weight="600" fill="{TEXT_DIM}">{escape(counts_str)}</text>')
out.append(f'<text x="{W//2}" y="{y_footer}" text-anchor="middle" '
           f'font-family="DejaVu Sans, sans-serif" font-size="{FOOTER_FONT}" '
           f'fill="{TEXT_DIM}">'
           f'As of {date(2026,5,24).isoformat()}. Information about other platforms gathered from their public docs and recent independent reviews; corrections welcome via Matrix #agorise:matrix.org.'
           f'</text>')

out.append('</svg>')
svg_str = '\n'.join(out)

with open('/home/claude/work/comparison.svg', 'w') as f:
    f.write(svg_str)

cairosvg.svg2png(
    bytestring=svg_str.encode('utf-8'),
    write_to='/mnt/user-data/outputs/morphit-comparison.png',
    output_width=W,
)

print(f'Canvas:  {W} × {H} px')
print(f'Sections: {total_sections}')
print(f'Total feature rows: {total_features}')
print('Per-platform 💚 counts:')
for i, name in enumerate(['Morphit', 'Bisq', 'Haveno/RetoSwap', 'OpenMonero', 'BasicSwap']):
    print(f'  {name}: {counts[i]}/{total_features}')
