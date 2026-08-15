import { useEffect, useMemo, useState } from "react";
import { mdiGithub, mdiOpenInNew } from "@mdi/js";
import { Button } from "@/components/primitives/Button";
import { Checkbox } from "@/components/primitives/Checkbox";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { Icon } from "@/components/primitives/Icon";
import { Radio } from "@/components/primitives/Radio";
import { TextInput } from "@/components/primitives/TextInput";
import { cmd } from "@/lib/commands";
import {
	buildIssueBody,
	type Attachments,
	type ReportInput,
	type ReportKind,
} from "@/lib/feedback/body";
import { collectDiagnostics, type Diagnostics } from "@/lib/feedback/diagnostics";
import { isSignedIn, submitReport } from "@/lib/feedback/submit";
import { msg, t } from "@/lib/i18n";
import { log } from "@/lib/util/log";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import type { SubmittedReport } from "@/store/feedback";

const KINDS: Array<{ value: ReportKind; label: string }> = [
	{ value: "bug", label: msg("Something is broken") },
	{ value: "idea", label: msg("Suggestion") },
];

const ATTACHMENTS: Array<{ key: keyof Attachments; label: string }> = [
	{ key: "diagnostics", label: msg("App version, system and plugins") },
	{ key: "settings", label: msg("Settings you've changed") },
	{ key: "log", label: msg("Recent log") },
];

