import { useCallback } from "react";
import type { MapSettings } from "@/bindings.gen";
import { useCurrentMap, getCurrentMap, updateMapMeta } from "@/store/useMapStore";

export function useMapSetting<K extends keyof MapSettings>(
	key: K,
	defaultValue: NonNullable<MapSettings[K]>,
): [NonNullable<MapSettings[K]>, (v: MapSettings[K]) => void];
export function useMapSetting<K extends keyof MapSettings>(
	key: K,
): [Exclude<MapSettings[K], undefined>, (v: MapSettings[K]) => void];
export function useMapSetting<K extends keyof MapSettings>(
	key: K,
	defaultValue?: NonNullable<MapSettings[K]>,
): [Exclude<MapSettings[K], undefined>, (v: MapSettings[K]) => void] {
	const map = useCurrentMap();
	const set = useCallback(
		(v: MapSettings[K]) => {
			const settings = getCurrentMap()?.meta.settings;
			if (settings) updateMapMeta({ settings: { ...settings, [key]: v } });
		},
		[key],
	);
	const raw = map?.meta.settings?.[key] as Exclude<MapSettings[K], undefined>;
	return [defaultValue !== undefined ? (raw ?? defaultValue) : raw, set] as [
		Exclude<MapSettings[K], undefined>,
		(v: MapSettings[K]) => void,
	];
}
