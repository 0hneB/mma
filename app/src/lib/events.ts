import { useSyncExternalStore } from "react";
import { log } from "@/lib/util/log";
import type {
	Location,
	Update,
	LocationPatch_Deserialize,
	MapData,
	RenderDelta,
	Selection,
	Tag,
	TagPatch,
} from "@/bindings.gen";
import type { SelectedIds, SelCellEntry } from "@/lib/render/CellManager";

/** Phantom helper: captures a payload type at the value level without a real value. */
const event = <T>() => null as T;

export interface SelectionBitmaskPayload {
	selColors: [number, number, number][];
	cellEntries: SelCellEntry[];
	setIds: (ids: SelectedIds) => void;
}

const EVENT_DEFS = {
	"location:add": event<Location[]>(),
	"location:remove": event<number[]>(),
	"location:update": event<Update<LocationPatch_Deserialize>[]>(),
	"tag:add": event<Tag[]>(),
	"tag:remove": event<number[]>(),
	"tag:update": event<Update<TagPatch>[]>(),
	"selection:change": event<Selection[]>(),
	"active:change": event<number | null>(),
	"map:open": event<MapData>(),
	"map:close": event<void>(),
	"store:changed": event<void>(),
	"render:delta": event<RenderDelta>(),
	"render:selection": event<SelectionBitmaskPayload>(),
	"settings:changed": event<void>(),
	"fullscreen:changed": event<void>(),
	"plugins:changed": event<void>(),
	"hotkeys:changed": event<void>(),
	"toasts:changed": event<void>(),
	"scene:changed": event<void>(),
	"measure:changed": event<void>(),
	"anchor:changed": event<void>(),
	"viewport-lock:changed": event<void>(),
	"trail:changed": event<void>(),
	"altitude:changed": event<void>(),
	"seen:changed": event<void>(),
};

export type EditorEventMap = typeof EVENT_DEFS;
export type EditorEvent = keyof EditorEventMap;
export type EventHandler<E extends EditorEvent> = (payload: EditorEventMap[E]) => void;

/** Events whose payload is `void` may be emitted with no argument; all others require one. */
type EmitArgs<E extends EditorEvent> = EditorEventMap[E] extends void
	? []
	: [payload: EditorEventMap[E]];

const ALL_EVENTS = Object.keys(EVENT_DEFS) as EditorEvent[];

const handlers = new Map<EditorEvent, Set<(payload: never) => void>>();
const versions = new Map<EditorEvent, number>();

export function emit<E extends EditorEvent>(evt: E, ...args: EmitArgs<E>): void {
	versions.set(evt, (versions.get(evt) ?? 0) + 1);
	const set = handlers.get(evt);
	if (!set) return;
	const payload = args[0] as never;
	for (const h of set) {
		try {
			h(payload);
		} catch (e) {
			log.error(`[event] ${evt}:`, e);
		}
	}
}

/** Subscribe to an event and derive a reactive value from it. The canonical
 *  primitive for event-driven React state in this codebase. */
export function useEventValue<T>(evt: EditorEvent, getValue: () => T): T {
	return useSyncExternalStore((cb) => subscribe(evt, cb), getValue);
}

/** React hook: re-renders when the given event fires. Returns a version counter
 *  (opaque, only useful as a change signal). Replaces per-module version tracking. */
export const useEvent = (evt: EditorEvent) => useEventValue(evt, () => versions.get(evt) ?? 0);

export function subscribe<E extends EditorEvent>(evt: E, handler: EventHandler<E>): () => void {
	let set = handlers.get(evt);
	if (!set) {
		set = new Set();
		handlers.set(evt, set);
	}
	const h = handler as (payload: never) => void;
	set.add(h);
	return () => {
		set!.delete(h);
	};
}

/** Subscribe one payload-agnostic handler to several events; returns a single combined unsubscribe. */
export function subscribeMany(events: readonly EditorEvent[], handler: () => void): () => void {
	const unsubs = events.map((e) => subscribe(e, handler));
	return () => unsubs.forEach((u) => u());
}

/** Events under a given `namespace:` prefix, derived from the event map. */
type EventsWithPrefix<P extends string> = Extract<EditorEvent, `${P}:${string}`>;
const eventsWithPrefix = <P extends string>(prefix: P): EventsWithPrefix<P>[] =>
	ALL_EVENTS.filter((e): e is EventsWithPrefix<P> => e.startsWith(`${prefix}:`));

/** The events that fire whenever location data changes. */
export const LOCATION_DATA_EVENTS = eventsWithPrefix("location");
/** Selection-related events. */
export const SELECTION_EVENTS = eventsWithPrefix("selection");
/** The events that fire whenever tag definitions change. */
export const TAG_DATA_EVENTS = eventsWithPrefix("tag");
/** Map open/close lifecycle. */
export const MAP_LIFECYCLE_EVENTS = eventsWithPrefix("map");
