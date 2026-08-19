// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HotkeyInput } from "@/components/primitives/HotkeyInput";

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

function render(onChange: (combo: string) => void) {
	act(() => root.render(<HotkeyInput value="" onChange={onChange} />));
	return container.querySelector("input") as HTMLInputElement;
}

function press(input: HTMLInputElement, key: string) {
	act(() => {
		input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
	});
}

describe("HotkeyInput", () => {
	it("does not record on focus alone", () => {
		const onChange = vi.fn();
		const input = render(onChange);
		act(() => input.focus());
		press(input, "a");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("records once the field is clicked", () => {
		const onChange = vi.fn();
		const input = render(onChange);
		act(() => input.click());
		press(input, "a");
		expect(onChange).toHaveBeenCalledWith("a");
	});
});
