import { useEffect, useSyncExternalStore } from "react";
import type { WorkArea, MaybeLocation } from "@/types";
import {
	isVirtualLocation,
	isImportPreview,
	LocationFlag,
	locId,
	applyLocationPatch,
} from "@/types";
import type { Location, MapData, MapMeta, Tag, ExtraFieldDef, CommitDiff } from "@/bindings.gen";
import { listen } from "@tauri-apps/api/event";
import { cmd } from "@/lib/commands";
import type {
	MutationResult,
	MapMetaPatch_Deserialize as MapMetaPatch,
	SelectionSync,
} from "@/bindings.gen";
import { emit as emitEvent } from "@/lib/events";
import { log, fireAndForget } from "@/lib/util/log";
import { hexToRgb } from "@/lib/util/color";
import { trace } from "@/lib/util/debug";
import { nowUnix } from "@/lib/util/format";
import { mmaBufUrl } from "@/lib/util/util";
import {
	setUserFieldDefs,
	mergeUserFieldDefs,
	resetForMapChange,
} from "@/lib/data/fieldDefRegistry";
import {
	planFieldMove,
	planFieldDelete,
	rewriteSelectionFields,
	type MergeWinner,
} from "@/lib/data/fieldOps";
import type { LocationPatch_Deserialize as LocationPatch, Update, TagPatch } from "@/bindings.gen";
import type { RenderDelta } from "@/bindings.gen";
import {
	SelectedIds,
	decodeSelectionBitmask,
	type ReadonlyIdSet,
	type SelCellEntry,
} from "@/lib/render/CellManager";
import { resetImportState, bumpImportMarkerVersion } from "./importStaging";
import { resetCommitDiffState } from "./commitDiff";
import { setCachedMapList, invalidateMapList, reloadMapList } from "./mapList";

/** Minimal pub/sub bus. `.on()` returns an unsubscribe function. */
function createBus<T extends (...args: never[]) => void>() {
	let handlers: T[] = [];
	return {
		on: (fn: T) => {
			handlers.push(fn);
			return () => {
				handlers = handlers.filter((h) => h !== fn);
			};
		},
		emit: ((...args: Parameters<T>) => {
			for (const h of handlers) h(...args);
		}) as T,
	};
}

/** Fires when Rust sends incremental render changes (adds/removes/patches to cell buffers). */
export const renderDeltaBus = createBus<(delta: RenderDelta) => void>();

type SelectionBitmaskHandler = (
	selColors: [number, number, number][],
	cellEntries: SelCellEntry[],
	setIds: (ids: SelectedIds) => void,
) => void;
/** Fires when selection bitmasks are resolved. Subscribers apply per-cell masks to the render overlay. */
export const selBitmaskBus = createBus<SelectionBitmaskHandler>();

import type { Selection, SelectionProps } from "@/bindings.gen";
import {
	type GroupType,
	addSelection as addSel,
	removeSelection as removeSel,
	intersectSelections,
	unionSelections,
	invertSelections,
	toggleManualSelection as toggleManual,
	setPolygonName as renamePolygonSel,
	setSelectionColors as setSelColor,
	reorderSelections,
	composeSelections as composeSels,
	composeWithChild as composeWithChildSel,
	decomposeChild as decomposeChildSel,
	removeFromComposite as removeFromCompositeSel,
	composeSiblings as composeSiblingsSel,
	replaceSelection as replaceSel,
	sampleIds,
	isolateGhostKeys,
} from "./selections";

const storeBus = createBus<() => void>();
const subscribe = storeBus.on;
const notify = storeBus.emit;

/** Subscribe to any store mutation (map open/close, rename, edits, ...). */
export const subscribeStore = subscribe;
/** Fire the store bus directly (for sibling store modules). */
export const notifyStore = notify;

/** Build a reactive store hook: subscribe to the bus, return the latest value.
 *  The value itself is the useSyncExternalStore snapshot, so consumers re-render
 *  only when its reference changes (Object.is). Two invariants follow:
 *  - getValue must return a cached/stable reference, never construct per call
 *  - mutations must reassign the published reference, never mutate in place */
function makeStoreHook<T>(getValue: () => T): () => T {
	return function useStoreValue(): T {
		return useSyncExternalStore(subscribe, getValue);
	};
}

/** Single-slot memo for values derived from store state: re-derives only when an
 *  input reference changes, so repeated calls return the same object. This is what
 *  lets a derived getter double as a hook snapshot (see makeStoreHook). Inputs
 *  must be the copy-on-write references the derivation reads. */
function memoOnRefs<const I extends readonly unknown[], O>(
	getInputs: () => I,
	derive: (...inputs: I) => O,
): () => O {
	let slot: { inputs: I; output: O } | null = null;
	return () => {
		const inputs = getInputs();
		if (!slot || slot.inputs.some((v, i) => v !== inputs[i])) {
			slot = { inputs, output: derive(...inputs) };
		}
		return slot.output;
	};
}

// --- Current map state ---
let currentMapId: string | null = null;
let currentMap: MapData | null = null;
/** Persisted bitmasks per selection key. Updated incrementally on each
 *  mutation (delta refresh) when the column store is available. */
let selections: Selection[] = [];
/** Resolved count per selection node (top-level and nested), keyed by `Selection.key`.
 *  The sole source for sidebar counts — refreshed wholesale from Rust on every sync. */
let selectionCounts: Record<string, number> = {};
/** Keys of selections that are "ghosted": kept in the list but excluded from the
 *  Rust sync, so they neither render nor count toward the selected set. Ephemeral.
 *  Reassigned on every change (never mutated in place) — it is a hook snapshot. */
let ghostedSelections: ReadonlySet<string> = new Set<string>();
let selectedLocationIds: SelectedIds = SelectedIds.EMPTY;
let activeLocationId: number | null = null;
let duplicateLocations: Location[] = [];
let workArea: WorkArea = "overview";
let activePluginId: string | null = null;
let mapVersion = 0;
let tagCounts: Record<number, number> = {};
let undoRedoState = { canUndo: false, canRedo: false };
/** Extra-field keys known to exist in location data on the current map.
 *  Populated from `StoreStatus.knownFieldKeys` on map open, extended
 *  incrementally via `MutationResult.newFieldDefs`.
 *  Treat as immutable -- reassign, never mutate in place: consumers memo on
 *  the Set's reference identity (`useMemo(..., [keys])`). */
