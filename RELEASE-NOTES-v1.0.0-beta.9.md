# Morphit v1.0.0-beta.9

A security-hardening and correctness release on top of beta.8. Three
operator-facing fixes lead it: the price-manipulation defenses are now
fully active and visible on `/v1/health`; the Content-Security-Policy
that was breaking in-browser crypto on some deploys is root-caused and
fixed (and is now identical across every deploy path); and the
production rate-limiting that could ban a busy instance for an hour is
fixed. The rest is home/login polish, fresher FAQ and feed metadata, and
a clean hostile-input audit of every indexer handler. **Recommended for
all operators — especially anyone who saw a blank/broken page behind a
WAF, or whose instance was getting rate-limit-banned.**

## Added

- **The price-manipulation defenses are now fully active and visible.**
  Two of the three anti-manipulation detectors were built but not yet
  switched on: the slow-drift detector (catches a "frog in boiling
  water" attack that nudges the price a little each cycle) and the
  native-vs-external detector. Both are now wired alongside the existing
  cross-instance peer detector, and all three report their status in the
  `/v1/health` response so operators and monitors can see them working.

- **Feed readers now auto-discover all three formats.** Every page that
  offers a feed advertises RSS 2.0, Atom, and JSON Feed in its
  autodiscovery tags (previously only RSS), so a reader finds whichever
  format it prefers without you pasting a URL.

## Changed

- **A correct, privacy-clean Content-Security-Policy on every deploy
  path.** We root-caused why the CSP was sometimes blanking the site or
  breaking sign-in: it was being emitted as a `<meta>` tag that browsers
  can't fully enforce and that clobbered the working header. It is now a
  single real header, **byte-identical** across the nginx config, the
  operator docs, and the BunkerWeb path, and it keeps the QR-login camera
  working while dropping the external price API entirely for privacy. The
  Permissions-Policy is now a real header too. Operators who had been
  hand-editing the policy out should remove that workaround.

- **Production rate-limiting no longer bans busy instances.** The WAF's
  per-IP limit on the API was tighter than a single page load, so a
  normal burst of requests could trip it, escalate to an hour-long IP
  ban, and then feed on its own error responses. The ceiling is raised to
  sit comfortably above the app's own fine-grained limiter, and a
  rate-limit burst can no longer escalate into a ban.

- **A lighter home page and a polished login.** The "Welcome to *your
  instance*" banner is gone, the login heading now uses the brand
  gradient, and the wordmark's shine is slower and dimmer. The page shell
  shipped on every request is about a hundred lines lighter.

- **Fresher FAQ and machine-readable site description.** The
  AI-crawler corpus that describes Morphit to assistants was out of date
  and is resynced (and now guarded against drifting again). The "follow
  Morphit with RSS" FAQ answer no longer implies that only three assets
  have feeds — every supported asset does.

## Fixed

- **The FAQ accordion opens reliably from a "related" link.** Clicking a
  related-article pill at the bottom of an answer now scrolls to *and
  opens* the target article, instead of scrolling to a still-closed one.

- **The ops CLI no longer writes a placeholder tagline.** Pressing Enter
  at the optional "Instance tagline" prompt during `morphit-ops init`
  used to save the literal text "A Morphit instance" to your config (and
  surface it on the homepage and in the federated directory). The prompt
  is now genuinely optional and writes nothing when left blank.

- **Source-repository labels corrected.** The machine-readable site files
  now correctly identify the canonical source as the self-hosted Forgejo
  instance rather than a GitHub mirror.

- **Removed a duplicate database-schema definition.** One table used by
  the price-drift defense was declared twice in the schema. It was
  harmless — the database created it once — but the duplicate is removed
  so the two copies can never drift apart.

## Under the hood

- A complete hostile-input audit of all seventeen indexer message
  handlers came back clean, with one low-severity hardening fix: the
  forbidden-character policy that strips invisible/bidi control
  characters from user input had drifted slightly between handlers and is
  now converged (while deliberately keeping the right-to-left marks that
  the Farsi locale needs), with a new guard so the copies can't diverge
  again.

- New regression guards were added: one keeps the AI-crawler corpus in
  sync with the source FAQ, and one keeps the Content-Security-Policy and
  Permissions-Policy byte-identical across all four deploy surfaces and
  rejects a weakened-but-consistent edit.

---

*Morphit is non-custodial and no-KYC. It never holds your keys and never
takes custody of funds. As always, verify the release signature against
the published fingerprint before deploying.*