export function ReportDialog({ onClose }: { onClose: () => void }) {
	const [kind, setKind] = useState<ReportKind>("bug");
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [steps, setSteps] = useState("");
	const [attach, setAttach] = useState<Attachments>({
		diagnostics: true,
		settings: true,
		log: true,
	});
	const [showPreview, setShowPreview] = useState(false);

	const [signedIn, setSignedIn] = useState(false);
	const [anonAvailable, setAnonAvailable] = useState(true);
	const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
	const [logTail, setLogTail] = useState("");
	const [ready, setReady] = useState(false);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState<SubmittedReport | null>(null);

	useEffect(() => {
		void (async () => {
			const [who, anon, diag, tail] = await Promise.all([
				isSignedIn(),
				cmd.feedbackAnonymousAvailable().catch(() => false),
				collectDiagnostics().catch((e) => {
					log.warn(`[feedback] diagnostics failed: ${e}`);
					return null;
				}),
				cmd.feedbackLogTail().catch((e) => {
					log.warn(`[feedback] log tail failed: ${e}`);
					return "";
				}),
			]);
			setSignedIn(who);
			setAnonAvailable(anon);
			setDiagnostics(diag);
			setLogTail(tail);
			setReady(true);
		})();
	}, []);

	const anonymous = !signedIn;
	const input = useMemo<ReportInput>(
		() => ({ kind, title: title.trim(), description, steps }),
		[kind, title, description, steps],
	);
	const body = useMemo(
		() => (diagnostics ? buildIssueBody(input, diagnostics, { anonymous, attach, logTail }) : ""),
		[input, diagnostics, anonymous, attach, logTail],
	);

	const blocked = !title.trim() || !description.trim() || !diagnostics;
	const cannotSend = anonymous && !anonAvailable;
	const withheld = ATTACHMENTS.some(({ key }) => !attach[key]);

	const send = async () => {
		setSending(true);
		setError(null);
		try {
			setSent(await submitReport(input, body, anonymous));
		} catch (e) {
			setError(String(e));
		} finally {
			setSending(false);
		}
	};

	const signIn = async () => {
		setError(null);
		try {
			const info = await cmd.githubStartLogin();
			await openExternal(info.verificationUri);
			// The code has to be visible while the browser tab is open, so it goes in the
			// error slot's calmer sibling rather than a toast that would vanish.
			setError(
				t("Enter code {code} in your browser to finish signing in.", { code: info.userCode }),
			);
			await cmd.githubPollLogin();
			setSignedIn(true);
			setError(null);
		} catch (e) {
			setError(String(e));
		}
	};

	if (!ready) return null;

	if (sent) {
		return (
			<Dialog open onOpenChange={(open) => !open && onClose()}>
				<DialogContent title={t("Report sent")} className="report-dialog">
					<p className="report-dialog__sent">
						{sent.anonymous
							? t("Thanks. Replies show up in Settings, under Feedback. Check back there.")
							: t("Thanks. This was filed on your GitHub account, so replies reach you there too.")}
					</p>
					<div className="report-dialog__actions">
						<Button onClick={() => void openExternal(sent.url)}>
							<Icon path={mdiOpenInNew} size={14} /> {t("View report")}
						</Button>
						<Button variant="primary" onClick={onClose}>
							{t("Done")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		);
	}

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent title={t("Send feedback")} className="report-dialog">
				<div className="report-dialog__kinds">
					{KINDS.map((k) => (
						<label key={k.value} className="report-dialog__kind">
							<Radio
								name="report-kind"
								checked={kind === k.value}
								onChange={() => setKind(k.value)}
							/>
							{t(k.label)}
						</label>
					))}
				</div>

				{/* The one region that flexes. The preview takes it over rather than being wedged in
				    below, so showing it costs no height and nothing else moves. */}
				<div className="report-dialog__area">
					{showPreview ? (
						<pre className="report-dialog__preview">{body}</pre>
					) : (
						<div className="report-dialog__fields">
							<TextInput
								autoFocus
								placeholder={t("Title")}
								value={title}
								onChange={(e) => setTitle(e.target.value)}
							/>
							<textarea
								className="text-input report-dialog__body"
								placeholder={
									kind === "bug"
										? t("What happened, and what did you expect?")
										: t("What would you like?")
								}
								value={description}
								onChange={(e) => setDescription(e.target.value)}
							/>
							{kind === "bug" && (
								<textarea
									className="text-input report-dialog__body report-dialog__body--steps"
									placeholder={t("Steps to reproduce (optional)")}
									value={steps}
									onChange={(e) => setSteps(e.target.value)}
								/>
							)}
						</div>
					)}
				</div>

				<div className="report-dialog__meta">
					<div className="report-dialog__attachments">
						{ATTACHMENTS.map(({ key, label }) => (
							<label key={key} className="report-dialog__option">
								<Checkbox
									checked={attach[key]}
									onChange={(e) => setAttach((a) => ({ ...a, [key]: e.target.checked }))}
								/>
								{t(label)}
							</label>
						))}
					</div>
					{/* Always present, only revealed: unchecking a box must not move the rest. */}
					<p className={`report-dialog__nudge${withheld ? "" : " report-dialog__nudge--idle"}`}>
						{t("Attaching these makes bugs far easier to fix!")}
					</p>

					<div className="report-dialog__identity">
						{signedIn ? (
							<span className="report-dialog__muted">
								{t("Filing on your GitHub account. Replies reach you on GitHub.")}
							</span>
						) : (
							<>
								<span className="report-dialog__muted">
									{anonAvailable
										? t(
												"Filing anonymously. Replies come back here in the app; sign in to get them on GitHub too.",
											)
										: t("Anonymous reporting is unavailable in this build. Sign in to send.")}
								</span>
								<Button small onClick={() => void signIn()}>
									<Icon path={mdiGithub} size={14} /> {t("Sign in with GitHub")}
								</Button>
							</>
						)}
					</div>

					<button
						type="button"
						className="report-dialog__toggle"
						onClick={() => setShowPreview((v) => !v)}
					>
						{showPreview ? t("Back to the form") : t("Show exactly what will be sent")}
					</button>

					{error && <p className="report-dialog__error">{error}</p>}
				</div>

				<div className="report-dialog__actions">
					<Button onClick={onClose}>{t("Cancel")}</Button>
					<Button
						variant="primary"
						disabled={blocked || sending || cannotSend}
						onClick={() => void send()}
					>
						{sending ? t("Sending...") : t("Send")}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	);
}
