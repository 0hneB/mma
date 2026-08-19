/** A fixup for one persisted blob, mutating the parsed value in place. Runs on every read, so it
 *  must be idempotent -- that is what lets migrations work with no stored schema version. */
export type Migration = (stored: Record<string, unknown>) => void;

export interface StoredMigration {
	/** App version this shipped in. Migrations older than `SUPPORTED_FROM` are deleted. */
	since: string;
	/** localStorage key it applies to. */
	key: string;
	/** One line: which shape changed to what. */
	describe: string;
	apply: Migration;
}

/** Oldest app version an install can upgrade from and still have its stored blobs migrated.
 *  Bump this to prune: `migrations.test.ts` then names every entry that has aged out, and
 *  deleting them is the whole job. Someone updating from before this loses only the affected
 *  *preferences* (they fall back to defaults) -- no user data is persisted through localStorage. */
export const SUPPORTED_FROM = "0.9.0";

/** Every migration that still applies, oldest first.
 *
 *  Entries are snapshots of history: they name old keys and old shapes as literals and must
 *  never import live types, or renaming a setting silently rewrites the past. */
export const MIGRATIONS: StoredMigration[] = [
	{
		since: "0.9.2",
		key: "appSettings",
		describe: "marker/active/preview/panoDot/polygon/tagFolder colors: {r,g,b} -> [r,g,b]",
		apply: (stored) => {
			const keys = [
				"markerColor",
				"activeLocationColor",
				"importPreviewColor",
				"panoDotColor",
				"polygonColor",
				"tagFolderColor",
			];
			for (const key of keys) {
				const v = stored[key];
				if (v && !Array.isArray(v)) {
					const { r, g, b } = v as { r: number; g: number; b: number };
					stored[key] = [r, g, b];
				}
			}
		},
	},
];

export function migrationsFor(key: string): Migration[] {
	return MIGRATIONS.filter((m) => m.key === key).map((m) => m.apply);
}

/** Compare dotted numeric versions. Returns <0, 0, >0 like a sort comparator. */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}