let knownFieldKeys = new Set<string>();

/** Reactive per-tag location counts for the open map, keyed by tag id. */
export const useTagCounts = makeStoreHook(() => tagCounts);

/** Per-tag location counts for the open map, keyed by tag id. */
export function getTagCounts() {
	return tagCounts;
}

async function computeCommitDiff(): Promise<CommitDiff> {
	const [added, removed, modified] = await cmd.storeCommitDiff();
	return { added, removed, modified };
}

function getMapSnapshot() {
	return mapVersion;
}

/** Mark the current map's content dirty and re-render its consumers. */
function bump() {
	mapVersion++;
	notify();
}
/** Alias of bump() for sibling store modules. */
export const bumpStore = bump;

/** Reactive open map (metadata + settings), or null when no map is open. */
export const useCurrentMap = makeStoreHook(() => currentMap);

const NO_TAGS: Tag[] = [];
/** Tags that exist from the user's point of view. Raw `meta.tags` also holds soft-deleted ghosts (count=0, visible=false, kept for undo revival) — almost nothing outside the undo/revival machinery should enumerate those. */
export const getVisibleTags: () => Tag[] = memoOnRefs(
	() => [currentMap?.meta.tags] as const,
	(tags) => (tags ? Object.values(tags).filter((t) => t.visible !== false) : NO_TAGS),
);

export const useVisibleTags = makeStoreHook(getVisibleTags);

/** Raw by-id tag lookup — includes soft-deleted ghosts so stale references
 *  (e.g. a selection whose tag just died) still resolve to a name. */
export function getTag(id: number): Tag | undefined {
	return currentMap?.meta.tags[id];
}

/** Reactive counter bumped on every map-content change; subscribe to re-render on any edit. */
export const useMapVersion = makeStoreHook(() => mapVersion);
/** Reactive set of all currently selected location ids. */
export const useSelectedLocationIds = makeStoreHook(() => selectedLocationIds);

let cachedActiveLocation: Location | null = null;
/** Reactive location currently open in the editor, or null. */
export const useActiveLocation = makeStoreHook((): Location | null => cachedActiveLocation);
/** Reactive locations shown in the duplicate-resolution panel. */
export const useDuplicateLocations = makeStoreHook(() => duplicateLocations);

/** Reactive editor pane: "overview" | "location" | "duplicates" | "import" | "plugin". */
export const useWorkArea = makeStoreHook(() => workArea);

let cachedCommitDiff = { added: 0, removed: 0, modified: 0 };

export function hasCommitDiff(): boolean {
	return (
		cachedCommitDiff.added > 0 || cachedCommitDiff.removed > 0 || cachedCommitDiff.modified > 0
	);
}

export function useCommitDiff() {
	const version = useSyncExternalStore(subscribe, getMapSnapshot);
	useEffect(() => {
		computeCommitDiff().then((d) => {
			if (
				d.added !== cachedCommitDiff.added ||
				d.removed !== cachedCommitDiff.removed ||
				d.modified !== cachedCommitDiff.modified
			) {
				cachedCommitDiff = d;
				bump();
			}
		});
	}, [version]);
	return cachedCommitDiff;
}

// --- Autosave ---
let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
let inflightPersist: Promise<void> | null = null;
const AUTOSAVE_DELAY_MS = 2000;

/** Number of uncommitted changes (the overlay size). */
export async function getDirtyCount(): Promise<number> {
	const result = await cmd.storeGetSummary();
	return result.dirtyCount;
}

/** Schedule an autosave shortly. Mutations call this automatically; debounced. */
export function scheduleSave() {
	if (autosaveTimer) clearTimeout(autosaveTimer);
	autosaveTimer = setTimeout(() => {
		autosaveTimer = null;
		doSave();
	}, AUTOSAVE_DELAY_MS);
}

export function cancelAutosave() {
	if (autosaveTimer) {
		clearTimeout(autosaveTimer);
		autosaveTimer = null;
	}
}

export function waitForInflightPersist() {
	return inflightPersist;
}

/** Background auto-commit after an import with autoCommit set. */
export function scheduleAutoCommit(mapId: string, importedCount: number) {
	inflightPersist = cmd
		.storeCommit(mapId, `Import ${importedCount} locations`)
		.then(() => {
			undoRedoState = { canUndo: false, canRedo: false };
			cachedCommitDiff = { added: 0, removed: 0, modified: 0 };
		})
		.catch((e: unknown) => log.error("[import] background commit failed:", e))
		.finally(() => {
			inflightPersist = null;
			bump();
		});
}

async function doSave(): Promise<void> {
	if (!currentMapId || !currentMap) return;
	await inflightPersist;

	const t = trace("save");
	inflightPersist = cmd
		.storeSaveDirty()
		.then(() => {
			t.end();
			invalidateMapList();
		})
		.catch((err) => {
			scheduleSave();
			log.error("Autosave failed, will retry:", err);
		})
		.finally(() => {
			inflightPersist = null;
		});
	await inflightPersist;
}

/** Save any unsaved changes now instead of waiting for the autosave timer. */
export async function flushSave(): Promise<void> {
	cancelAutosave();
	await doSave();
}

// --- Init (called once at startup) ---
/** One-time store startup. The app calls this; plugins never need to. */
export async function initStore() {
	setCachedMapList(await cmd.storeListMaps());
	notify();
	listen("map-list-changed", () => reloadMapList());
}

/** Cross-module stopwatch for map-open latency. */
export const mapOpen = {
	start: 0,
	seen: new Set<string>(),
	begin() {
		this.start = performance.now();
		this.seen.clear();
	},
	mark(phase: string) {
		if (!this.start || this.seen.has(phase)) return;
		this.seen.add(phase);
		log.info(`[map-open] ${phase}=${Math.round(performance.now() - this.start)}ms`);
	},
};

