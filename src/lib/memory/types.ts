export type Room = {
  id: string;
  name: string;
  createdAt: number;
};

export type Sight = {
  at: number;
  room: string;
  where: string;
};

export type Item = {
  id: string;
  name: string;
  roomId: string;
  where: string;
  firstSeenAt: number;
  lastSeenAt: number;
  timesSeen: number;
  photoKey: string | null;
  missing: boolean;
  sample: boolean;
  history: Sight[];
};

export type Spot = {
  name: string;
  where: string;
  /** Best-quality still frame showing this object, stored locally. */
  photoBlob?: Blob | null;
  /** Unix timestamp (milliseconds) when this object appeared in the recording. */
  seenAt?: number;
};
