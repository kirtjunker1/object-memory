import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Camera, CircleStop, LoaderCircle, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ItemRow } from "@/components/item-row";
import { identifyScene } from "@/lib/identify.functions";
import { blobToBase64, cropJpeg, extractFramesFromVideo, fileToJpeg, frameToJpeg, photoToAnalysisJpeg } from "@/lib/images";
import { cn } from "@/lib/cn";
import { PRESET_ROOMS, normName, uid } from "@/lib/memory/names";
import { useMemory } from "@/lib/memory/store";
import { useCamera } from "@/lib/use-camera";
import { btnPrimary, btnQuiet, btnSecondary, field } from "@/lib/ui";

export const Route = createFileRoute("/scan")({
  head: () => ({ meta: [{ title: "Scan a room · Nook" }] }),
  component: ScanPage,
});

type Draft = {
  id: string;
  name: string;
  where: string;
  keep: boolean;
  photoBlob: Blob | null;
  photoUrl: string | null;
  seenAt: number;
};

type Phase = "look" | "recording" | "processing" | "review";
const LOOKS_PER_DAY = 25;
const MAX_RECORDING_MS = 60_000;

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
}

function looksUsed(): number {
  if (typeof localStorage === "undefined") return 0;
  try {
    const raw = localStorage.getItem("nook.looks");
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { day?: string; n?: number };
    if (parsed.day !== todayKey() || typeof parsed.n !== "number") return 0;
    return parsed.n;
  } catch {
    return 0;
  }
}

function noteLook() {
  try {
    localStorage.setItem("nook.looks", JSON.stringify({ day: todayKey(), n: looksUsed() + 1 }));
  } catch {
    // ignore
  }
}

