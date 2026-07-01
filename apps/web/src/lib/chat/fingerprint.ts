/**
 * Morphit chat — out-of-band fingerprint computation.
 *
 * REVISIT-LIST item 11.  Opt-in, hidden-by-default protection
 * against malicious-indexer MITM on chat-key delivery.
 *
 * ─── Threat model ──────────────────────────────────────────
 *
 * By default Morphit chat is TOFU: the indexer hands each side
 * the counterparty's published X25519 chat pubkey, and the
 * client trusts whatever it receives.  A hostile indexer could
 * substitute attacker-controlled keys on both sides
 * simultaneously, MITM the entire conversation, and neither
 * client would notice.
 *
 * The fingerprint feature lets two users OPTIONALLY verify
 * that they see the same key for each other by computing a
 * deterministic 8-word phrase from `(my_pub, peer_pub)` on
 * each side and comparing the words via a trusted out-of-band
 * channel (voice call, in person, different platform).  If
 * both sides see the same 8 words, no MITM occurred.
 *
 * If the words differ → either MITM in progress, or one user's
 * client is reading a different peer's pubkey.  Either way,
 * stop trusting the conversation until you understand why.
 *
 * Fingerprint comparison only protects against MITM.  It does
 * NOT prove the person on the other end of the OOB channel is
 * who they say they are — the user has to recognize their
 * counterparty's voice, face, etc.  Documented in the FAQ.
 *
 * ─── Black-hat audit ───────────────────────────────────────
 *
 * 1. *Asymmetric fingerprint.*  Alice and Bob must compute the
 *    SAME fingerprint despite their inputs being mirror-images
 *    (alice has alice_pub + bob_pub; bob has bob_pub +
 *    alice_pub).  We sort the two pubkeys lexicographically
 *    BEFORE hashing, so both sides feed identical input.
 *
 * 2. *Pre-image attack on a target fingerprint.*  Attacker
 *    wants to produce a fake X25519 pubkey K' such that
 *    fingerprint(real_pub, K') == fingerprint(real_pub,
 *    legit_pub).  Cost: 2^64 grinds (output is 8 bytes = 64
 *    bits).  At 10^9 grinds/sec, ~584 years per attempt.
 *    Comfortably infeasible.  Headroom against future Moore's-
 *    law speedups: a 1000x speedup still leaves attack at
 *    ~6 months on a single machine; a 1M× speedup leaves it
 *    at ~5 hours, which would be reasonable to revisit, but
 *    we'd see that coming.
 *
 * 3. *Wordlist mistakable for a seed phrase.*  We deliberately
 *    avoid BIP39 because users might confuse 8 verification
 *    words with an asset-recovery seed and try to back them
 *    up.  We use the PGP Word List (Patrick Juola & William
 *    Beverly, 1995, public domain) — phonetically distinct,
 *    purpose-built for OOB verification, no association with
 *    crypto wallets.
 *
 * 4. *Reordering attacks.*  PGP wordlist is split into "even"
 *    and "odd" sub-lists.  Each fingerprint byte at an even
 *    index maps to the even list, odd to the odd list.  A user
 *    who reads back words in the wrong order would notice
 *    because the alternation is broken.  More importantly,
 *    swapping any two adjacent words changes the meaning since
 *    they're drawn from different sub-vocabularies.
 *
 * 5. *Encoding canonicalization.*  Hash inputs are raw 32-byte
 *    pubkeys, not their on-chain base64 encoding.  Both sides
 *    must agree on byte form; any client that decodes the
 *    on-chain pub correctly arrives at the same bytes.
 *
 * 6. *Side-channel via fingerprint computation.*  The pubs are
 *    PUBLIC values (anyone can fetch them from the indexer).
 *    Nothing secret to leak via timing.  No constant-time
 *    requirement.
 *
 * 7. *Cross-conversation linkability.*  Fingerprint is a hash
 *    of the (sorted) pubkey pair.  Knowing alice's fingerprint
 *    with bob reveals nothing about alice's fingerprint with
 *    carol — different inputs → unrelated outputs.
 *
 * 8. *Domain separation.*  Hash input is prefixed with a
 *    distinct domain tag ("morphit-fingerprint-v1") so the
 *    same byte sequence used for any other purpose (DH,
 *    signing) yields a different hash.  Forward-compat: a
 *    future v2 protocol with different parameters bumps this
 *    suffix.
 *
 * 9. *Empty / null pubkey.*  If either input is missing
 *    (peer hasn't published their chat identity yet), the
 *    function throws.  Caller surfaces "peer not ready" UI
 *    rather than computing a fingerprint over zeros.
 *
 * 10. *Length validation.*  We reject any input whose length
 *     is not exactly 32 bytes — defends against accidentally
 *     hashing a base64 string or a truncated buffer.
 *
 * 11. *Time-of-check vs time-of-use.*  The fingerprint reflects
 *     the pubkeys AT THE MOMENT of computation.  If the indexer
 *     later returns a different peer pub, future encrypts go
 *     to a different recipient than the verified fingerprint
 *     showed.  This is a chat-protocol concern (key pinning is
 *     the defense, see $lib/chat/pubPin); fingerprint
 *     verification is one INPUT to that pinning decision.
 *
 * 12. *Wordlist tampering.*  Module loaders couldn't substitute
 *     a different wordlist (the lists are private and frozen at
 *     module load).  TypeScript readonly + const enforcement
 *     prevents accidental mutation.
 *
 * The module has NO crypto-library dependency — only a
 * Web-Crypto-API call (SubtleCrypto.digest) for SHA-256.  Pure
 * fn shape lets the smoke runner exercise it from tsx without
 * a sodium build.
 *
 * (We could use BLAKE2b for theoretical alignment with the
 * rest of the chat module's KDF, but SHA-256 from Web Crypto
 * is universally available, has no library install, and is
 * equally suitable for a 64-bit fingerprint truncation.)
 */

