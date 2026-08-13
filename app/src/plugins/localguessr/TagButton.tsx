import { useMemo, useState } from "react";
import { Button } from "@/components/primitives/Button";
import { Dialog, DialogContent } from "@/components/primitives/Dialog";
import { TextInput } from "@/components/primitives/TextInput";
import { Icon } from "@/components/primitives/Icon";
import { mdiTagPlusOutline } from "@mdi/js";
import { t } from "@/lib/i18n";
import { toast } from "@/lib/util/toast";
import { createTags, getVisibleTags, useMapState } from "@/store/useMapStore";

/**
 * Tag the locations a round just showed you, without leaving the game. This is the
 * loop the plugin exists for: play your own map, mark what needs fixing in place.
 */
export function TagButton({ locationIds, label }: { locationIds: number[]; label?: string }) {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const tags = useMapState(getVisibleTags);

	const query = name.trim().toLowerCase();
	const suggestions = useMemo(
		() =>
			tags
				.filter((tag) => !query || tag.name.toLowerCase().includes(query))
				.slice(0, 10),
		[tags, query],
	);

	const apply = async (raw: string) => {
		const tagName = raw.trim();
		if (!tagName || busy || locationIds.length === 0) return;
		setBusy(true);
		try {
			await createTags([tagName], { kind: "ids", ids: locationIds });
			toast(
				locationIds.length === 1
					? t("Tagged with {tag}", { tag: tagName })
					: t("Tagged {n} locations with {tag}", { n: locationIds.length, tag: tagName }),
			);
			setName("");
			setOpen(false);
		} catch (e) {
			toast(e instanceof Error ? e.message : t("Could not add the tag"));
		} finally {
			setBusy(false);
		}
	};

	if (locationIds.length === 0) return null;

	return (
		<>
			<button
				type="button"
				className="lg-tag-btn"
				onClick={() => setOpen(true)}
				aria-label={label ?? t("Add a tag")}
			>
				<Icon path={mdiTagPlusOutline} size={18} />
				{label && <span>{label}</span>}
			</button>

			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent
					title={
						locationIds.length === 1
							? t("Tag this location")
							: t("Tag {n} locations", { n: locationIds.length })
					}
					className="lg-tag-dialog"
				>
					<form
						className="lg-tag-dialog__form"
						onSubmit={(e) => {
							e.preventDefault();
							void apply(name);
						}}
					>
						<TextInput
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("Tag name")}
							autoFocus
							disabled={busy}
						/>
						{suggestions.length > 0 && (
							<div className="lg-tag-dialog__chips">
								{suggestions.map((tag) => (
									<button
										key={tag.id}
										type="button"
										className="lg-tag-dialog__chip"
										disabled={busy}
										style={{ borderColor: tag.color || undefined }}
										onClick={() => void apply(tag.name)}
									>
										{tag.name}
									</button>
								))}
							</div>
						)}
						<div className="lg-tag-dialog__actions">
							<Button type="button" onClick={() => setOpen(false)} disabled={busy}>
								{t("Cancel")}
							</Button>
							<Button variant="primary" type="submit" disabled={!name.trim() || busy}>
								{t("Add tag")}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
		</>
	);
}
