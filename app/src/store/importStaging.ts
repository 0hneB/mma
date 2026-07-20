import { useSyncExternalStore } from "react";
import { bboxTupleToBounds, isVirtualLocation } from "@/types";
import type { EditorImportPreview } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { log } from "@/lib/util/log";
import { mmaBufUrl } from "@/lib/util/util";
import { fitMapToBounds } from "@/lib/map/mapState";
import { getSettings } from "@/store/settings";
import { whenSceneSettled } from "@/lib/render/sceneStore";
import {
	subscribeStore,
	bumpStore,
	mutate,
	getCurrentMap,
	getCurrentMapId,
	getActiveLocation,
	getWorkArea,
	setWorkArea,
	updateMapMeta,
	waitForInflightPersist,
	cancelAutosave,
	scheduleAutoCommit,
} from "./useMapStore";

/** Parsed-but-not-committed import shown while `workArea === "import"`. */
export interface ImportStaging {
	preview: EditorImportPreview;
	source: "file" | "paste";
}

let importStaging: ImportStaging | null = null;
let importPreviewPositions = new Float32Array(0);
let importMarkerVersion = 0;

export function useImportStaging() {
	return useSyncExternalStore(subscribeStore, () => importStaging);
}

export function useImportMarkerVersion() {
	return useSyncExternalStore(subscribeStore, () => importMarkerVersion);
}

export function getImportPreviewPositions() {
	return importPreviewPositions;
}

export function getImportStaging() {
	return importStaging;
}

/** Reset import state (called when map edit state is cleared). */
export function resetImportState() {
	importStaging = null;
	importPreviewPositions = new Float32Array(0);
}

/** Bump the import marker version (used by staged location preview). */
export function bumpImportMarkerVersion() {
	importMarkerVersion++;
}

async function setImportStagingInternal(preview: EditorImportPreview, source: "file" | "paste") {
	let positions = new Float32Array(0);
	try {
		const resp = await fetch(mmaBufUrl(preview.previewPositionsPath));
		if (!resp.ok) throw new Error(`preview fetch ${resp.status}: ${await resp.text()}`);
		positions = new Float32Array(await resp.arrayBuffer());
	} catch (e) {
		log.error("[import] preview positions fetch failed:", e);
	}
	importStaging = { preview, source };
	importPreviewPositions = positions;
	importMarkerVersion++;
	setWorkArea("import");
	if (getSettings().panToImported)
		fitMapToBounds(bboxTupleToBounds(preview.bounds), 100, getSettings().pastePadding);
}

/** Import from a known file path. Used by file picker and drag-and-drop. */
export async function beginImportFromPath(path: string) {
	await setImportStagingInternal(await cmd.storeImportPreview(path), "file");
}

/** Stage pasted text for preview. Throws if no locations are found. */
export async function beginImportPaste(text: string) {
	await setImportStagingInternal(await cmd.storeImportPastePreview(text), "paste");
}

/** Commit the staged import, optionally dropping fields and applying a bulk tag. */
export async function confirmImport(droppedFields: string[], tagName?: string) {
	if (!importStaging) return null;
	await waitForInflightPersist();

	const r = await cmd.storeImportFile(droppedFields, tagName?.trim() || null);
	cancelImport();
	await mutate(() => Promise.resolve(r));

	const map = getCurrentMap();
	if (map && r.settings && Object.keys(r.settings).length) {
		await updateMapMeta({ settings: { ...map.meta.settings, ...r.settings } });
	}

	if (r.autoCommit) {
		const mapId = getCurrentMapId();
		if (mapId) {
			await whenSceneSettled();
			cancelAutosave();
			await waitForInflightPersist();
			scheduleAutoCommit(mapId, r.importedCount);
		}
	}
	return r;
}

/** Discard the staged import without committing. */
export function cancelImport() {
	importStaging = null;
	importPreviewPositions = new Float32Array(0);
	importMarkerVersion++;
	const active = getActiveLocation();
	if ((active && isVirtualLocation(active)) || getWorkArea() === "import") {
		setWorkArea("overview");
	} else {
		bumpStore();
	}
}