/** Reset all per-map editing state to its initial values. */
function clearEditState() {
	selections = [];
	selectedLocationIds = SelectedIds.EMPTY;
	activeLocationId = null;
	cachedActiveLocation = null;
	workArea = "overview";
	resetImportState();
	resetCommitDiffState();
}

// --- Actions ---
/** Open a map in this window, closing any currently open map first. */
export async function openMap(id: string) {
	mapOpen.begin();

	cancelAutosave();
	await inflightPersist;

	const t = trace("openMap");
	currentMapId = id;
	currentMap = null;
	notify();
	const meta = await cmd.storeGetMap(id);
	t.step("getMap");

	if (meta) {
		try {
			const openResult = await cmd.storeOpenMap(id);
			t.step("store_open_map");
			mapOpen.mark("data");
			currentMap = meta;
			tagCounts = openResult.tagCounts ?? {};
			undoRedoState = { canUndo: openResult.canUndo, canRedo: openResult.canRedo };
			knownFieldKeys = new Set(openResult.knownFieldKeys);
			setUserFieldDefs(meta.meta.extra?.fields ?? {});
		} catch (e) {
			log.error("[openMap] store_open_map failed:", e);
			currentMap = null;
			currentMapId = null;
			notify();
			return;
		}
		cmd.storeTouchMapOpened(id);
	}

	clearEditState();
	bump();
	t.end();
	if (currentMap) emitEvent("map:open", currentMap);
}

/** Tear down all in-memory state for the open map. */
function resetMapState() {
	emitEvent("map:close");
	currentMapId = null;
	currentMap = null;

	clearEditState();
	knownFieldKeys = new Set();
	resetForMapChange();

	renderDeltaBus.emit({ added: [], updated: [], removed: [], colorPatches: [], fullReset: true });
	undoRedoState = { canUndo: false, canRedo: false };
	tagCounts = {};
	bump();
}

/** Close the open map, saving unsaved changes first. */
export async function closeMap() {
	await flushSave();
	resetMapState();
	await cmd.storeCloseMap();
}

/** Drop the open map without persisting anything */
export function discardOpenMap() {
	cancelAutosave();
	resetMapState();
}

/** Id of the open map, or null. */
export function getCurrentMapId() {
	return currentMapId;
}

/** The open map (metadata + settings), or null. */
export function getCurrentMap() {
	return currentMap;
}

/** Returns the set of extra-field keys known to exist on the current map. */
export function getKnownFieldKeys(): ReadonlySet<string> {
	return knownFieldKeys;
}

/** Reactive hook for `knownFieldKeys`. Re-renders when keys are added. */
export const useKnownFieldKeys = makeStoreHook((): ReadonlySet<string> => knownFieldKeys);

/** The location currently open in the editor, or null. */
export function getActiveLocation(): Location | null {
	return cachedActiveLocation;
}

/** Fetch every location in the map. */
export async function fetchAllLocations(): Promise<Location[]> {
	const path = await cmd.storeGetAllLocations();
	const res = await fetch(mmaBufUrl(path));
	return res.json();
}

/** Fetch one location by id, or null if it doesn't exist. */
export async function fetchLocation(id: number): Promise<Location | null> {
	return cmd.storeGetLocation(id);
}

/** Fetch locations by id (missing ids are skipped). Prefer this over per-id fetches. */
export async function fetchLocationsByIds(ids: number[]): Promise<Location[]> {
	return cmd.storeGetLocationsByIds(ids);
}

/** All selections including ghosted. Only for rendering/UI that needs the full list. */
export function getAllSelections() {
	return selections;
}

/** Active (non-ghosted) selections, the default for any operational logic. */
export const getSelections: () => Selection[] = memoOnRefs(
	() => [selections, ghostedSelections] as const,
	(sels, ghosts) => (ghosts.size === 0 ? sels : sels.filter((s) => !ghosts.has(s.key))),
);

/** The set of all currently selected location ids (the union of all selections). */
export function getSelectedLocationIds() {
	return selectedLocationIds;
}

/** Overwrite the selected-id set directly, bypassing selection resolution. Rarely what you want -- prefer `addSelections`. */
export function setSelectedLocationIds(ids: SelectedIds) {
	selectedLocationIds = ids;
}

/** @internal Test-only. Forces a full selection re-resolve in Rust and returns
 *  the raw selected IDs. App code should use getSelectedLocationIds() instead —
 *  mutations already sync selections via MutationResult. */
export async function syncSelections(): Promise<{ ids: number[] }> {
	const sels = buildSyncInputs();
	if (sels.length === 0) return { ids: [] };
	await cmd.storeSyncSelections(sels);
	const ids = await cmd.storeGetSelectedIdsList();
	return { ids };
}

/** Optimistically patch map meta, persist, and refresh the map list. */
async function patchMapMeta(id: string, patch: MapMetaPatch) {
	if (currentMap && currentMapId === id) {
		const meta = { ...currentMap.meta };
		if (patch.name != null) meta.name = patch.name;
		if (patch.description != null) meta.description = patch.description;
		if (patch.folder !== undefined) meta.folder = patch.folder;
		if (patch.settings != null) meta.settings = patch.settings;
		if (patch.scoreBounds != null) meta.scoreBounds = patch.scoreBounds;
		if (patch.extra != null) meta.extra = patch.extra;
		if (patch.labels != null) meta.labels = patch.labels;
		currentMap = { ...currentMap, meta };
	}
	bump();
	await cmd.storeUpdateMapMeta(id, patch);
	await invalidateMapList();
}

export function renameMap(id: string, name: string) {
	return patchMapMeta(id, { name });
}

export function updateMapLabels(id: string, labels: string[]) {
	return patchMapMeta(id, { labels });
}

export function updateMapMeta(patch: MapMetaPatch) {
	if (!currentMapId) return;
	return patchMapMeta(currentMapId, patch);
}

/** Replace the map's extra-field definitions (types/labels for `Location.extra` keys). */
export async function setMapExtraFields(fields: Record<string, ExtraFieldDef>) {
	if (!currentMapId || !currentMap) return;
	const current = currentMap.meta.extra ?? {};
	const replaced = { ...current, fields };
	currentMap = { ...currentMap, meta: { ...currentMap.meta, extra: replaced } };
	setUserFieldDefs(fields);
	bump();
	await cmd.storeUpdateMapMeta(currentMapId, { extra: replaced } as Partial<MapMeta>);
}

