// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dialog, DialogTrigger, DialogContent } from "@/components/primitives/Dialog";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

function Harness() {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger>open me</DialogTrigger>
			<DialogContent title="Test">body</DialogContent>
		</Dialog>
	);
}

describe("Dialog focus", () => {
	it("returns focus to the trigger on close", async () => {
		act(() => root.render(<Harness />));
		const trigger = container.querySelector("button") as HTMLButtonElement;

		// jsdom's click() does not move focus the way a real one does
		act(() => {
			trigger.focus();
			trigger.click();
		});
		expect(document.querySelector(".modal")).toBeTruthy();

		const close = document.querySelector(".modal button") as HTMLButtonElement;
		await act(async () => {
			close.click();
			await new Promise((r) => setTimeout(r, 0));
		});

		expect(document.activeElement).toBe(trigger);
	});
});
