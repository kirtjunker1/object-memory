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

// Current multimodal Flash models (2.5 is limited to existing users).
const MODEL_CANDIDATES = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-2.5-flash-lite",
] as const;
const MAX_FRAMES = 8;
const MAX_TOTAL_BASE64 = 3_000_000;
const MAX_FRAME_BASE64 = 900_000;

const SKIP = new Set([
  "wall", "floor", "ceiling", "window", "door", "room", "ground",
  "picture", "photo", "image", "person", "people",
]);

const PROMPT = `You are reviewing an ordered sequence of still frames from a phone camera panning around a home. Build one inventory of distinct household objects a person would want to find later.

Return ONLY JSON in this exact shape:
{"items":[{"name":"short everyday object name","where":"brief description and location","frameIndex":0}]}

Rules:
- Look carefully at EVERY frame. Objects often appear only in middle or later frames.
- List up to 30 distinct, clearly visible physical objects (remotes, keys, phones, books, mugs, bags, chargers, shoes, pillows, plants, lamps, etc.).
- frameIndex is zero-based and must be the clearest frame showing that object (integer from 0 to the last frame index).
- List each object only once; pick its best frame.
- Skip walls, floors, ceilings, windows, doors, people, pets, and empty open space.
- Do not invent objects. Prefer specific names ("black TV remote") over vague ones ("object").
- "where" should describe appearance and place, e.g. "black remote with gray buttons, on the coffee table".
- Do not repeat the room name in "where".
- If nothing useful is visible, return {"items":[]}.
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
    let frames = input?.frames;
    if (!Array.isArray(frames) || frames.length === 0) {
      throw new Error("The recording frames are missing or invalid. Please record again.");
    }

    // Evenly subsample if the client sent more frames than we allow.
    if (frames.length > MAX_FRAMES) {
      const picked: typeof frames = [];
      for (let i = 0; i < MAX_FRAMES; i += 1) {
        const idx = Math.round((i * (frames.length - 1)) / (MAX_FRAMES - 1));
        picked.push(frames[idx]);
      }
      frames = picked;
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

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const buildParts = (frames: typeof data.frames) => {
      const next: Array<
        { inline_data: { mime_type: string; data: string } } | { text: string }
      > = [];
      frames.forEach((frame, index) => {
        const raw = frame.imageBase64.includes(",")
          ? frame.imageBase64.slice(frame.imageBase64.indexOf(",") + 1)
          : frame.imageBase64;
        next.push({
          inline_data: {
            mime_type: "image/jpeg",
            data: raw,
          },
        });
        next.push({ text: `Frame index ${index}.` });
      });
      next.push({
        text: `${PROMPT}\nThe room is: ${data.roomName}. There are ${frames.length} frames, numbered from 0 to ${frames.length - 1}.`,
      });
      return next;
    };

    const callGemini = async (
      model: string,
      frames: typeof data.frames,
    ): Promise<{ ok: true; text: string } | { ok: false; status: number; body: string }> => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: buildParts(frames) }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 4096,
          },
        }),
        signal: AbortSignal.timeout(90_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return { ok: false, status: response.status, body };
      }

      const payload = await response.json() as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const text = payload.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? "")
        .join("\n")
        .trim();

      if (!text) {
        return { ok: false, status: 200, body: "empty candidates" };
      }
      return { ok: true, text };
    };

    // Frame sets to try: full set, then lighter subsets if Gemini is overloaded.
    const frameSets: Array<typeof data.frames> = [data.frames];
    if (data.frames.length > 4) {
      const light: typeof data.frames = [];
      for (let i = 0; i < 4; i += 1) {
        const idx = Math.round((i * (data.frames.length - 1)) / 3);
        light.push(data.frames[idx]);
      }
      frameSets.push(light);
    }
    if (data.frames.length > 1) {
      frameSets.push([data.frames[Math.floor(data.frames.length / 2)]]);
    }

    try {
      let lastStatus = 0;
      let lastBody = "";

      for (const frames of frameSets) {
        for (const model of MODEL_CANDIDATES) {
          // Retry transient overload (503) and rate limits (429).
          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (attempt > 0) {
              await sleep(800 * attempt * attempt);
            }

            let result: Awaited<ReturnType<typeof callGemini>>;
            try {
              result = await callGemini(model, frames);
            } catch (error) {
              console.error(
                "Gemini request threw",
                model,
                error instanceof Error ? error.message : "unknown",
              );
              lastStatus = 0;
              lastBody = error instanceof Error ? error.message : "network error";
              continue;
            }

            if (result.ok) {
              try {
                return { ok: true, items: parseItems(result.text, frames) };
              } catch {
                return { ok: false, error: "Couldn't read the objects Gemini identified. Please try again." };
              }
            }

            lastStatus = result.status;
            lastBody = result.body;
            console.error(
              "Gemini identification failed",
              model,
              result.status,
              `frames=${frames.length}`,
              `attempt=${attempt + 1}`,
              result.body.slice(0, 300),
            );

            if (result.status === 401 || result.status === 403) {
              return { ok: false, error: "Gemini couldn't authorize the request. Check the API key configuration." };
            }
            if (result.status === 400) {
              break;
            }
            if (result.status === 404) {
              break;
            }
            if (result.status === 429 || result.status === 503) {
              continue;
            }
            break;
          }
        }
      }

      console.error("All Gemini attempts failed", lastStatus, lastBody.slice(0, 300));
      if (lastStatus === 503) {
        return {
          ok: false,
          error: "Gemini is temporarily overloaded (503). Wait a minute and try a shorter Look, or name the frames yourself.",
        };
      }
      if (lastStatus === 429) {
        return { ok: false, error: "Gemini's request limit was reached. Please wait a little and try again." };
      }
      if (lastStatus === 404) {
        return {
          ok: false,
          error: "No available Gemini vision model for this API key. Check the key and model access in Google AI Studio.",
        };
      }
      return {
        ok: false,
        error: `Couldn't analyze this recording (Gemini ${lastStatus || "error"}). You can name the frames yourself.`,
      };
    } catch (error) {
      console.error(
        "Gemini recording analysis failed",
        error instanceof Error ? error.message : "unknown",
      );
      return { ok: false, error: "Couldn't reach Gemini. Check your connection and try again." };
    }
  });
