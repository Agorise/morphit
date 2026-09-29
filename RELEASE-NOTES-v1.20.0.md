# Morphit v1.20.0

A major release. BLURT-paid orders now show on every instance, not only where they were posted.
Bitcoin and Monero fees can be tied to the order they pay for. You can sign in with a QR code
across instances. Each instance can set its own colour theme. Tor-only nodes keep even the
operating system off clearnet. It also carries a whole-system security, privacy and reliability
review.

Four database migrations (v62–v65) run by themselves. The operator-register, release, order and
stranger-fee operations gain new optional fields. Older indexers ignore these fields, and nothing
that used to be valid stops being valid.

## New

- **Orders paid in BLURT show on every instance.**
  - **Before:** each instance counted the operator's 90 % share of a listing fee only if it went
    to *its own* fees account. An order posted through morphitir was therefore hidden as
    "underpaid" on morphit.io, and first messages between users of different instances were
    dropped.
  - **Now:** an instance publishes its fees account in its on-chain registration, and every
    instance accepts payments to it. `sudo morphit-ops upgrade` publishes it by itself. The
    10 % treasury share is still required.
  - **Existing orders appear too.** Once an operator has upgraded, its users' live orders
    from before — including those paid on v1.19 — appear on every upgraded instance within
    minutes, if their 90 % share went to the first fees account the operator registers. An
    order whose share went to a fees account the operator had switched away from before
    upgrading stays on its own instance only. Expired orders do not come back, and first
    messages already dropped stay lost.
  - **Which operators are accepted:** every operator whose on-chain registration names a fees
    account — the same registrations the Operators page shows. A new instance needs nothing
    from anyone else.
  - An instance that never set a fees account keeps sending 100 % to the treasury.
- **Bitcoin fees get their own address for every order**, once the treasury's extended public
  key (xpub) is pinned in a release.
  - Users just pay the address shown, by QR code or link, and no longer paste a transaction
    ID.
  - Nobody can claim someone else's payment.
  - Payments no longer all go to one public address.
  - Every instance and the browser compute the same address from chain data.
  - "I've paid — check now" re-checks at once.
  - **For the treasury:** `sudo morphit-ops treasury btc` shows the gap limit to set in the
    treasury wallet.
- **Monero fees work.**
  - **Before:** the transaction proof Morphit asked for could never be checked by the block
    explorers, so every Monero-paid order ended up "missing".
  - **Now:** you prove the payment with the transaction key your wallet shows. There is help for
    Feather, the Monero GUI and CLI, Cake Wallet and Monerujo.
  - **Tying the payment to its order:** once the treasury's main address is pinned in a release,
    you pay a Monero integrated address made for your order, so a copied transaction cannot pay
    for anyone else's order.
- **Monero block explorers updated.**
  - `localmonero.co/blocks` now forwards to moneroblocks.info, which works differently, so it
    is dropped. monerohash.com/explorer and exploremonero.com no longer answer and are dropped
    too.
  - moneroblocks.info is back in a new way: it only sees the transaction ID. Your instance
    checks the payment itself with the transaction key: the output, the amount (against the
    amount commitment recorded on-chain) and the order binding.
  - The defaults are now xmrchain.net, moneroexplorer.org and moneroblocks.info.
  - **Two of them must now agree** before a Monero fee counts as paid (it used to be one), so
    no single explorer can decide it. An instance that lists only one explorer keeps accepting
    one explorer's answer and says so when it starts; `MORPHIT_INDEXER_XMR_MIN_SUCCESSFUL_RESPONSES`
    still sets it explicitly.
  - **If you set your own list in `MORPHIT_INDEXER_XMR_EXPLORER_URLS`,** remove those three
    explorers. For moneroblocks.info, write `raw-tx+https://moneroblocks.info`.
- **Sign in with a QR code across instances.**
  - Your phone, signed in on one instance, can approve a login on another instance's page. The
    QR code must come from an instance in the Morphit directory.
  - Your phone only talks to its own instance, which passes the sealed message on (over Tor or
    I2P where needed). The other instance never sees your phone's address.
  - QR sign-in now also works on .onion and .i2p pages.
- **Your instance, your colours.**
  - For example: `sudo morphit-ops branding apply --theme-from '#f3dca0' --theme-to '#bb872f'`
    (on the server), or a ready-made theme such as `--theme champagne-gold`.
  - Every colour the site uses is derived from these, and each is checked for readable
    contrast: buttons, links, cards, hover and focus, chat bubbles, the page background and its
    corner glows.
  - Nothing is rebuilt and the build-integrity check stays green.
  - With no theme set, Morphit looks exactly as before.
