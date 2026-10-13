"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sun, Moon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDateRange, type DateRange } from "@/hooks/use-date-range";
import { useTheme } from "@/hooks/use-theme";
import { supabaseAvailable } from "@/lib/utils";
import { usePlan } from "@/hooks/use-plan";

const pageTitles: Record<string, string> = {
  "/": "Overview",
  "/limits": "Limit Analysis",
  "/tokens": "Tokens",
  "/tools": "Tools",
  "/projects": "Projects",
  "/costs": "Costs",
  "/recommendations": "Tips",
};

const rangeLabels: Record<DateRange, string> = {
  today: "Today",
  "7d": "7 Days",
  "30d": "30 Days",
  "90d": "90 Days",
};

export function Header() {
  const pathname = usePathname();
  const { range, setRange } = useDateRange();
  const plan = usePlan();
  const { theme, toggleTheme } = useTheme();
  const [lastSync, setLastSync] = useState<string>("—");

  useEffect(() => {
    async function loadLastSync() {
      if (!supabaseAvailable()) return;
      try {
        const { createBrowserClient } = await import("@/lib/supabase/client");
        const supabase = createBrowserClient();
        const { data } = await supabase
          .from("sync_state")
          .select("last_sync_at")
          .order("id", { ascending: false })
          .limit(1);
        if (data && data.length > 0 && data[0].last_sync_at) {
          setLastSync(
            new Date(data[0].last_sync_at).toLocaleString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          );
        }
      } catch {}
    }
    loadLastSync();
  }, []);

  const title = pageTitles[pathname] ?? "Dashboard";

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-3 sm:px-4 lg:px-6">
      {/* Left: page title + last sync */}
      <div className="min-w-0">
        <h1 className="text-base sm:text-lg font-semibold truncate leading-tight">{title}</h1>
        <p className="text-[10px] text-muted-foreground leading-tight">
          Last sync: {lastSync}
        </p>
      </div>

      {/* Right: controls */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Date range selector */}
        <Select value={range} onValueChange={(val) => setRange(val as DateRange)}>
          <SelectTrigger className="h-8 w-[80px] sm:w-[100px] text-xs sm:text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.entries(rangeLabels) as [DateRange, string][]).map(
              ([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              )
            )}
          </SelectContent>
        </Select>

        {/* Theme toggle (visible on mobile, hidden on lg where sidebar has it) */}
        <button
          onClick={toggleTheme}
          className="md:hidden flex items-center justify-center size-8 rounded-lg border border-border text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>

        {/* Plan badge */}
        <Badge variant="outline" className="text-xs">{plan.label}</Badge>
      </div>
    </header>
  );
}
