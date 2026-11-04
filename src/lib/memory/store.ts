import { create } from "zustand";
import { loadState, persist } from "@/lib/memory/db";
import { normName, uid } from "@/lib/memory/names";
import { buildPractice } from "@/lib/memory/samples";
import type { Item, Room, Spot } from "@/lib/memory/types";

type RememberInput = {
  roomName: string;
  spots: Spot[];
  photoBlob?: Blob | null;
  sample?: boolean;
};

type DetailsInput = {
  name: string;
  where: string;
  roomName: string;
};

type MemoryState = {
  ready: boolean;
  error: string | null;
  rooms: Room[];
  items: Item[];
  hydrate: () => Promise<void>;
  remember: (input: RememberInput) => Promise<void>;
  updateDetails: (id: string, input: DetailsInput) => Promise<void>;
  markMissing: (id: string, missing: boolean) => Promise<void>;
  removeItem: (id: string) => Promise<void>;
  loadPractice: () => Promise<void>;
  clearSamples: () => Promise<void>;
  clearAll: () => Promise<void>;
};

let hydrating = false;

function prune(rooms: Room[], items: Item[]): Room[] {
  const ids = new Set(items.map((item) => item.roomId));
  return rooms.filter((room) => ids.has(room.id));
}

function ensureRoom(rooms: Room[], name: string, now: number): { rooms: Room[]; room: Room } {
  const clean = name.trim().slice(0, 40) || "Room";
  const found = rooms.find((room) => normName(room.name) === normName(clean));
  if (found) return { rooms, room: found };
  const room = { id: uid(), name: clean, createdAt: now };
  return { rooms: [...rooms, room], room };
}

function roomLabel(rooms: Room[], id: string): string {
  return rooms.find((room) => room.id === id)?.name ?? "Room";
}

async function commit(
  rooms: Room[],
  items: Item[],
  ops?: { putPhoto?: { id: string; blob: Blob }; putPhotos?: { id: string; blob: Blob }[]; deletePhotoIds?: string[]; wipePhotos?: boolean },
) {
  const nextRooms = ops?.wipePhotos ? [] : prune(rooms, items);
  const nextItems = ops?.wipePhotos ? [] : items;
  await persist({ rooms: nextRooms, items: nextItems }, ops);
  return { rooms: nextRooms, items: nextItems };
}

