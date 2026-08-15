/** Verification primitives shared by the intake and reply routes.
 *
 *  The proof-of-work rule here must stay identical to the solver in
 *  `app/src-tauri/src/feedback.rs`; the two are a matched pair and there is no negotiation
 *  step between them. */

const encoder = new TextEncoder();

function hex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(data: string | ArrayBuffer): Promise<string> {
	const bytes = typeof data === "string" ? encoder.encode(data) : data;
	return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/** The image formats an attachment may be, identified by magic bytes rather than by what the
 *  client claims. A caller that could name its own content type could park anything at a
 *  github.com URL. */
export function imageType(bytes: ArrayBuffer): string | null {
	const b = new Uint8Array(bytes);
	const starts = (...sig: number[]) => sig.every((v, i) => b[i] === v);
	if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
	if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
	// RIFF....WEBP
	if (starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((v, i) => b[8 + i] === v)) {
		return "image/webp";
	}
	return null;
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
