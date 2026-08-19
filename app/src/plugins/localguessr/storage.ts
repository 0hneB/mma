import { createPluginStorage } from "@/plugins/registry";
import type { Game, StreakMode } from "./game";

const storage = createPluginStorage("localguessr");
const SAVED_GAME = "savedGame";
const GLOBAL_STREAK = "globalStreak";

/**
 * The one in-flight game per map, kept so closing the sidebar mid-round isn't a loss.
 * Keyed by the map the rounds were drawn from: their location ids and tags mean nothing
 * on any other map. Only the drawn rounds are stored, never the pool they came from.
 */
export function getSavedGame(mapId: string): Game | null {
	const game = storage.get<Game | null>(`${SAVED_GAME}:${mapId}`, null);
	return game && game.mapId === mapId && Array.isArray(game.locations) && game.locations.length > 0
		? game
		: null;
}

export function saveGame(game: Game): void {
	storage.set(`${SAVED_GAME}:${game.mapId}`, game);
}

export function clearSavedGame(mapId: string): void {
	storage.set(`${SAVED_GAME}:${mapId}`, null);
}

interface GlobalStreak {
	mode: StreakMode;
	count: number;
}

export function getGlobalStreak(mode: StreakMode): number {
	if (mode === "off") return 0;
	const s = storage.get<GlobalStreak | null>(GLOBAL_STREAK, null);
	return s?.mode === mode ? s.count : 0;
}

export function setGlobalStreak(mode: StreakMode, count: number): void {
	if (mode === "off") return;
	storage.set(GLOBAL_STREAK, { mode, count } satisfies GlobalStreak);
}