/** Sync JS-side state (location count, undo/redo, tag counts, field keys, selections) from a Rust MutationResult. */
function syncMutationResult(r: MutationResult) {
	if (!currentMap) return;
	const hasNewDefs = r.newFieldDefs != null && Object.keys(r.newFieldDefs).length > 0;
	if (hasNewDefs) {
		knownFieldKeys = new Set(knownFieldKeys);
		for (const key of Object.keys(r.newFieldDefs!)) knownFieldKeys.add(key);
		mergeUserFieldDefs(r.newFieldDefs!);
	}
	// Published references are hook snapshots: only replace them when the value
	// actually changed, so unrelated consumers keep a stable reference.
	if (currentMap.meta.locationCount !== r.locationCount) {
		currentMap = {
			...currentMap,
			meta: {
				...currentMap.meta,
				locationCount: r.locationCount,
			},
		};
	}
	if (undoRedoState.canUndo !== r.canUndo || undoRedoState.canRedo !== r.canRedo) {
		undoRedoState = { canUndo: r.canUndo, canRedo: r.canRedo };
	}
	if (r.tagCounts) tagCounts = r.tagCounts;
	if (r.tags) {
		const oldTags = currentMap.meta.tags;
		currentMap = { ...currentMap, meta: { ...currentMap.meta, tags: r.tags } };
		const removedKeys: string[] = [];
		for (const idStr of Object.keys(oldTags)) {
			const id = Number(idStr);
			const was = oldTags[id];
			const now = r.tags[id];
			if (was && was.visible !== false && (!now || now.visible === false)) {
				removedKeys.push(`tag:${id}`);
			}
		}
		removeSelections(removedKeys);
	}
	if (r.selectionSync) applySelectionSync(r.selectionSync);
}

/** Decode the inline bitmask bytes from Rust and emit to selBitmaskBus. */
export function emitBitmask(bytes: number[]) {
	const { selColors, cellEntries } = decodeSelectionBitmask(bytes);
	selBitmaskBus.emit(selColors, cellEntries, (ids) => {
		selectedLocationIds = ids;
	});
}

function applySelectionSync(sync: SelectionSync) {
	selectionCounts = sync.counts;
	if (sync.bitmask) emitBitmask(sync.bitmask);
}

const EMPTY_MUTATION: MutationResult = {
	delta: { added: [], updated: [], removed: [], colorPatches: [], fullReset: false },
	selectionSync: null,
	newFieldDefs: null,
	tags: null,
	version: 0,
	locationCount: 0,
	canUndo: false,
	canRedo: false,
	tagCounts: null,
	knownFieldKeys: [],
};

/** Run a mutation IPC, emit its render delta, sync JS state, and schedule a save. */
export async function mutate(fn: () => Promise<MutationResult>): Promise<MutationResult> {
	if (!currentMap) return EMPTY_MUTATION;
	const r = await fn();
	await inflightPersist;
	renderDeltaBus.emit(r.delta);
	syncMutationResult(r);
	bump();
	scheduleSave();
	return r;
}

/** Add locations to the map. Rust assigns real ids and they are written back into
 *  the passed objects -- build with `createLocation` (id 0) and read `loc.id` after. Undoable. */
export async function addLocations(locs: Location[], opts?: { hideInDelta?: boolean }) {
	if (locs.length === 0) return;
	const t = trace("add");
	const r = await mutate(() => cmd.storeAddLocations(locs));
	t.end({ delta: `+${r.delta.added.length} -${r.delta.removed.length}` });
	for (let i = 0; i < r.delta.added.length && i < locs.length; i++) {
		locs[i].id = r.delta.added[i].id;
	}
	if (opts?.hideInDelta) {
		for (const entry of r.delta.added) entry.a = 0;
	}
	emitEvent("location:add", locs);
}

/** Clone a location in place and return the new id, or null if it doesn't exist. Undoable. */
export async function duplicateLocation(id: number): Promise<number | null> {
	if (!currentMap || isVirtualLocation({ id })) return null;
	const loc = await cmd.storeGetLocation(id);
	if (!loc) return null;
	const now = nowUnix();
	const clone: Location = { ...loc, id: 0, createdAt: now, modifiedAt: now };
	await addLocations([clone]);
	return clone.id;
}

/** Remove locations by id. Undoable. */
export async function removeLocations(ids: ReadonlyIdSet) {
	if (ids.size === 0) return;
	if ([...ids].some((id) => isVirtualLocation({ id }))) {
		await setActiveLocation(null);
		return;
	}
	if (activeLocationId && ids.has(activeLocationId)) {
		activeLocationId = null;
		cachedActiveLocation = null;
		workArea = "overview";
	}
	bump();
	await mutate(() => cmd.storeRemoveLocations([...ids])).catch((e) =>
		log.error("[delete] store_remove_locations failed:", e),
	);
	emitEvent("location:remove", [...ids]);
}

/** Patch locations by id. Only include the fields you're changing; `extra` merges
 *  per-key (null deletes a key). Undoable by default. */
export async function updateLocations(
	updates: Update<LocationPatch>[],
	opts?: { undoable?: boolean },
) {
	if (updates.length === 0) return;
	if (updates.some((u) => isVirtualLocation(u))) return;
	await mutate(() => cmd.storeUpdateLocations(updates, opts?.undoable ?? true));
	emitEvent("location:update", updates);
	if (cachedActiveLocation && updates.some((u) => u.id === activeLocationId)) {
		const activePatch = updates.find((u) => u.id === activeLocationId)?.patch;
		if (activePatch) cachedActiveLocation = applyLocationPatch(cachedActiveLocation, activePatch);
		bump();
	}
}

// --- Bulk metadata-field operations ---

/** Rename or merge extra-field `from` into `to` across all locations, then migrate
 *  its definition and every selection that references it. Merge ≡ rename; `winner`
 *  decides the survivor only where a location already holds `to`. */
