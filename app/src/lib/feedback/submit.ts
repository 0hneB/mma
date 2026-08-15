import type { IssueThread } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { addReport, getInstallId, updateReport, type SubmittedReport } from "@/store/feedback";
import type { ReportInput, ReportKind } from "./body";

/** Which transport a submission would use. Signed in, the issue is authored by the user and
 *  they get GitHub's own notifications; anonymous, the worker files it on their behalf. */
export async function isSignedIn(): Promise<boolean> {
	try {
		return await cmd.githubHasSession();
	} catch {
		return false;
	}
}

/** Repo-standard labels for a report kind, matching what the issue templates apply. */
export function labelsFor(kind: ReportKind): string[] {
	return ["via:app", kind === "bug" ? "bug" : "enhancement"];
}

/** File `body` as an issue and record it locally. The caller composes the body so the dialog
 *  can show the user exactly what will be sent. */
export async function submitReport(
	input: ReportInput,
	body: string,
	anonymous: boolean,
): Promise<SubmittedReport> {
	// Only the anonymous transport issues a reply token; signed-in threads are read with the
	// user's own credentials. The worker labels anonymous reports itself -- it has the push
	// access the reporter lacks.
	const ref = anonymous
		? await cmd.feedbackSubmitAnonymous(input.title, body, getInstallId())
		: {
				...(await cmd.githubCreateIssue(input.title, body, labelsFor(input.kind))),
				token: undefined,
			};
	if (!anonymous) {
		// GitHub silently drops labels sent without push access, so ask the worker to re-apply
		// them. Best-effort: an unlabelled report is still a report.
		void cmd.feedbackRequestLabel(ref.number).catch(() => {});
	}

	const report: SubmittedReport = {
		number: ref.number,
		url: ref.url,
		title: input.title,
		kind: input.kind,
		submittedAt: new Date().toISOString(),
		anonymous,
		token: ref.token,
		seenReplies: 0,
		replies: 0,
		state: "open",
		stateReason: null,
	};
	addReport(report);
	return report;
}

/** What became of one report and what has been said on it, whichever transport filed it. */
export async function fetchThread(report: SubmittedReport): Promise<IssueThread> {
	if (report.anonymous) {
		if (!report.token) throw new Error("no reply token for this report");
		return cmd.feedbackAnonymousThread(report.number, report.token);
	}
	const me = await cmd.githubMe();
	const thread = await cmd.githubIssueThread(report.number);
	// The reporter's own comments are not replies to themselves.
	return { ...thread, comments: thread.comments.filter((c) => c.author !== me?.login) };
}

/** Refresh state and reply counts for every stored report. Failures are per-report: one dead
 *  thread must not stop the rest from updating. */
export async function refreshReports(reports: SubmittedReport[]): Promise<void> {
	await Promise.all(
		reports.map(async (r) => {
			try {
				const { state, stateReason, comments } = await fetchThread(r);
				if (comments.length !== r.replies || state !== r.state || stateReason !== r.stateReason) {
					updateReport(r.number, { replies: comments.length, state, stateReason });
				}
			} catch (e) {
				log.debug(`[feedback] refresh failed for #${r.number}: ${e}`);
			}
		}),
	);
}
