# Morphit v1.9.7

## Hardware-key (YubiKey) enrollment

Binding a YubiKey to your keystore as a second unlock method now speaks the full HMAC-SHA1 challenge-response protocol to your key over the browser's hardware-device connection. If you have a YubiKey with a slot configured for challenge-response — set it up with Yubico's free **YubiKey Manager** app, slot 2 by convention — you can enroll it from **Settings → Hardware key** in a Chromium browser (Chrome, Edge, or Brave). Enrollment always proves your key is genuinely answering before it commits anything, and your passphrase and 12-word seed phrase always remain, so a key that isn't set up for this can never lock you out.

## Clearer YubiKey setup guidance

The enrollment card used to point you at the wrong tool for configuring your key. It now names the correct one — **YubiKey Manager**, which programs the challenge-response slot — instead of Yubico Authenticator, which manages one-time codes and can't set up the slot. The slot picker also explains, in plainer terms, why slot 2 is the usual choice.

## A tidier download page

The "Why so many mirrors?" note on the download page no longer carries a stray line about mirrors that were "coming soon." Every mirror listed is live, and each is still verifiable against the signed tag and the on-chain SHA-256.

## Smaller touches

- **Clearer key-entry hints.** The fields where you paste a posting or active key now show the correct example format — **"5J… or 5K…"** — since those private keys always begin with 5J or 5K.
- **A nudge toward a strong password.** When you first set the password that unlocks Morphit on your device, the hint now reminds you to choose a **strong** password of at least 8 characters.
- **Order terms look sharper.** When you use Markdown in your order terms, the bullet points, numbered-list numbers, and horizontal rules now render in Morphit's brand green — matching the quote blocks.

## For operators

There is nothing new to do. This release changes the web app and its wording only — no new operator steps, and the on-chain release format is unchanged and fully backward-compatible.