// ─── PGP Word List (Patrick Juola & William Beverly 1995, PD) ───
//
// 256 even-indexed words + 256 odd-indexed words.  Both lists are
// frozen at module load via `as const` + readonly.  Each word
// chosen for phonetic distinctness from every other word in the
// SAME list (so within-position reads are unambiguous over voice).

const PGP_WORDS_EVEN = [
	'aardvark',
	'absurd',
	'accrue',
	'acme',
	'adrift',
	'adult',
	'afflict',
	'ahead',
	'aimless',
	'Algol',
	'allow',
	'alone',
	'ammo',
	'ancient',
	'apple',
	'artist',
	'assume',
	'Athens',
	'atlas',
	'Aztec',
	'baboon',
	'backfield',
	'backward',
	'banjo',
	'beaming',
	'bedlamp',
	'beehive',
	'beeswax',
	'befriend',
	'Belfast',
	'berserk',
	'billiard',
	'bison',
	'blackjack',
	'blockade',
	'blowtorch',
	'bluebird',
	'bombast',
	'bookshelf',
	'brackish',
	'breadline',
	'breakup',
	'brickyard',
	'briefcase',
	'Burbank',
	'button',
	'buzzard',
	'cement',
	'chairlift',
	'chatter',
	'checkup',
	'chisel',
	'choking',
	'chopper',
	'Christmas',
	'clamshell',
	'classic',
	'classroom',
	'cleanup',
	'clockwork',
	'cobra',
	'commence',
	'concert',
	'cowbell',
	'crackdown',
	'cranky',
	'crowfoot',
	'crucial',
	'crumpled',
	'crusade',
	'cubic',
	'dashboard',
	'deadbolt',
	'deckhand',
	'dogsled',
	'dragnet',
	'drainage',
	'dreadful',
	'drifter',
	'dropper',
	'drumbeat',
	'drunken',
	'Dupont',
	'dwelling',
	'eating',
	'edict',
	'egghead',
	'eightball',
	'endorse',
	'endow',
	'enlist',
	'erase',
	'escape',
	'exceed',
	'eyeglass',
	'eyetooth',
	'facial',
	'fallout',
	'flagpole',
	'flatfoot',
	'flytrap',
	'fracture',
	'framework',
	'freedom',
	'frighten',
	'gazelle',
	'Geiger',
	'glitter',
	'glucose',
	'goggles',
	'goldfish',
	'gremlin',
	'guidance',
	'hamlet',
	'highchair',
	'hockey',
	'indoors',
	'indulge',
	'inverse',
	'involve',
	'island',
	'jawbone',
	'keyboard',
	'kickoff',
	'kiwi',
	'klaxon',
	'locale',
	'lockup',
	'merit',
	'minnow',
	'miser',
	'Mohawk',
	'mural',
	'music',
	'necklace',
	'Neptune',
	'newborn',
	'nightbird',
	'Oakland',
	'obtuse',
	'offload',
	'optic',
	'orca',
	'payday',
	'peachy',
	'pheasant',
	'physique',
	'playhouse',
	'Pluto',
	'preclude',
	'prefer',
	'preshrunk',
	'printer',
	'prowler',
	'pupil',
	'puppy',
	'python',
	'quadrant',
	'quiver',
	'quota',
	'ragtime',
	'ratchet',
	'rebirth',
	'reform',
	'regain',
	'reindeer',
	'rematch',
	'repay',
	'retouch',
	'revenge',
	'reward',
	'rhythm',
	'ribcage',
	'ringbolt',
	'robust',
	'rocker',
	'ruffled',
	'sailboat',
	'sawdust',
	'scallion',
	'scenic',
	'scorecard',
	'Scotland',
	'seabird',
	'select',
	'sentence',
	'shadow',
	'shamrock',
	'showgirl',
	'skullcap',
	'skydive',
	'slingshot',
	'slowdown',
	'snapline',
	'snapshot',
	'snowcap',
	'snowslide',
	'solo',
	'southward',
	'soybean',
	'spaniel',
	'spearhead',
	'spellbind',
	'spheroid',
	'spigot',
	'spindle',
	'spyglass',
	'stagehand',
	'stagnate',
	'stairway',
	'standard',
	'stapler',
	'steamship',
	'sterling',
	'stockman',
	'stopwatch',
	'stormy',
	'sugar',
	'surmount',
	'suspense',
	'sweatband',
	'swelter',
	'tactics',
	'talon',
	'tapeworm',
	'tempest',
	'tiger',
	'tissue',
	'tonic',
	'topmost',
	'tracker',
	'transit',
	'trauma',
	'treadmill',
	'Trojan',
	'trouble',
	'tumor',
	'tunnel',
	'tycoon',
	'uncut',
	'unearth',
	'unwind',
	'uproot',
	'upset',
	'upshot',
	'vapor',
	'village',
	'virus',
	'Vulcan',
	'waffle',
	'wallet',
	'watchword',
	'wayside',
	'willow',
	'woodlark',
	'Zulu'
] as const;