- **Tor-only nodes keep the operating system off clearnet too.**
  - System updates are fetched over Tor.
  - The clock is set from onion sites over Tor instead of public time servers.
  - Ubuntu's news fetches are switched off.
  - The upgrade switches an existing node, checks it works, and puts everything back if it
    doesn't.
- **IPFS clean-up.** Old release and snapshot copies are unpinned every week. The current and
  previous release and recent snapshots are always kept.

## Fixed — critical

- **One malformed character could stop every indexer.** Chain data containing a NUL character
  made the database refuse the whole block, and indexers retried it forever. Such text is now
  handled the same way on every node, and indexing never stops on it.
- **Fast-sync no longer rejects honest snapshots** that contain orders or fees signed with an
  active key.

## Fixed — privacy

- **Servers no longer write visitors' IP addresses to disk.**
  - Before, BunkerWeb kept an access log with every visitor's address in Docker's log files,
    with no size limit. The frontend's web server logged the forwarded visitor address, and
    bare-metal installs logged every page and API call.
  - Now access logging is off everywhere. BunkerWeb's log line no longer contains an address,
    and Docker keeps no BunkerWeb log. The exception: if CrowdSec reads that log, a small
    rotating one (5 MB) is kept for it.
  - To watch BunkerWeb live without storing anything, run this on the server:
    `sudo docker attach --no-stdin --sig-proxy=false bunkerweb`.
- **Tor and I2P visitors now get the same browser protections as everyone else.** Their pages
  used to be served with no Content-Security-Policy and no anti-framing header. The onion and
  I2P policy allows the page itself plus the seven onion RPC nodes.
- **The QR login camera works again on Ansible-installed BunkerWeb sites.** BunkerWeb's default
  policy blocked it in Chrome-based browsers. (Firefox ignores that header.)
- **Hidden-only nodes stop two leftover clearnet contacts.** Publishing a snapshot no longer asks
  ipfs.io, and the hourly IPFS pin no longer waits 15 minutes for the public network.

## Fixed — money

- **The relay can no longer pay the same thing twice.**
  - If an RPC node lost its reply, the relay used to sign and send a second, different
    transaction. The same happened when a node rejected a transfer that another node had
    already accepted. Welcome bonuses, the 2 BLURT signup dust and power-ups could be paid two
    or three times.
  - Now every payment is signed once and the same bytes are offered to each node. Anything
    uncertain is settled by reading the chain before anything is sent again.
- **Signups keep their limits through restarts and bad nodes.**
  - The daily signup ceiling was never saved on installed boxes, so it reset on every restart.
    The `SIGNUPS_DISABLED` switch did nothing for the same reason.
  - Both now live in `/var/lib/morphit/relay`, which is created by itself.
  - Signups from one address can no longer beat the per-address limit by arriving together.
  - One invite can no longer create two accounts.
  - A misbehaving RPC node can no longer push creations past the ceiling.
- **The relay refuses a sudden account-creation fee spike** (more than 1.5× the configured fee)
  instead of paying it.
  - New error codes: `relay_fee_spike` and `broadcast_outcome_unknown`. The second one means
    "we can't tell yet whether your account was created — try again in a minute with the same
    name". A retry with the same name is safe and costs nothing extra.
- **Typing `12,50` into an amount no longer becomes 1250.**
  - Every amount box now understands a comma or a point as the decimal mark, and Persian,
    Arabic and full-width digits.
  - A number that could be read two ways, like `1,234`, is refused with both readings shown.
- **Expired orders no longer raise your listing fee.** The indexer never marks orders as
  expired, so every order that ran out used to count as live forever. The fee grew 1.5× for
  each one, up to a lockout.
- **Real BTC/XMR fee payments can't be pushed out of the re-check queue** by a flood of fake
  ones. A made-up XMR transaction is now marked missing, like BTC. A fee paid exactly at the
  floor is no longer rejected by rounding.
- **Finishing a trade automatically keeps the buyer's trade credit.** An automatic completion
  used to drop it.

## Fixed — security

- **Notification links can't send you to another site any more.**
- **Remember me.**
  - The copy of your keys kept for a page reload now expires after 30 seconds and only
    survives a real reload.
  - Going Back to Morphit after leaving now asks for your password again.
