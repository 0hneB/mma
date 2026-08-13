const { registerPlugin } = window.MMA;
import { mdiGamepadVariantOutline } from "@mdi/js";
import { LocalGuessrSidebar } from "./LocalGuessrSidebar";

registerPlugin({
	id: "localguessr",
	name: "LocalGuessr",
	description: "Play a guessing game on your own map, and tag rounds as you go",
	icon: mdiGamepadVariantOutline,
	sidebar: LocalGuessrSidebar,
	activate() {},
});