const PGP_WORDS_ODD = [
	'adroitness',
	'adviser',
	'aftermath',
	'aggregate',
	'alkali',
	'almighty',
	'amulet',
	'amusement',
	'antenna',
	'applicant',
	'Apollo',
	'armistice',
	'article',
	'asteroid',
	'Atlantic',
	'atmosphere',
	'autopsy',
	'Babylon',
	'backwater',
	'barbecue',
	'belowground',
	'bifocals',
	'bodyguard',
	'bookseller',
	'borderline',
	'bottomless',
	'Bradbury',
	'bravado',
	'Brazilian',
	'breakaway',
	'Burlington',
	'businessman',
	'butterfat',
	'Camelot',
	'candidate',
	'cannonball',
	'Capricorn',
	'caravan',
	'caretaker',
	'celebrate',
	'cellulose',
	'certify',
	'chambermaid',
	'Cherokee',
	'Chicago',
	'clergyman',
	'coherence',
	'combustion',
	'commando',
	'company',
	'component',
	'concurrent',
	'confidence',
	'conformist',
	'congregate',
	'consensus',
	'consulting',
	'corporate',
	'corrosion',
	'councilman',
	'crossover',
	'crucifix',
	'cumbersome',
	'customer',
	'Dakota',
	'decadence',
	'December',
	'decimal',
	'designing',
	'detector',
	'detergent',
	'determine',
	'dictator',
	'dinosaur',
	'direction',
	'disable',
	'disbelief',
	'disruptive',
	'distortion',
	'document',
	'embezzle',
	'enchanting',
	'enrollment',
	'enterprise',
	'equation',
	'equipment',
	'escapade',
	'Eskimo',
	'everyday',
	'examine',
	'existence',
	'exodus',
	'fascinate',
	'filament',
	'finicky',
	'forever',
	'fortitude',
	'frequency',
	'gadgetry',
	'Galveston',
	'getaway',
	'glossary',
	'gossamer',
	'graduate',
	'gravity',
	'guitarist',
	'hamburger',
	'Hamilton',
	'handiwork',
	'hazardous',
	'headwaters',
	'hemisphere',
	'hesitate',
	'hideaway',
	'holiness',
	'hurricane',
	'hydraulic',
	'impartial',
	'impetus',
	'inception',
	'indigo',
	'inertia',
	'infancy',
	'inferno',
	'informant',
	'insincere',
	'insurgent',
	'integrate',
	'intention',
	'inventive',
	'Istanbul',
	'Jamaica',
	'Jupiter',
	'leprosy',
	'letterhead',
	'liberty',
	'maritime',
	'matchmaker',
	'maverick',
	'Medusa',
	'megaton',
	'microscope',
	'microwave',
	'midsummer',
	'millionaire',
	'miracle',
	'misnomer',
	'molasses',
	'molecule',
	'Montana',
	'monument',
	'mosquito',
	'narrative',
	'nebula',
	'newsletter',
	'Norwegian',
	'October',
	'Ohio',
	'onlooker',
	'opulent',
	'Orlando',
	'outfielder',
	'Pacific',
	'pandemic',
	'Pandora',
	'paperweight',
	'paragon',
	'paragraph',
	'paramount',
	'passenger',
	'pedigree',
	'Pegasus',
	'penetrate',
	'perceptive',
	'performance',
	'pharmacy',
	'phonetic',
	'photograph',
	'pioneer',
	'pocketful',
	'politeness',
	'positive',
	'potato',
	'processor',
	'provincial',
	'proximate',
	'puberty',
	'publisher',
	'pyramid',
	'quantity',
	'racketeer',
	'rebellion',
	'recipe',
	'recover',
	'repellent',
	'replica',
	'reproduce',
	'resistor',
	'responsive',
	'retraction',
	'retrieval',
	'retrospect',
	'revenue',
	'revival',
	'revolver',
	'sandalwood',
	'sardonic',
	'Saturday',
	'savagery',
	'scavenger',
	'sensation',
	'sociable',
	'souvenir',
	'specialist',
	'speculate',
	'stethoscope',
	'stupendous',
	'supportive',
	'surrender',
	'suspicious',
	'sympathy',
	'tambourine',
	'telephone',
	'therapist',
	'tobacco',
	'tolerance',
	'tomorrow',
	'torpedo',
	'tradition',
	'travesty',
	'trombonist',
	'truncated',
	'typewriter',
	'ultimate',
	'undaunted',
	'underfoot',
	'unicorn',
	'unify',
	'universe',
	'unravel',
	'upcoming',
	'vacancy',
	'vagabond',
	'vertigo',
	'Virginia',
	'visitor',
	'vocalist',
	'voyager',
	'warranty',
	'Waterloo',
	'whimsical',
	'Wichita',
	'Wilmington',
	'Wyoming',
	'yesteryear',
	'Yucatan'
] as const;