export const useMemory = create<MemoryState>((set, get) => ({
  ready: false,
  error: null,
  rooms: [],
  items: [],

  hydrate: async () => {
    if (get().ready || hydrating) return;
    hydrating = true;
    try {
      const state = await loadState();
      set({ ...state, ready: true, error: null });
    } catch {
      set({ ready: true, error: "Memory couldn't be opened on this device." });
    } finally {
      hydrating = false;
    }
  },

  remember: async (input) => {
    const now = Date.now();
    const spots = input.spots
      .map((spot) => ({
        name: spot.name.trim().slice(0, 60),
        where: (spot.where.trim() || "Somewhere in view").slice(0, 160),
        photoBlob: spot.photoBlob ?? input.photoBlob ?? null,
        seenAt: Number.isFinite(spot.seenAt) ? Number(spot.seenAt) : now,
      }))
      .filter((spot) => spot.name);
    if (!spots.length) return;

    let rooms = get().rooms.slice();
    let items = get().items.slice();
    const ensured = ensureRoom(rooms, input.roomName, now);
    rooms = ensured.rooms;
    const room = ensured.room;
    const putPhotos: { id: string; blob: Blob }[] = [];
    const retire = new Set<string>();
    const seenNames = new Set<string>();

    for (const spot of spots) {
      const key = normName(spot.name);
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      let photoKey: string | null = null;
      if (spot.photoBlob) {
        photoKey = uid();
        putPhotos.push({ id: photoKey, blob: spot.photoBlob });
      }

      const existing = items.find((item) => normName(item.name) === key);
      if (!existing) {
        items.push({
          id: uid(),
          name: spot.name,
          roomId: room.id,
          where: spot.where,
          firstSeenAt: spot.seenAt,
          lastSeenAt: spot.seenAt,
          timesSeen: 1,
          photoKey,
          missing: false,
          sample: Boolean(input.sample),
          history: [],
        });
        continue;
      }

      const moved = existing.roomId !== room.id || existing.where !== spot.where;
      if (existing.photoKey && photoKey && existing.photoKey !== photoKey && !existing.photoKey.startsWith("/")) {
        retire.add(existing.photoKey);
      }
      const next: Item = {
        ...existing,
        name: spot.name,
        roomId: room.id,
        where: spot.where,
        lastSeenAt: spot.seenAt,
        timesSeen: existing.timesSeen + 1,
        photoKey: photoKey ?? existing.photoKey,
        missing: false,
        sample: Boolean(input.sample),
        history: moved
          ? [
              ...existing.history,
              { at: existing.lastSeenAt, room: roomLabel(rooms, existing.roomId), where: existing.where },
            ].slice(-6)
          : existing.history,
      };
      items = items.map((item) => (item.id === existing.id ? next : item));
    }

    const deletePhotoIds = [...retire].filter((id) => !items.some((item) => item.photoKey === id));
    const saved = await commit(rooms, items, { putPhotos, deletePhotoIds });
    set(saved);
  },

  updateDetails: async (id, input) => {
    const current = get().items.find((item) => item.id === id);
    if (!current) return;
    const now = Date.now();
    const name = input.name.trim().slice(0, 60) || current.name;
    const where = (input.where.trim() || current.where).slice(0, 160);
    let rooms = get().rooms.slice();
    const ensured = ensureRoom(rooms, input.roomName, now);
    rooms = ensured.rooms;
    const moved = ensured.room.id !== current.roomId || where !== current.where;
    const next: Item = {
      ...current,
      name,
      where,
      roomId: ensured.room.id,
      missing: false,
      sample: current.sample,
      lastSeenAt: moved ? now : current.lastSeenAt,
      timesSeen: moved ? current.timesSeen + 1 : current.timesSeen,
      history: moved
        ? [
            ...current.history,
            { at: current.lastSeenAt, room: roomLabel(get().rooms, current.roomId), where: current.where },
          ].slice(-6)
        : current.history,
    };
    const items = get().items.map((item) => (item.id === id ? next : item));
    const saved = await commit(rooms, items);
    set(saved);
  },

  markMissing: async (id, missing) => {
    const items = get().items.map((item) => (item.id === id ? { ...item, missing } : item));
    const saved = await commit(get().rooms, items);
    set(saved);
  },

  removeItem: async (id) => {
    const removed = get().items.find((item) => item.id === id);
    const items = get().items.filter((item) => item.id !== id);
    const deletePhotoIds =
      removed?.photoKey &&
      !removed.photoKey.startsWith("/") &&
      !items.some((item) => item.photoKey === removed.photoKey)
        ? [removed.photoKey]
        : [];
    const saved = await commit(get().rooms, items, { deletePhotoIds });
    set(saved);
  },

  loadPractice: async () => {
    const now = Date.now();
    let items = get().items.filter((item) => !item.sample);
    let rooms = prune(get().rooms, items);
    const practice = buildPractice(now);
    const userNames = new Set(items.map((item) => normName(item.name)));
    for (const practiceRoom of practice.rooms) {
      const incoming = practice.items.filter(
        (item) => item.roomId === practiceRoom.id && !userNames.has(normName(item.name)),
      );
      if (!incoming.length) continue;
      const ensured = ensureRoom(rooms, practiceRoom.name, now);
      rooms = ensured.rooms;
      for (const item of incoming) items.push({ ...item, roomId: ensured.room.id });
    }
    const saved = await commit(rooms, items);
    set(saved);
  },

  clearSamples: async () => {
    const items = get().items.filter((item) => !item.sample);
    const saved = await commit(get().rooms, items);
    set(saved);
  },

  clearAll: async () => {
    const saved = await commit([], [], { wipePhotos: true });
    set(saved);
  },
}));
