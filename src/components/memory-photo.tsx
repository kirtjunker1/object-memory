import { MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";
import { getPhoto } from "@/lib/memory/db";

export function MemoryPhoto({
  photoKey,
  alt,
  className,
}: {
  photoKey: string | null;
  alt: string;
  className?: string;
}) {
  const staticUrl = photoKey?.startsWith("/") && !photoKey.startsWith("//") ? photoKey : null;
  const [url, setUrl] = useState<string | null>(staticUrl);

  useEffect(() => {
    if (!photoKey || photoKey.startsWith("/")) {
      setUrl(staticUrl);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void getPhoto(photoKey).then((blob) => {
      if (cancelled || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photoKey, staticUrl]);

  if (!url) {
    return (
      <span className={cn("flex items-center justify-center bg-accent-soft text-accent", className)}>
        <MapPin className="size-4" aria-hidden />
      </span>
    );
  }

  return <img src={url} alt={alt} className={cn("bg-paper-deep object-cover", className)} />;
}