// Sanity assertions at module load — frozen to fail fast if the
// wordlists are ever accidentally truncated or expanded.
if (PGP_WORDS_EVEN.length !== 256) {
	throw new Error(`PGP_WORDS_EVEN: expected 256 entries, got ${PGP_WORDS_EVEN.length}`);
}
if (PGP_WORDS_ODD.length !== 256) {
	throw new Error(`PGP_WORDS_ODD: expected 256 entries, got ${PGP_WORDS_ODD.length}`);
}

/** Number of words per fingerprint.  8 words × 1 byte/word
 *  = 64 bits of pre-image resistance.  At 10^9 grinds/sec
 *  on a single machine, brute force costs ~2^64 / 10^9 ≈ 584
 *  years to find a collision against a target fingerprint. */
const FINGERPRINT_WORDS = 8;

/** Domain separation tag for the fingerprint hash.  Versioned
 *  so a future v2 with different parameters doesn't collide
 *  with v1 fingerprints stored or memorized by users. */
const DOMAIN_TAG = 'morphit-fingerprint-v1';

/** Length of an X25519 chat pubkey in bytes. */
const PUB_BYTES = 32;

/** Compare two byte arrays lexicographically.  Returns negative
 *  if a < b, positive if a > b, zero if equal.  We compare byte-
 *  by-byte; the arrays are guaranteed equal length (32). */
