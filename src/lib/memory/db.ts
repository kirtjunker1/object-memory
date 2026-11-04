import type { Item, Room } from "@/lib/memory/types";

const DB_NAME = "nook-memory";
const DB_VERSION = 1;

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("Memory isn't available on this device."));
  }
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("rooms")) {
          database.createObjectStore("rooms", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("items")) {
          database.createObjectStore("items", { keyPath: "id" });
        }
        if (!database.objectStoreNames.contains("photos")) {
          database.createObjectStore("photos");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        opening = null;
        reject(request.error);
      };
    });
  }
  return opening;
}

function asItem(raw: Item): Item {
  return {
    ...raw,
    history: Array.isArray(raw.history) ? raw.history : [],
    missing: Boolean(raw.missing),
    sample: Boolean(raw.sample),
    timesSeen: raw.timesSeen || 1,
    photoKey: raw.photoKey ?? null,
    where: raw.where || "Somewhere in view",
  };
}

export async function loadState(): Promise<{ rooms: Room[]; items: Item[] }> {
  const database = await openDb();
  const tx = database.transaction(["rooms", "items"], "readonly");
  const rooms = await req<Room[]>(tx.objectStore("rooms").getAll());
  const items = await req<Item[]>(tx.objectStore("items").getAll());
  await done(tx);
  return { rooms, items: items.map(asItem) };
}

export async function getPhoto(id: string): Promise<Blob | null> {
  const database = await openDb();
  const tx = database.transaction("photos", "readonly");
  const blob = await req<Blob | undefined>(tx.objectStore("photos").get(id));
  await done(tx);
  return blob ?? null;
}

export async function persist(
  state: { rooms: Room[]; items: Item[] },
  ops?: {
    putPhoto?: { id: string; blob: Blob };
    putPhotos?: { id: string; blob: Blob }[];
    deletePhotoIds?: string[];
    wipePhotos?: boolean;
  },
): Promise<void> {
  const database = await openDb();
  const tx = database.transaction(["rooms", "items", "photos"], "readwrite");
  const rooms = tx.objectStore("rooms");
  const items = tx.objectStore("items");
  const photos = tx.objectStore("photos");
  if (ops?.wipePhotos) photos.clear();
  else {
    for (const id of ops?.deletePhotoIds ?? []) photos.delete(id);
    if (ops?.putPhoto) photos.put(ops.putPhoto.blob, ops.putPhoto.id);
    for (const photo of ops?.putPhotos ?? []) photos.put(photo.blob, photo.id);
  }
  rooms.clear();
  for (const room of state.rooms) rooms.put(room);
  items.clear();
  for (const item of state.items) items.put(item);
  await done(tx);
}