export async function renameField(from: string, to: string, winner: MergeWinner = "from") {
	if (!currentMap || from === to || !to) return;
	const updates = planFieldMove(await fetchAllLocations(), from, to, winner);
	const nextKeys = new Set(knownFieldKeys);
	if (updates.length) {
		await updateLocations(updates, { undoable: false });
		nextKeys.add(to);
	}
	nextKeys.delete(from);
	knownFieldKeys = nextKeys;
	await migrateFieldReferences(from, to);
}

/** Delete extra-field `key` from every location, its definition, and references. */
export async function deleteField(key: string) {
	if (!currentMap) return;
	const updates = planFieldDelete(await fetchAllLocations(), key);
	if (updates.length) {
		await updateLocations(updates, { undoable: false });
	}
	knownFieldKeys = new Set(knownFieldKeys);
	knownFieldKeys.delete(key);
	await migrateFieldReferences(key, null);
}

/** Migrate field definition + active selection references after a data move.
 *  Saved selections are deliberately NOT rewritten: they are global name-based
 *  rules resolved against whichever map is open, so a map-local rename/delete
 *  must not mutate them (the rule simply stops resolving here). */
async function migrateFieldReferences(from: string, to: string | null) {
	if (!currentMap) return;
	const defs = { ...(currentMap.meta.extra?.fields ?? {}) };
	if (defs[from]) {
		if (to && !defs[to]) defs[to] = defs[from];
		delete defs[from];
		await setMapExtraFields(defs);
	}
	await applySelectionUpdate((sels) => rewriteSelectionFields(sels, from, to));
}

// --- Selections ---

/** All selections including ghosted. Only for rendering/UI that needs the full list. */
export const useAllSelections = makeStoreHook(() => selections);

/** Active (non-ghosted) selections — the default for any operational logic. */
export const useSelections = makeStoreHook(getSelections);

/** Keyed per-node selection counts (by `Selection.key`). Look up a row's count by its key. */
export const useSelectionCounts = makeStoreHook(() => selectionCounts);

/** Per-selection location counts, keyed by `Selection.key`. */
export function getSelectionCounts() {
	return selectionCounts;
}

/** Resolve a selection's overlay color, substituting the live tag color for Tag selections. */
function selectionSyncColor(s: Selection): [number, number, number] {
	if (s.props.type === "Tag" && currentMap) {
		const tag = currentMap.meta.tags[s.props.tagId];
		if (tag) return hexToRgb(tag.color);
	}
	return s.color;
}

/** All selections, each flagged ghosted or not. Rust counts every one, renders/selects only non-ghosted. */
function buildSyncInputs() {
	return selections.map((s) => ({
		key: s.key,
		props: s.props,
		color: selectionSyncColor(s),
		ghosted: ghostedSelections.has(s.key),
	}));
}

/** Apply a pure selection transform, then IPC to Rust to resolve bitmasks and sync the overlay. */
async function applySelectionUpdate(updater: (sels: Selection[]) => Selection[]) {
	if (!currentMap) return;
	const t = trace("selection", { summary: true });
	selections = updater(selections);
	pruneGhosted();
	const sels = buildSyncInputs();
	const result = await cmd.storeSyncSelections(sels);
	t.step("ipc");
	applySelectionSync(result);
	bump();
	t.step("apply");
	t.end({ selected: result.selectedCount });
	emitEvent("selection:change", selections);
}

/** Drop ghosted keys that no longer correspond to a live selection. */
function pruneGhosted() {
	if (ghostedSelections.size === 0) return;
	const live = new Set(selections.map((s) => s.key));
	const pruned = new Set([...ghostedSelections].filter((k) => live.has(k)));
	if (pruned.size !== ghostedSelections.size) ghostedSelections = pruned;
}

/** Reactive set of ghosted (temporarily excluded) selection keys. */
export const useGhostedSelections = makeStoreHook(() => ghostedSelections);
/** The set of ghosted (temporarily excluded) selection keys. */
export const getGhostedSelections = () => ghostedSelections;

/** Toggle a selection's ghosted state and re-sync (excludes/includes it from the overlay). */
export function toggleGhostSelection(key: string) {
	const next = new Set(ghostedSelections);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	ghostedSelections = next;
	return applySelectionUpdate((sels) => sels);
}

/** "Solo" a selection: ghost every other top-level selection, keep this one visible.
 *  If it is already the only visible one, un-ghost everything (toggle back). */
export function isolateSelection(key: string) {
	ghostedSelections = isolateGhostKeys(
		selections.map((s) => s.key),
		ghostedSelections,
		key,
	);
	return applySelectionUpdate((sels) => sels);
}

/** Ghost every top-level selection; if all are already ghosted, un-ghost them all. */
export function toggleGhostAllSelections() {
	const keys = selections.map((s) => s.key);
	const allGhosted = keys.length > 0 && keys.every((k) => ghostedSelections.has(k));
	ghostedSelections = allGhosted ? new Set() : new Set([...ghostedSelections, ...keys]);
	return applySelectionUpdate((sels) => sels);
}

/** Add selections to the sidebar and highlight their locations. Same-key selections replace. */
export function addSelections(props: SelectionProps[]) {
	return applySelectionUpdate((sels) => {
		let result = sels;
		for (const p of props) result = addSel(result, p);
		return result;
	});
}

/** No-op (no sync) when none of the keys are live selections. */
export function removeSelections(keys: string[]) {
	const live = new Set(selections.map((s) => s.key));
	const present = keys.filter((k) => live.has(k));
	if (present.length === 0) return;
	return applySelectionUpdate((sels) => {
		let result = sels;
		for (const k of present) result = removeSel(result, k);
		return result;
	});
}

/** Clear all selections. */
export function resetSelections() {
	return applySelectionUpdate(() => []);
}

/** Combine selections into an AND composite. `keys` null combines all top-level selections. */
export function selectIntersection(keys: string[] | null = null) {
	return applySelectionUpdate((sels) => intersectSelections(sels, keys));
}

/** Combine selections into an OR composite. `keys` null combines all top-level selections. */
export function selectUnion(keys: string[] | null = null) {
	return applySelectionUpdate((sels) => unionSelections(sels, keys));
}

