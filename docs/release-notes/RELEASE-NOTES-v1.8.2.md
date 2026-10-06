# Morphit v1.8.2

## Your first message to a brand-new listing no longer goes missing

If you spotted a listing the instant it was posted and fired off a message right away, that very first message could quietly vanish — and the other person never got a notification about it. Later messages went through fine, which made it all the more confusing.

The cause was timing. A listing and the first message about it can land in the same block, and Morphit was occasionally trying to file the message before it had filed the listing it referred to — so the message had nothing to attach to and was dropped. Morphit now always records a listing before any message that mentions it, so your first hello always lands and always rings the other person's bell.

## A home for your website, and a clearer streaming link

Settings has a new **Website or Blog URL** field — a spot for your personal site or blog — sitting just above your streaming link. Your profile shows it as a small globe you can click through.

The streaming field is now simply called **Streaming URL**, and it happily takes any streaming home you like — YouTube, Twitch, Rumble, Blurt.media, whatever you use — not just one. Both fields accept any normal `https://` link (and plain `http://` too, so `.onion`, I2P, and Lokinet addresses work for the privacy-minded). If you paste something that isn't a real web link, Morphit tells you before you save.

## Plainer wording in the help pages

The FAQ and glossary now say "the blockchain" and "on-chain" in more places instead of leaning on the name of the specific chain underneath. Nothing about how Morphit works changed — just the words, so newcomers have an easier time. Where a coin is genuinely the coin you're paying a listing fee in, it's still named as itself.

## A little polish when posting

The final step of posting a listing reads more clearly now — about the small listing fee, and about the 15-minute window you get to fix a typo, or to cancel and re-list, after a listing goes up.

Your data, your keys, your trades — all untouched throughout.
