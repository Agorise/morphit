# Pre-launch — outside-scope security testing

Ken asked: "if I were to hire an outside professional security auditing
agency, would they do any tests that you have not?" Yes. This document
catalogs what they would do that I CAN'T do from inside a code-review
sandbox, why each matters, and which ones are highest-leverage for
Morphit's specific threat model.

The two big categorical gaps: **DAST** (dynamic application security
testing — needs a running target) and **wetware** (a human security
specialist's intuitions don't substitute for source review alone).

---

## High-leverage tests I cannot run

### 1. DAST — dynamic web-app testing against a running instance

**What it is.** A professional firm spins up a Morphit instance and
hits it with tools like Burp Suite Pro, ZAP, or Nuclei to find runtime
bugs that static review misses: timing leaks under load, race
conditions in real concurrency, response-header drift, content-type
sniffing, session fixation, etc.

**Why this matters for Morphit specifically.**
- Every instance is operator-deployed, so the attack surface includes
  the operator's stack (nginx, BunkerWeb, kernel, Tor exit posture).
  A pen-tester running against a real deploy catches misconfigurations
  that source review never sees.
- The federation layer means responses from one instance can be
  observed by other instances; behavior under cross-instance load is
  not reproducible in source review.

**Recommendation.** Highest-leverage gap. Engage at least one
DAST-capable team before any "soft launch" beyond a closed-group
beta. The `BETA-INCIDENT-RUNBOOK.md` already anticipates that
operators may discover issues post-launch — a DAST pass before that
catches issues operators can't.

### 2. Active fuzzing

**What it is.** AFL, libFuzzer, Atheris, or stateful fuzzers like
Boofuzz/Restler crash-test parsers and protocol handlers. Different
from property-based testing (fast-check) in that fuzzers actively
mutate inputs to maximize coverage and find crashes/hangs/asserts.

**Where it would land in Morphit.**
- Chain-op JSON payload parsers (`apps/indexer/src/indexer/handlers/`)
- Chat-payload decoder (`apps/web/src/lib/chat/payload.ts`)
- Address validators (BTC/XMR/BLURT/USDT/USDC/DAI/BCH/LTC/DASH/DOGE/
  ZEC/ARRR/DCR/SOL/ETH/XRP — 16 codepaths)
- Keystore envelope decoder (`apps/web/src/lib/crypto/keystore.ts`)
- HTTP body parsers in indexer + relay

**Recommendation.** Run a 24-hour libFuzzer pass against each
parser. The chain-op payload parsers are the highest-priority targets
because untrusted input flows directly into DB writes.

### 3. Cryptographic specialist review

**What it is.** A working cryptographer (think Trail of Bits, NCC
Group, or Cure53) reads the crypto code line-by-line. They catch
things a generalist source reviewer cannot:
- Side-channel weaknesses in primitive selection
- Padding-oracle exposure
- Bleichenbacher-style attacks
- Subtle nonce-reuse hazards
- Key-derivation parameter choices (Argon2 m/t/p tuning for the threat
  model, not just "above OWASP floor")
- Forward-secrecy / future-secrecy posture in the chat layer

**Where it would land in Morphit.**
- `apps/web/src/lib/crypto/keystore.ts` — envelope encryption
- `apps/web/src/lib/crypto/keystoreYubikey.ts` — hardware-key wrapping
- `apps/web/src/lib/crypto/keystoreTotp.ts` — 2FA secret encryption
- `apps/web/src/lib/crypto/passkeys/` — WebAuthn flows
- `apps/web/src/lib/chat/` — message authentication

**Recommendation.** One full crypto pass before launch. Pre-launch
is the cheapest time to discover that a primitive choice was wrong;
post-launch every key in existence becomes legacy.

### 4. Threat modeling workshop

**What it is.** A 1-2 day session where security engineers run STRIDE
or PASTA on every trust boundary, identifying threats that source
review cannot enumerate because they emerge from system composition.

**For Morphit specifically.**
- Trust boundary: user ↔ instance frontend ↔ instance indexer ↔
  Blurt chain ↔ other instances ↔ counterparties off-platform
- Each boundary has a STRIDE category that source review touches
  partially but doesn't systematize.

**Recommendation.** Skippable if budget is tight, but a pre-launch
threat model from outsiders catches blind spots in the developer's
own threat model. Most teams over-defend against attackers they've
been thinking about and under-defend against attackers they haven't.

### 5. Supply-chain attack review

**What it is.** Audit of every npm package + Python dependency for
known vulnerabilities, malicious-package risk, abandoned-maintainer
risk, typosquatting risk, post-install script risk, lockfile-integrity
risk.

**Tools the firm would run.**
- `npm audit` + `socket.dev` + `Snyk` + `Dependabot` advisories
- SBOM generation (CycloneDX or SPDX)
- Reproducible-build attestation
- Signature verification on the release tarballs

**Where I have partial coverage.** I've run `npm audit` informally
and the deps-clean smoke checks for known-bad packages. A pro firm
would do a full SBOM with attestations.

**Recommendation.** Medium-high leverage. Easy wins. Ken's BLURT-
treasury and YubiKey are the highest-value targets a supply-chain
attacker would aim for.

### 6. Browser-fingerprinting analysis

**What it is.** Run the deployed UI through PrivacyAnalyzer, Panopti-
click-style tools, or a custom canvas/WebGL/font fingerprint extractor
to verify that "no fingerprinting" is actually true at runtime.