/** Wrap selections in an Invert composite (everything NOT in them). `keys` null inverts all. */
export function selectInverse(keys: string[] | null = null) {
	return applySelectionUpdate((sels) => invertSelections(sels, keys));
}

/** Add or remove one location from the Manual selection (creating it if needed). */
export function toggleManualSelection(locationId: number) {
	return applySelectionUpdate((sels) => toggleManual(sels, locationId));
}

/** Replace the current selection with a single Manual selection holding `count` ids picked
 *  at random from whatever is currently selected. `count` is clamped to the selection size.
 *  No-op when nothing is selected. Returns the number of ids actually picked. */
export function selectRandomFromSelection(count: number): number {
	const ids = Array.from(getSelectedLocationIds());
	const picked = sampleIds(ids, count);
	if (picked.length === 0) return 0;
	void applySelectionUpdate(() => addSel([], { type: "Manual", locations: picked }));
	return picked.length;
}

/** Replace the current selection with a single Manual selection of ids picked from the
 *  current selection, spaced apart in Rust: either `count` ids maximizing spacing, or as
 *  many as fit at `minDistanceM`. No-op when the pick returns nothing. */
export async function selectSpacedFromSelection(opts: {
	count?: number;
	minDistanceM?: number;
}): Promise<{ picked: number; distanceM: number }> {
	const result = await cmd.storePickSpaced(opts.count ?? null, opts.minDistanceM ?? null);
	if (result.ids.length === 0) return { picked: 0, distanceM: 0 };
	await applySelectionUpdate(() => addSel([], { type: "Manual", locations: result.ids }));
	return { picked: result.ids.length, distanceM: result.distanceM };
}

/** Read-only preview of transitive duplicate groups (size >= 2) within `distance` metres. */
export function previewDuplicateGroups(distance: number): Promise<number[][]> {
	return cmd.storeDuplicateGroups(distance);
}

/** Merge each transitive duplicate group into one survivor (tags unioned). One undoable edit. */
export async function mergeDuplicates(distance: number) {
	await mutate(() => cmd.storeMergeDuplicates(distance));
}

/**
 * Prune duplicates within a resolved selection: keeps the most relevant location per
 * cluster (<= 25m) or thins to enforce spacing (> 25m). Locations tagged "keep pano"
 * get a +5 score bonus. Returns the number pruned.
 */
export async function pruneDuplicates(props: SelectionProps, distance: number): Promise<number> {
	if (!currentMap) return 0;
	const ids = await cmd.storeResolveSelection(props);
	if (ids.length === 0) return 0;
	const keepTagIds = getVisibleTags()
		.filter((t) => t.name === "keep pano")
		.map((t) => t.id);
	const r = await mutate(() => cmd.storePruneDuplicates(ids, distance, keepTagIds));
	return r.delta.removed.length;
}

/** Edit an existing filter (or any selection) in place by key, preserving its
 *  position inside any AND/OR/Invert composite. Carries ghost state to the new key. */
export function updateFilterSelection(oldKey: string, props: SelectionProps) {
	return applySelectionUpdate((sels) => {
		const next = replaceSel(sels, oldKey, props);
		// Carry a ghost flag across an in-place re-key. A collision instead merges into the
		// existing selection (shrinking the list); the survivor keeps its own ghost state and
		// pruneGhosted clears the old key, so only migrate when nothing was merged away.
		if (next.length === sels.length) {
			let migrated: Set<string> | null = null;
			for (let i = 0; i < sels.length; i++) {
				if (next[i].key !== sels[i].key && ghostedSelections.has(sels[i].key)) {
					migrated ??= new Set(ghostedSelections);
					migrated.delete(sels[i].key);
					migrated.add(next[i].key);
				}
			}
			if (migrated) ghostedSelections = migrated;
		}
		return next;
	});
}

/** Rename a polygon selection. */
export function setPolygonName(key: string, name: string) {
	return applySelectionUpdate((sels) => renamePolygonSel(sels, key, name));
}

/** Set the highlight color of selections, by key. */
export function setSelectionColors(entries: { key: string; color: [number, number, number] }[]) {
	applySelectionUpdate((sels) => {
		let result = sels;
		for (const { key, color } of entries) result = setSelColor(result, key, color);
		return result;
	});
}

/** Move a selection before/after another in the sidebar order. */
export function reorderSelection(fromKey: string, toKey: string, position: "before" | "after") {
	applySelectionUpdate((sels) => reorderSelections(sels, fromKey, toKey, position));
}

/** Nest existing selections under a new AND/OR/Invert composite. */
export function composeSelections(
	dragKey: string,
	dropKey: string,
	mode: GroupType,
	dragParent: string | null,
	dropParent: string | null,
) {
	applySelectionUpdate((sels) => {
		if (dragParent && dropParent && dragParent === dropParent) {
			return composeSiblingsSel(sels, dragParent, dragKey, dropKey, mode);
		}
		const updated = dragParent ? decomposeChildSel(sels, dragParent, dragKey) : sels;
		if (dropParent) {
			return composeWithChildSel(updated, dragKey, dropParent, dropKey, mode);
		}
		return composeSels(updated, dragKey, dropKey, mode);
	});
}

/** Pull a child out of a composite back to the top level. */
export function decomposeChild(parentKey: string, childKey: string) {
	applySelectionUpdate((sels) => decomposeChildSel(sels, parentKey, childKey));
}

/** Delete a child from a composite (without re-adding it at the top level). */
export function removeChildFromSelection(parentKey: string, childKey: string) {
	applySelectionUpdate((sels) => removeFromCompositeSel(sels, parentKey, childKey));
}

/** Toggle tag selections on/off for the given tags (used by tag-pill clicks). */
export function toggleTagSelections(tagIds: number[]) {
	if (!currentMap || tagIds.length === 0) return;
	applySelectionUpdate((sels) => {
		let result = sels;
		for (const tagId of tagIds) {
			const key = `tag:${tagId}`;
			const exists = result.some((s) => s.key === key);
			if (exists) result = removeSel(result, key);
			else result = addSel(result, { type: "Tag", tagId });
		}
		return result;
	});
}

