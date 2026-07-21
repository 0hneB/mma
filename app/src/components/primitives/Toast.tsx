import { useSyncExternalStore } from "react";
import { getToasts } from "@/lib/util/toast";
import { subscribe as subscribeEvent } from "@/lib/events";

export function ToastContainer() {
	const entries = useSyncExternalStore((cb) => subscribeEvent("toasts:changed", cb), getToasts);
	if (entries.length === 0) return null;
	return (
		<div className="toast-container">
			{entries.map((t) => (
				<div key={t.id} className={`toast-entry${t.progress ? " toast-entry--progress" : ""}`}>
					<span>{t.message}</span>
					{t.progress && (
						<>
							<div className="toast-progress__track">
								<div
									className="toast-progress__bar"
									style={{ width: `${Math.round(t.progress.fraction * 100)}%` }}
								/>
							</div>
							{t.progress.label && (
								<span className="toast-progress__label">{t.progress.label}</span>
							)}
						</>
					)}
				</div>
			))}
		</div>
	);
}
