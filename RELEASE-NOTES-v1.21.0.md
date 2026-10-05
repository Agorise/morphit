# Morphit v1.21.0

A full security and privacy review of the whole codebase, done the way a hostile expert would: 19
independent reviewers, a red team against a running instance, a fresh threat model, and four rounds of
fixes, each checked by reviewers who had not seen the fix. Every fix comes with a test that was run
against the old code and seen failing.

**Upgrading:** clearnet servers run `sudo morphit-ops upgrade` as usual (see "Every node" below for the
new `--questions` and `--heals`). **Zero-clearnet servers must use the signed offline bundle** — follow
"Zero-clearnet nodes" below step by step. There is one database migration (new indexes, and stored
push-subscription browser details removed); it runs by itself at start-up.

**New consensus rules switch on at 2026-11-01 00:00 UTC** (by block timestamp, so every indexer agrees).
Please upgrade every instance before then. The rules are listed under "Marketplace" below.

## Indexer: things one user or one node could break

- **One cheap on-chain operation could stop every indexer for good.** Two duplicate fee-bearing operations
  in one transaction, or a deeply nested JSON operation of about 6 KB, made every indexer retry the same
  block forever. Both now fail only that operation; indexing goes on.
- **A single RPC node could feed the indexer unsigned "official" operations** (a release record or a new
  RPC node list) and so add its own nodes to the pool or change the treasury. Official operations are now
  accepted only with a valid signature from the pinned key.
- **Trusted reads (posting keys, snapshots) need operators to agree, and a stale answer never wins.** A
  value is confirmed only when at least two operator names agree and form a majority; an answer that is
  provably older is overruled, and a lone disagreement delays confirmation instead of deciding it.
  Operators are counted by node name.
- **One node answering errors no longer freezes indexing**; the pool moves on to the next node.
- **Peer price federation works.** A field-name mismatch meant no peer price was ever counted.
- **Memory and load limits:** RPC replies are capped by what was asked for, account-history reads have
  per-client and total limits (`413 reply_too_large`, `503 history_busy`), the indexer has a 1536 MiB
  memory cap, and the database gets per-request timeouts, missing indexes and no JIT stalls.

## Privacy

- **BunkerWeb contacts no one.** As shipped it sent blocked visitors' IP addresses, full URLs and request
  headers to its maker's service, looked every visitor up in public DNS blocklists, and downloaded lists and
  databases from third parties. All of that is off, on new and upgraded servers alike.
- **Fee checks and prices go over Tor first.** BTC fees are checked with onion block explorers, XMR fees
  with onion xmrblocks explorers, and BTC/XMR prices come from the agreeing median of five Haveno and Bisq
  price nodes over Tor. Clearnet sources are only a fallback, and never used on zero-clearnet nodes —
  which now offer BTC and XMR fees again.
- **The relay no longer writes visitor network prefixes or account names to its log**, stores no browser
  details with push subscriptions, and only sends Web Push to the real push services.
- **The browser's release check:** two small requests to one node, once a day, shared by all tabs. The
  browser now checks the release signature itself, so one node cannot forge it, and a release older than
  the running site never supplies fee addresses.
- **Nothing about who you are survives Sign Out or a "just this session" sign-in** in another tab, the
  profile cache or chat state; account-named server answers are no longer cached by the browser.
- **The public health pages show only status**; host memory, disk and counters need the local header.
- **Every instance uses its own address** in page links and previews; zero-clearnet instances carry no
  clearnet address at all.

## Chat

- **Messages now prove who sent them.** New messages use an authenticated format, so the operator's server
  cannot insert a message "from" the other trader. Older messages still open but are marked unverified and
  never offer "Pay now" or change a trade.
- **"Verify peer" is a 60-digit safety number** (it was 64 bits, which a determined attacker could match).
  Compare once more after upgrading.
- **A changed chat key always asks you first**, Lock keeps your comparisons, and a replaced key can only
  open old messages.

## Keys and sign-in

- **The page's Content-Security-Policy no longer allows inline or eval'd scripts.**
- **Removing or hardening a YubiKey can no longer be undone** by a later password change; the YubiKey
  path also asks for your 2FA code when 2FA is on.
- **Decrypted keys are no longer written to disk** during a page reload.

## Marketplace

- **A stranger can no longer mark your order "paid"**; payments are checked against the amount you asked
  and the actual counterparty, and a payment with no amount asked shows as "received", not "paid".
