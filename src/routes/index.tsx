import { createFileRoute, Link } from "@tanstack/react-router";
import { Camera, Search } from "lucide-react";
import { useState } from "react";
import { ItemRow } from "@/components/item-row";
import { btnPrimary, btnQuiet, btnSecondary } from "@/lib/ui";
import { useMemory } from "@/lib/memory/store";
import type { Item, Room } from "@/lib/memory/types";

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "Nook" }] }),
  component: Home,
});

function roomName(rooms: Room[], id: string): string {
  return rooms.find((room) => room.id === id)?.name ?? "Room";
}

function Home() {
  const ready = useMemory((state) => state.ready);
  const error = useMemory((state) => state.error);
  const items = useMemory((state) => state.items);
  const rooms = useMemory((state) => state.rooms);
  const loadPractice = useMemory((state) => state.loadPractice);
  const clearSamples = useMemory((state) => state.clearSamples);
  const clearAll = useMemory((state) => state.clearAll);
  const [confirmForget, setConfirmForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const recent = [...items].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, 5);
  const roomCards = rooms
    .map((room) => ({
      room,
      count: items.filter((item) => item.roomId === room.id).length,
      lastSeenAt: Math.max(
        0,
        ...items.filter((item) => item.roomId === room.id).map((item) => item.lastSeenAt),
      ),
    }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  const hasSample = items.some((item) => item.sample);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setNote(null);
    try {
      await action();
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : "Couldn't save that.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="py-8">
      <header className="flex items-center gap-3">
        <span
          className="flex size-11 items-center justify-center rounded-md bg-accent font-display text-xl text-on-accent"
          aria-hidden
        >
          N
        </span>
        <div>
          <p className="font-display text-xl leading-none">Nook</p>
          <p className="mt-1 text-sm text-muted">A memory for your rooms</p>
        </div>
      </header>

      <h1 className="mt-8 max-w-xl font-display text-5xl leading-tight md:text-6xl">Where did it go?</h1>
      <p className="mt-4 max-w-xl text-lg text-muted">
        Scan a room once. When something is missing, Nook tells you where it was last seen.
      </p>

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Link
          to="/scan"
          className="flex flex-col rounded-xl bg-accent p-6 text-on-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <Camera className="size-6" aria-hidden />
          <h2 className="mt-6 font-display text-3xl leading-tight">Scan a room</h2>
          <p className="mt-2 text-on-accent/80">
            Walk through with the camera. Nook notes what it sees, and when.
          </p>
          <span className="mt-6 text-sm font-semibold">Open the camera</span>
        </Link>
        <Link
          to="/find"
          search={{ q: "", room: "" }}
          className="flex flex-col rounded-xl border border-line bg-card p-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        >
          <Search className="size-6 text-accent" aria-hidden />
          <h2 className="mt-6 font-display text-3xl leading-tight">Find something</h2>
          <p className="mt-2 text-muted">Search a name. If it was seen, you get the room and the spot.</p>
          <span className="mt-6 text-sm font-semibold text-accent">Search memory</span>
        </Link>
      </div>

      {error ? (
        <p className="mt-6 rounded-lg border border-line bg-card px-4 py-3 text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {note ? (
        <p className="mt-6 rounded-lg border border-line bg-card px-4 py-3 text-sm" role="status">
          {note}
        </p>
      ) : null}

      {!ready ? <p className="mt-8 text-sm text-muted">Opening your memory…</p> : null}

      {ready && items.length === 0 ? (
        <section className="mt-10 rounded-xl border border-line bg-card p-6">
          <h2 className="font-display text-2xl">Nothing remembered yet</h2>
          <p className="mt-2 max-w-xl text-muted">
            Try a practice home before you scan your own rooms. It has a kitchen, a living room, and a
            desk — keys in a bowl, glasses on a side table, headphones by a lamp.
          </p>
          <button
            type="button"
            className={`${btnPrimary} mt-5`}
            disabled={busy}
            onClick={() => void run(loadPractice)}
          >
            Try the practice home
          </button>
          <p className="mt-4 text-sm text-muted">Stays on this device.</p>
        </section>
      ) : null}

      {roomCards.length > 0 ? (
        <section className="mt-10">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-2xl">Rooms</h2>
            <p className="text-sm text-muted tabular-nums">
              {items.length} {items.length === 1 ? "thing" : "things"}
            </p>
          </div>
          <ul className="mt-4 grid gap-3 sm:grid-cols-3">
            {roomCards.map(({ room, count }) => (
              <li key={room.id}>
                <Link
                  to="/find"
                  search={{ q: "", room: room.name }}
                  className="flex min-h-20 flex-col justify-center rounded-lg border border-line bg-card px-4 py-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                >
                  <span className="font-medium">{room.name}</span>
                  <span className="text-sm text-muted">
                    {count} {count === 1 ? "thing" : "things"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {recent.length > 0 ? (
        <section className="mt-10">
          <h2 className="font-display text-2xl">Last seen</h2>
          <ul className="mt-4 flex flex-col gap-2">
            {recent.map((item: Item) => (
              <li key={item.id}>
                <ItemRow item={item} roomName={roomName(rooms, item.roomId)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {ready && items.length > 0 ? (
        <div className="mt-8 flex flex-wrap items-center gap-2">
          {hasSample ? (
            <button
              type="button"
              className={btnSecondary}
              disabled={busy}
              onClick={() => void run(clearSamples)}
            >
              Remove practice home
            </button>
          ) : null}
          {confirmForget ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm text-muted">Forget everything stored on this device?</p>
              <button
                type="button"
                className={btnPrimary}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await clearAll();
                    setConfirmForget(false);
                  })
                }
              >
                Forget
              </button>
              <button type="button" className={btnQuiet} onClick={() => setConfirmForget(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className={btnQuiet} onClick={() => setConfirmForget(true)}>
              Forget everything
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
