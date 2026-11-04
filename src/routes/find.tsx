import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ItemRow } from "@/components/item-row";
import { MemoryPhoto } from "@/components/memory-photo";
import { PRESET_ROOMS, normName } from "@/lib/memory/names";
import { isConfident, searchItems } from "@/lib/memory/search";
import { useMemory } from "@/lib/memory/store";
import { seenLabel } from "@/lib/memory/time";
import type { Item } from "@/lib/memory/types";
import { btnPrimary, btnQuiet, btnSecondary, field } from "@/lib/ui";

type FindSearch = { q: string; room: string };

export const Route = createFileRoute("/find")({
  validateSearch: (search: Record<string, unknown>): FindSearch => ({
    q: typeof search.q === "string" ? search.q.slice(0, 80) : "",
    room: typeof search.room === "string" ? search.room.slice(0, 40) : "",
  }),
  head: () => ({ meta: [{ title: "Find something · Nook" }] }),
  component: FindPage,
});

function FindPage() {
  const { q, room } = Route.useSearch();
  const ready = useMemory((state) => state.ready);
  const items = useMemory((state) => state.items);
  const rooms = useMemory((state) => state.rooms);
  const updateDetails = useMemory((state) => state.updateDetails);
  const markMissing = useMemory((state) => state.markMissing);
  const removeItem = useMemory((state) => state.removeItem);

  const [value, setValue] = useState(q);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftWhere, setDraftWhere] = useState("");
  const [draftRoom, setDraftRoom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(q);
  }, [q]);

  const roomItems = useMemo(() => {
    if (!room) return [];
    const match = rooms.find((stored) => normName(stored.name) === normName(room));
    if (!match) return [];
    return items
      .filter((item) => item.roomId === match.id)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }, [room, rooms, items]);

  const hits = useMemo(() => searchItems(value, items, rooms), [value, items, rooms]);
  const confident = value.trim().length > 0 && isConfident(hits);
  const featured = hits.find((hit) => hit.item.id === selectedId) ?? (confident ? hits[0] : undefined);
  const rest = featured ? hits.filter((hit) => hit.item.id !== featured.item.id) : hits;

  useEffect(() => {
    setSelectedId(null);
    setEditing(false);
    setConfirmDelete(false);
  }, [value]);

  const roomChoices = useMemo(() => {
    const names = [...PRESET_ROOMS];
    for (const stored of rooms) {
      if (!names.some((name) => normName(name) === normName(stored.name))) names.push(stored.name);
    }
    return names;
  }, [rooms]);

  function beginEdit(item: Item, roomName: string) {
    setEditing(true);
    setConfirmDelete(false);
    setDraftName(item.name);
    setDraftWhere(item.where);
    setDraftRoom(roomName);
  }

  async function saveEdit(id: string) {
    setBusy(true);
    setError(null);
    try {
      await updateDetails(id, { name: draftName, where: draftWhere, roomName: draftRoom });
      setEditing(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }

  const recent = [...items].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 8);
  const showingRoom = !value.trim() && room;

  return (
    <div className="py-8">
      <p className="text-sm font-medium text-accent">Find</p>
      <label htmlFor="find" className="mt-1 block font-display text-4xl leading-tight">
        What are you looking for?
      </label>
      <input
        id="find"
        value={value}
        autoFocus={!room}
        onChange={(event) => {
          setValue(event.target.value);
          setError(null);
        }}
        placeholder="Keys, glasses, charger"
        maxLength={80}
        className="mt-4 w-full border-b border-line bg-transparent pb-3 font-display text-3xl text-ink outline-none placeholder:text-muted"
      />

      {!ready ? <p className="mt-6 text-sm text-muted">Opening your memory…</p> : null}
      {error ? (
        <p className="mt-4 rounded-lg border border-line bg-card px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-6" aria-live="polite">
        {showingRoom ? (
          <section>
            <h2 className="font-display text-3xl">{room}</h2>
            {roomItems.length === 0 ? (
              <p className="mt-3 text-muted">Nothing remembered in the {room} yet.</p>
            ) : (
              <ul className="mt-4 flex flex-col gap-2">
                {roomItems.map((item) => (
                  <li key={item.id}>
                    <ItemRow
                      item={item}
                      roomName={room}
                      onSelect={() => {
                        setValue(item.name);
                        setSelectedId(item.id);
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        {ready && !value.trim() && !room ? (
          recent.length === 0 ? (
            <p className="max-w-xl text-muted">
              Nothing remembered yet. Scan a room, or load the practice home from the start screen.
            </p>
          ) : (
            <section>
              <h2 className="font-display text-2xl">Recently seen</h2>
              <ul className="mt-4 flex flex-col gap-2">
                {recent.map((item) => (
                  <li key={item.id}>
                    <ItemRow
                      item={item}
                      roomName={rooms.find((stored) => stored.id === item.roomId)?.name ?? "Room"}
                      onSelect={() => setValue(item.name)}
                    />
                  </li>
                ))}
              </ul>
            </section>
          )
        ) : null}

        {value.trim() && hits.length === 0 ? (
          <p className="max-w-xl text-muted">
            Nothing remembered matches “{value.trim()}”. Scan the room it might be in, or add it by hand
            after you find it.
          </p>
        ) : null}

        {featured ? (
          <article className="overflow-hidden rounded-xl border border-line bg-card">
            <MemoryPhoto
              photoKey={featured.item.photoKey}
              alt={`Where the ${featured.item.name} was seen`}
              className="aspect-video w-full"
            />
            <div className="p-5">
              <p className="text-sm text-muted tabular-nums">
                Last seen {seenLabel(featured.item.lastSeenAt)}
                {featured.item.timesSeen > 1 ? ` · seen ${featured.item.timesSeen} times` : ""}
              </p>
              <h2 className="mt-2 font-display text-5xl leading-tight">{featured.roomName}</h2>
              <p className="mt-2 font-display text-2xl">{featured.item.name}</p>
              <p className="mt-2 text-lg">{featured.item.where}</p>
              {featured.item.missing ? (
                <p className="mt-3 text-sm text-muted">You marked this as not there anymore.</p>
              ) : null}
              {featured.item.history.length > 0 ? (
                <div className="mt-4">
                  <h3 className="text-sm font-medium text-muted">Before that</h3>
                  <ul className="mt-2 flex flex-col gap-1 text-sm">
                    {[...featured.item.history].reverse().map((sight) => (
                      <li key={`${sight.at}-${sight.room}`}>
                        {sight.room} — {sight.where}
                        <span className="text-muted"> · {seenLabel(sight.at)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {editing ? (
                <form
                  className="mt-5 flex flex-col gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveEdit(featured.item.id);
                  }}
                >
                  <label className="text-sm text-muted" htmlFor="edit-name">
                    Name
                  </label>
                  <input id="edit-name" value={draftName} maxLength={60} onChange={(event) => setDraftName(event.target.value)} className={field} />
                  <label className="text-sm text-muted" htmlFor="edit-where">
                    Where
                  </label>
                  <input id="edit-where" value={draftWhere} maxLength={160} onChange={(event) => setDraftWhere(event.target.value)} className={field} />
                  <label className="text-sm text-muted" htmlFor="edit-room">
                    Room
                  </label>
                  <select
                    id="edit-room"
                    value={draftRoom}
                    onChange={(event) => setDraftRoom(event.target.value)}
                    className={field}
                  >
                    {roomChoices.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="submit" className={btnPrimary} disabled={busy}>
                      Save
                    </button>
                    <button type="button" className={btnSecondary} onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <div className="mt-5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={btnSecondary}
                    disabled={busy}
                    onClick={() => void markMissing(featured.item.id, !featured.item.missing).catch(() => setError("Couldn't update that."))}
                  >
                    {featured.item.missing ? "It's there again" : "It's not there"}
                  </button>
                  <button
                    type="button"
                    className={btnSecondary}
                    onClick={() => beginEdit(featured.item, featured.roomName)}
                  >
                    I moved it
                  </button>
                  {confirmDelete ? (
                    <button
                      type="button"
                      className={btnPrimary}
                      disabled={busy}
                      onClick={() =>
                        void removeItem(featured.item.id)
                          .then(() => {
                            setConfirmDelete(false);
                            setValue("");
                          })
                          .catch(() => setError("Couldn't forget that."))
                      }
                    >
                      Forget it
                    </button>
                  ) : (
                    <button type="button" className={btnQuiet} onClick={() => setConfirmDelete(true)}>
                      Forget
                    </button>
                  )}
                </div>
              )}
            </div>
          </article>
        ) : null}

        {value.trim() && rest.length > 0 ? (
          <section className={featured ? "mt-6" : ""}>
            <h2 className="font-display text-2xl">{featured ? "Other possibilities" : "Possible matches"}</h2>
            <ul className="mt-3 flex flex-col gap-2">
              {rest.map((hit) => (
                <li key={hit.item.id}>
                  <ItemRow
                    item={hit.item}
                    roomName={hit.roomName}
                    onSelect={() => {
                      setSelectedId(hit.item.id);
                      setEditing(false);
                      setConfirmDelete(false);
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}
