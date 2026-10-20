# Morphit v1.21.12

**Chat, profile saves and every other error the app reads work again on BunkerWeb sites.** BunkerWeb,
on its default settings, replaced every error answer from the site with its own web page. The app
reads those answers for their reason. On morphit.io, a message to a new member failed with
"Malformed response from indexer (status 404)", and a short-bio save showed "the chain rejected the
transaction" without saying why. Worse, the app never published a new member's chat key, so nobody
could write to anyone who joined after BunkerWeb went in. The upgrade turns that replacing off and proves
it on the running site. And when an account is short of BLURT, the app now says so on every screen that
writes to the chain: "Broadcast rejected due to insufficient funds. Buy BLURT to save more data to
the chain."

Also fixed: members whose name ends like a file (`bob.old`, `ann.git`, `max.svg`) got the web server's
404 page for their chat key and their pages. And on BunkerWeb sites the upgrade did not set up, normal
browsing could ban a visitor for a day.

This release includes everything in v1.21.11 (see its notes): the download page about Morphit,
the barter chat buttons, and `www.<domain>` on BunkerWeb sites.

**Upgrading:** `sudo morphit-ops upgrade` on every server. No database change. On a BunkerWeb site the
upgrade changes a few lines of `bunkerweb.env`, recreates BunkerWeb's services so they read them, and
checks the result on the running site. The frontend container is rebuilt from this release, and a
bare-metal nginx site's own file is updated. Members who joined while answers were replaced get their
chat key published the next time they open a chat. Publishing it costs the usual small fee, so an
account with no BLURT left needs some first. The `www` note in v1.21.11 applies when you upgrade from
v1.21.10 or earlier. **Every instance must run v1.21.1 or later before 2026-11-01 00:00 UTC.**

## BunkerWeb replaced the site's error answers

- **What happened.** BunkerWeb's `REVERSE_PROXY_INTERCEPT_ERRORS` is `yes` by default. It swaps every
  400, 401, 403, 404, 405, 413, 429 and 500–504 answer from the site for BunkerWeb's own HTML error
  page. Morphit's indexer and relay answer refusals as JSON with a reason, and the app acts on that
  reason.
  - Seen on morphit.io (v1.21.10): asked directly, the indexer answered a missing chat key correctly
    (404, "no chat identity for @…"); through BunkerWeb, the same request got its HTML page.
  - None of Morphit's code had changed: every BunkerWeb site has had this since BunkerWeb went in.
  - The bio save was a real refusal by the chain. The account had 0.076 BLURT left, and the save
    costs about 0.11 (see below).
- **What it broke, everywhere the app reads an error answer:**
  - **Chat.**
    - Opening a chat for the first time looks up your own chat key, and "not found" is the signal to
      publish it. With BunkerWeb's page instead, the app could not tell, so it never published the key.
      Nobody could write to a member who joined after BunkerWeb went in.
    - A message to such a member showed "Malformed response from indexer (status 404)" instead of
      "they have not set up chat yet".
  - **Profile.** A member with no profile yet could not save a display name, bio, website or links
    from Settings: the page read "no profile yet" as a failed load and kept saving off. (An avatar
    could still be saved, and that created the profile.)
  - **Every chain write** (chat, profile, listings, feedback, sending, paying):
    - The chain's reason for a refusal was lost, so the user never saw "not enough BLURT", "your
      device's clock is off", "wrong key" or "too large".
    - The broadcast service's "this is already on the network, do not send it again" warning was lost
      too, inviting a second payment.
  - **Listings.**
    - A listing just posted showed "failed to load" instead of "still posting", and the edit page
      skipped its wait for the indexer.
    - A gone listing read "load failed" instead of "not found", and the feature-bid form's "listing
      not found" never showed.
  - **Sign-up.**
    - Every relay refusal became "the chain rejected…": signups paused, the daily limit reached (and
      its voucher steps), "try again in N minutes", a name already taken.
    - After a sign-up whose result was unknown, the safe retry of your own name was lost.
  - **Elsewhere.** Compare-orderbook reasons, the login QR "not in the directory" screen, push and
    email notification setup errors, and the explorer's "history is busy, retrying" wait.
