import { useSyncExternalStore } from "react";
import type { LatLng } from "@/types";
import type { CommitDiff, CommitInfo } from "@/bindings.gen";
import { cmd } from "@/lib/commands";
import { fitMapToBounds } from "@/lib/map/mapState";
import { subscribeStore, bumpStore, getCurrentMap, getWorkArea, setWorkArea } from "./useMapStore";

/** Ephemeral commit-diff overlay shown while `workArea === "diff"`. Position arrays are
 *  interleaved `[lng, lat]` f32; `diffMarkerVersion` bumps to rebuild the layers. */
export interface CommitDiffPreview {
	commitId: string;
	hash: string;
	counts: CommitDiff;
	added: Float32Array;
	removed: Float32Array;
	modified: Float32Array;
}

let commitDiffPreview: CommitDiffPreview | null = null;
let diffMarkerVersion = 0;

export function useCommitDiffPreview() {
	return useSyncExternalStore(subscribeStore, () => commitDiffPreview);
}

export function useDiffMarkerVersion() {
	return useSyncExternalStore(subscribeStore, () => diffMarkerVersion);
}

export function getCommitDiffPreview() {
	return commitDiffPreview;
}

/** Reset diff state (called when map edit state is cleared). */
export function resetCommitDiffState() {
	commitDiffPreview = null;
}

/** Interleave `[lng, lat]` pairs into an f32 buffer for deck.gl. */
export function diffPositions(locs: LatLng[]): Float32Array {
	const a = new Float32Array(locs.length * 2);
	for (let i = 0; i < locs.length; i++) {
		a[i * 2] = locs[i].lng;
		a[i * 2 + 1] = locs[i].lat;
	}
	return a;
}

/** Split a commit delta into added / removed / modified. An updated location appears in
 *  both `created` (new) and `removed` (old), keyed by id. */
export function categorizeCommitDelta<T extends { id: number }>(delta: {
	created: T[];
	removed: T[];
}): { added: T[]; removed: T[]; modified: T[] } {
	const removedIds = new Set(delta.removed.map((l) => l.id));
	const createdIds = new Set(delta.created.map((l) => l.id));
	return {
		added: delta.created.filter((l) => !removedIds.has(l.id)),
		removed: delta.removed.filter((l) => !createdIds.has(l.id)),
		modified: delta.created.filter((l) => removedIds.has(l.id)),
	};
}

/** Fetch a commit's delta and overlay its added/removed/modified locations on the map,
 *  temporarily replacing the regular markers. */
export async function beginCommitDiffPreview(commit: CommitInfo) {
	if (!getCurrentMap()) return;
	const delta = await cmd.storeGetCommitDelta(commit.mapId, commit.id);
	const { added, removed, modified } = categorizeCommitDelta(delta);
	commitDiffPreview = {
		commitId: commit.id,
		hash: commit.id.slice(0, 7),
		counts: { added: added.length, removed: removed.length, modified: modified.length },
		added: diffPositions(added),
		removed: diffPositions(removed),
		modified: diffPositions(modified),
	};
	diffMarkerVersion++;
	setWorkArea("diff");
	const all = [...added, ...removed, ...modified];
	if (all.length > 0) {
		let west = Infinity,
			south = Infinity,
			east = -Infinity,
			north = -Infinity;
		for (const l of all) {
			if (l.lng < west) west = l.lng;
			if (l.lng > east) east = l.lng;
			if (l.lat < south) south = l.lat;
			if (l.lat > north) north = l.lat;
		}
		fitMapToBounds({ west, south, east, north }, 100);
	}
}

/** Leave commit-diff preview and restore the regular markers. */
export function endCommitDiffPreview() {
	commitDiffPreview = null;
	diffMarkerVersion++;
	if (getWorkArea() === "diff") setWorkArea("overview");
	else bumpStore();
}
