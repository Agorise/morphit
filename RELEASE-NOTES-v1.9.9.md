# Morphit v1.9.9

This release is about the documentation — the guides and references that help you run a Morphit node. Nothing about how Morphit itself works has changed, and the on-chain release format is unchanged and fully backward-compatible.

## An easier home-hosting setup guide

Setting up a node on a computer at home just got easier to follow. The "Run a Morphit node" guide now walks you more carefully through the home-networking steps:

- It shows the exact `http://` addresses to type when opening your router's settings.
- If those don't open your router, it gives you a one-line command to find its real address.
- It adds a concrete "is my door actually open?" test: you put up a temporary page on your machine and check it from your phone on mobile data — like a real outside visitor — before going live. The guide spells out exactly what seeing your test page (success) or a timeout (forwarding not reaching the machine yet) each mean, so you can fix a home setup with confidence instead of guesswork.

## More accurate operator documentation

The operations manual had a thorough, line-by-line accuracy pass against the actual software. A number of small drifts — commands, file permissions, service-account details, and technical descriptions that no longer matched the code — were corrected, along with the fees-and-rewards reference and the internal design notes. The result is documentation you can follow with more confidence, whether you are setting up your first node or running one day to day.
