import { uid } from "@/lib/memory/names";
import type { Item, Room } from "@/lib/memory/types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function makeRoom(name: string, now: number): Room {
  return { id: uid(), name, createdAt: now };
}

function makeItem(
  room: Room,
  name: string,
  where: string,
  photoKey: string,
  ago: number,
  now: number,
  extra?: Partial<Item>,
): Item {
  const seen = now - ago;
  return {
    id: uid(),
    name,
    roomId: room.id,
    where,
    firstSeenAt: extra?.history?.[0]?.at ?? seen,
    lastSeenAt: seen,
    timesSeen: extra?.history?.length ? extra.history.length + 1 : 1,
    photoKey,
    missing: false,
    sample: true,
    history: extra?.history ?? [],
  };
}

export function buildPractice(now: number): { rooms: Room[]; items: Item[] } {
  const living = makeRoom("Living room", now);
  const kitchen = makeRoom("Kitchen", now);
  const office = makeRoom("Office", now);

  const items: Item[] = [
    makeItem(
      kitchen,
      "Car keys",
      "In the speckled bowl on the counter",
      "/samples/kitchen.jpg",
      2 * HOUR,
      now,
      {
        history: [
          {
            at: now - 26 * HOUR,
            room: "Entryway",
            where: "On the small table by the front door",
          },
        ],
      },
    ),
    makeItem(
      kitchen,
      "Phone charger",
      "Plugged into the outlet on the backsplash, just left of the toaster",
      "/samples/kitchen.jpg",
      6 * HOUR,
      now,
    ),
    makeItem(
      living,
      "TV remote",
      "On the coffee table, near the front edge",
      "/samples/living.jpg",
      5 * HOUR,
      now,
    ),
    makeItem(
      living,
      "Reading glasses",
      "On the walnut side table, next to the ceramic lamp",
      "/samples/living.jpg",
      20 * HOUR,
      now,
    ),
    makeItem(
      living,
      "Navy throw",
      "Draped over the left arm of the sofa",
      "/samples/living.jpg",
      4 * DAY,
      now,
    ),
    makeItem(
      office,
      "Headphones",
      "On the left side of the desk, beside the brass lamp",
      "/samples/office.jpg",
      8 * HOUR,
      now,
    ),
    makeItem(
      office,
      "Notebook",
      "On the desk, with the brass lamp standing on it",
      "/samples/office.jpg",
      3 * DAY,
      now,
    ),
    makeItem(
      office,
      "Blue pen",
      "In the ceramic cup on the right side of the desk",
      "/samples/office.jpg",
      DAY,
      now,
    ),
  ];

  return { rooms: [living, kitchen, office], items };
}
