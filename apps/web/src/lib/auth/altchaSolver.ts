/**
 * Morphit — Altcha proof-of-work solver (client-side).
 *
 * Lazy-loaded. This module is imported only via `await import()`
 * from the onboarding signup flow, and only when the relay has
 * replied with an `altcha_required` status. Users who never hit
 * that branch (the vast majority) never download this chunk.
 *
 * Design: the actual PoW loop runs in a Web Worker so the main
 * thread stays responsive (critical on older phones where a
 * multi-second freeze feels like a broken app). The worker is
 * created via a Blob URL so we don't depend on any specific
 * bundler configuration for worker handling.
 *
 * The worker uses a small inline SHA-256 implementation (FIPS
 * 180-4) rather than crypto.subtle.digest — a JS implementation
 * in a tight loop is ~10× faster than awaiting subtle.digest
 * millions of times for small inputs, because subtle is
 * optimized for one large hash, not many tiny ones.
 *
 * Budget: the synchronous SHA-256 is ~60 lines. Total module
 * ~150 lines, gzipped ~2 KiB. Loaded only on altcha_required —
 * the common-case user never pays.
 */

export interface AltchaChallenge {
	algorithm: 'SHA-256';
	challenge: string; // hex
	salt: string;
	signature: string; // hex
	maxnumber: number;
}

export interface AltchaSolution {
	algorithm: 'SHA-256';
	challenge: string;
	salt: string;
	signature: string;
	number: number;
}

/**
 * Worker source as a string. Contains a tight SHA-256 brute-
 * force loop. Kept as a string so we can spawn it via a Blob
 * URL — portable across bundlers and needs no separate asset
 * pipeline.
 */
const WORKER_SOURCE = `
// Pure-JS SHA-256 (FIPS 180-4). Enough throughput for our PoW
// target. Operates on UTF-8 bytes; no dependencies.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
function rotr(x,n){return (x>>>n)|(x<<(32-n));}
function sha256(bytes){
  const bits = bytes.length*8;
  const padLen = (bytes.length%64<56?56:120)-(bytes.length%64);
  const padded = new Uint8Array(bytes.length+padLen+8);
  padded.set(bytes);
  padded[bytes.length]=0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length-4, bits>>>0);
  const H = new Uint32Array([
    0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
    0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
  ]);
  const W = new Uint32Array(64);
  for (let off=0; off<padded.length; off+=64) {
    for (let t=0; t<16; t++) W[t]=dv.getUint32(off+t*4);
    for (let t=16; t<64; t++) {
      const s0 = rotr(W[t-15],7)^rotr(W[t-15],18)^(W[t-15]>>>3);
      const s1 = rotr(W[t-2],17)^rotr(W[t-2],19)^(W[t-2]>>>10);
      W[t] = (W[t-16]+s0+W[t-7]+s1)|0;
    }
    let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (let t=0; t<64; t++) {
      const S1 = rotr(e,6)^rotr(e,11)^rotr(e,25);
      const ch = (e&f)^(~e&g);
      const T1 = (h+S1+ch+K[t]+W[t])|0;
      const S0 = rotr(a,2)^rotr(a,13)^rotr(a,22);
      const mj = (a&b)^(a&c)^(b&c);
      const T2 = (S0+mj)|0;
      h=g; g=f; f=e; e=(d+T1)|0; d=c; c=b; b=a; a=(T1+T2)|0;
    }
    H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
    H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
  }
  let out='';
  for (let i=0; i<8; i++) out += H[i].toString(16).padStart(8,'0');
  return out;
}

self.onmessage = (e) => {
  const { salt, challenge, maxnumber } = e.data;
  const encoder = new TextEncoder();
  for (let n=0; n<=maxnumber; n++) {
    const bytes = encoder.encode(salt + n.toString());
    if (sha256(bytes) === challenge) {
      self.postMessage({ ok: true, number: n });
      return;
    }
  }
  self.postMessage({ ok: false, error: 'no-solution' });
};
`;

/**
 * Solve the PoW challenge. Returns the full solution payload to
 * send back to the relay. Spawns a short-lived Web Worker so
 * the main thread (and the Svelte UI) stays responsive while
 * the brute-force runs.
 *
 * Throws if no solution is found within maxnumber attempts
 * (indicates a server misconfiguration — the issuer picks a
 * random target in [0, maxnumber] so a solution always exists).
 */
export async function solveAltcha(challenge: AltchaChallenge): Promise<AltchaSolution> {
	if (challenge.algorithm !== 'SHA-256') {
		throw new Error(`Unsupported altcha algorithm: ${challenge.algorithm}`);
	}
	const blob = new Blob([WORKER_SOURCE], { type: 'application/javascript' });
	const url = URL.createObjectURL(blob);
	const worker = new Worker(url);
	try {
		const number = await new Promise<number>((resolve, reject) => {
			worker.onmessage = (e: MessageEvent) => {
				const data = e.data as { ok: boolean; number?: number; error?: string };
				if (data.ok && typeof data.number === 'number') {
					resolve(data.number);
				} else {
					reject(new Error(data.error ?? 'altcha-failed'));
				}
			};
			worker.onerror = (e: ErrorEvent) => reject(new Error(e.message));
			worker.postMessage({
				salt: challenge.salt,
				challenge: challenge.challenge,
				maxnumber: challenge.maxnumber
			});
		});
		return {
			algorithm: 'SHA-256',
			challenge: challenge.challenge,
			salt: challenge.salt,
			signature: challenge.signature,
			number
		};
	} finally {
		worker.terminate();
		URL.revokeObjectURL(url);
	}
}
