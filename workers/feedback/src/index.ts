/** Accountless issue intake for MMA.
 *
 *  This is a front door, not a tracker. It files the issue on GitHub and forgets it: there is
 *  no database, no user record, and no copy of the report here. The reply token is an HMAC of
 *  the issue number, so reads are authorized arithmetically rather than by lookup.
 *
 *  Signed-in users never touch this worker -- the app talks to GitHub directly as them. */

import { addLabels, createIssue, getIssue, relayedComments } from "./github";
import { hmacHex, imageType, safeEqual, sha256Hex, verifyPow } from "./verify";

export interface Env {
	/** Numeric id of the GitHub App. */
	GITHUB_APP_ID: string;
	/** PKCS#8 PEM private key for that App. */
	GITHUB_APP_KEY: string;
	/** `owner/repo` the App is installed on. */
	GITHUB_REPO: string;
	/** Signing key for reply tokens. Rotating it invalidates every outstanding token. */
	WORKER_SECRET: string;
	/** Images referenced by report bodies. GitHub's own attachment store is unreachable from
	 *  here -- it rejects both App installation and user-to-server tokens -- so the images a
	 *  reporter attaches live in a bucket and are served back by the route below. */
	ATTACHMENTS: R2Bucket;
}

/** Must match `POW_BITS` in `app/src-tauri/src/feedback.rs`. */
const POW_BITS = 20;

const MAX_TITLE = 200;
const MAX_BODY = 65_000;

/** Per attachment. Generous for a screenshot, small enough that the proof of work above is a
 *  real cost per megabyte stored. The app caps the count. */
const MAX_ATTACHMENT = 5 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
};

/** Marks a body as one of ours. The label route will touch nothing without it. */
const MARKER = "<!-- mma-report ";

/** The only labels this worker will ever apply, keyed by the report kind in the machine block.
 *  An allowlist rather than a passthrough: the body is written by the client, so anything read
 *  out of it is untrusted input. */
const KIND_LABELS: Record<string, string> = { bug: "bug", idea: "enhancement" };

/** The report kind declared in the body's machine block, if it is one of ours. */
export function reportKind(body: string): string | null {
	const start = body.indexOf(MARKER);
	if (start === -1) return null;
	const end = body.indexOf(" -->", start);
	if (end === -1) return null;
	try {
		const meta = JSON.parse(body.slice(start + MARKER.length, end)) as { kind?: unknown };
		return typeof meta.kind === "string" && meta.kind in KIND_LABELS ? meta.kind : null;
	} catch {
		return null;
	}
}

