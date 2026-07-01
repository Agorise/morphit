# Morphit v1.0.0-beta.29

This release is mostly about making your account protection more trustworthy and
your wallet and profile screens more accurate. The biggest work happened in the
parts you can't see — the code that guards your keys — but there are also a number
of visible fixes across the wallet, the profile, sign-up, the block explorer, and
the operator tools, plus a new FAQ entry explaining why Morphit is licensed the way
it is.

Nothing here changes how trading works, what anything costs, or what data Morphit
keeps (still none of it). If you're already signed in, you don't need to do
anything; your account, keys, and balances carry over untouched.

## Your account protection

- **Changing your password no longer risks your hardware key.** If you protect your
  account with a YubiKey, changing your password used to quietly drop the hardware
  key — afterwards the key could no longer unlock you. That's fixed: a password
  change now keeps every unlock method you've set up exactly as it was, hardware key
  included. (Two-factor authenticator codes were always preserved, and still are.)

- **Enrolling a hardware key now proves it actually works first.** When you add a
  YubiKey, Morphit now checks that the key produces a real, unique response before it
  trusts it for unlocking — and refuses to finish if it can't. This closes a subtle
  way a misbehaving key or browser could have left you with a "protected" account
  that wasn't genuinely protected. Your password remains a fallback, so a bad key can
  never lock you out.

- **A long-standing flaw in the encrypted key store was fixed.** A wrong internal
  setting meant the hardware-key / layered key-store path could fail when writing —
  it now works correctly. This path requires a physical key, so it never affected
  password-only accounts.

## Wallet and profile

- **Voting power now matches your Blurt wallet.** The "Voting" figure on your balance
  card and on explorer account pages now uses the same calculation Blurt's own wallet
  shows, to two decimals, instead of a different measure that could read low.

- **The balance card refreshes on demand and animates changes.** A refresh button
  (matching the one on explorer pages) lets you pull fresh numbers, and changed
  balances count up smoothly rather than jumping.

- **Your profile picture is consistent everywhere.** The little identicon in the
  account menu now always matches the one on your profile and settings — it used to
  occasionally show an older version until a full page reload.

- **Clearer sign-up.** While you type a username, the claim button now previews
  "Claim my @yourname username now" in real time, the field shows a clear invalid
  state when a name is taken or reserved, and the "are you sure you want to leave?"
  prompt wording is plainer.

- **Smaller touches.** The on-screen private key now carries a lock icon so it's
  obvious it's secret; low-balance hints are now a readable amber with a warning
  icon; a duplicate "sign out" button was removed from settings (the one in the
  account menu stays); and several support and explorer links now open correctly in
  a new tab.

- **Block explorer link fixes.** Transaction and block links that could land on a
  "not found" page now resolve correctly, and the account page shows all four Blurt
  key types (owner, active, posting, memo).

## Connectivity

- **The node list is clearer and sortable.** Your settings now list the relay/index
  nodes best-first, with a refresh button to re-check their speeds, latencies shown
  in seconds (turning amber when a node is slow), a plain "Error: <code>" when a node
  is failing, and the full set of network nodes shown — including the ones your
  browser can't reach directly but your instance uses behind the scenes.

## A note on the license

- **New FAQ: "Why does Morphit use the AGPL-3.0 license?"** A short, plain-language
  explanation of the privacy-and-freedom reasoning behind Morphit's copyleft license
  — why it's a better fit than permissive or no-license alternatives for software
  meant to be forked and run by anyone. The "AGPL-3.0" text in the footer now links
  straight to it.

## For operators

- **Two i2p addresses, not one.** Your instance can now advertise both an
  always-resolvable `.b32.i2p` address and a human-readable `.i2p` vanity address
  (either, both, or neither), set independently. Existing single-address setups keep
  working.

- **Editing one alternate address no longer wipes the others.** A bug in the main
  `morphit-ops` menu could erase your Tor, i2p, or Nostr addresses when you edited a
  different one. Editing alternate-network addresses now keeps the values you don't
  touch, the same way Branding & SEO already did. If your live instance lost its Tor
  onion to this, you can re-add it from the dedicated alt-address command without
  waiting — it's per-network and won't disturb the rest.

- **Node-health shows your sign-up funding at a glance.** The `morphit-ops` node
  health view now surfaces your relay's account-creation funding status alongside
  version and uptime.

- **The desktop "update available" prompt now appears reliably,** and a caching bug
  that made the footer occasionally "forget" your instance's name (and could serve
  stale data on mobile) is fixed; the fix heals itself on the next deploy with no
  hard reload needed.

- As with recent betas, **this release changes no third-party dependencies.**

## Under the hood

- **The cryptographic core of both two-factor methods is now covered by automated
  tests** for the first time — the full hardware-key enroll-and-unlock round trip and
  the authenticator-code enroll-and-verify flow, including that codes survive a
  password change, plus the new enrollment-verification guard described above.

- **The hardware-key USB transport has a complete, documented diagnosis of what still
  needs fixing on real hardware.** The browser-to-key byte protocol has known issues
  that can only be verified and corrected with a physical key in hand; rather than
  guess, the exact problems are now written down in the code, and the enrollment
  guard above prevents an unverified key from ever being trusted in the meantime.
