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
  /** Normalized crop box [x, y, width, height] in 0–1 image coordinates. */
  box?: [number, number, number, number];
};

export type IdentifyResult =
  | { ok: true; items: IdentifiedSceneItem[] }
  | { ok: false; error: string };

// Gemini models (tried first).
const GEMINI_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-2.5-flash-lite",
] as const;

// OpenRouter free vision models (fallback when Gemini is down/overloaded).
const OPENROUTER_MODELS = [
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
  "nvidia/nemotron-3.5-super-vl:free",
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
{"items":[{"name":"short everyday object name","where":"brief description and location","frameIndex":0,"box":[0.12,0.25,0.28,0.35]}]}

Rules:
- Look carefully at EVERY frame. Objects often appear only in middle or later frames.
- List up to 30 distinct, clearly visible physical objects (remotes, keys, phones, books, mugs, bags, chargers, shoes, pillows, plants, lamps, etc.).
- frameIndex is zero-based and must be the clearest frame showing that object (integer from 0 to the last frame index).
- List each object only once; pick its best frame.
- box is the object's tight bounding box in that frame as [x, y, width, height], each a fraction from 0 to 1 of the image width/height (x = left edge, y = top edge).
- Make box tight around the object with a small margin. Do not use the whole frame unless the object truly fills it.
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

function normalizeBox(raw: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(raw) || raw.length < 4) return undefined;
  const nums = raw.slice(0, 4).map((v) => Number(v));
  if (!nums.every((n) => Number.isFinite(n))) return undefined;

  const scale = nums.some((n) => Math.abs(n) > 1.5) ? 1000 : 1;
  const [a, b, c, d] = nums.map((n) => n / scale);

  const candidates: Array<[number, number, number, number]> = [
    [a, b, c, d],
    [a, b, c - a, d - b],
    [b, a, d - b, c - a],
  ];

  const score = (box: [number, number, number, number]) => {
    const [x, y, w, h] = box;
    if (w <= 0.02 || h <= 0.02) return -1;
    if (w > 1.05 || h > 1.05) return -1;
    if (x < -0.05 || y < -0.05) return -1;
    if (x + w > 1.1 || y + h > 1.1) return -1;
    const area = Math.min(1, Math.max(0, w)) * Math.min(1, Math.max(0, h));
    return 1 - area;
  };

  let best: [number, number, number, number] | null = null;
  let bestScore = -1;
  for (const cand of candidates) {
    const s = score(cand);
    if (s > bestScore) {
      bestScore = s;
      best = cand;
    }
  }
  if (!best || bestScore < 0) return undefined;

  let [x, y, w, h] = best;
  x = Math.min(0.95, Math.max(0, x));
  y = Math.min(0.95, Math.max(0, y));
  w = Math.min(1 - x, Math.max(0.05, w));
  h = Math.min(1 - y, Math.max(0.05, h));
  return [x, y, w, h];
}

function parseItems(text: string, frames: SceneFrameInput[]): IdentifiedSceneItem[] {
  const parsed = extractJson(text) as { items?: unknown };
  if (!parsed || !Array.isArray(parsed.items)) return [];

  const out: IdentifiedSceneItem[] = [];
  const seen = new Set<string>();
  const lastFrame = Math.max(0, frames.length - 1);

  for (const raw of parsed.items) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as {
      name?: unknown;
      where?: unknown;
      frameIndex?: unknown;
      box?: unknown;
    };
    const name = cleanLabel(record.name, 60);
    const where = cleanLabel(record.where, 160) || "Somewhere in view";
    const key = normName(name);
    if (!key || SKIP.has(key) || seen.has(key)) continue;

    let frameIndex = Number(record.frameIndex);
    if (!Number.isFinite(frameIndex)) frameIndex = 0;
    frameIndex = Math.max(0, Math.min(lastFrame, Math.round(frameIndex)));

    const box = normalizeBox(record.box);

    seen.add(key);
    out.push({
      name,
      where,
      frameIndex,
      timestampMs: frames[frameIndex].timestampMs,
      box,
    });
    if (out.length >= 30) break;
  }

  return out;
}

function stripDataUrl(base64: string): string {
  return base64.includes(",")
    ? base64.slice(base64.indexOf(",") + 1)
    : base64;
}

function buildPrompt(roomName: string, frameCount: number): string {
  return `${PROMPT}\nThe room is: ${roomName}. There are ${frameCount} frames, numbered from 0 to ${frameCount - 1}.`;
}

type ProviderOk = { ok: true; text: string };
type ProviderFail = { ok: false; status: number; body: string };
type ProviderResult = ProviderOk | ProviderFail;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(
  apiKey: string,
  model: string,
  frames: SceneFrameInput[],
  roomName: string,
): Promise<ProviderResult> {
  const parts: Array<
    { inline_data: { mime_type: string; data: string } } | { text: string }
  > = [];

  frames.forEach((frame, index) => {
    parts.push({
      inline_data: {
        mime_type: "image/jpeg",
        data: stripDataUrl(frame.imageBase64),
      },
    });
    parts.push({ text: `Frame index ${index}.` });
  });
  parts.push({ text: buildPrompt(roomName, frames.length) });

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
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

  if (!text) return { ok: false, status: 200, body: "empty candidates" };
  return { ok: true, text };
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  frames: SceneFrameInput[],
  roomName: string,
): Promise<ProviderResult> {
  const content: Array<
    { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
  > = [];

  frames.forEach((frame, index) => {
    content.push({
      type: "image_url",
      image_url: {
        url: `data:image/jpeg;base64,${stripDataUrl(frame.imageBase64)}`,
      },
    });
    content.push({ type: "text", text: `Frame index ${index}.` });
  });
  content.push({ type: "text", text: buildPrompt(roomName, frames.length) });

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://nook.app",
      "X-Title": "Nook object memory",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: 4096,
      temperature: 0.2,
    }),
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    return { ok: false, status: response.status, body };
  }

  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const text = payload.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) return { ok: false, status: 200, body: "empty choices" };
  return { ok: true, text };
}