function formatClock(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatSeenAt(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function ScanPage() {
  const identify = useServerFn(identifyScene);
  const { videoRef, live, error: cameraError, startCamera, stopCamera } = useCamera();
  const ready = useMemory((state) => state.ready);
  const rooms = useMemory((state) => state.rooms);
  const items = useMemory((state) => state.items);
  const remember = useMemory((state) => state.remember);

  const [room, setRoom] = useState("Living room");
  const [custom, setCustom] = useState("");
  const [phase, setPhase] = useState<Phase>("look");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [busy, setBusy] = useState(false);
  const [recordingMs, setRecordingMs] = useState(0);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [extraName, setExtraName] = useState("");
  const [extraWhere, setExtraWhere] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const frameTimerRef = useRef<number | null>(null);
  const liveFramesRef = useRef<{ photoBlob: Blob; imageBase64: string; timestampMs: number }[]>([]);
  const capturingFrameRef = useRef(false);
  const draftUrlsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      if (frameTimerRef.current !== null) window.clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
      recorderRef.current = null;
      chunksRef.current = [];
      liveFramesRef.current = [];
      for (const url of draftUrlsRef.current) URL.revokeObjectURL(url);
      draftUrlsRef.current.clear();
    };
  }, []);

  const roomNames = useMemo(() => {
    const names = [...PRESET_ROOMS];
    for (const stored of rooms) {
      if (!names.some((name) => normName(name) === normName(stored.name))) names.push(stored.name);
    }
    if (room && !names.some((name) => normName(name) === normName(room))) names.unshift(room);
    return names;
  }, [rooms, room]);

  const roomRecord = rooms.find((stored) => normName(stored.name) === normName(room));
  const inRoom = items
    .filter((item) => roomRecord && item.roomId === roomRecord.id)
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);

  function clearDraftUrls() {
    for (const url of draftUrlsRef.current) URL.revokeObjectURL(url);
    draftUrlsRef.current.clear();
  }

  async function openReview(
    spots: {
      name: string;
      where: string;
      frameIndex?: number;
      timestampMs?: number;
      box?: [number, number, number, number];
    }[],
    frames: { photoBlob: Blob; timestampMs: number }[],
    recordingStartedAt: number,
  ) {
    if (!mountedRef.current) return;
    clearDraftUrls();

    const nextDrafts = await Promise.all(
      spots.map(async (spot) => {
        const frame = frames[spot.frameIndex ?? 0];
        let photoBlob = frame?.photoBlob ?? null;

        if (photoBlob && spot.box) {
          try {
            photoBlob = await cropJpeg(photoBlob, spot.box);
          } catch {
            // Keep the full frame if cropping fails.
          }
        }

        const photoUrl = photoBlob ? URL.createObjectURL(photoBlob) : null;
        if (photoUrl) draftUrlsRef.current.add(photoUrl);
        return {
          id: uid(),
          name: spot.name,
          where: spot.where,
          keep: true,
          photoBlob,
          photoUrl,
          seenAt: recordingStartedAt + (spot.timestampMs ?? frame?.timestampMs ?? 0),
        };
      }),
    );

    if (!mountedRef.current) return;
    setDrafts(nextDrafts);
    setExtraName("");
    setExtraWhere("");
    setPhase("review");
  }

  async function captureLiveFrame(): Promise<void> {
    if (capturingFrameRef.current) return;
    const video = videoRef.current;
    if (!video || video.videoWidth < 2 || video.videoHeight < 2) return;
    if (liveFramesRef.current.length >= 20) return;
    capturingFrameRef.current = true;
    try {
      const photoBlob = await frameToJpeg(video);
      const analysisBlob = await photoToAnalysisJpeg(photoBlob);
      const imageBase64 = await blobToBase64(analysisBlob);
      const timestampMs = Math.max(0, Date.now() - startTimeRef.current);
      liveFramesRef.current.push({ photoBlob, imageBase64, timestampMs });
    } catch {
      // skip missed frame
    } finally {
      capturingFrameRef.current = false;
    }
  }

  async function analyzeFrames(
    frames: { photoBlob: Blob; imageBase64: string; timestampMs: number }[],
    recordingStartedAt: number,
  ) {
    setPhase("processing");
    setBusy(true);
    setBanner("Preparing frames for AI review…");
    setError(null);
    try {
      if (!frames.length) {
        throw new Error("No frames were captured from the recording. Please try again.");
      }
      if (!mountedRef.current) return;
      setBanner(`Analyzing ${frames.length} moments from your recording…`);
      const result = await identify({
        data: {
          roomName: room,
          frames: frames.map(({ imageBase64, timestampMs }) => ({ imageBase64, timestampMs })),
        },
      });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result.error);
        await openReview(
          frames.map((_, index) => ({ name: "", where: "", frameIndex: index })),
          frames,
          recordingStartedAt,
        );
        setBanner("AI review failed. You can name the captured frames below or add items manually.");
        return;
      }
      if (result.items.length) {
        await openReview(result.items, frames, recordingStartedAt);
        setBanner(
          `Found ${result.items.length} possible ${result.items.length === 1 ? "item" : "items"}. Review them before saving.`,
        );
      } else {
        await openReview(
          frames.map((_, index) => ({ name: "", where: "", frameIndex: index })),
          frames,
          recordingStartedAt,
        );
        setBanner("No clear objects were identified. Name the frames below or add items manually.");
      }
    } catch (caught) {
      if (mountedRef.current) {
        setError(caught instanceof Error ? caught.message : "Couldn't analyze that recording.");
        setPhase("look");
        void startCamera();
      }
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  function stopFrameCapture() {
    if (frameTimerRef.current !== null) {
      window.clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
  }

  function stopRecording() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    stopFrameCapture();
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      setPhase("processing");
      setBusy(true);
      setBanner("Finishing your recording…");
      void (async () => {
        await captureLiveFrame();
        try {
          if (typeof recorder.requestData === "function") recorder.requestData();
        } catch {
          // ignore
        }
        if (recorder.state === "recording") recorder.stop();
      })();
    } else {
      const startedAt = startTimeRef.current;
      const frames = liveFramesRef.current.slice();
      liveFramesRef.current = [];
      if (frames.length) {
        void analyzeFrames(frames, startedAt);
      } else {
        setError("The recording was empty. Please try again.");
        setPhase("look");
        setBusy(false);
        void startCamera();
      }
    }
  }

  function startRecording() {
    if (busy || phase === "recording") return;
    if (!live) {
      setError(cameraError ?? "The camera isn't ready yet.");
      return;
    }
    if (looksUsed() >= LOOKS_PER_DAY) {
      setError("You've used today's 25 scans. Please try again tomorrow.");
      return;
    }

    const video = videoRef.current;
    const stream = video?.srcObject;
    if (!(stream instanceof MediaStream)) {
      setError("The camera stream isn't available. Please reload the page and allow camera access.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setError("Video recording isn't supported by this browser. Try the latest version of Chrome or Safari.");
      return;
    }

    try {
      const preferredTypes = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/mp4"];
      const mimeType = preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2_500_000 })
        : new MediaRecorder(stream, { videoBitsPerSecond: 2_500_000 });

      chunksRef.current = [];
      liveFramesRef.current = [];
      capturingFrameRef.current = false;
      startTimeRef.current = Date.now();
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        stopFrameCapture();
        recorder.onstop = null;
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          // ignore
        }
        recorderRef.current = null;
        chunksRef.current = [];
        liveFramesRef.current = [];
        stopCamera();
        if (!mountedRef.current) return;
        setError("The camera recording ran into a problem. Please try again.");
        setPhase("look");
        setBusy(false);
        void startCamera();
      };
      recorder.onstop = () => {
        const startedAt = startTimeRef.current;
        const liveFrames = liveFramesRef.current.slice();
        liveFramesRef.current = [];
        const chunks = chunksRef.current.slice();
        const mime = recorder.mimeType || "video/webm";
        recorderRef.current = null;
        chunksRef.current = [];
        stopCamera();
        if (!mountedRef.current) return;

        if (liveFrames.length > 0) {
          void analyzeFrames(liveFrames, startedAt);
          return;
        }

        const recording = new Blob(chunks, { type: mime });
        if (!recording.size) {
          setError("The recording was empty. Please try again.");
          setPhase("look");
          setBusy(false);
          void startCamera();
          return;
        }
        void (async () => {
          try {
            setBanner("Preparing the recording for AI review…");
            const frames = await extractFramesFromVideo(recording, 20);
            if (!mountedRef.current) return;
            await analyzeFrames(frames, startedAt);
          } catch (caught) {
            if (mountedRef.current) {
              setError(caught instanceof Error ? caught.message : "Couldn't analyze that recording.");
              setPhase("look");
              setBusy(false);
              void startCamera();
            }
          }
        })();
      };

      recorder.start(250);
      noteLook();
      setRecordingMs(0);
      setBanner("Recording. Slowly move around the room so objects are clear.");
      setError(null);
      setPhase("recording");

      void captureLiveFrame();
      frameTimerRef.current = window.setInterval(() => {
        void captureLiveFrame();
      }, 2000);

      timerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        setRecordingMs(Math.min(elapsed, MAX_RECORDING_MS));
        if (elapsed >= MAX_RECORDING_MS) stopRecording();
      }, 200);
    } catch (caught) {
      recorderRef.current = null;
      chunksRef.current = [];
      liveFramesRef.current = [];
      stopFrameCapture();
      setError(caught instanceof Error ? caught.message : "Couldn't start video recording.");
      setPhase("look");
    }
  }

  async function onFile(file: File | undefined) {
    if (!file || busy || phase === "recording") return;
    setBusy(true);
    setBanner(null);
    setError(null);
    try {
      const photoBlob = await fileToJpeg(file);
      const photoSeenAt = Date.now();
      if (!mountedRef.current) return;
      if (looksUsed() >= LOOKS_PER_DAY) {
        setBanner("You've used today's 25 scans. You can still add items manually.");
        await openReview([{ name: "", where: "", frameIndex: 0 }], [{ photoBlob, timestampMs: 0 }], photoSeenAt);
        return;
      }
      const analysisPhoto = await photoToAnalysisJpeg(photoBlob);
      const imageBase64 = await blobToBase64(analysisPhoto);
      noteLook();
      const result = await identify({
        data: { roomName: room, frames: [{ imageBase64, timestampMs: 0 }] },
      });
      if (!mountedRef.current) return;
      if (!result.ok) {
        setError(result.error);
        await openReview([{ name: "", where: "", frameIndex: 0 }], [{ photoBlob, timestampMs: 0 }], photoSeenAt);
        return;
      }
      const reviewItems = result.items.length
        ? result.items
        : [{ name: "", where: "", frameIndex: 0 }];
      await openReview(reviewItems, [{ photoBlob, timestampMs: 0 }], photoSeenAt);
      if (!result.items.length) setBanner("Nothing stood out. Add a name to the photo below or add items manually.");
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "Couldn't use that photo.");
    } finally {
      if (mountedRef.current) setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function nameIt() {
    setError(null);
    const video = videoRef.current;
    if (live && video) {
      try {
        const photoBlob = await frameToJpeg(video);
        if (!mountedRef.current) return;
        await openReview([{ name: "", where: "", frameIndex: 0 }], [{ photoBlob, timestampMs: 0 }], Date.now());
        return;
      } catch {
        // continue without photo
      }
    }
    await openReview([{ name: "", where: "" }], [], Date.now());
  }

  function addExtra() {
    const name = extraName.trim();
    if (!name) return;
    setDrafts((current) => [
      ...current,
      {
        id: uid(),
        name,
        where: extraWhere.trim() || "Somewhere in view",
        keep: true,
        photoBlob: null,
        photoUrl: null,
        seenAt: Date.now(),
      },
    ]);
    setExtraName("");
    setExtraWhere("");
  }

  async function save() {
    const spots = drafts
      .filter((draft) => draft.keep && draft.name.trim())
      .map((draft) => ({
        name: draft.name,
        where: draft.where,
        photoBlob: draft.photoBlob,
        seenAt: draft.seenAt,
      }));
    if (!spots.length) {
      setError("Keep at least one thing, or add a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await remember({ roomName: room, spots });
      if (!mountedRef.current) return;
      setBanner(`Remembered ${spots.length} ${spots.length === 1 ? "thing" : "things"} in the ${room}.`);
      clearDraftUrls();
      setDrafts([]);
      setPhase("look");
      void startCamera();
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "Couldn't save that.");
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  return (
    <div className="py-8">
      <p className="text-sm font-medium text-accent">Scan</p>
      <h1 className="mt-1 font-display text-4xl leading-tight">Look around the room</h1>
      <p className="mt-2 max-w-xl text-muted">
        Record a short walkthrough. When you stop, Nook reviews the recording and finds the objects it can recognize.
      </p>

      <div className="mt-6 flex gap-2 overflow-x-auto no-scrollbar pb-1">
        {roomNames.map((name) => {
          const selected = normName(name) === normName(room);
          return (
            <button
              key={name}
              type="button"
              disabled={phase === "recording" || phase === "processing" || busy}
              onClick={() => setRoom(name)}
              className={cn(
                "min-h-11 shrink-0 rounded-full border px-4 text-sm font-medium disabled:opacity-50",
                selected ? "border-accent bg-accent text-on-accent" : "border-line bg-card text-ink",
              )}
            >
              {name}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          className={cn(field, "flex-1")}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="Or type a room name"
          disabled={phase === "recording" || phase === "processing" || busy}
        />
        <button
          type="button"
          className={btnSecondary}
          disabled={!custom.trim() || phase === "recording" || phase === "processing" || busy}
          onClick={() => {
            setRoom(custom.trim());
            setCustom("");
          }}
        >
          Use
        </button>
      </div>

      {(banner || error || cameraError) && (
        <div className="mt-4 space-y-2">
          {banner && <p className="rounded-2xl border border-line bg-card px-4 py-3 text-sm text-ink">{banner}</p>}
          {(error || cameraError) && (
            <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error || cameraError}</p>
          )}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div>
          <div className="relative overflow-hidden rounded-3xl border border-line bg-black aspect-[3/4] sm:aspect-video">
            <video ref={videoRef} className="h-full w-full object-cover" playsInline muted autoPlay />
            {phase === "recording" && (
              <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-sm text-white">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />
                {formatClock(recordingMs)}
              </div>
            )}
            {phase === "processing" && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/50 text-white">
                <LoaderCircle className="h-8 w-8 animate-spin" />
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {phase !== "recording" && phase !== "processing" && (
              <button type="button" className={btnPrimary} disabled={busy || !ready} onClick={startRecording}>
                <Video className="h-4 w-4" />
                Look
              </button>
            )}
            {phase === "recording" && (
              <button type="button" className={btnPrimary} onClick={stopRecording}>
                <CircleStop className="h-4 w-4" />
                Stop
              </button>
            )}
            <button type="button" className={btnSecondary} disabled={busy || phase === "recording" || phase === "processing"} onClick={() => void nameIt()}>
              <Camera className="h-4 w-4" />
              Name it myself
            </button>
            <button type="button" className={btnQuiet} disabled={busy || phase === "recording" || phase === "processing"} onClick={() => fileRef.current?.click()}>
              Upload photo
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>

          {phase === "review" && (
            <div className="mt-6 space-y-4">
              <h2 className="font-display text-2xl">Review what was found</h2>
              <div className="space-y-3">
                {drafts.map((draft) => (
                  <div key={draft.id} className="rounded-2xl border border-line bg-card p-3">
                    <div className="flex gap-3">
                      {draft.photoUrl ? (
                        <img src={draft.photoUrl} alt="" className="h-20 w-20 rounded-xl object-cover" />
                      ) : (
                        <div className="flex h-20 w-20 items-center justify-center rounded-xl bg-muted/20 text-xs text-muted">No photo</div>
                      )}
                      <div className="min-w-0 flex-1 space-y-2">
                        <input
                          className={field}
                          value={draft.name}
                          onChange={(e) =>
                            setDrafts((all) => all.map((d) => (d.id === draft.id ? { ...d, name: e.target.value } : d)))
                          }
                          placeholder="Name"
                        />
                        <input
                          className={field}
                          value={draft.where}
                          onChange={(e) =>
                            setDrafts((all) => all.map((d) => (d.id === draft.id ? { ...d, where: e.target.value } : d)))
                          }
                          placeholder="Where"
                        />
                        <p className="text-xs text-muted">{formatSeenAt(draft.seenAt)}</p>
                      </div>
                      <label className="flex items-center gap-1 text-sm">
                        <input
                          type="checkbox"
                          checked={draft.keep}
                          onChange={(e) =>
                            setDrafts((all) => all.map((d) => (d.id === draft.id ? { ...d, keep: e.target.checked } : d)))
                          }
                        />
                        Keep
                      </label>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                <input className={cn(field, "flex-1")} value={extraName} onChange={(e) => setExtraName(e.target.value)} placeholder="Add another name" />
                <input className={cn(field, "flex-1")} value={extraWhere} onChange={(e) => setExtraWhere(e.target.value)} placeholder="Where" />
                <button type="button" className={btnSecondary} onClick={addExtra}>Add</button>
              </div>

              <div className="flex gap-2">
                <button type="button" className={btnPrimary} disabled={busy} onClick={() => void save()}>
                  Save to {room}
                </button>
                <button
                  type="button"
                  className={btnQuiet}
                  disabled={busy}
                  onClick={() => {
                    clearDraftUrls();
                    setDrafts([]);
                    setPhase("look");
                    void startCamera();
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <aside className="rounded-3xl border border-line bg-card p-4">
          <h2 className="font-display text-xl">Already in {room}</h2>
          {!ready ? (
            <p className="mt-3 text-sm text-muted">Loading memory…</p>
          ) : inRoom.length === 0 ? (
            <p className="mt-3 text-sm text-muted">Nothing saved here yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {inRoom.map((item) => (
                <li key={item.id}>
                  <ItemRow item={item} roomName={room} />
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>
    </div>
  );
}
