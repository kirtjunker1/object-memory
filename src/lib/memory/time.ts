import { format, isToday, isYesterday } from "date-fns";

export function seenLabel(ts: number): string {
  if (isToday(ts)) return `Today, ${format(ts, "h:mm a")}`;
  if (isYesterday(ts)) return `Yesterday, ${format(ts, "h:mm a")}`;
  return format(ts, "MMM d, h:mm a");
}
