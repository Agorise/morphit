/**
 * Minimal ambient declaration for the `qrcode` npm package.
 *
 * Morphit uses qrcode lazy-loaded inside the QrPanel component
 * to render per-asset payment URIs as scannable QR codes (BTC,
 * XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR — see
 * `buildPaymentUri` in `apps/web/src/lib/chat/payload.ts` for the
 * canonical per-asset URI shape).  We declare only the API surface we actually call — the package
 * is not installed in development sandboxes, so without these
 * stubs tsc would fail to resolve the import even though the
 * import is dynamic.
 *
 * Once the package is installed (`npm install` in apps/web),
 * the package's own types ship in node_modules and these
 * declarations are superseded.  No runtime impact either way.
 */
declare module 'qrcode' {
	export interface QRCodeToStringOptions {
		/** SVG output is the smallest text-based render and the
		 *  only output type Morphit uses. */
		type?: 'svg' | 'utf8' | 'terminal';
		/** QR error-correction level.  M = ~15% recoverable; L =
		 *  ~7%; Q = ~25%; H = ~30%.  We use M as the
		 *  user-friendly default — addresses are not life-critical
		 *  and a higher correction level produces a denser QR
		 *  that's harder to scan from a screen with reflection. */
		errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
		/** Extra blank space around the QR.  4 modules per the
		 *  spec; smaller looks cleaner inside our chat bubble. */
		margin?: number;
		/** Color overrides — we leave default (black on white) for
		 *  best scan reliability across lighting conditions, but
		 *  declare for completeness. */
		color?: {
			dark?: string;
			light?: string;
		};
	}

	/** Render a string into a QR code as the requested format.
	 *  When `type: 'svg'`, returns the SVG markup as a string
	 *  ready to inject into the DOM.  We use SVG because:
	 *    - Resolution-independent (sharp on any zoom level)
	 *    - No <canvas> dependency
	 *    - Just inline as innerHTML; no extra bytes for image
	 *      encoding overhead. */
	export function toString(text: string, options?: QRCodeToStringOptions): Promise<string>;
}
