import { Link, useRouterState } from "@tanstack/react-router";
import { Camera, House, Search } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useMemory } from "@/lib/memory/store";

const LINKS = [
  { to: "/", label: "Home", icon: House },
  { to: "/scan", label: "Scan", icon: Camera },
  { to: "/find", label: "Find", icon: Search },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const hydrate = useMemory((state) => state.hydrate);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <div className="min-h-dvh bg-paper text-ink">
      <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-5 md:px-8">
        <div className="min-w-0 flex-1">{children}</div>
        <nav
          aria-label="Primary"
          className="sticky bottom-0 z-10 -mx-5 mt-6 border-t border-line bg-paper/95 px-5 pb-safe backdrop-blur md:-mx-8 md:px-8"
        >
          <ul className="grid grid-cols-3">
            {LINKS.map((link) => {
              const active = link.to === "/" ? pathname === "/" : pathname.startsWith(link.to);
              const Icon = link.icon;
              return (
                <li key={link.to}>
                  <Link
                    to={link.to}
                    search={link.to === "/find" ? { q: "", room: "" } : undefined}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-14 flex-col items-center justify-center gap-1 text-xs font-medium",
                      active ? "text-accent" : "text-muted",
                    )}
                  >
                    <Icon className="size-5" aria-hidden />
                    {link.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </div>
    </div>
  );
}