const getSelectedTagIds: () => ReadonlySet<number> = memoOnRefs(
	() => [selections] as const,
	(sels) => {
		const ids = new Set<number>();
		for (const s of sels) if (s.props.type === "Tag") ids.add(s.props.tagId);
		return ids;
	},
);

export const useSelectedTagIds = makeStoreHook(getSelectedTagIds);

let virtualIdSeq = 0;
/** Each preview gets a fresh negative id so its identity changes between previews (the pano viewer re-resolves on active-id change). */
const freshVirtualId = () => --virtualIdSeq;

/** Open a staged-import location read-only, "as if" it were active. The location becomes
 *  virtual (negative id; ImportPreview flag) so identity and mutate-guards derive from it. */
export async function openStagedLocation(index: number) {
	const loc = await cmd.storeImportStagedLocation(index);
	activeLocationId = null;
	// Rust's active_id must not stay pinned to the previous real location.
	fireAndForget(cmd.storeSetActive(null), "stagedOpen:setActive");
	cachedActiveLocation = {
		...loc,
		id: freshVirtualId(),
		flags: loc.flags | LocationFlag.ImportPreview,
	};
	workArea = "location";
	bumpImportMarkerVersion();
	bump();
	emitEvent("active:change", null);
}

/** Open an arbitrary location read-only as a virtual seen-preview: loads its pano without
 *  adding anything to the map. The caller sets LoadAsPanoId so the exact pano resolves. */
export function previewVirtualLocation(loc: Location) {
	activeLocationId = null;
	fireAndForget(cmd.storeSetActive(null), "virtualPreview:setActive");
	cachedActiveLocation = {
		...loc,
		id: freshVirtualId(),
		flags: loc.flags | LocationFlag.SeenOverlay,
	};
	workArea = "location";
	bump();
	emitEvent("active:change", null);
}

/** Materialize a `MaybeLocation`. */
export async function resolveLocation(m: MaybeLocation): Promise<Location | null> {
	return typeof m === "number" ? await cmd.storeGetLocation(m) : m;
}

/** Open a location in the editor (null closes it). With `checkDuplicates`, opening a spot
 *  with 2+ locations within 2m opens the duplicate-resolution panel instead. */
export async function setActiveLocation(target: MaybeLocation | null, checkDuplicates = true) {
	const t = trace("setActive");
	const id = target == null ? null : locId(target);
	if (cachedActiveLocation && isVirtualLocation(cachedActiveLocation)) {
		bumpImportMarkerVersion();
		const wasStaged = isImportPreview(cachedActiveLocation);
		if (id == null) {
			cachedActiveLocation = null;

			if (wasStaged) workArea = "import";
			else if (activePluginId) workArea = "plugin";
			else workArea = "overview";

			bump();
			emitEvent("active:change", null);
			t.end();
			return;
		}
	}
	activeLocationId = id;
	fireAndForget(cmd.storeSetActive(id), "setActive");
	if (id) {
		const loc = await resolveLocation(target!);
		t.step("ipc");
		if (checkDuplicates && loc) {
			const nearby = await cmd.storeFindNearby(loc.lat, loc.lng, 2.0);
			if (nearby.length >= 2) {
				duplicateLocations = nearby;
				workArea = "duplicates";
				activeLocationId = null;
				cachedActiveLocation = null;
				bump();
				emitEvent("active:change", null);
				t.end({ duplicates: nearby.length });
				return;
			}
		}
		cachedActiveLocation = loc ?? null;
		workArea = "location";
	} else {
		cachedActiveLocation = null;
		duplicateLocations = [];
		workArea = activePluginId ? "plugin" : "overview";
	}
	bump();
	emitEvent("active:change", activeLocationId);
	t.end();
}

/** Open one location from the duplicate-resolution panel in the editor. */
export function openDuplicateLocation(loc: Location) {
	activeLocationId = loc.id;
	cachedActiveLocation = loc;
	workArea = "location";
	fireAndForget(cmd.storeSetActive(loc.id), "setActive");
	bump();
}

/** Drop a location from the duplicate-resolution panel (does not delete it). */
export function removeDuplicate(id: number) {
	duplicateLocations = duplicateLocations.filter((l) => l.id !== id);
	bump();
}

/** Close the duplicate-resolution panel and return to the overview. */
export function closeDuplicates() {
	duplicateLocations = [];
	setWorkArea("overview");
}

/** Transition the editor pane, enforcing state invariants:
 *  leaving "location" clears the active location, leaving "plugin" clears the plugin id. */
export function setWorkArea(area: WorkArea) {
	workArea = area;
	if (area !== "location") {
		activeLocationId = null;
		cachedActiveLocation = null;
	}
	if (area !== "plugin") activePluginId = null;
	bump();
}

// --- Plugin mode ---

/** Reactive id of the plugin whose sidebar is open, or null. */
export const useActivePluginId = makeStoreHook(() => activePluginId);

/** The current editor pane. */
export function getWorkArea() {
	return workArea;
}

/** Open a plugin's sidebar (switches the editor pane to "plugin"). */
export function setPluginMode(pluginId: string) {
	activePluginId = pluginId;
	setWorkArea("plugin");
}

/** Close the plugin sidebar and return to the overview. */
export function exitPluginMode() {
	setWorkArea("overview");
}

// --- Tag CRUD ---

/** Get-or-create tags by name. Returns the tag objects for use
 *  in subsequent location updates. Idempotent — existing tags are returned
 *  as-is, new names get auto-generated colors. */
export async function createTags(names: string[]): Promise<Tag[]> {
	if (names.length === 0) return [];
	await mutate(() => cmd.storeCreateTags(names));
	const lower = new Set(names.map((n) => n.toLowerCase()));
	const created = Object.values(currentMap!.meta.tags).filter((t) =>
		lower.has(t.name.toLowerCase()),
	);
	emitEvent("tag:add", created);
	return created;
}

/** Rename or recolor tags. If a rename collides with an existing tag name
 *  (case-insensitive), the two tags are merged — all locations are remapped
 *  to the survivor. */
