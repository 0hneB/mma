const { registerPlugin } = window.MMA;
import { mapMakingApp } from "@/components/primitives/Icon";
import { SyncSidebar } from "./SyncSidebar";
import { controller } from "./controller";
import { activateSyncPlugin } from "@/lib/sync/controller";

registerPlugin({
	id: "map-making-sync",
	name: "map-making.app sync",
	description: "Bidirectional sync with map-making.app maps",
	icon: mapMakingApp,
	experimental: true,
	sidebar: SyncSidebar,
	activate: () => activateSyncPlugin(controller),
});
