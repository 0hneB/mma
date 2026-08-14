/* eslint-disable react-refresh/only-export-components */
import { useRef, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { mdiCloudDownloadOutline } from "@mdi/js";
import { cmd } from "@/lib/commands";
import type { ValiLocation } from "@/bindings.gen";
import { createLocation, LocationFlag } from "@/types";
import { createTags } from "@/store/useMapStore";
import { Sidebar } from "@/components/primitives/Sidebar";
import { Icon } from "@/components/primitives/Icon";
import { Tooltip } from "@/components/primitives/Tooltip";
import { ValiDownloadDialog } from "./ValiDownloadDialog";
import { log } from "@/lib/util/log";
import "./vali.css";
import { t } from "@/lib/i18n";

// The embedded Vali GUI (vendored bundle, ?host=mma) owns the whole flow: definition
// editor, tag input, generate button, progress. This side is just the bridge:
//   <- iframe  { type: "vali:generate", data, tag }
//   <- iframe  { type: "vali:cancel" }
//   -> iframe  { type: "vali:progress", progress } (forwarded vali-progress events)
//   -> iframe  { type: "vali:done", count } | { type: "vali:error", message }

const VALIG_URL = "/valig/index.html?host=mma";

async function importLocations(valiLocs: ValiLocation[], tagName: string): Promise<number> {
	let tagId: number | null = null;
	if (tagName) {
		tagId = (await createTags([tagName]))[0].id;
	}
	const locations = valiLocs.map((v) =>
		createLocation({
			lat: v.lat,
			lng: v.lng,
			heading: v.heading,
			...(v.zoom != null ? { zoom: v.zoom } : {}),
			...(v.pitch != null ? { pitch: v.pitch } : {}),
			...(v.panoId != null ? { panoId: v.panoId } : {}),
			...(v.tags.length ? { extra: { tags: v.tags } } : {}),
			flags: LocationFlag.LoadAsPanoId,
			...(tagId != null ? { tags: [tagId] } : {}),
		}),
	);
	MMA.addLocations(locations);
	return locations.length;
}

/** Vali serialises work behind a single cancel token, so a generate and a download must never
 *  overlap -- the second start would leave the first uncancellable. */
export type ValiBusy = "generate" | "download" | null;

export function valiMessageAction(
	type: unknown,
	busy: ValiBusy,
): "cancel" | "generate" | "reject" | "ignore" {
	if (type === "vali:cancel") return "cancel";
	if (type !== "vali:generate") return "ignore";
	if (busy === null) return "generate";
	return busy === "download" ? "reject" : "ignore";
}

export function ValiSidebar({ onClose }: { onClose: () => void }) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [downloadOpen, setDownloadOpen] = useState(false);
	// The ref answers the message handler synchronously; the state only drives the button.
	const busyRef = useRef<ValiBusy>(null);
	const [busy, setBusyState] = useState<ValiBusy>(null);
	const setBusy = (b: ValiBusy) => {
		busyRef.current = b;
		setBusyState(b);
	};

	useEffect(() => {
		const onMessage = async (e: MessageEvent) => {
			const post = (msg: unknown) => iframeRef.current?.contentWindow?.postMessage(msg, "*");
			const action = valiMessageAction(e.data?.type, busyRef.current);
			if (action === "ignore") return;
			if (action === "cancel") {
				cmd.valiCancel();
				return;
			}
			if (action === "reject") {
				post({ type: "vali:error", message: t("A coverage data download is still running.") });
				return;
			}
			setBusy("generate");
			const unlisten = await listen("vali-progress", (ev) =>
				post({ type: "vali:progress", progress: ev.payload }),
			);
			try {
				const locations = await cmd.valiGenerate(JSON.stringify(e.data.data));
				const count = await importLocations(locations, String(e.data.tag ?? ""));
				post({ type: "vali:done", count });
			} catch (err) {
				log.error("[vali] generate failed:", err);
				post({ type: "vali:error", message: String(err) });
			} finally {
				unlisten();
				setBusy(null);
			}
		};
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, []);

	return (
		<Sidebar
			title={t("Vali")}
			onBack={onClose}
			className="vali-sidebar"
			flush
			actions={
				<Tooltip content={t("Download coverage data")} side="bottom">
					<button
						className="icon-button"
						type="button"
						aria-label={t("Download coverage data")}
						disabled={busy === "generate"}
						onClick={() => setDownloadOpen(true)}
					>
						<Icon path={mdiCloudDownloadOutline} />
					</button>
				</Tooltip>
			}
		>
			<div className="vali-sidebar__iframe-wrap">
				<iframe ref={iframeRef} src={VALIG_URL} title={t("Vali")} />
			</div>
			<ValiDownloadDialog
				open={downloadOpen}
				onOpenChange={setDownloadOpen}
				running={busy === "download"}
				onRunningChange={(running) => setBusy(running ? "download" : null)}
			/>
		</Sidebar>
	);
}