function frameSetsFor(frames: SceneFrameInput[]): SceneFrameInput[][] {
  const sets: SceneFrameInput[][] = [frames];
  if (frames.length > 4) {
    const light: SceneFrameInput[] = [];
    for (let i = 0; i < 4; i += 1) {
      const idx = Math.round((i * (frames.length - 1)) / 3);
      light.push(frames[idx]);
    }
    sets.push(light);
  }
  if (frames.length > 1) {
    sets.push([frames[Math.floor(frames.length / 2)]]);
  }
  return sets;
}

export const identifyScene = createServerFn({ method: "POST" })
  .validator((input: { frames?: SceneFrameInput[]; roomName?: string }) => {
    let frames = input?.frames;
    if (!Array.isArray(frames) || frames.length === 0) {
      throw new Error("The recording frames are missing or invalid. Please record again.");
    }

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
    const geminiKey = process.env.GEMINI_API_KEY?.trim();
    const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();

    if (!geminiKey && !openRouterKey) {
      return {
        ok: false,
        error: "Vision isn't configured yet. Set GEMINI_API_KEY and/or OPENROUTER_API_KEY.",
      };
    }

    const sets = frameSetsFor(data.frames);
    let lastStatus = 0;
    let lastBody = "";
    let triedAny = false;

    const tryParse = (text: string, frames: SceneFrameInput[]): IdentifyResult => {
      try {
        return { ok: true, items: parseItems(text, frames) };
      } catch {
        return { ok: false, error: "Couldn't read the objects the AI identified. Please try again." };
      }
    };

    // 1) Gemini first
    if (geminiKey) {
      for (const frames of sets) {
        for (const model of GEMINI_MODELS) {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (attempt > 0) await sleep(800 * attempt * attempt);
            triedAny = true;

            let result: ProviderResult;
            try {
              result = await callGemini(geminiKey, model, frames, data.roomName);
            } catch (error) {
              console.error("Gemini threw", model, error instanceof Error ? error.message : "unknown");
              lastStatus = 0;
              lastBody = error instanceof Error ? error.message : "network error";
              continue;
            }

            if (result.ok) return tryParse(result.text, frames);

            lastStatus = result.status;
            lastBody = result.body;
            console.error(
              "Gemini failed",
              model,
              result.status,
              `frames=${frames.length}`,
              `attempt=${attempt + 1}`,
              result.body.slice(0, 200),
            );

            if (result.status === 401 || result.status === 403) break;
            if (result.status === 400 || result.status === 404) break;
            if (result.status === 429 || result.status === 503) continue;
            break;
          }
        }
      }
    }

    // 2) OpenRouter free vision models as fallback
    if (openRouterKey) {
      console.error("Falling back to OpenRouter after Gemini issues", lastStatus);
      for (const frames of sets) {
        for (const model of OPENROUTER_MODELS) {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            if (attempt > 0) await sleep(1000 * attempt);
            triedAny = true;

            let result: ProviderResult;
            try {
              result = await callOpenRouter(openRouterKey, model, frames, data.roomName);
            } catch (error) {
              console.error("OpenRouter threw", model, error instanceof Error ? error.message : "unknown");
              lastStatus = 0;
              lastBody = error instanceof Error ? error.message : "network error";
              continue;
            }

            if (result.ok) return tryParse(result.text, frames);

            lastStatus = result.status;
            lastBody = result.body;
            console.error(
              "OpenRouter failed",
              model,
              result.status,
              `frames=${frames.length}`,
              `attempt=${attempt + 1}`,
              result.body.slice(0, 200),
            );

            if (result.status === 401 || result.status === 403) {
              return {
                ok: false,
                error: "OpenRouter couldn't authorize the request. Check OPENROUTER_API_KEY.",
              };
            }
            if (result.status === 429) continue;
            if (result.status === 404) break;
            break;
          }
        }
      }
    }

    if (!triedAny) {
      return { ok: false, error: "Vision isn't configured yet. Please try again later." };
    }

    console.error("All vision providers failed", lastStatus, lastBody.slice(0, 300));

    if (lastStatus === 503) {
      return {
        ok: false,
        error: "Vision services are temporarily overloaded. Wait a minute and try a shorter Look, or name frames yourself.",
      };
    }
    if (lastStatus === 429) {
      return {
        ok: false,
        error: "Vision rate limit reached. Wait a little and try again, or name frames yourself.",
      };
    }
    if (!openRouterKey && (lastStatus === 503 || lastStatus === 429 || lastStatus === 0)) {
      return {
        ok: false,
        error: "Gemini is unavailable right now. Add OPENROUTER_API_KEY for a free fallback, or name frames yourself.",
      };
    }

    return {
      ok: false,
      error: `Couldn't analyze this recording (${lastStatus || "error"}). You can name the frames yourself.`,
    };
  });