function lexCompare(a: Uint8Array, b: Uint8Array): number {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		const ai = a[i]!;
		const bi = b[i]!;
		if (ai !== bi) return ai - bi;
	}
	return a.length - b.length;
}

/** Compute the OOB fingerprint for a chat-pubkey pair.  Both
 *  sides of a conversation produce the same fingerprint when
 *  given the same (myPub, peerPub) regardless of which side is
 *  computing — we sort the inputs lexicographically before
 *  hashing.
 *
 *  Inputs MUST be raw 32-byte X25519 pubkeys.  Throws on bad
 *  length or null/undefined.  Caller (the UI) catches and
 *  surfaces "peer not ready" instead of computing over zeros. */
export async function computeFingerprint(
	pubA: Uint8Array,
	pubB: Uint8Array
): Promise<readonly string[]> {
	if (!(pubA instanceof Uint8Array) || pubA.length !== PUB_BYTES) {
		throw new Error(
			`computeFingerprint: pubA must be ${PUB_BYTES}-byte Uint8Array, got ${pubA?.length}`
		);
	}
	if (!(pubB instanceof Uint8Array) || pubB.length !== PUB_BYTES) {
		throw new Error(
			`computeFingerprint: pubB must be ${PUB_BYTES}-byte Uint8Array, got ${pubB?.length}`
		);
	}

	// Canonicalize input order: sort lexicographically.  This is
	// what makes the function symmetric — Alice and Bob feed
	// identical bytes regardless of who calls themselves "A".
	const [first, second] = lexCompare(pubA, pubB) <= 0 ? [pubA, pubB] : [pubB, pubA];

	// Build hash input: domain-tag || first || second.
	const tagBytes = new TextEncoder().encode(DOMAIN_TAG);
	const input = new Uint8Array(tagBytes.length + PUB_BYTES + PUB_BYTES);
	input.set(tagBytes, 0);
	input.set(first, tagBytes.length);
	input.set(second, tagBytes.length + PUB_BYTES);

	// SHA-256 over the canonical input, truncated to 8 bytes.
	// Web Crypto is universally available; no library install.
	// We could use BLAKE2b for stylistic alignment with the
	// chat module's KDF, but SHA-256 is fine for fingerprint
	// truncation — the security here is in the truncation
	// length (64 bits), not the choice of hash family.
	const digest = await crypto.subtle.digest('SHA-256', input);
	const digestBytes = new Uint8Array(digest);

	// Map the first 8 bytes through alternating wordlists.
	// Even-indexed bytes (0, 2, 4, 6) → PGP_WORDS_EVEN.
	// Odd-indexed bytes (1, 3, 5, 7) → PGP_WORDS_ODD.
	// Alternation defends against word-reordering errors during
	// voice readback — swapping adjacent words is detectable
	// because the alternation pattern breaks.
	const words: string[] = [];
	for (let i = 0; i < FINGERPRINT_WORDS; i++) {
		const byte = digestBytes[i]!;
		const word = (i % 2 === 0 ? PGP_WORDS_EVEN : PGP_WORDS_ODD)[byte]!;
		words.push(word);
	}
	return words;
}

/** Format a fingerprint word array for display.  Uses spaces
 *  rather than hyphens or dots — easier for users to read each
 *  word out loud distinctly during OOB comparison. */
export function formatFingerprint(words: readonly string[]): string {
	return words.join(' ');
}