- **Prices shown in the app are live**, from the indexer; when none is known the pay field stays blank.
- **Rules that switch on at 2026-11-01 00:00 UTC:** deeper-than-64-level payloads and U+FFFE/U+FFFF text
  are rejected; a review must cite an order the two of you discussed or completed; attestor loyalty counts
  only the treasury's share; feature bids under the step are queued, and only live, paid orders rank;
  display and operator names are checked for look-alikes of reserved names; profile fields are validated;
  chat read receipts are bounded; an order replacement offering only disabled payment methods is refused.

## Servers

- **Services no longer run as root where they don't need to,** and the service account can no longer gain
  root through files it owns.
- **TLS certificates renew on BunkerWeb servers** (they could not before), and hardening no longer cuts off
  Docker's forwarding.
- **Zero-clearnet servers enforce it:** only Tor and i2pd may reach the internet; DNS goes nowhere but the
  box itself; the Matrix alert bot is refused unless it goes over Tor to an onion homeserver.
- **Upgrades verify the release against the on-chain record or the pinned signing key on every path**, and
  zero-clearnet upgrades install nothing from the internet.
- **Branded instances get their own link-preview image**, drawn from their logo and name.

## Repository

- Internal working notes, personal details and process records are no longer in the public repository.
  The threat model (`docs/audit/2026-10-*`) and docs were rewritten to match the code; claims that were not
  true were corrected or removed.
- Vulnerability reports: Matrix direct message to `@agorise:matrix.org` only (see SECURITY.md).

## Every node: questions and repairs after the upgrade

**The repair part of the upgrade never waits for an answer now.** A question asked part-way through could hold up
the upgrade or cut it off. On the upgrade *to* this release, the old upgrader's own two questions (described below) still
wait unless you pass `--yes`.

Where the repairs used to ask, they now take the safe choice and tell you:
- the journal is left as it is;
- on a tor-only node, a Matrix bot on a clearnet homeserver is stopped;
- plain-text backups are left as they are.

**`sudo morphit-ops upgrade --questions`**, run from a terminal, asks those questions. Each upgrade lists the
questions it left on its last lines.

**When a line says "the next `sudo morphit-ops upgrade` tries again", that is now true even when you are already on
the newest release.** A plain `sudo morphit-ops upgrade` on an up-to-date box prints "✓ Already on the latest
release." and then re-checks this release's repairs; nothing is downloaded or installed. `--check-only` and `--json`
still only look.

**`sudo morphit-ops upgrade --heals`** does the same directly, without checking for a release first. Use it when a
line asks you to, or when an upgrade says its repair step ran out of time.

**Tor-only node, Matrix bot kept on a clearnet homeserver (`KEEP-CLEARNET`):** the rule that lets only Tor and i2pd
reach the internet is then not loaded on that node, and the upgrade says the node is not zero-clearnet while the bot
is kept. The rule would cut the bot off, including the DNS lookups it needs. To get the rule:
1. Move the bot to a homeserver on the node or a `.onion` one: `sudo morphit-ops matrix setup`.
2. Run `sudo rm /etc/morphit/matrix-bot.tor-only-decision`.
3. Run `sudo morphit-ops upgrade --heals`.


## Zero-clearnet nodes: upgrade from the signed offline bundle

On a zero-clearnet node, **do not** run the plain upgrade for this release. That includes menu option 2 and a bare
`sudo morphit-ops upgrade`. The upgrader already on your box (v1.20.3 or older) would then install the packages with `npm ci`
from the npm registry over the clearnet.

Use the offline bundle instead. The release job builds it, and it is signed with the release key your box already
trusts, so nothing on the box touches the clearnet and npm is not used.

**On your own computer** (any computer with internet), download the two files from the release page. The bundle is
about **250 MB**: 246.5 MB measured when it carries its Node.js and Kubo runtimes. Without the runtimes it is
135.0 MB; Kubo v0.42.0 is 54.6 MB and Node.js v22.22.2 about 57 MB.

```
curl -fLO https://git.agorise.net/agorise/morphit/releases/download/v1.21.0/morphit-v1.21.0-offline.tar.gz
curl -fLO https://git.agorise.net/agorise/morphit/releases/download/v1.21.0/morphit-v1.21.0-offline.tar.gz.asc
```

Copy both to the node, logging in the way you normally do. Use `scp -O`, not plain `scp`:

```
scp -O morphit-v1.21.0-offline.tar.gz morphit-v1.21.0-offline.tar.gz.asc <you>@<your-node>:/tmp/
```

**On the node**, in a terminal:

1. Check that the node can verify the signature. Each command must print something, and neither may say
   "No such file" or "command not found":
   ```
   gpg --version | head -1
   ls /opt/morphit/.forgejo/release-signers/agorise.asc
   ```
