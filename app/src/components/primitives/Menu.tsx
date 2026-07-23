/* eslint-disable react-refresh/only-export-components -- namespaced part objects are the call-site API */
import { createContext, useContext } from "react";
import { Menu as BaseMenu } from "@base-ui-components/react/menu";
import { ContextMenu as BaseContextMenu } from "@base-ui-components/react/context-menu";
import type { ReactElement, ReactNode } from "react";

type Mode = "dropdown" | "context";

const ModeCtx = createContext<Mode>("dropdown");

function makeRoot(mode: Mode) {
	return function MenuRoot({
		children,
		modal,
		onOpenChange,
	}: {
		children: ReactNode;
		modal?: boolean;
		onOpenChange?: (open: boolean) => void;
	}) {
		const inner =
			mode === "dropdown" ? (
				<BaseMenu.Root modal={modal} onOpenChange={(open) => onOpenChange?.(open)}>
					{children}
				</BaseMenu.Root>
			) : (
				<BaseContextMenu.Root onOpenChange={(open) => onOpenChange?.(open)}>
					{children}
				</BaseContextMenu.Root>
			);
		return <ModeCtx.Provider value={mode}>{inner}</ModeCtx.Provider>;
	};
}

function MenuTrigger({
	children,
	disabled,
}: {
	children: ReactElement;
	asChild?: boolean;
	disabled?: boolean;
}) {
	const mode = useContext(ModeCtx);
	const Trigger = mode === "dropdown" ? BaseMenu.Trigger : BaseContextMenu.Trigger;
	return <Trigger disabled={disabled} render={children as ReactElement<Record<string, unknown>>} />;
}

function MenuPortal({ children }: { children: ReactNode }) {
	return <BaseMenu.Portal>{children}</BaseMenu.Portal>;
}

function MenuContent({
	children,
	className,
	align = "start",
	sideOffset = 4,
	ref,
}: {
	children: ReactNode;
	className?: string;
	align?: "start" | "center" | "end";
	sideOffset?: number;
	onCloseAutoFocus?: (e: Event) => void;
	ref?: React.Ref<HTMLDivElement>;
}) {
	return (
		<BaseMenu.Positioner side="bottom" align={align} sideOffset={sideOffset}>
			<BaseMenu.Popup className={className} ref={ref}>
				{children}
			</BaseMenu.Popup>
		</BaseMenu.Positioner>
	);
}

function MenuItem({
	children,
	className,
	onSelect,
	disabled,
}: {
	children: ReactNode;
	className?: string;
	disabled?: boolean;
	onSelect?: (e: Event) => void;
}) {
	return (
		<BaseMenu.Item
			className={className}
			disabled={disabled}
			onClick={(e) => {
				const evt = new Event("menuSelect", { cancelable: true });
				onSelect?.(evt);
				// Radix parity: preventDefault in onSelect keeps the menu open.
				if (evt.defaultPrevented)
					(e as unknown as { preventBaseUIHandler: () => void }).preventBaseUIHandler();
			}}
		>
			{children}
		</BaseMenu.Item>
	);
}

function MenuSeparator({ className }: { className?: string }) {
	return <BaseMenu.Separator className={className} />;
}

export const DropdownMenu = {
	Root: makeRoot("dropdown"),
	Trigger: MenuTrigger,
	Portal: MenuPortal,
	Content: MenuContent,
	Item: MenuItem,
	Separator: MenuSeparator,
};

export const ContextMenu = {
	Root: makeRoot("context"),
	Trigger: MenuTrigger,
	Portal: MenuPortal,
	Content: MenuContent,
	Item: MenuItem,
	Separator: MenuSeparator,
};
