// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- ambient module decl must be referenced so dts-bundle-generator pulls it into plugin type-gen
/// <reference path="../../types/measuretool.d.ts" />
import { useSyncExternalStore, useEffect } from "react";
import MeasureToolClass from "measuretool-googlemaps-v3";
import type { LatLng } from "@/types";
import { createSyncStore } from "@/lib/util/syncStore";

// --- Measure tool state ---

interface MeasureState {
	instance: InstanceType<typeof MeasureToolClass> | null;
	isMeasuring: boolean;
}

let mState: MeasureState = { instance: null, isMeasuring: false };
const mStore = createSyncStore();
function mSnap() {
	return mState;
}

function createInstance(map: google.maps.Map) {
	const mt = new MeasureToolClass(map, {
		contextMenu: false,
		showSegmentLength: false,
	});
	mt.addListener("measure_start", () => {
		mState = { ...mState, isMeasuring: true };
		mStore.notify();
	});
	mt.addListener("measure_end", () => {
		mState = { ...mState, isMeasuring: false };
		mStore.notify();
		queueMicrotask(() => map.setOptions({ draggableCursor: "crosshair" }));
	});
	return mt;
}

export function startMeasure(map: google.maps.Map, latLng: LatLng) {
	let { instance } = mState;
	if (!instance) {
		instance = createInstance(map);
		mState = { ...mState, instance };
		mStore.notify();
	}
	instance.start([latLng]);
}

export function endMeasure() {
	mState.instance?.end();
}

export function useMeasureState() {
	return useSyncExternalStore(mStore.subscribe, mSnap);
}

export function useMeasure() {
	const s = useMeasureState();
	useEffect(() => () => endMeasure(), []);
	return s;
}

// --- Lat/lng anchor state ---

let anchor: LatLng | null = null;
const aStore = createSyncStore();
function aSnap() {
	return anchor;
}

export function setLatLngAnchor(v: LatLng | null) {
	anchor = v;
	aStore.notify();
}

export function useLatLngAnchor() {
	return useSyncExternalStore(aStore.subscribe, aSnap);
}

export const subscribeLatLngAnchor = aStore.subscribe;

export function getLatLngAnchor() {
	return anchor;
}