2. Run the upgrade from the bundle. `--yes` answers the two questions the old upgrader asks; they would
   otherwise wait for you with no time limit:
   ```
   sudo morphit-ops upgrade --from-file=/tmp/morphit-v1.21.0-offline.tar.gz --yes
   ```
   You should see these three lines, in this order:
   - `✓ Integrity verified (gpg-signature).`
   - `Offline bundle detected (prebuilt node_modules) — skipping npm ci; no registry needed.`
   - `Using the prebuilt web frontend shipped in the release (no rebuild).`

   Let it run until `✓ Success — your Morphit server is now running v1.21.0` (about two to three minutes).

   The rest of the output comes from the old upgrader already on your box, which cannot be changed. Read it like this:
   - **Without `--yes`, it asks "Apply upgrade from v1.20.x to v1.21.0? … This will: … run npm ci, rebuild + redeploy
     the web frontend …".** That text is old. With the bundle, nothing is installed from npm and nothing is rebuilt
     (see the two lines above). Answer `y`.
   - **Without `--yes`, a box that has never had a warrant canary may also ask "Set one up now, right here on this
     box? …".** Answer `n`. The upgrade then goes on, and you can set a canary up any time later with
     `sudo bash /opt/morphit/scripts/canary/setup.sh`.
   - **If your Matrix bot is set up, it prints "Matrix alert username configured — enabling + restarting
     morphit-matrix-bot…".** On a tor-only node whose bot uses a clearnet homeserver, ignore it. The bot refuses to
     start, and the background checks (step 4) switch it off again. To keep the bot on its clearnet homeserver
     anyway, use step 3.
   - **It ends with "Congratulations! … nothing else to do".** That is not true for this release: carry on with
     step 3.
3. Answer the questions the upgrade did not stop for: the old relay log lines, the Matrix bot, and plain-text
   backups. Any it does not need to ask, it skips:
   ```
   sudo morphit-ops upgrade --questions
   ```
4. Read what ran after the services restarted:
   ```
   sudo cat /var/log/morphit/after-upgrade-heal.log
   ```
   The last line must be `Done.`. If it is not, the checks are still running: they wait up to 15 minutes for the
   services to restart and then up to 10 minutes for the background web repairs. Wait a minute and read it again.
5. Once `Done.` is there, run the repairs once more. This picks up whatever had to wait until Docker pulls through
   Tor, which the checks in step 4 set up. One example is the frontend's newer nginx base, if a line said the
   frontend "stays on its current nginx base for now". Nothing is downloaded over the clearnet:
   ```
   sudo morphit-ops upgrade --heals
   ```
6. Remove the two files:
   ```
   rm /tmp/morphit-v1.21.0-offline.tar.gz /tmp/morphit-v1.21.0-offline.tar.gz.asc
   ```

If something goes wrong:
- **`Cannot verify the integrity of release v1.21.0`**: nothing was changed. The two files must sit side by side
  under exactly these names. Download the `.asc` again and repeat step 2. If the same error also says "No on-chain
  hash available … Start it with: sudo systemctl start morphit-indexer", ignore that hint. the old indexer never
  stores the bundle's hash, so starting it does not help. Only the `.asc` does.
- **`Could not import release-signer key agorise.asc`**: gpg could not start its helper. Run step 2 as
  `sudo env TMPDIR=/tmp morphit-ops upgrade --from-file=/tmp/morphit-v1.21.0-offline.tar.gz --yes`.
- **A line starting `The upgrade stopped its heal step at the time limit`**: wait until the upgrade has finished,
  then run `sudo morphit-ops upgrade --heals`.


## What this upgrade changes on installed servers, by itself

- **BunkerWeb no longer contacts anyone.** These were already off: BunkerNet, DNS blocklists, the reverse-DNS
  black/white/grey lists, the anonymous report and third-party captchas. Now:
  - its daily GeoIP download (db-ip.com), release check (api.github.com) and "preview" Pro-plugin download
    (assets.bunkerity.com) are replaced: the upgrade mounts Morphit's own job lists into BunkerWeb's scheduler, and
    country rules use the GeoIP file inside the BunkerWeb image;
  - reverse scan and plugin downloads stay off;
  - BunkerWeb's in-memory list of the last 100 blocked requests is off (`USE_METRICS=no`). That list held each
    visitor's address, full URL and browser with no time limit.
