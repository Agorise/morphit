/**
 * The BLURT the relay sends each new account right after creating it.
 *
 * Blurt charges a fee for every operation, from the sender's LIQUID BLURT:
 * 0.050 per operation plus 0.200 per 1,024 bytes of the signed transaction
 * (libraries/chain/database.cpp `process_tx_fee`; the witnesses' current
 * values). A new member who wants to set up their profile before posting needs
 * to pay for each field they save — every Save on the settings page is its own
 * transaction. Measured with the real builders and the chain's serializer
 * (v1.21.13):
 *
 *   display name 0.084 · short bio 0.111 · website 0.093 · streaming 0.094 ·
 *   Nostr 0.100 · languages 0.090 · avatar up to 1.288 (the 6 KB cap) ·
 *   settings sync 0.223 per save · first order 0.177 · a short chat message
 *   0.199 (0.31 for 500 characters)
 *
 * 2 BLURT ran out after an avatar, one order and a few saves: the next field
 * (a 0.111 short bio) was refused. 4 BLURT pays for every profile field once
 * (avatar at the cap), two settings saves, the first order and about seven
 * short messages. It adds 2 BLURT to the ~100 BLURT the chain already charges
 * for each account.
 */
export const SIGNUP_DUST_BLURT = 4;