interface ReportRequest {
	title?: unknown;
	body?: unknown;
	installId?: unknown;
	nonce?: unknown;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function bad(message: string, status = 400): Response {
	return json({ error: message }, status);
}

async function replyToken(env: Env, number: number): Promise<string> {
	return hmacHex(env.WORKER_SECRET, `report:${number}`);
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
	let payload: ReportRequest;
	try {
		payload = (await request.json()) as ReportRequest;
	} catch {
		return bad("malformed request");
	}

	const { title, body, installId, nonce } = payload;
	if (typeof title !== "string" || typeof body !== "string" || typeof installId !== "string") {
		return bad("missing fields");
	}
	if (!title.trim() || !body.trim()) return bad("empty report");
	if (title.length > MAX_TITLE || body.length > MAX_BODY) return bad("report too large", 413);
	if (typeof nonce !== "number") return bad("missing proof of work");

	// The work is bound to this exact body, so a solved nonce cannot be recycled.
	if (!(await verifyPow(await sha256Hex(body), nonce, POW_BITS))) {
		return bad("insufficient proof of work", 429);
	}

	const kind = reportKind(body);
	const labels = ["via:app", "anonymous", ...(kind ? [KIND_LABELS[kind]] : [])];
	const issue = await createIssue(env, title, body, labels);
	return json({ ...issue, token: await replyToken(env, issue.number) });
}

/** A display name that cannot carry markup into the alt text of the reference. The extension
 *  comes from the sniffed type, never from what the client claimed. */
function safeName(raw: string | null, contentType: string): string {
	const stem =
		(raw ?? "")
			.replace(/\.[^.]*$/, "")
			.replace(/[^\w.-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "attachment";
	return `${stem}.${EXTENSIONS[contentType]}`;
}

/** Store an image and hand back the URL to reference it by.
 *
 *  Separate from the report itself because the body has to carry the URLs, so the upload has
 *  to happen first. Both tiers come through here: the app cannot reach any image host of its
 *  own, and GitHub's is closed to us. */
async function handleUpload(request: Request, env: Env): Promise<Response> {
	const bytes = await request.arrayBuffer();
	if (!bytes.byteLength) return bad("empty attachment");
	if (bytes.byteLength > MAX_ATTACHMENT) return bad("attachment too large", 413);

	const contentType = imageType(bytes);
	if (!contentType) return bad("not an image");

	const url = new URL(request.url);
	const digest = await sha256Hex(bytes);
	const nonce = Number(url.searchParams.get("nonce"));
	if (!(await verifyPow(digest, nonce, POW_BITS))) {
		return bad("insufficient proof of work", 429);
	}

	// Content-addressed: replaying the same bytes (their proof of work is replayable too)
	// overwrites the same object instead of storing another copy.
	const key = `${digest}.${EXTENSIONS[contentType]}`;
	await env.ATTACHMENTS.put(key, bytes, { httpMetadata: { contentType } });
	return json({
		url: `${url.origin}/attachments/${key}`,
		name: safeName(url.searchParams.get("name"), contentType),
	});
}

/** Serve a stored image. Keys are ours and immutable, so this is cacheable forever and needs
 *  no authentication -- the URL is the capability, and it only exists inside an issue body. */
async function handleAttachment(key: string, env: Env): Promise<Response> {
	const object = await env.ATTACHMENTS.get(key);
	if (!object) return bad("not found", 404);
	return new Response(object.body, {
		headers: {
			"Content-Type": object.httpMetadata?.contentType ?? "application/octet-stream",
			"Cache-Control": "public, max-age=31536000, immutable",
		},
	});
}

/** Apply our labels to an issue the app filed as the signed-in user.
 *
 *  GitHub silently drops labels from reporters without push access, so an outside contributor's
 *  report arrives bare however the app sends it. The installation token has push access, so the
 *  worker finishes the job. Authorization is the marker itself: this only ever adds a fixed
 *  label set, and only to an issue whose body already identifies as an app report -- so it
 *  cannot be used to label anything else in the repository. */
async function handleLabel(number: number, env: Env): Promise<Response> {
	const issue = await getIssue(env, number);
	const kind = reportKind(issue.body ?? "");
	if (!kind) return bad("not an app report", 403);
	await addLabels(env, number, ["via:app", KIND_LABELS[kind]]);
	return json({ ok: true });
}

/** What became of the report, and the replies addressed to whoever filed it. The state is what
 *  lets the app show a closed report as closed without the reporter having a GitHub account. */
async function handleReplies(number: number, token: string, env: Env): Promise<Response> {
	if (!safeEqual(token, await replyToken(env, number))) return bad("invalid token", 403);
	const [issue, comments] = await Promise.all([
		getIssue(env, number),
		relayedComments(env, number),
	]);
	return json({
		state: issue.state ?? "open",
		stateReason: issue.state_reason ?? null,
		comments,
	});
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "POST" && url.pathname === "/reports") {
			return handleSubmit(request, env).catch((e) => bad(String(e), 502));
		}

		if (request.method === "POST" && url.pathname === "/uploads") {
			return handleUpload(request, env).catch((e) => bad(String(e), 502));
		}

		const attachment = url.pathname.match(/^\/attachments\/([\w-]+\.\w+)$/);
		if (request.method === "GET" && attachment) {
			return handleAttachment(attachment[1], env).catch((e) => bad(String(e), 502));
		}

		const label = url.pathname.match(/^\/reports\/(\d+)\/label$/);
		if (request.method === "POST" && label) {
			return handleLabel(Number(label[1]), env).catch((e) => bad(String(e), 502));
		}

		const replies = url.pathname.match(/^\/reports\/(\d+)$/);
		if (request.method === "GET" && replies) {
			const token = url.searchParams.get("token");
			if (!token) return bad("missing token", 403);
			return handleReplies(Number(replies[1]), token, env).catch((e) => bad(String(e), 502));
		}

		return bad("not found", 404);
	},
};