- **BunkerWeb's blacklist is off, and part of it cannot be replaced.** BunkerWeb checks every blacklist entry only
  after a reverse-DNS lookup of each visitor's address, which tells outside DNS servers who visits your site. With
  the blacklist off:
  - Addresses and networks you listed (`BLACKLIST_IP`) keep working. The upgrade moves them into an nginx `deny`
    rule (`CUSTOM_CONF_SERVER_HTTP_morphit_ip_blocks`) and says so.
  - **Network (ASN) blocks, reverse-DNS name blocks, user-agent and URL lists no longer apply.** The upgrade names
    each one it finds. Ansible-installed servers had `BLACKLIST_ASN=AS14061 AS24940 AS16276` (DigitalOcean, Hetzner,
    OVH); visitors from those networks, VPN users among them, are no longer turned away.
  - The Tor-exit list and the downloaded bad-bot list are no longer used.
  - Country blocks (`BLACKLIST_COUNTRY`) still work, from the GeoIP file on the server.
- **Kubo (IPFS) takes no settings from the internet.** AutoConf, HTTP routers (cid.contact, delegated-ipfs.dev) and
  DoH resolvers are off. A clearnet node seeds over the public DHT, joined through the standard bootstrap peers.
- **Ubuntu's own fetches a server does not need are off on every node:**
  - the login banner's news (motd.ubuntu.com) and apt's Ubuntu Pro news;
  - the release-upgrade check at login (changelogs.ubuntu.com; `Prompt=never` in
    `/etc/update-manager/release-upgrades`). To move to a new Ubuntu release later, set it back to `Prompt=lts` and
    run `sudo do-release-upgrade`;
  - fwupd's firmware-list refresh and pollinate;
  - rkhunter's data-file update. Ubuntu's rkhunter cannot download one anyway; its data comes with the apt package.

  snapd and Ubuntu Pro's status check stay on: installed snaps and a Pro subscription need them.
- **Zero-clearnet nodes can reach their own local network again.** The rule that lets only Tor and i2pd reach the
  internet now also allows the local network (10/8, 172.16/12, 192.168/16, IPv6 fc00::/7), so a NAS, a printer or
  your laptop work as before. DNS goes nowhere but the box itself: it is refused to the local network, to
  link-local addresses (home routers often announce their fe80:: address as the resolver) and to the internet, over
  IPv4 and IPv6, from every program — Tor, i2pd and the containers included (none of them needs it).
- **No Docker Hub download on a zero-clearnet node.** The frontend moves to this release's pinned nginx base image
  only when that image is already on the box, can be loaded from a `vendor/docker/` file you put there, or can be
  fetched with Docker going through Tor. Otherwise it keeps its current base and says so; once Docker pulls through
  Tor, `sudo morphit-ops upgrade --heals` on the server switches it. (The release's offline bundle carries no Docker
  images.)
- **Running the indexer and relay as their own users** (not root) is now checked where each one really listens, and
  each gets up to two minutes to start. A service that runs as its user but has not answered yet keeps running as
  its user, and the upgrade says so. Only a service that is down, keeps restarting or runs as someone else is put
  back on root.
- **The indexer has a memory cap** (1536 MiB, systemd `MemoryMax`), like the relay (512 MiB) and the MCP server
  (256 MiB). A burst of large requests can no longer take the whole box. The cap is about twice the most the indexer
  was measured to use honestly. `sudo morphit-ops upgrade` checks that the running indexer carries it; if the
  indexer happens to use more than 80% of the cap at that moment, nothing is changed and the upgrade says so.
  The indexer now reads its own cap, so the optional flow catch-up sizes its buffer to fit.
- **Served web files stay with the canary user.** The service-user heal no longer hands `apps/web/static` back to
  root (it already left `apps/web/build` alone).
## Releasing (maintainer)

**The offline bundle.** The release job now builds it itself, without Docker, and attaches it with its `.sha256`.
Without the bundle the release is not published. The job signs the tarball and the bundle only when the
`MORPHIT_RELEASE_SIGNING_KEY` secret is set; otherwise it attaches no `.asc`, and a node running this release
installs later ones by the SHA-256 in @morphit's signed on-chain record. For this release only, the maintainer signs
the bundle and attaches its `.asc`, because the upgrader on v1.20.x zero-clearnet nodes accepts the bundle only with
a signature.

The bundle carries no OS packages or Docker images. A fully offline **fresh install** still needs the full appliance
bundle: `bash scripts/build-offline-bundle.sh` on an Ubuntu 24.04 box with Docker. That build is optional and not
part of the release steps.

**Moved tags.** The release job checks that the tag still points at what you signed. If a release for the tag already
exists, the job attaches to it only when it was built from the same signed tag object. A tag moved back to an older
signed object after publishing is therefore refused before anything is attached, and nothing is published for it.

Block 4 also checks that the release job built the very tag you pushed in Block 2. If it stops with "the tag was
moved after it was pushed", do not broadcast. Delete that release on git.agorise.net, codeberg.org and gitea.com,
because its tarball, bundle and signatures are already published there.

Neither check adds a command.
