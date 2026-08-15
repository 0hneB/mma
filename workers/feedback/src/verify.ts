/** Verification primitives shared by the intake and reply routes.
 *
 *  The proof-of-work rule here must stay identical to the solver in
 *  `app/src-tauri/src/feedback.rs`; the two are a matched pair and there is no negotiation
 *  step between them. */

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

export function leadingZeroBits(bytes: Uint8Array): number {
	let n = 0;
	for (const b of bytes) {
		if (b !== 0) return n + Math.clz32(b) - 24;
		n += 8;
	}
	return n;
}

/** `challenge` is the SHA-256 of the submitted body, so a nonce is bound to the exact text
 *  it was solved for and cannot be reused for a different report. */
export async function verifyPow(challenge: string, nonce: number, bits: number): Promise<boolean> {
	if (!Number.isInteger(nonce) || nonce < 0) return false;
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${challenge}:${nonce}`));
	return leadingZeroBits(new Uint8Array(digest)) >= bits;
}

/** Constant-time string compare, so a reply token cannot be recovered byte by byte. */
export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
