# Morphit v1.0.0-beta.13

A fast follow-up to beta.12 that fixes the one thing standing between an
operator and a genuinely unattended node, plus four front-end bugs you
would hit on day one. **Headline: the relay's systemd service now
actually starts.** beta.12 shipped the relay as a hardened, sandboxed
systemd unit — but the sandbox restricted network address families to
IPv4/IPv6 only and left out Unix domain sockets, which the TypeScript
runtime (`tsx`) needs for its own internal plumbing. The result was a
relay that crash-looped at boot with `EAFNOSUPPORT`. This release adds
`AF_UNIX` back to every affected unit, so the relay (and the MCP and
mint-acts units) come up cleanly. **Recommended for all operators**, and
especially anyone who did the beta.12 systemd migration and found the
relay wouldn't stay up. This release also folds in a comprehensive
pre-release hardening audit (details under the hood).

## Added

- **A "Forget address history" control.** Settings → Privacy now lets you
  clear the crypto addresses Morphit remembers on your device for
  autofill — it shows how many are stored and wipes them on a two-step
  confirm. That list was always local-only and never left your device;
  this just gives you a one-tap way to clear it.

## Fixed

- **The relay systemd service no longer crash-loops at startup.** The
  shipped `morphit-relay.service` (and `morphit-mcp.service`,
  `morphit-relay-mint-acts.service`) sandboxed the process to
  `AF_INET AF_INET6` and omitted `AF_UNIX`. The TypeScript runner
  communicates over a Unix domain socket internally, so that socket
  failed to open and the service never came up. All three units now
  permit `AF_UNIX`. The indexer unit was already correct and is
  unchanged.

- **Footer "Media kit" and "PGP keys" links no longer 404.** Clicking
  the media-kit (`/morphit-mediakit.zip`) or PGP-keys (`/pgp_keys.asc`)
  links — and the warrant-canary link — used to land on a blank 404 with
  a spurious language prefix in the URL. The client-side router was
  intercepting these file links and mistaking the filename for a locale.
  They now force a real browser navigation and download/open correctly.
  The same fix was applied to the corresponding links on the Security
  and "About this instance" pages.

- **Block-explorer search for an account no longer 404s.** Searching the
  explorer for an account (for example `@morphit`) used to land on a
  blank 404 because the resulting navigation dropped the active language
  prefix from the URL. Account, transaction, and block searches now keep
  the locale prefix and resolve correctly.

- **An instance's "Registered" date now shows the real date.** The
  morphit.io card on the Instances page showed `Registered: —` instead
  of the operator account's on-chain creation date. It now shows the
  real date (18 April, 2026 for @morphit). On upgrade the indexer also
  repairs any directory row that still carries the old placeholder, so
  the date appears after the next indexer start — without overwriting a
  genuine registration date for any real peer.

- **An instance no longer shows itself as "Unreachable."** The directory
  probe was firing a real HTTP request at the node's own public URL to
  decide reachability. Many deployments can't reach their own public
  address from inside the box (no hairpin NAT / loopback), so a healthy
  node reported itself `Unreachable`. The probe now recognises its own
  origin and marks it reachable locally instead of round-tripping over
  the network. Real peers are still probed exactly as before.

- **Some in-app links could land on a blank 404.** A sweep of internal
  links found 23 that were missing the active language prefix —
  including two-segment chat and order-detail links (which 404'd) and a
  dead "inbox" link with no destination. All now navigate correctly.

- **The MCP server no longer exposes a lister's fee mechanics to AI
  agents.** The read-only `get_listing` tool (used by AI agents querying
  the public orderbook over the MCP server) returned the raw owner-view
  record, which included the lister's internal fee method and status. It
  now returns the same public-fields-only view as the search tool.

- **The "Can I trade goods and services?" FAQ now matches the full asset
  list.** It had enumerated only 10 of the supported assets; it now uses
  drift-proof wording ("BTC, XMR, Blurt, or any other coin Morphit
  lists") that won't go stale as the asset list changes.

## Under the hood

- **Several new regression smokes** guard the fixes above: the two from
  the systemd/static-asset fixes (a check that fails if any
  `tsx`/`node`/`npm` unit restricts address families without `AF_UNIX`,
  and a check that fails if any same-origin static-asset link is missing
  the attribute that forces a real navigation), plus checks that every
  internal link carries a language prefix, that every operator-doc
  section reference in the code resolves to a real heading, that the MCP
  tools only ever return public fields, and that the test battery's
  registration stays internally consistent.

- **A comprehensive pre-release audit.** Before this release every code
  path was re-walked: a hostile-operator re-pass of all 17 chain-operation
  handlers (zero new findings), plus passes over navigation, cross-stack
  wiring, error/empty states, regex and SSRF defenses, database fields,
  memory teardown, broken references, the MCP server, dead translation
  keys, the ops-cli command surface, and the privacy claims in the docs
  (no-IP-logging, no-cookies, no-analytics — each verified against the
  code). Findings were fixed in-line; the items above are the
  user-visible ones.

- **The Farsi (فارسی) translation was professionally revised** — 114
  strings improved by a native translator (more natural phrasing,
  properly localized UI terms, a corrected right-to-left URL), kept at
  full key parity with the other locales.

- **Broader search descriptions.** The orderbook, FAQ, post-order, and
  sign-in pages now signal the full range of supported coins in their
  search-result descriptions — not just the BTC, XMR, and Blurt
  flagships — across all ten languages, so the pages can surface for
  people searching to buy or sell the other listed coins.

---

### Upgrade notes

This is a drop-in upgrade from beta.12. If you did the beta.12 systemd
migration and the relay would not stay running, this release is the fix:
after upgrading, re-copy the shipped unit files into place and reload
systemd (the upgrade pulls the corrected units; copying them is what
applies the `AF_UNIX` change). The indexer restart also re-seeds the
federation directory, which is what corrects the "Registered" date and
the self-"Unreachable" status on your own instance card.
