import { createSyncStore } from "@/lib/util/syncStore";

interface ToastEntry {
	id: number;
	message: string;
	progress?: { fraction: number; label?: string };
}

let toasts: ToastEntry[] = [];
let nextId = 0;
const { subscribe: subscribeToasts, notify } = createSyncStore();
export { subscribeToasts };

export function toast(message: string, duration = 2500, container?: HTMLElement) {
	if (container) {
		const el = document.createElement("div");
		el.textContent = message;
		el.style.cssText =
			"position:absolute;bottom:2rem;left:50%;transform:translateX(-50%);background:#222;color:#fff;padding:.5rem 1rem;border-radius:4px;font-size:.875rem;z-index:100;pointer-events:none;white-space:nowrap";
		container.appendChild(el);
		setTimeout(() => el.remove(), duration);
		return;
	}
	const id = nextId++;
	toasts = [...toasts, { id, message }];
	notify();
	setTimeout(() => {
		toasts = toasts.filter((t) => t.id !== id);
		notify();
	}, duration);
}

export interface ProgressHandle {
	update(fraction: number, label?: string): void;
	finish(message?: string, duration?: number): void;
}

export function progressToast(message: string): ProgressHandle {
	const id = nextId++;
	toasts = [...toasts, { id, message, progress: { fraction: 0 } }];
	notify();
	return {
		update(fraction: number, label?: string) {
			toasts = toasts.map((t) => (t.id === id ? { ...t, progress: { fraction, label } } : t));
			notify();
		},
		finish(message?: string, duration = 2500) {
			if (message) {
				toasts = toasts.map((t) => (t.id === id ? { ...t, message, progress: undefined } : t));
				notify();
				setTimeout(() => {
					toasts = toasts.filter((t) => t.id !== id);
					notify();
				}, duration);
			} else {
				toasts = toasts.filter((t) => t.id !== id);
				notify();
			}
		},
	};
}

export function getToasts() {
	return toasts;
}