- **Now.** `REVERSE_PROXY_INTERCEPT_ERRORS=no`: the site's own answers reach the browser unchanged, with
  their status and reason. BunkerWeb's own answers (a firewall block, a request limit) keep its pages.
  - **New installs** set it (the Ansible template and `bunkerweb.env.example`).
  - **On installed boxes,** `morphit-ops upgrade`:
    - sets it, and turns off every copy of the line (an operator's own `yes` too: the app cannot work
      with it);
    - recreates BunkerWeb's services (a plain restart keeps a container's old settings);
    - checks a chat key that cannot exist: it must come back as the indexer's own JSON answer, not
      BunkerWeb's page;
    - if the page still comes back, recreates them once more (not while BunkerWeb is still loading)
      and checks again;
    - failing that, gives the exact command to run. When BunkerWeb's Compose service sets the
      setting itself, it says where.
- **When a page comes back anyway** (a firewall in front of the site, or a box not upgraded yet), the app
  says who answered instead of "Malformed response":
  - "Your Morphit server's web firewall answered with its own page instead of the indexer's reply
    (status 404), so the reason was lost…"
  - "…could not reach its indexer (status 502)…"
  - "…is limiting requests right now (status 429)…"
  - A chain refusal whose reason was replaced says that the reason was replaced.

## Account names that end like a file

- **What happened.** A Blurt name can end in `.old`, `.git`, `.bak`, `.svg` and the like (each part of
  a name is 3 or more characters). The web server's rule that hides leftover files (`.env`, `.sql`,
  `.bak` …) and its rule for SVG images matched every address. That included the API and the app's
  pages:
  - `/v1/chat-identity/bob.old` got the web server's own 404 page, so that member's chat key was
    never published.
  - `/en/@bob.old` (the profile) and `/en/chat/max.svg` (the chat) answered 404 instead of the app.
- **Now.** The API (`/v1/`, `/relay/`) is never matched by those rules. Under a language path, every
  such address is a page of the app, never a file. A leftover file elsewhere is still never served:
  missing or not, the answer is the same 404.
- **Where.**
  - **BunkerWeb sites:** the frontend container's nginx. The upgrade reads its running config and
    rebuilds it from this release when it has the old rules.
  - **Bare-metal nginx sites:** the upgrade rewrites the two rules in the site's own `web.conf` copy,
    tests it with `nginx -t`, reloads, and checks what nginx loaded.
  - Checked on a real nginx 1.24 with both shipped configs, and with v1.21.11's `web.conf` after the
    upgrade's rewrite.

## Bans on BunkerWeb sites

- Morphit counts only 401, 405 and 444 towards BunkerWeb's bad-behavior bans, at 50 a minute, banning
  for an hour (the install template).
  - A 404 is a member with no chat key or profile yet, or the app checking for a file; a 403 is
    BunkerWeb's own answer to a banned visitor; a 429 is a short burst.
  - Earlier upgrades only took 400 out of BunkerWeb's default list. A box without the template's lines
    therefore kept counting 403, 404 and 429, at BunkerWeb's 10 a minute with a ban of a day.
  - Ordinary browsing could ban a real visitor for a day.
- **Now.** The upgrade sets Morphit's list where BunkerWeb's default or the earlier upgrade's list is in
  force (an operator's own list only loses 400). It sets the threshold, window and ban time where they
  are missing.

## Out of BLURT

- Blurt charges every transaction a fee from the account's liquid BLURT: 0.050 BLURT per operation plus
  0.200 BLURT per KB of the whole signed transaction. These are the witnesses' current settings, as the
  chain reported them on 2026-10-19.
  - A short-bio save costs about 0.11 BLURT.
  - The avatar in this report (5.8 KB on chain) cost about 1.2 BLURT.
- When the balance cannot cover the fee (or a payment), the chain refuses with "Account does not have
  sufficient funds…".
- That refusal now reads **"Broadcast rejected due to insufficient funds. Buy BLURT to save more data
  to the chain."** in all 10 languages. It shows on every screen that writes to the chain: settings,
  chat, feedback, posting and editing a listing, featuring a listing, sending, powering up and down,
  and paying in a chat.
