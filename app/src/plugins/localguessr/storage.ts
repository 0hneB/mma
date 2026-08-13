import { createPluginStorage } from "@/plugins/registry";
import type { Game } from "./game";

const storage = createPluginStorage("localguessr");
const SAVED_GAME = "savedGame";

/**
 * The one in-flight game, kept so closing the sidebar mid-round isn't a loss.
 * Only the drawn rounds are stored, never the pool they came from.
 */
export function getSavedGame(): Game | null {
	const game = storage.get<Game | null>(SAVED_GAME, null);
	return game && Array.isArray(game.locations) && game.locations.length > 0 ? game : null;
}

export function saveGame(game: Game): void {
	storage.set(SAVED_GAME, game);
}

export function clearSavedGame(): void {
	storage.set(SAVED_GAME, null);
}