**Why this matters for Morphit's priority #1 (privacy).**
- The brag list claims "no fingerprinting via canvas/WebGL/fonts."
  Source review checks that we don't WRITE fingerprinting code;
  runtime testing checks that no third-party script or browser
  default exposes one anyway.

**Recommendation.** Medium leverage. Can do a self-test by running
Tor Browser at the deployed instance.

### 7. Tor/I2P / hidden-service operational testing

**What it is.** Pen-test the .onion deployment specifically:
- Hidden-service descriptor leakage
- Exit-node correlation
- Tor circuit-isolation per-action
- Onion-balance failover
- Static-asset hostname leaks (CDN, fonts, favicons)

**Recommendation.** High leverage for the niche of users who NEED
this (journalists, dissidents, etc.). Lower leverage for the broad
user base. Schedule it post-soft-launch when there's a live `.onion`
to test.

### 8. Real-load + chaos testing

**What it is.** k6 / Locust / Gatling fire realistic load patterns
at the indexer + relay + DB and a chaos-engineering tool (Litmus,
Chaos Mesh) injects faults (kill -9, network partition, disk full,
clock skew). Tests behavior under stress.

**Where it would land in Morphit.**
- Indexer's chain-replay path under burst load
- Relay's altcha challenge issuance under DDoS
- DB upsert race conditions under concurrent writes
- Federation probe scheduler under network partition
- Chain-op handler idempotency under replay

**Recommendation.** Run before any second-instance comes online.
Hardest to schedule but the chaos-tests catch things that fix
themselves in dev but fail in production.

### 9. Mobile / WebView attack surface

**What it is.** If anyone bundles Morphit in a WebView (Tauri,
Capacitor, etc.), that WebView is the attack surface. Same source,
different runtime.

**For Morphit.** PWA only. No native Android/iOS yet. If a community
member packages it, those packages need their own review.

**Recommendation.** N/A pre-launch. Note in `SECURITY.md` that
unofficial mobile packagings are out-of-scope.

### 10. Social-engineering / phishing simulation

**What it is.** Test Ken (and any future operator/admin) for
spear-phishing resistance: fake YubiKey-firmware-update emails, fake
Forgejo "admin needs to re-auth" emails, fake "your operator account
is suspended" emails.

**Recommendation.** Low priority pre-launch. Document the
operator-trust model in `OPERATOR-TRUST-DESIGN.md` so operators know
that "this email is from Anthropic-Agorise" is a phishing red flag
(we never email; Matrix only).

---

## Lower-leverage but worth knowing

### 11. Smart-contract audit
N/A. Morphit has zero smart contracts. The chain-op model is BLURT
custom_json, not on-chain logic.

### 12. PCI / GDPR / AML compliance audit
N/A. Non-custodial means no PCI scope. No KYC means the GDPR surface
is minimal (the `/privacy` page enumerates what data flows where).
AML doesn't apply to a non-custodial marketplace.

### 13. Hardware HSM review
N/A unless an operator chooses to back the treasury key in an HSM.
That's an operator decision documented in `OPERATIONS.md`.

### 14. Penetration of physical infrastructure
N/A. Software project, no physical infrastructure.

### 15. Red-team engagement
A red-team engagement combines DAST + fuzzing + threat modeling +
social engineering over a 2-4 week period with a defender-vs-attacker
scoreboard. Highest-bandwidth security exercise. Only worth it
post-launch when you have something for attackers to actually try
to compromise.

---

## What I AM doing in cp138 that overlaps

- **Source code review.** A pro firm would also do this; mine is
  comprehensive but they bring different intuitions and battle-scar
  pattern recognition.
- **Static analysis** (tsc, eslint, custom smokes). They'd also run
  CodeQL, Semgrep, and specialty tools like Bandit (Python),
  Brakeman (Ruby; N/A here), gosec, etc.
- **Documentation review.** They'd verify SECURITY.md, OPERATIONS.md,
  threat-model docs match the code. I'm doing this in Phase I.

---

## Concrete recommendation

For a non-custodial, no-KYC, AGPL-3.0 P2P marketplace at pre-launch:

| Test | Leverage | Urgency |
|---|---|---|
| DAST against running instance | High | Pre-public-launch |
| Cryptographic specialist review | High | Pre-public-launch |
| Active fuzzing of payload parsers | High | Pre-public-launch |
| Threat modeling workshop | Medium-high | Pre-public-launch |
| Supply-chain audit + SBOM | Medium-high | Pre-public-launch |
| Tor/I2P operational test | Medium | Post-soft-launch |
| Real-load + chaos tests | Medium | Pre-second-instance |
| Browser-fingerprinting verify | Medium | Post-soft-launch |
| Mobile / WebView | Low | If/when Morphit ships WebView |
| Social engineering | Low | Post-soft-launch |
| Red-team engagement | High | Post-launch (when valuable) |

Estimated cost for the top 5 from a tier-1 firm (Trail of Bits, NCC
Group, Cure53): $40–120k depending on scope. For a $0-revenue,
launching project that's a large bill. Realistic alternatives:

- **HackerOne / Bugcrowd bug bounty.** ~$5k initial setup. Public
  pre-launch programs find lots of low-hanging fruit cheaply.
- **Pre-launch reviewer rotation.** Find 3-5 individual contractors
  via Matrix/Mastodon at $5-15k each for focused mini-engagements
  (one does DAST, one does crypto, one does fuzzing). Cheaper than
  a firm; takes more coordination.
- **Academic crypto review.** Some university research groups will
  review crypto designs for free if the work is publishable. AGPL +
  novel threat model could attract this.
