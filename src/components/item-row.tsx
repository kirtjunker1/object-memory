import { Link } from "@tanstack/react-router";
import { MemoryPhoto } from "@/components/memory-photo";
import type { Item } from "@/lib/memory/types";
import { seenLabel } from "@/lib/memory/time";

export function ItemRow({
  item,
  roomName,
  onSelect,
}: {
  item: Item;
  roomName: string;
  onSelect?: () => void;
}) {
  const inner = (
    <>
      <MemoryPhoto
        photoKey={item.photoKey}
        alt=""
        className="size-14 shrink-0 rounded-md"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">
          {item.name}
          {item.missing ? <span className="font-normal text-muted"> · not there</span> : null}
        </span>
        <span className="block truncate text-sm text-muted">{item.where}</span>
        <span className="block truncate text-xs text-muted tabular-nums">
          {roomName} · {seenLabel(item.lastSeenAt)}
        </span>
      </span>
    </>
  );

  const className =
    "flex w-full items-center gap-3 rounded-lg border border-line bg-card p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink";

  if (onSelect) {
    return (
      <button type="button" onClick={onSelect} className={className}>
        {inner}
      </button>
    );
  }

  return (
    <Link to="/find" search={{ q: item.name, room: "" }} className={className}>
      {inner}
    </Link>
  );
}
