"use client";

import { useEffect, useState } from "react";
import { resolvePlan, type ResolvedPlan } from "@/lib/constants";
import { supabaseAvailable } from "@/lib/utils";

// Shared across components so sync_state is queried once per page load
let detectedPlanPromise: Promise<string | null> | null = null;

async function fetchDetectedPlan(): Promise<string | null> {
  if (!supabaseAvailable()) return null;
  try {
    const { createBrowserClient } = await import("@/lib/supabase/client");
    const supabase = createBrowserClient();
    const { data, error } = await supabase
      .from("sync_state")
      .select("plan_type")
      .order("id", { ascending: false })
      .limit(1);
    // An error here usually means migration 008 hasn't been applied yet
    if (error) return null;
    return data?.[0]?.plan_type ?? null;
  } catch {
    return null;
  }
}

// Active plan, auto-detected from Claude Code's account data by ingest.py,
// falling back to NEXT_PUBLIC_PLAN_TYPE (see resolvePlan).
export function usePlan(): ResolvedPlan {
  const [plan, setPlan] = useState<ResolvedPlan>(() => resolvePlan(null));

  useEffect(() => {
    let cancelled = false;
    detectedPlanPromise ??= fetchDetectedPlan();
    detectedPlanPromise.then((detected) => {
      if (!cancelled) setPlan(resolvePlan(detected));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return plan;
}
