import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Camera, CircleStop, LoaderCircle, Video } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ItemRow } from "@/components/item-row";
import { identifyScene } from "@/lib/identify.functions";
import { blobToBase64, extractFramesFromVideo, fileToJpeg, frameToJpeg, photoToAnalysisJpeg } from "@/lib/images";
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
    // Camera scanning should still work when browser storage is unavailable.
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
  const draftUrlsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      timerRef.current = null;
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
      recorderRef.current = null;
      chunksRef.current = [];
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

  function openReview(
    spots: { name: string; where: string; frameIndex?: number; timestampMs?: number }[],
    frames: { photoBlob: Blob; timestampMs: number }[],
    recordingStartedAt: number,
  ) {
    if (!mountedRef.current) return;
    clearDraftUrls();
    const nextDrafts = spots.map((spot) => {
      const frame = frames[spot.frameIndex ?? 0];
      const photoBlob = frame?.photoBlob ?? null;
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
    });
    setDrafts(nextDrafts);
    setExtraName("");
    setExtraWhere("");
    setPhase("review");
  }

  async function analyzeRecording(recording: Blob, recordingStartedAt: number) {
    setPhase("processing");
    setBusy(true);
    setBanner("Preparing the recording for AI review…");
    setError(null);
    try {
      const frames = await extractFramesFromVideo(recording, 20);
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
        openReview([{ name: "", where: "", frameIndex: 0 }], frames, recordingStartedAt);
        return;
      }
      const reviewItems = result.items.length
        ? result.items
        : [{ name: "", where: "", frameIndex: 0 }];
      openReview(reviewItems, frames, recordingStartedAt);
      setBanner(
        result.items.length
          ? `Found ${result.items.length} possible ${result.items.length === 1 ? "item" : "items"}. Review them before saving.`
          : "No clear objects were identified. Add a name to the photo below or add items manually.",
      );
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

  function stopRecording() {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      setPhase("processing");
      setBusy(true);
      setBanner("Finishing your recording…");
      recorder.stop();
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
      startTimeRef.current = Date.now();
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        if (timerRef.current !== null) window.clearInterval(timerRef.current);
        timerRef.current = null;
        recorder.onstop = null;
        try {
          if (recorder.state !== "inactive") recorder.stop();
        } catch {
          // The recorder may already have stopped after its error event.
        }
        recorderRef.current = null;
        chunksRef.current = [];
        stopCamera();
        if (!mountedRef.current) return;
        setError("The camera recording ran into a problem. Please try again.");
        setPhase("look");
        setBusy(false);
        void startCamera();
      };
      recorder.onstop = () => {
        const recording = new Blob(chunksRef.current, {
          type: recorder.mimeType || "video/webm",
        });
        const startedAt = startTimeRef.current;
        recorderRef.current = null;
        chunksRef.current = [];
        stopCamera();
        if (!mountedRef.current) return;
        if (!recording.size) {
          setError("The recording was empty. Please try again.");
          setPhase("look");
          setBusy(false);
          void startCamera();
          return;
        }
        void analyzeRecording(recording, startedAt);
      };

      recorder.start(1000);
      noteLook();
      setRecordingMs(0);
      setBanner("Recording. Slowly move around the room so objects are clear.");
      setError(null);
      setPhase("recording");
      timerRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startTimeRef.current;
        setRecordingMs(Math.min(elapsed, MAX_RECORDING_MS));
        if (elapsed >= MAX_RECORDING_MS) stopRecording();
      }, 200);
    } catch (caught) {
      recorderRef.current = null;
      chunksRef.current = [];
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
        openReview([{ name: "", where: "", frameIndex: 0 }], [{ photoBlob, timestampMs: 0 }], photoSeenAt);
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
        openReview([{ name: "", where: "", frameIndex: 0 }], [{ photoBlob, timestampMs: 0 }], photoSeenAt);
        return;
      }
      const reviewItems = result.items.length
        ? result.items
        : [{ name: "", where: "", frameIndex: 0 }];
      openReview(reviewItems, [{ photoBlob, timestampMs: 0 }], photoSeenAt);
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
        openReview([{ name: "", where: "", frameIndex: 0 }], [{ photoBlob, timestampMs: 0 }], Date.now());
        return;
      } catch {
        // Continue to the manual review screen without a photo.
      }
    }
    openReview([{ name: "", where: "" }], [], Date.now());
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
                selected
                  ? "border-accent bg-accent text-on-accent"
                  : "border-line bg-card text-ink",
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const name = custom.trim();
          if (!name || phase === "recording" || phase === "processing") return;
          setRoom(name.slice(0, 40));
          setCustom("");
        }}
      >
        <input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="New room"
          maxLength={40}
          aria-label="New room name"
          className={field}
          disabled={phase === "recording" || phase === "processing"}
        />
        <button type="submit" className={btnSecondary} disabled={phase === "recording" || phase === "processing"}>
          Add
        </button>
      </form>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(16rem,0.8fr)]">
        <div>
          <div className="relative aspect-video overflow-hidden rounded-xl bg-view">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              className="absolute inset-0 h-full w-full object-cover"
            />
            {!live && phase !== "review" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-view px-6 text-center text-view-fg">
                <Camera className="size-7" aria-hidden />
                <p className="max-w-xs text-sm">{cameraError ?? "Opening the camera…"}</p>
              </div>
            ) : null}
            {phase === "recording" ? (
              <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/75 px-3 py-2 text-sm font-semibold text-white">
                <span className="size-2.5 animate-pulse rounded-full bg-red-500" />
                REC {formatClock(recordingMs)} / 1:00
              </div>
            ) : null}
            {phase === "processing" ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/65 px-6 text-center text-white">
                <LoaderCircle className="size-8 animate-spin" aria-hidden />
                <p className="text-sm font-medium">Reviewing your recording…</p>
                <p className="text-xs text-white/80">This can take a little while.</p>
              </div>
            ) : null}
            {phase === "look" && live ? (
              <>
                <span className="pointer-events-none absolute left-3 top-3 size-6 border-l-2 border-t-2 border-view-fg" />
                <span className="pointer-events-none absolute right-3 top-3 size-6 border-r-2 border-t-2 border-view-fg" />
                <span className="pointer-events-none absolute bottom-3 left-3 size-6 border-b-2 border-l-2 border-view-fg" />
                <span className="pointer-events-none absolute bottom-3 right-3 size-6 border-b-2 border-r-2 border-view-fg" />
              </>
            ) : null}
          </div>

          {banner ? (
            <p className="mt-4 rounded-lg bg-accent-soft px-4 py-3 text-sm text-accent" role="status">
              {banner}
            </p>
          ) : null}
          {error ? (
            <p className="mt-4 rounded-lg border border-line bg-card px-4 py-3 text-sm" role="alert">
              {error}
            </p>
          ) : null}

          {phase === "look" ? (
            <div className="mt-4">
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  className={`${btnPrimary} flex-1`}
                  disabled={!live || busy || !ready}
                  onClick={startRecording}
                >
                  <span className="inline-flex items-center justify-center gap-2">
                    <Video className="size-4" /> Look
                  </span>
                </button>
                <label className={`${btnSecondary} flex-1 ${busy ? "pointer-events-none opacity-50" : ""}`}>
                  Photo
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="sr-only"
                    disabled={busy}
                    onChange={(event) => void onFile(event.target.files?.[0])}
                  />
                </label>
              </div>
              <button type="button" className={`${btnQuiet} mt-2`} onClick={() => void nameIt()} disabled={busy}>
                Name things yourself
              </button>
              <p className="mt-3 text-sm text-muted">
                Look records up to 60 seconds. After you stop, selected frames are analyzed together. Item photographs are saved on this device.
              </p>
            </div>
          ) : null}

          {phase === "recording" ? (
            <div className="mt-4">
              <button type="button" className={`${btnPrimary} w-full`} onClick={stopRecording}>
                <span className="inline-flex items-center justify-center gap-2">
                  <CircleStop className="size-4" /> Stop &amp; analyze
                </span>
              </button>
              <p className="mt-3 text-sm text-muted">
                Slowly pan around the room. Try to keep objects in view for a moment so Nook can identify them clearly.
              </p>
            </div>
          ) : null}

          {phase === "processing" ? (
            <p className="mt-4 text-sm text-muted">Please keep this page open while the recording is being analyzed.</p>
          ) : null}

          {phase === "review" ? (
            <div className="mt-4">
              <h2 className="font-display text-2xl">Review discoveries</h2>
              <p className="mt-1 text-sm text-muted">
                Check each object, adjust its name or location, and remove anything that shouldn't be saved.
              </p>
              {drafts.length === 0 ? (
                <p className="mt-3 text-sm text-muted">Nothing listed yet. Add anything you want remembered.</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-3">
                  {drafts.map((draft) => (
                    <li key={draft.id} className="rounded-lg border border-line bg-card p-3">
                      <div className="flex gap-3">
                        {draft.photoUrl ? (
                          <img src={draft.photoUrl} alt={draft.name} className="size-24 shrink-0 rounded-md object-cover" />
                        ) : (
                          <div className="flex size-24 shrink-0 items-center justify-center rounded-md bg-view text-muted">
                            <Camera className="size-6" />
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <label className="flex items-center gap-2 text-sm font-medium">
                            <input
                              type="checkbox"
                              checked={draft.keep}
                              onChange={(event) =>
                                setDrafts((current) => current.map((item) =>
                                  item.id === draft.id ? { ...item, keep: event.target.checked } : item,
                                ))
                              }
                            />
                            Keep this item
                          </label>
                          <p className="mt-2 text-xs text-muted">Seen {formatSeenAt(draft.seenAt)}</p>
                        </div>
                      </div>
                      <input
                        value={draft.name}
                        aria-label="Object name"
                        maxLength={60}
                        onChange={(event) => setDrafts((current) => current.map((item) =>
                          item.id === draft.id ? { ...item, name: event.target.value } : item,
                        ))}
                        className={`${field} mt-3`}
                      />
                      <input
                        value={draft.where}
                        aria-label="Description and where it was found"
                        placeholder="Description / where it was found"
                        maxLength={160}
                        onChange={(event) => setDrafts((current) => current.map((item) =>
                          item.id === draft.id ? { ...item, where: event.target.value } : item,
                        ))}
                        className={`${field} mt-2`}
                      />
                    </li>
                  ))}
                </ul>
              )}

              <form
                className="mt-4 flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  addExtra();
                }}
              >
                <input
                  value={extraName}
                  onChange={(event) => setExtraName(event.target.value)}
                  placeholder="Add something it missed"
                  aria-label="Add an object"
                  maxLength={60}
                  className={field}
                />
                <input
                  value={extraWhere}
                  onChange={(event) => setExtraWhere(event.target.value)}
                  placeholder="Description / where it was found"
                  aria-label="Description and where the added object was found"
                  maxLength={160}
                  className={field}
                />
                <button type="submit" className={btnSecondary}>Add to the list</button>
              </form>

              <div className="mt-4 flex flex-wrap gap-3">
                <button type="button" className={btnPrimary} disabled={busy || !ready} onClick={() => void save()}>
                  {busy ? "Saving…" : `Remember in ${room}`}
                </button>
                <button
                  type="button"
                  className={btnSecondary}
                  disabled={busy}
                  onClick={() => {
                    clearDraftUrls();
                    setPhase("look");
                    setDrafts([]);
                    setError(null);
                    setBanner(null);
                    void startCamera();
                  }}
                >
                  Look again
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <aside>
          <h2 className="font-display text-2xl">Already in the {room}</h2>
          {inRoom.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Nothing remembered here yet.</p>
          ) : (
            <ul className="mt-3 flex flex-col gap-2">
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
