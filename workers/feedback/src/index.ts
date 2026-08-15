/** Accountless issue intake for MMA.
 *
 *  This is a front door, not a tracker. It files the issue on GitHub and forgets it: there is
 *  no database, no user record, and no copy of the report here. The reply token is an HMAC of
 *  the issue number, so reads are authorized arithmetically rather than by lookup.
 *
 *  Signed-in users never touch this worker -- the app talks to GitHub directly as them. */

import { addLabels, createIssue, getIssue, relayedComments } from "./github";
import { hmacHex, safeEqual, sha256Hex, verifyPow } from "./verify";

export interface Env {
	/** Numeric id of the GitHub App. */
	GITHUB_APP_ID: string;
	/** PKCS#8 PEM private key for that App. */
	GITHUB_APP_KEY: string;
	/** `owner/repo` the App is installed on. */
	GITHUB_REPO: string;
	/** Signing key for reply tokens. Rotating it invalidates every outstanding token. */
	WORKER_SECRET: string;
}

/** Must match `POW_BITS` in `app/src-tauri/src/feedback.rs`. */
const POW_BITS = 20;

const MAX_TITLE = 200;
const MAX_BODY = 65_000;

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
