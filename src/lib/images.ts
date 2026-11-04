const ANALYSIS_MAX_EDGE = 768;
const PHOTO_MAX_EDGE = 1920;
const ANALYSIS_QUALITY = 0.68;
const PHOTO_QUALITY = 0.94;
const MAX_ANALYSIS_FRAMES = 20;

function dimensions(source: HTMLVideoElement | ImageBitmap): { width: number; height: number } {
  if (source instanceof HTMLVideoElement) {
    return { width: source.videoWidth, height: source.videoHeight };
  }
  return { width: source.width, height: source.height };
}

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't save that frame."))),
      "image/jpeg",
      quality,
    );
  });
}

async function drawToJpeg(
  source: HTMLVideoElement | ImageBitmap,
  maxEdge: number,
  quality: number,
): Promise<Blob> {
  const { width, height } = dimensions(source);
  if (!width || !height) throw new Error("That frame isn't ready yet.");

  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext("2d", { alpha: false });
  if (!context) throw new Error("Couldn't read that frame.");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvasToJpeg(canvas, quality);
}

/** Capture a high-quality still for an item's saved photograph. */
export async function frameToJpeg(video: HTMLVideoElement): Promise<Blob> {
  return drawToJpeg(video, PHOTO_MAX_EDGE, PHOTO_QUALITY);
}

/** Convert a selected photo while retaining a high-quality copy for review. */
export async function fileToJpeg(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Couldn't read that photo. Try a JPG or PNG.");
  }
  try {
    return await drawToJpeg(bitmap, PHOTO_MAX_EDGE, PHOTO_QUALITY);
  } finally {
    bitmap.close();
  }
}

/** Make a compact analysis copy while keeping the high-quality original for review. */
export async function photoToAnalysisJpeg(photo: Blob): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(photo);
  } catch {
    throw new Error("Couldn't prepare that photo for analysis. Try another image.");
  }
  try {
    return await drawToJpeg(bitmap, ANALYSIS_MAX_EDGE, ANALYSIS_QUALITY);
  } finally {
    bitmap.close();
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export type ExtractedVideoFrame = {
  /** Reduced image sent to Gemini for analysis. */
  imageBase64: string;
  /** High-quality still saved as the discovered item's photograph. */
  photoBlob: Blob;
  /** Milliseconds from the beginning of the recording. */
  timestampMs: number;
};

function waitForMediaEvent(video: HTMLVideoElement, eventName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The recording couldn't be opened on this device."));
    };
    const cleanup = () => {
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

/** Extract up to 20 ordered stills, spread across the complete one-minute recording. */
export async function extractFramesFromVideo(
  recording: Blob,
  maxFrames = MAX_ANALYSIS_FRAMES,
): Promise<ExtractedVideoFrame[]> {
  if (!recording.size) throw new Error("The recording was empty. Please try again.");

  const url = URL.createObjectURL(recording);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    const metadata = waitForMediaEvent(video, "loadedmetadata");
    video.src = url;
    video.load();
    await metadata;

    const duration = Number.isFinite(video.duration) ? Math.min(video.duration, 60) : 0;
    if (!duration || !video.videoWidth || !video.videoHeight) {
      throw new Error("The recording didn't contain readable video. Please try again.");
    }

    const count = Math.max(1, Math.min(maxFrames, MAX_ANALYSIS_FRAMES, Math.ceil(duration / 3)));
    const firstTime = Math.min(0.1, duration / 2);
    const lastTime = Math.max(firstTime, duration - Math.min(0.1, duration / 2));
    const output: ExtractedVideoFrame[] = [];

    for (let index = 0; index < count; index += 1) {
      const progress = count === 1 ? 0.5 : index / (count - 1);
      const time = firstTime + (lastTime - firstTime) * progress;

      if (Math.abs(video.currentTime - time) > 0.01) {
        const seeked = waitForMediaEvent(video, "seeked");
        video.currentTime = time;
        await seeked;
      }

      const photoBlob = await drawToJpeg(video, PHOTO_MAX_EDGE, PHOTO_QUALITY);
      const analysisBlob = await drawToJpeg(video, ANALYSIS_MAX_EDGE, ANALYSIS_QUALITY);
      output.push({
        imageBase64: await blobToBase64(analysisBlob),
        photoBlob,
        timestampMs: Math.round(time * 1000),
      });
    }

    return output;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}
