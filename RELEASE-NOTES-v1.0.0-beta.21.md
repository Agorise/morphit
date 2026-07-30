# Morphit v1.0.0-beta.21

A sign-in and account-setup release. The headline fix is that signing in with a
Blurt posting key — and the final naming step of creating a brand-new account —
now work in the browser; both were crashing on a low-level type mismatch that
only showed up in the browser build, never in tests. On top of that, signing in
got clearer end to end: you can sign in with a seed phrase, a JSON keyfile, or a
posting key from one screen, the account-name box checks your name against Blurt
as you type, and the error messages now tell you exactly what went wrong instead
of a generic "import failed." New accounts now also receive all four of their
Blurt keys, each copyable and downloadable, with a plain warning about never
sharing them. A couple of smaller annoyances — the order book's filter menus not
closing when you tapped away, and the FAQ search jumping the page when you
pressed Enter — are fixed too.

For operators: there's nothing required beyond deploying this build. Everything
in this release is on the visitor side — there are no configuration, service, or
command changes since beta.20.

## Fixed

- **Signing in with your posting key now works.** Pasting a Blurt posting key to
  sign in was failing with a generic "import failed" message. The cause was a
  low-level type mismatch (a key was handed to the Blurt library as the wrong
  kind of byte array) that only surfaces in the browser, so automated tests
  never caught it. It's fixed, and the same fix also repairs the final
  name-registration step when creating a brand-new account, which was hitting the
  identical problem.
- **The order book's filter menus close when you tap away.** Opening the Asset,
  Fiat, or Payment filter and then tapping somewhere else — including up in the
  page header — used to leave the menu stuck open. All three now close on an
  outside tap.
- **FAQ search no longer jumps the page when you press Enter.** Typing a question
  and pressing Enter used to scroll the page to a seemingly random spot. Enter is
  now ignored in the FAQ search; you pick an answer from the suggestions list by
  tapping it.

## Improved

- **Sign in with a seed phrase, a JSON keyfile, or a posting key — from one
  screen.** The sign-in screen now says exactly that, the "go back" link is a
  real link, and the wording around using a posting key is clearer about what it
  can and can't do (you can read, post, and trade, but changing your account keys
  still needs a wallet like blurtwallet.com).
- **The account-name box checks your name as you type.** It strips a leading "@"
  for you, turns red if you type a character that can't be in a Blurt username,
  and — once you've typed a valid name — quietly confirms with a "looks good!"
  that the account actually exists on Blurt.
- **Much clearer sign-in errors.** Instead of one generic failure message, the
  sign-in flow now tells you precisely what happened and highlights the field at
  fault: you pasted your master password instead of your posting key; you pasted
  the wrong *kind* of key (owner, active, or memo); the key is valid but belongs
  to a different account; the account name wasn't found; or the Blurt network
  couldn't be reached (which is a connection problem, not a problem with your
  key).
- **Pasting a seed phrase is more forgiving.** If you paste a seed with commas
  between the words, or with capital letters, Morphit tidies it up for you when
  you click away from the box.

## New

- **New accounts now receive all four Blurt keys.** When you create an account,
  you can reveal your owner, active, posting, and memo keys, each with a one-tap
  copy button and a "download as a text file" option. A prominent warning
  explains, in plain language, that anyone holding one of these private keys has
  full control of the account and its funds — so they should never be shared with
  Morphit, support, friends, or any website. (Morphit never uses a master
  password; these individual keys are what you keep.) The same panel is available
  later from the Back up my keys page.

## Under the hood

- **New key-handling helpers, each proven to match the Blurt library exactly.**
  This release adds the ability to write out a private key in the standard Blurt
  WIF format, to recognise when someone has pasted a master password instead of a
  key (by comparing only public, on-chain information — never an oracle for any
  secret), and to derive the four-key backup set. Each is verified byte-for-byte
  against the reference Blurt library, both in-sandbox and by automated checks
  that run on every build, and none of this key material is ever logged, stored,
  or sent over the network.
- **Regression guards for the sign-in and order-book fixes.** New automated
  checks pin the posting-key conversion, the master-password detection, the seed
  tidy-up, the four-key derivation, and the order book's tap-away-to-close
  behaviour, so a future edit can't quietly undo them.
- **Translation upkeep.** Every new piece of on-screen text ships in all ten
  languages, and an unused leftover string was removed.