- **Lock session locks every open Morphit tab**, not just the current one.
- **The Active-key prompt refuses your owner key**, even when the account uses one key for
  both.
- **Changing the auto-lock time takes effect at once.**
- **Keys are wiped from memory when a 2FA code is required or wrong.**
- **The indexer no longer shows unsigned chat live, and a single RPC node can no longer plant a
  posting key.** Keys read from blocks are confirmed by two RPC operators before chat
  verification relies on them.
- **Fast chat hardening.**
  - Clearnet fast-chat pushes connect only to the address that was checked to be public.
  - `https://` onion and I2P addresses are refused at registration and dialled correctly if
    already registered.
- **The federation directory.**
  - Censored instances are no longer dropped as dead one day after they last registered.
  - A peer can no longer fill the directory with oversized or fake data.
- **Behind BunkerWeb, one visitor can no longer rate-limit everyone.** All visitors used to
  share one limit bucket.
- **Server-side fixes.**
  - Several root-owned files could be redirected by a local account through symbolic links.
    Among them: the upgrade's temporary folder, the branding ownership change, and two marker
    files.
  - The first-boot helper ran any user's canary script as root.

## Fixed — upgrades and operations

- **The upgrade finds BunkerWeb by what it is, not by its name**, so hand-made stacks (like
  morphit.io's) are handled correctly.
  - It only restarts BunkerWeb, its scheduler and the frontend, and never the whole stack.
  - It uses every compose file you started the stack with.
  - If it can't tell which container is which, it changes nothing and says so.
- **The upgrade checks that services actually stay up** after a restart. A brief automatic
  restart while the database starts is fine. A rollback now also brings back a service that
  crashed.
- **The upgrade now also refreshes the helper scripts** in `/usr/local/lib/morphit/`. It also
  opens the IPFS port (4001, TCP and UDP) on clearnet IPFS hosts that were installed before it
  was added.
- **Every RPC use goes through the full node pool**, with the healthiest node first:
  `morphit-ops` lookups and registration, the canary, and the release broadcast scripts. On a
  tor-only box only hidden nodes are used. The browser on an onion page now uses all seven
  onion RPC nodes, not two.
- **16 old one-off debug and patch scripts in `ops/` were removed.** Several of them broke
  today's indexer if run.
- **Honest messages.**
  - `morphit-ops doctor` no longer tells you to remove an RPC node that is only briefly down.
  - The firewall check no longer says "OK" when it could not reach the site.
  - `morphit-ops --version` shows the real version.
  - `branding status` asks for sudo instead of guessing.
- **Plain-HTTP I2P visitors** see a calm note where the browser does not allow a feature (2FA
  codes, copy buttons), instead of an error.
- **Other.**
  - The homepage's "What Morphit is built around" heading is removed in all 10 languages. The
    seven cards stay, and their titles are now proper headings for screen readers.
  - "agorist" is no longer translated, and Blurt is spelled Blurt in Persian.

## Upgrading

Run `sudo morphit-ops upgrade` on each server. Nothing needs doing by hand.

- **Fees account.** The upgrade publishes your instance's fees account in its operator
  registration by itself. It keeps your current on-chain name, address and contact exactly as
  they are.
  - If it can't unlock the relay key without you, it prints one line. Then run
    `sudo morphit-ops register` on that server.
  - Check the result with `sudo morphit-ops status` → "Fees account (federation)".
- **On BunkerWeb boxes** the upgrade:
  - applies the new privacy and header settings to BunkerWeb and the frontend, checks them, and
    puts everything back if a check fails;
  - switches BunkerWeb to the frontend's new private port (8088) only after it sees that port
    working.
- **On Tor-only boxes** the upgrade also moves system updates and the clock onto Tor, as above.
  It finishes within its time limit. Anything left half-done is finished or undone by a timer
  within six hours.
- **Some protections take effect from the next upgrade after this one**, because this upgrade
  is still run by v1.19.0's own code: the upgrade's private temporary folder, its own symlink
  and npm checks, and its restart checks.
- **Registered `https://` onion address?** An operator who registered one should register again
  with `http://`: run `sudo morphit-ops register` on that server.
- **Bitcoin per-order addresses and Monero order-bound addresses start only when the maintainer
  pins the treasury keys in a later release.** That release comes after every instance runs
  v1.20.0. Until then, Bitcoin fees work as before and Monero fees use the transaction key.

Branded instances keep their logo, icons and name, and now their colours: the upgrade
re-applies them.
