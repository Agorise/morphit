# Morphit v1.3.0

## Existing Blurt accounts can now spend

Until now, signing in with a Posting key made Morphit read-mostly: the wallet's **Send** button was hidden outright, paying a trade partner in chat was blocked, and the BLURT listing fee was unreachable. The old advice — *"sign in with your 12-word seed or Keyfile"* — was advice for something no long-time Blurt user has.

Morphit now asks for your **Active key** at the moment it's needed, in all three places, and resumes exactly where you left off. Nothing you typed is lost.

- It accepts either an **Active key (WIF)** or your **pre-fork Blurt master password**, and works out which you gave it.
- It checks the key against the account's on-chain authorities before doing anything.
- It **refuses your Owner key**, and says so plainly. If your master password derives Owner but not Active, it refuses that too rather than quietly reaching for the most dangerous key you have.
- By default the key signs once and is **erased from memory**.

## Keep my Active key on this device

If you choose to, Morphit will store your Active key on this device, encrypted with your Morphit password — and then your **Keyfile contains both your Posting and Active keys**. No other Graphene-chain wallet offers an existing account an encrypted, portable key backup like this.

Three promises:

- **Never silent.** You chose Posting-only deliberately. The default answer is still "forget it".
- **Your password is the gate.** Possession of the Active key alone cannot rewrite a keystore.
- **Disk only if disk.** If you never asked Morphit to remember you on this device, nothing is written to it.

Your Owner and Memo keys are never held, and there is **no 12-word seed** for an imported account — a seed *derives* keys, and it cannot be built backwards from keys you already had. Morphit says so instead of pretending otherwise.

A red dot on your avatar tells you when you're holding key material you haven't backed up yet.

## Fixed: "Missing Posting Authority"

Signing into two different accounts in two browser tabs could leave one tab holding the first account's keys while believing it was the second. Every broadcast it made — display name, short bio — was rejected by the blockchain, which dumped three key authorities at you by way of explanation.

The account Morphit signs for is now derived from the signing key itself, not from a value another tab can overwrite. This also covers the order-with-fee transaction, which moves money.

## Also in this release

- The chat header now reads like an order card: larger avatar, display name with the new-trader sprout, then the posting key, trade count and reputation. On a phone the reputation moves up beside the name rather than wrapping. The LIVE indicator moved into the ⋮ menu.
- The orderbook no longer claims "1 of 3 slots filled today" when nothing is featured.
- Clearer wording on the Settings → RPC endpoints card.