export async function updateTags(updates: Update<TagPatch>[]) {
	if (updates.length === 0) return;
	await mutate(() => cmd.storeUpdateTags(updates));
	emitEvent("tag:update", updates);
	// ONLY resync on color change, everything else is resolved by Rust
	if (
		selections.some((s) => {
			const p = s.props;
			return p.type === "Tag" && updates.some((q) => q.id === p.tagId && q.patch.color != null);
		})
	) {
		applySelectionUpdate((sels) => sels);
	}
}

/** Delete tags and strip them from all locations. Undoable (the location
 *  changes are in the undo stack; visibility auto-restores on undo). */
export async function deleteTags(tagIds: number[]) {
	if (tagIds.length === 0) return;
	await mutate(() => cmd.storeDeleteTags(tagIds));
	emitEvent("tag:remove", tagIds);
}

/** Persist a new tag display order. */
export async function reorderTags(orderedIds: number[]) {
	await mutate(() => cmd.storeReorderTags(orderedIds));
}

/** Fetch locations, apply a tag transform, and mutate those that changed.
 *  `transform` returns null to skip a location (no change needed). */
async function modifyTagOnLocations(
	tagId: number,
	locationIds: number[],
	transform: (tags: number[], tagId: number) => number[] | null,
) {
	if (locationIds.length === 0) return;
	const locs = await cmd.storeGetLocationsByIds(locationIds);
	const updates: Update<LocationPatch>[] = [];
	for (const l of locs) {
		const next = transform(l.tags, tagId);
		if (next) updates.push({ id: l.id, patch: { tags: next } });
	}
	if (updates.length === 0) return;
	await mutate(() => cmd.storeUpdateLocations(updates, true));
}

/** Add a tag to locations (skips ones that already have it). Undoable. */
export function addTagToLocations(tagId: number, locationIds: number[]) {
	return modifyTagOnLocations(tagId, locationIds, (tags, id) =>
		tags.includes(id) ? null : [...tags, id],
	);
}

/** Remove a tag from the given locations. Undoable. */
export function removeTagFromLocations(tagId: number, locationIds: number[]) {
	return modifyTagOnLocations(tagId, locationIds, (tags, id) =>
		tags.includes(id) ? tags.filter((t) => t !== id) : null,
	);
}

/** Remove a tag from every location that has it. Undoable. */
export async function removeTagFromAllLocations(tagId: number) {
	if (!currentMap) return;
	const allWithTag = await cmd.storeResolveSelection({ type: "Tag", tagId });
	if (allWithTag.length > 0) await removeTagFromLocations(tagId, allWithTag);
}

// --- Undo/redo ---

/** Shared undo/redo handler: call the IPC, clear active if removed. */
async function undoRedo(which: () => Promise<MutationResult>) {
	try {
		const r = await mutate(which);
		if (activeLocationId && r.delta.removed.some((e) => e.id === activeLocationId)) {
			activeLocationId = null;
			cachedActiveLocation = null;
			workArea = "overview";
		}
	} catch (e) {
		log.debug(`[${which.name}] nothing or failed:`, e);
	}
}

/** Undo the last edit. */
export function undo() {
	return undoRedo(cmd.storeUndo);
}
/** Redo the last undone edit. */
export function redo() {
	return undoRedo(cmd.storeRedo);
}

/** Whether undo/redo are currently available. */
export function getUndoRedoState() {
	return undoRedoState;
}

export const useUndoRedo = makeStoreHook(() => undoRedoState);

// --- Version control ---

/** Bake overlay, write the commit delta, create a VCS commit. Resets undo stack. */
export async function commitMap(message?: string): Promise<string> {
	if (!currentMapId) throw new Error("No map open");
	const t = trace("commit");
	cancelAutosave();
	await inflightPersist;

	const id = await cmd.storeCommit(currentMapId, message ?? null);
	t.step("commit");
	t.end();
	undoRedoState = { canUndo: false, canRedo: false };
	cachedCommitDiff = { added: 0, removed: 0, modified: 0 };

	// Commit clears the overlay; commit-sensitive selections (e.g. Uncommitted) must
	// re-resolve against the new baseline instead of showing now-committed rows.
	if (selections.length > 0) {
		await applySelectionUpdate((s) => s);
	} else {
		bump();
	}
	return id;
}

/** Restore the map to a previous commit's state and reopen it. Clears undo/redo. */
export async function checkoutCommit(commitId: string) {
	if (!currentMapId) return;
	await flushSave();
	try {
		await cmd.storeCloseMap();
		await cmd.storeCheckoutCommit(currentMapId, commitId);
		await cmd.storeOpenMap(currentMapId);
		await cmd.storeResetUndo();
		const msg = `Revert to ${commitId.slice(0, 7)}`;
		await cmd.storeCommit(currentMapId, msg);
	} catch (e) {
		log.error("[checkout] restore failed:", e);
		throw e;
	}
	currentMap = await cmd.storeGetMap(currentMapId);
	selections = [];
	selectedLocationIds = SelectedIds.EMPTY;
	activeLocationId = null;
	undoRedoState = { canUndo: false, canRedo: false };

	renderDeltaBus.emit({ added: [], updated: [], removed: [], colorPatches: [], fullReset: true });
	bump();
	await invalidateMapList();
}

// --- Re-exports from extracted modules (keeps all existing imports working) ---

export {
	type ImportStaging,
	useImportStaging,
	useImportMarkerVersion,
	getImportPreviewPositions,
	beginImportFromPath,
	beginImportPaste,
	confirmImport,
	cancelImport,
} from "./importStaging";

export {
	type CommitDiffPreview,
	useCommitDiffPreview,
	useDiffMarkerVersion,
	getCommitDiffPreview,
	beginCommitDiffPreview,
	endCommitDiffPreview,
	diffPositions,
	categorizeCommitDelta,
} from "./commitDiff";

export {
	type SourceScope,
	type ScopeController,
	type ScopeHandle,
	useScope,
	createScope,
	applyScope,
	resolveScopeIds,
	partition,
} from "./scope";

export {
	useMapList,
	getMapList,
	invalidateMapList,
	createMap,
	deleteMap,
	renameFolder,
	moveMapToFolder,
	deleteFolder,
} from "./mapList";
