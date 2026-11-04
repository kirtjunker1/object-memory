import { useCallback, useEffect, useRef, useState } from "react";

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startRequestRef = useRef(0);
  const startPromiseRef = useRef<Promise<void> | null>(null);
  const mountedRef = useRef(false);
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopCamera = useCallback(() => {
    startRequestRef.current += 1;
    startPromiseRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setLive(false);
  }, []);

  const startCamera = useCallback(async () => {
    const existing = streamRef.current;
    if (existing?.getVideoTracks().some((track) => track.readyState === "live")) {
      const video = videoRef.current;
      if (video && video.srcObject !== existing) {
        video.srcObject = existing;
        try {
          await video.play();
        } catch {
          // The stream remains available; the user can retry from the camera control.
        }
      }
      setLive(true);
      setError(null);
      return;
    }

    if (startPromiseRef.current) return startPromiseRef.current;

    if (!navigator.mediaDevices?.getUserMedia) {
      setLive(false);
      setError("This browser can't access the camera. Open the site in a modern browser over HTTPS.");
      return;
    }

    const requestId = ++startRequestRef.current;
    const attempt = Promise.resolve().then(async () => {
      let nextStream: MediaStream | null = null;
      try {
        setError(null);
        try {
          nextStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: "environment" },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
          });
        } catch {
          nextStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: "environment" } },
          });
        }

        if (requestId !== startRequestRef.current || !mountedRef.current) {
          nextStream.getTracks().forEach((track) => track.stop());
          return;
        }

        const video = videoRef.current;
        if (!video) throw new Error("The camera preview isn't ready. Please try again.");

        streamRef.current = nextStream;
        video.srcObject = nextStream;
        await video.play();

        if (requestId !== startRequestRef.current || !mountedRef.current) {
          nextStream.getTracks().forEach((track) => track.stop());
          if (streamRef.current === nextStream) streamRef.current = null;
          return;
        }

        setLive(true);
        setError(null);
      } catch (caught) {
        nextStream?.getTracks().forEach((track) => track.stop());
        if (streamRef.current === nextStream) streamRef.current = null;
        if (requestId !== startRequestRef.current || !mountedRef.current) return;

        setLive(false);
        if (videoRef.current) videoRef.current.srcObject = null;
        if (caught instanceof DOMException && caught.name === "NotAllowedError") {
          setError("Camera permission was denied. Allow camera access in your browser settings and try again.");
        } else if (caught instanceof DOMException && caught.name === "NotFoundError") {
          setError("No camera was found on this device.");
        } else if (caught instanceof DOMException && caught.name === "NotReadableError") {
          setError("The camera is being used by another app. Close that app and try again.");
        } else {
          setError(caught instanceof Error ? caught.message : "Couldn't start the camera. Check camera permissions and try again.");
        }
      } finally {
        if (startRequestRef.current === requestId) startPromiseRef.current = null;
      }
    });

    startPromiseRef.current = attempt;
    return attempt;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void startCamera();
    return () => {
      mountedRef.current = false;
      startRequestRef.current += 1;
      startPromiseRef.current = null;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [startCamera]);

  return { videoRef, live, error, startCamera, stopCamera };
}
