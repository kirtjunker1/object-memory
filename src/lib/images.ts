const ANALYSIS_MAX_EDGE = 768;
const PHOTO_MAX_EDGE = 1920;
const ANALYSIS_QUALITY = 0.68;
const PHOTO_QUALITY = 0.94;
const MAX_ANALYSIS_FRAMES = 20;

function dimensions(source: HTMLVideoElement | ImageBitmap): {
  width: number;
  height: number;
} {
  if (source instanceof HTMLVideoElement) {
    return {
      width: source.videoWidth,
      height: source.videoHeight,
    };
  }

  return {
    width: source.width,
    height: source.height,
  };
}

function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Couldn't save that frame.")),
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

  if (!width || !height) {
    throw new Error("That frame isn't ready yet.");
  }

  const scale = Math.min(1, maxEdge / Math.max(width, height));

  const canvas = document.createElement("canvas");

  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));

  const context = canvas.getContext("2d", { alpha: false });

  if (!context) {
    throw new Error("Couldn't read that frame.");
  }

  context.drawImage(
    source,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  return canvasToJpeg(canvas, quality);
}

/** Capture a high-quality still for an item's saved photograph. */
export async function frameToJpeg(
  video: HTMLVideoElement,
): Promise<Blob> {
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
    return await drawToJpeg(
      bitmap,
      PHOTO_MAX_EDGE,
      PHOTO_QUALITY,
    );
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
    throw new Error(
      "Couldn't prepare that photo for analysis. Try another image.",
    );
  }

  try {
    return await drawToJpeg(
      bitmap,
      ANALYSIS_MAX_EDGE,
      ANALYSIS_QUALITY,
    );
  } finally {
    bitmap.close();
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());

  let binary = "";
  const chunk = 0x8000;

  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + chunk),
    );
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

/**
 * Wait for a media event, with a timeout so extraction cannot hang forever.
 */
function waitForMediaEvent(
  video: HTMLVideoElement,
  eventName: string,
  timeoutMs = 10000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout>;

    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener(eventName, onEvent);
      video.removeEventListener("error", onError);
    };

    const onEvent = () => {
      cleanup();
      resolve();
    };

    const onError = () => {
      cleanup();
      reject(
        new Error("The recording couldn't be opened on this device."),
      );
    };

    timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error("The recording took too long to process. Please try again."),
      );
    }, timeoutMs);

    video.addEventListener(eventName, onEvent, { once: true });
    video.addEventListener("error", onError, { once: true });
  });
}

/**
 * Recover a usable duration from a recording.
 *
 * Chromium-based browsers can report Infinity for WebM recordings created
 * with MediaRecorder. Seeking toward the end can force the browser to
 * discover and report the recording's actual duration.
 */
async function getVideoDuration(
  video: HTMLVideoElement,
): Promise<number> {
  // First, try the normal duration value.
  if (
    Number.isFinite(video.duration) &&
    video.duration > 0
  ) {
    return video.duration;
  }

  // Some browsers expose a usable end time through seekable ranges.
  const getSeekableEnd = (): number => {
    try {
      if (video.seekable.length > 0) {
        const end = video.seekable.end(video.seekable.length - 1);

        if (Number.isFinite(end) && end > 0) {
          return end;
        }
      }
    } catch {
      // The browser may not have populated seekable ranges yet.
    }

    return 0;
  };

  let duration = getSeekableEnd();

  if (duration > 0) {
    return duration;
  }

  // Chromium WebM duration recovery:
  // Seeking to a very large time can make the browser discover the end.
  try {
    const seeked = waitForMediaEvent(video, "seeked", 7000);

    video.currentTime = Number.MAX_SAFE_INTEGER;

    await seeked;
  } catch {
    // Continue to check duration and seekable ranges.
  }

  if (
    Number.isFinite(video.duration) &&
    video.duration > 0
  ) {
    duration = video.duration;
  } else {
    duration = getSeekableEnd();
  }

  if (!(duration > 0)) {
    throw new Error(
      "Couldn't determine the recording length. Please try recording again.",
    );
  }

  // Reset to the start so later frame seeks are reliable after the
  // Infinity-recovery seek left the playhead at the end.
  try {
    if (video.currentTime > 0.05) {
      const seeked = waitForMediaEvent(video, "seeked", 5000);
      video.currentTime = 0;
      await seeked;
    }
  } catch {
    // Frame extraction will still attempt individual seeks.
  }

  return duration;
}

/**
 * Extract up to 20 ordered stills, spread across the complete
 * one-minute recording.
 */
export async function extractFramesFromVideo(
  recording: Blob,
  maxFrames = MAX_ANALYSIS_FRAMES,
): Promise<ExtractedVideoFrame[]> {
  if (!recording.size) {
    throw new Error("The recording was empty. Please try again.");
  }

  const url = URL.createObjectURL(recording);

  const video = document.createElement("video");

  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;

  try {
    // Wait until the browser has loaded the recording metadata.
    const metadata = waitForMediaEvent(
      video,
      "loadedmetadata",
      15000,
    );

    video.src = url;
    video.load();

    await metadata;

    // Check video dimensions separately from duration.
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error(
        "The recording didn't contain readable video. Please try again.",
      );
    }

    // Recover the duration even if the browser initially reports Infinity.
    const actualDuration = await getVideoDuration(video);

    const duration = Math.min(actualDuration, 60);

    if (!duration || !Number.isFinite(duration)) {
      throw new Error(
        "Couldn't determine the recording length. Please try again.",
      );
    }

    // Sample more densely on short clips so stopping early still yields
    // enough frames for object identification.
    const count = Math.max(
      1,
      Math.min(
        maxFrames,
        MAX_ANALYSIS_FRAMES,
        duration < 3
          ? Math.max(1, Math.ceil(duration * 2))
          : Math.ceil(duration / 2.5),
      ),
    );

    // Avoid the absolute start/end of MediaRecorder WebM where keyframes
    // are sometimes missing or black.
    const firstTime = Math.min(0.15, Math.max(0, duration * 0.05));
    const lastTime = Math.max(
      firstTime,
      duration - Math.min(0.2, duration * 0.08),
    );

    const output: ExtractedVideoFrame[] = [];

    for (let index = 0; index < count; index += 1) {
      const progress =
        count === 1 ? 0.5 : index / (count - 1);

      const time =
        firstTime + (lastTime - firstTime) * progress;

      // Move to the requested timestamp.
      if (Math.abs(video.currentTime - time) > 0.01) {
        const seeked = waitForMediaEvent(
          video,
          "seeked",
          10000,
        );

        video.currentTime = time;

        await seeked;
      }

      // Brief settle so the decoded frame is painted before capture.
      await new Promise((resolve) => {
        requestAnimationFrame(() => resolve(undefined));
      });

      // Capture the high-quality photograph.
      const photoBlob = await drawToJpeg(
        video,
        PHOTO_MAX_EDGE,
        PHOTO_QUALITY,
      );

      // Create the smaller image for Gemini.
      const analysisBlob = await drawToJpeg(
        video,
        ANALYSIS_MAX_EDGE,
        ANALYSIS_QUALITY,
      );

      output.push({
        imageBase64: await blobToBase64(analysisBlob),
        photoBlob,
        timestampMs: Math.round(time * 1000),
      });
    }

    if (!output.length) {
      throw new Error(
        "No frames could be captured from that recording. Please try again.",
      );
    }

    return output;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();

    URL.revokeObjectURL(url);
  }
}

