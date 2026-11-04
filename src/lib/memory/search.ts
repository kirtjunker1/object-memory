import type { Item, Room } from "@/lib/memory/types";
import { normName } from "@/lib/memory/names";

export type SearchHit = {
  item: Item;
  roomName: string;
  score: number;
};

const STOP = new Set([
  "the",
  "a",
  "an",
  "my",
  "your",
  "where",
  "is",
  "are",
  "was",
  "were",
  "did",
  "i",
  "leave",
  "left",
  "put",
  "find",
  "in",
  "on",
  "of",
  "for",
  "to",
  "it",
  "me",
  "what",
  "about",
]);

const GROUPS = [
  ["key", "keyring", "keychain", "fob"],
  ["glass", "eyeglass", "spectacle", "reader"],
  ["remote", "clicker"],
  ["charger", "cable", "cord"],
  ["headphone", "headset", "earbud"],
  ["wallet", "billfold"],
  ["phone", "iphone", "cellphone", "mobile"],
  ["laptop", "computer", "macbook"],
  ["pen", "pencil"],
];

function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s")) return word.slice(0, -1);
  return word;
}

function tokens(value: string): string[] {
  return normName(value)
    .split(" ")
    .map(stem)
    .filter((token) => token.length > 1 && !STOP.has(token));
}

function expand(token: string): Set<string> {
  const set = new Set([token]);
  for (const group of GROUPS) {
    if (group.includes(token)) {
      for (const word of group) set.add(word);
    }
  }
  return set;
}

function covers(needles: Set<string>[], hay: Set<string>): number {
  return needles.filter((needle) => [...needle].some((token) => hay.has(token))).length;
}

export function searchItems(query: string, items: Item[], rooms: Room[]): SearchHit[] {
  const q = query.trim();
  if (!q) return [];
  const qTokens = tokens(q);
  if (!qTokens.length) return [];
  const qSets = qTokens.map(expand);
  const roomById = new Map(rooms.map((room) => [room.id, room.name]));

  const hits: SearchHit[] = [];
  for (const item of items) {
    const roomName = roomById.get(item.roomId) ?? "Unknown room";
    const nameSet = new Set(tokens(item.name).flatMap((token) => [...expand(token)]));
    const whereSet = new Set(tokens(item.where).flatMap((token) => [...expand(token)]));
    const roomSet = new Set(tokens(roomName).flatMap((token) => [...expand(token)]));
    const inName = covers(qSets, nameSet);
    const inWhere = covers(qSets, whereSet);
    const inRoom = covers(qSets, roomSet);

    let score = 0;
    const queryNorm = normName(q);
    const nameNorm = normName(item.name);
    if (queryNorm === nameNorm) score += 24;
    else if (nameNorm.includes(queryNorm)) score += 16;
    if (inName === qTokens.length) score += 10;
    score += inName * 4;
    score += inWhere * 2;
    score += inRoom * 3;
    if (item.missing) score *= 0.8;
    if (score <= 0) continue;
    hits.push({ item, roomName, score });
  }

  hits.sort((a, b) => b.score - a.score || b.item.lastSeenAt - a.item.lastSeenAt);
  return hits;
}

export function isConfident(hits: SearchHit[]): boolean {
  const top = hits[0];
  if (!top || top.score < 10) return false;
  const second = hits[1];
  if (!second) return true;
  return second.score <= top.score - 5;
}
