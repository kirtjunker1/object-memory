import { createServerFn } from "@tanstack/react-start";
import { cleanLabel, normName } from "@/lib/memory/names";

export type SceneFrameInput = {
  imageBase64: string;
  timestampMs: number;
};

export type IdentifiedSceneItem = {
  name: string;
  where: string;
  frameIndex: number;
  timestampMs: number;
};

export type IdentifyResult =
  | { ok: true; items: IdentifiedSceneItem[] }
  | { ok: false; error: string };

// Fast multimodal model suited to multi-frame room inventory.
// Prefer the project setup model; fall back to current Flash if needed.
const MODEL = "gemini-2.5-flash-lite";
const MAX_FRAMES = 20;
const MAX_TOTAL_BASE64 = 4_000_000;
const MAX_FRAME_BASE64 = 1_500_000;

const SKIP = new Set([
  "wall", "floor", "ceiling", "window", "door", "room", "ground",
  "picture", "photo", "image", "person", "people",
]);

const PROMPT = `You are reviewing an ordered sequence of still frames sampled from one continuous home video. Build one inventory of distinct, useful household objects visible anywhere in the sequence.
Return ONLY JSON in this exact shape:
{"items":[{"name":"short everyday object name","where":"useful location relative to furniture","frameIndex":0}]}
Rules:
- Identify up to 30 distinct, clearly visible physical objects that a person might want to find later.
- Review ALL frames, not just the first or last frame.
- The frame index is zero-based and must identify the clearest frame in which that object is visible.
- If an object appears in several frames or from several angles, list it only once and choose its clearest frame.
- Do not list the same object twice under slightly different names.
- Skip walls, floors, ceilings, windows, doors, people, pets, and general room features.
- Do not guess or invent objects. Only include objects clearly visible in at least one frame.
- Prefer specific names ("black TV remote") over vague words ("object").
- "where" should give a short useful description of the object's visible appearance AND where it was found, such as "black remote with gray buttons, on the coffee table". If it moves during the clip, use the clearest/latest useful location.
- Do not repeat the room name in "where".
- If no useful objects are visible, return {"items":[]}.
`;

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1] ?? text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no json");
  return JSON.parse(raw.slice(start, end + 1));
}

function parseItems(text: string, frames: SceneFrameInput[]): IdentifiedSceneItem[] {
  const parsed = extractJson(text) as { items?: unknown };
  if (!parsed || !Array.isArray(parsed.items)) return [];

  const out: IdentifiedSceneItem[] = [];
  const seen = new Set<string>();
  const lastFrame = Math.max(0, frames.length - 1);

  for (const raw of parsed.items) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as { name?: unknown; where?: unknown; frameIndex?: unknown };
    const name = cleanLabel(record.name, 60);
    const where = cleanLabel(record.where, 160) || "Somewhere in view";
    const key = normName(name);
    if (!key || SKIP.has(key) || seen.has(key)) continue;

    // Coerce frameIndex (model may return string, float, or out-of-range values).
    // Clamp to a valid frame instead of dropping the item entirely.
    let frameIndex = Number(record.frameIndex);
    if (!Number.isFinite(frameIndex)) frameIndex = 0;
    frameIndex = Math.max(0, Math.min(lastFrame, Math.round(frameIndex)));

    seen.add(key);
    out.push({
      name,
      where,
      frameIndex,
      timestampMs: frames[frameIndex].timestampMs,
    });
    if (out.length >= 30) break;
  }

  return out;
}

export const identifyScene = createServerFn({ method: "POST" })
  .validator((input: { frames?: SceneFrameInput[]; roomName?: string }) => {
    const frames = input?.frames;
    if (!Array.isArray(frames) || frames.length === 0 || frames.length > MAX_FRAMES) {
      throw new Error("The recording frames are missing or invalid. Please record again.");
    }

    let totalSize = 0;
    const safeFrames = frames.map((frame) => {
      if (
        !frame ||
        typeof frame.imageBase64 !== "string" ||
        frame.imageBase64.length < 32 ||
        frame.imageBase64.length > MAX_FRAME_BASE64 ||
        typeof frame.timestampMs !== "number" ||
        !Number.isFinite(frame.timestampMs) ||
        frame.timestampMs < 0 ||
        frame.timestampMs > 60_000
      ) {
        throw new Error("A recording frame could not be read. Please record again.");
      }

      totalSize += frame.imageBase64.length;
      return {
        imageBase64: frame.imageBase64,
        timestampMs: Math.round(frame.timestampMs),
      };
    });

    if (totalSize > MAX_TOTAL_BASE64) {
      throw new Error("This recording is too large to analyze. Please try recording more slowly.");
    }

    const roomName = typeof input.roomName === "string"
      ? input.roomName.slice(0, 40)
      : "room";

    return { frames: safeFrames, roomName };
  })
  .handler(async ({ data }): Promise<IdentifyResult> => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { ok: false, error: "Vision isn't configured yet. Please try again later." };
    }

    const prompt = `${PROMPT}\nThe room is: ${data.roomName}. There are ${data.frames.length} frames, numbered from 0 to ${data.frames.length - 1}.`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

    try {
      const parts: Array<
        { inline_data: { mime_type: string; data: string } } | { text: string }
      > = [];

      data.frames.forEach((frame, index) => {
        parts.push({
          inline_data: {
            mime_type: "image/jpeg",
            data: frame.imageBase64,
          },
        });
        parts.push({ text: `Frame index ${index}.` });
      });
      parts.push({ text: prompt });

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 3000,
          },
        }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!response.ok) {
        console.error("Gemini video-frame identification failed", response.status);
        if (response.status === 401 || response.status === 403) {
          return { ok: false, error: "Gemini couldn't authorize the request. Check the API key configuration." };
        }
        if (response.status === 429) {
          return { ok: false, error: "Gemini's request limit was reached. Please wait a little and try again." };
        }
        return { ok: false, error: "Couldn't analyze this recording. You can try recording again or name things yourself." };
      }

      const body = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = body.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("\n")
        .trim();

      if (!text) {
        return { ok: false, error: "Gemini returned no object list. Please try another recording." };
      }

      try {
        return { ok: true, items: parseItems(text, data.frames) };
      } catch {
        return { ok: false, error: "Couldn't read the objects Gemini identified. Please try again." };
      }
    } catch (error) {
      console.error(
        "Gemini recording analysis failed",
        error instanceof Error ? error.message : "unknown",
      );
      return { ok: false, error: "Couldn't reach Gemini. Check your connection and try again." };
    }
  });

