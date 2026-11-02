# Morphit v1.21.21

Fixes for people using the site: animated avatars, the avatar in the top-right corner, the heart picture shown for
an account, signing in when the Blurt network is slow, and avatars that could slow down other people's screens.
Nothing about fees, trades or the chain changes.

## For people using the site

**Animated SVG avatars move.** An animated SVG used to reach the chain as one still frame: the upload removed every
animation and every filter effect (blur, glow, shadow, colour changes). Both are now kept. Anything that could link
somewhere, run code or load something from elsewhere is still removed. An avatar uploaded before this release was
saved without its animation, so **upload it again** to make it move. An animated GIF still becomes a still picture
(a moving GIF does not fit the 6 KB an avatar may take on the chain); the upload page now says so.

**An avatar can no longer slow down everyone else's screen.** Filter effects are held to a size that suits a small
picture, and copies of a part of the picture can no longer multiply into thousands. One account could otherwise have
made the orderbook crawl for everyone who looked at its orders. A picture that asks for more filter work than an
avatar needs keeps all its shapes and drops only its effects. Ordinary avatars, animated ones included, look exactly
as before.

**Your avatar shows in the top-right corner, and everywhere else.** Some older accounts that had set an avatar got
the heart picture in the top-right corner, in the orderbook and in chat, even after signing out and in again. Only
their own profile page showed the avatar. Every page now shows it.

**One heart picture per account.** An account without an avatar showed one heart on its profile page and in the
block explorer, and a different one in the top-right corner and everywhere else. It is now the same heart
everywhere, on every Morphit site that runs v1.21.21.

**Signing in no longer says "Something unexpected went wrong" when the network is slow.**

- A pasted posting key is checked against the Blurt network straight away, while you type your new password.
- If the network does not answer, the check tries again by itself.
- If you press "Unlock my account" while it is still trying, a calm note says the network is slow and that this is
  not caused by anything you did. The password fields wait with it. You are signed in as soon as the network
  answers, or you can press Stop, which stops at once.
- If the network is slow to say which account the key belongs to, the Username field appears with a calm note: type
  your username, or just wait.
- Signing in with a 12-word seed or a key file also keeps asking for the account name by itself, instead of sending
  you to type it on the settings page after one slow moment.
- A red message now appears only for something you can fix: a mistyped key, an Active, Owner or Memo key (named
  right under the key field, before you type a password), or a username that does not hold the key.

## For operators

Nothing to do: upgrade as usual. The fixes above are in the site and the indexer that the upgrade installs.

## For monitoring scripts: changed JSON

- `GET /v1/profiles?accounts=…` also returns an account that has a profile but no `accounts` row (an older account
  this indexer never recorded); its `posting_pubkey` is `null`. It used to leave such an account out.
- `POST /v1/chain/key-references` answers `502` when nothing was found and the chain or the indexer's own table
  could not be read. It used to answer `200` with `{"accounts": []}`, which reads as "no account has this key".
