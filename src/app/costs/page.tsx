"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import {
  DollarSign,
  TrendingUp,
  Calendar,
  CreditCard,
  Zap,
  GitCommit,
} from "lucide-react";
import { formatNumber } from "@/lib/utils";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useDateRange } from "@/hooks/use-date-range";
import { MODEL_PRICING } from "@/lib/constants";
import { usePlan } from "@/hooks/use-plan";
import type { DailyAggregate } from "@/lib/supabase/types";
// ─── Sample Data ───────────────────────────────────────────────

const SAMPLE_COST_DATA = [
  { date: "May 19", opus: 2.85, sonnet: 0.42, haiku: 0.08 },
  { date: "May 20", opus: 4.12, sonnet: 0.31, haiku: 0.05 },
  { date: "May 21", opus: 1.95, sonnet: 0.78, haiku: 0.06 },
  { date: "May 22", opus: 5.67, sonnet: 0.18, haiku: 0.03 },
  { date: "May 23", opus: 3.42, sonnet: 0.52, haiku: 0.07 },
  { date: "May 24", opus: 4.88, sonnet: 0.25, haiku: 0.04 },
  { date: "May 25", opus: 2.64, sonnet: 0.38, haiku: 0.05 },
];

const MODEL_COLORS = {
  opus: "#8B5CF6",
  sonnet: "#3B82F6",
  haiku: "#10B981",
};

// ─── Helpers ───────────────────────────────────────────────────

interface CostRow {
  date: string;
  opus: number;
  sonnet: number;
  haiku: number;
}


function computeModelCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  let pricing = MODEL_PRICING["claude-opus"];
  if (model.includes("sonnet")) pricing = MODEL_PRICING["claude-sonnet"];
  else if (model.includes("haiku")) pricing = MODEL_PRICING["claude-haiku"];

  return (
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output +
    (cacheReadTokens / 1_000_000) * pricing.cacheRead +
    (cacheCreationTokens / 1_000_000) * pricing.cacheCreation
  );
}

function aggregateCosts(rows: DailyAggregate[]): CostRow[] {
  const map = new Map<string, { opus: number; sonnet: number; haiku: number }>();

  for (const r of rows) {
    const existing = map.get(r.date) ?? { opus: 0, sonnet: 0, haiku: 0 };
    const model = r.model || "";
    const cost = computeModelCost(
      model,
      r.total_input_tokens,
      r.total_output_tokens,
      r.total_cache_read_tokens,
      r.total_cache_creation_tokens
    );

    if (model.includes("sonnet")) existing.sonnet += cost;
    else if (model.includes("haiku")) existing.haiku += cost;
    else existing.opus += cost;

    map.set(r.date, existing);
  }

  return Array.from(map.entries())
    .map(([date, costs]) => ({
      date: new Date(date).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      }),
      opus: Number(costs.opus.toFixed(2)),
      sonnet: Number(costs.sonnet.toFixed(2)),
      haiku: Number(costs.haiku.toFixed(2)),
    }))
    .sort(
      (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );
}

// ─── Page Component ────────────────────────────────────────────

export default function CostsPage() {
  const { dateStr } = useDateRange();
  const plan = usePlan();
  const [costData, setCostData] = useState<CostRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    async function fetchData() {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

      if (!url || !key) {
        setCostData(SAMPLE_COST_DATA);
        setIsLive(false);
        setLoading(false);
        return;
      }

      try {
        const { createBrowserClient } = await import("@/lib/supabase/client");
        const supabase = createBrowserClient();
        const { data, error } = await supabase
          .from("daily_aggregates")
          .select("*")
          .gte("date", dateStr)
          .order("date", { ascending: true });

        if (error || !data || data.length === 0) {
          setCostData(SAMPLE_COST_DATA);
          setIsLive(false);
        } else {
          setCostData(aggregateCosts(data as DailyAggregate[]));
          setIsLive(true);
        }
      } catch {
        setCostData(SAMPLE_COST_DATA);
        setIsLive(false);
      }
      setLoading(false);
    }

    fetchData();
  }, [dateStr]);

  // Compute KPIs from cost data
  const todayCost = costData.length > 0
    ? costData[costData.length - 1].opus +
      costData[costData.length - 1].sonnet +
      costData[costData.length - 1].haiku
    : 0;

  const weekCost = costData.reduce(
    (s, d) => s + d.opus + d.sonnet + d.haiku,
    0
  );

  const avgDaily = costData.length > 0 ? weekCost / costData.length : 0;
  const monthCost = avgDaily * 25; // approximate month-to-date
  const projectedMonth = avgDaily * 30;

  // Token count estimate (rough: $1 ~ 66K tokens at opus rates)
  const totalTokensEstimate = weekCost * 66_000;

  // Value analysis derived values
  const planPrice = plan.monthlyPrice;
  const savings = projectedMonth - planPrice;
  const savingsPercent = projectedMonth > 0 ? ((savings / projectedMonth) * 100) : 0;
  const costPerCommit = avgDaily > 0 ? (avgDaily / 14) : 0;
  const dailyTokens = totalTokensEstimate / (costData.length || 1);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-80" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Cost Analysis</h1>
          <p className="text-xs text-muted-foreground">
            Equivalent API pricing for your {plan.label} flat-rate plan (${planPrice}/mo)
          </p>
        </div>
        <Badge variant="outline" className="gap-1.5 text-xs">
          <div
            className={`h-2 w-2 rounded-full ${isLive ? "bg-green-500 animate-pulse" : "bg-yellow-500"}`}
          />
          {isLive ? "Live Data" : "Sample Data"}
        </Badge>
      </div>

      {/* Section A: Cost KPIs - Gradient Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Today */}
        <Card className="bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border-emerald-500/20">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wider text-emerald-400 font-medium">Today</div>
              <DollarSign className="h-3.5 w-3.5 text-emerald-400/60" />
            </div>
            <div className="text-2xl font-bold tabular-nums text-emerald-400">
              ${todayCost.toFixed(2)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {todayCost < avgDaily ? "below" : "above"} daily avg &middot; {Math.abs(((todayCost - avgDaily) / (avgDaily || 1)) * 100).toFixed(0)}%
            </div>
          </CardContent>
        </Card>

        {/* This Week */}
        <Card className="bg-gradient-to-br from-blue-500/10 to-blue-600/5 border-blue-500/20">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wider text-blue-400 font-medium">This Week</div>
              <Calendar className="h-3.5 w-3.5 text-blue-400/60" />
            </div>
            <div className="text-2xl font-bold tabular-nums text-blue-400">
              ${weekCost.toFixed(2)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {costData.length}-day total
            </div>
          </CardContent>
        </Card>

        {/* This Month */}
        <Card className="bg-gradient-to-br from-violet-500/10 to-violet-600/5 border-violet-500/20">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wider text-violet-400 font-medium">This Month</div>
              <CreditCard className="h-3.5 w-3.5 text-violet-400/60" />
            </div>
            <div className="text-2xl font-bold tabular-nums text-violet-400">
              ${monthCost.toFixed(2)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              estimated to date
            </div>
          </CardContent>
        </Card>

        {/* Projected */}
        <Card className="bg-gradient-to-br from-amber-500/10 to-amber-600/5 border-amber-500/20">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wider text-amber-400 font-medium">Projected Month</div>
              <TrendingUp className="h-3.5 w-3.5 text-amber-400/60" />
            </div>
            <div className="text-2xl font-bold tabular-nums text-amber-400">
              ${projectedMonth.toFixed(2)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {projectedMonth > planPrice
                ? `+${((projectedMonth - planPrice) / planPrice * 100).toFixed(0)}% over ${plan.label}`
                : `${((planPrice - projectedMonth) / planPrice * 100).toFixed(0)}% under ${plan.label}`}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Section B: Daily Cost by Model - Stacked Bar Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Daily Cost by Model
          </CardTitle>
          <CardDescription className="text-xs">
            Equivalent API pricing. Your {plan.label} plan is ${planPrice}/mo flat.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={350}>
            <BarChart data={costData}>
              <defs>
                <linearGradient id="gradOpus" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0.5} />
                </linearGradient>
                <linearGradient id="gradSonnet" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3B82F6" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="#3B82F6" stopOpacity={0.5} />
                </linearGradient>
                <linearGradient id="gradHaiku" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10B981" stopOpacity={0.9} />
                  <stop offset="100%" stopColor="#10B981" stopOpacity={0.5} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="date" fontSize={11} tick={{ fill: "#888" }} />
              <YAxis
                fontSize={11}
                tick={{ fill: "#888" }}
                tickFormatter={(v: any) => `$${v}`}
              />
              <Tooltip
                contentStyle={{ background: "#1a1a2e", border: "1px solid #333", borderRadius: 8 }}
                formatter={(v: any) => [`$${Number(v).toFixed(2)}`, undefined]}
                labelFormatter={(label: any) => `Date: ${label}`}
                labelStyle={{ color: "#aaa" }}
                itemStyle={{ color: "#ddd" }}
              />
              <Legend
                wrapperStyle={{ fontSize: 11 }}
              />
              <Bar
                dataKey="opus"
                name="Opus"
                stackId="cost"
                fill="url(#gradOpus)"
              />
              <Bar
                dataKey="sonnet"
                name="Sonnet"
                stackId="cost"
                fill="url(#gradSonnet)"
              />
              <Bar
                dataKey="haiku"
                name="Haiku"
                stackId="cost"
                fill="url(#gradHaiku)"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Section C: Plan Value & Usage Metrics - 2-column layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Left: Plan Value */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Plan Value</CardTitle>
            <CardDescription className="text-xs">
              {plan.label} (${planPrice}/mo) vs equivalent API cost
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              {/* API Cost bar */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-muted-foreground">API equivalent</span>
                  <span className="text-xs font-mono font-medium text-foreground">${projectedMonth.toFixed(2)}</span>
                </div>
                <div className="h-2.5 w-full rounded-full bg-muted/50 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-500 to-violet-400 transition-all duration-500"
                    style={{ width: `${Math.min((projectedMonth / Math.max(projectedMonth, planPrice)) * 100, 100)}%` }}
                  />
                </div>
              </div>
              {/* Plan bar */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-muted-foreground">{plan.label} plan</span>
                  <span className="text-xs font-mono font-medium text-foreground">${planPrice.toFixed(2)}</span>
                </div>
                <div className="h-2.5 w-full rounded-full bg-muted/50 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 transition-all duration-500"
                    style={{ width: `${Math.min((planPrice / Math.max(projectedMonth, planPrice)) * 100, 100)}%` }}
                  />
                </div>
              </div>
            </div>

            <div className="rounded-lg bg-muted/30 border border-border/50 p-3">
              <div className={`text-lg font-bold tabular-nums ${savings > 0 ? "text-emerald-400" : "text-amber-400"}`}>
                {savings > 0
                  ? `Saving $${savings.toFixed(2)}/mo`
                  : `$${Math.abs(savings).toFixed(2)}/mo over API`}
              </div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {savings > 0
                  ? `${savingsPercent.toFixed(0)}% cheaper than API rates`
                  : "API pricing would be more cost-effective"}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Right: Usage Metrics */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Usage Metrics</CardTitle>
            <CardDescription className="text-xs">
              Token consumption and efficiency
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {/* Tokens used */}
              <div className="flex items-center gap-3 rounded-lg bg-blue-500/5 border border-blue-500/10 p-3">
                <div className="rounded-full bg-blue-500/10 p-1.5">
                  <Zap className="h-3.5 w-3.5 text-blue-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-blue-400/80 font-medium">Tokens this week</div>
                  <div className="text-lg font-bold tabular-nums text-blue-400">{formatNumber(totalTokensEstimate)}</div>
                </div>
              </div>

              {/* Daily average */}
              <div className="flex items-center gap-3 rounded-lg bg-violet-500/5 border border-violet-500/10 p-3">
                <div className="rounded-full bg-violet-500/10 p-1.5">
                  <Calendar className="h-3.5 w-3.5 text-violet-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-violet-400/80 font-medium">Daily average</div>
                  <div className="text-lg font-bold tabular-nums text-violet-400">{formatNumber(dailyTokens)} tokens</div>
                </div>
              </div>

              {/* Cost per commit */}
              <div className="flex items-center gap-3 rounded-lg bg-amber-500/5 border border-amber-500/10 p-3">
                <div className="rounded-full bg-amber-500/10 p-1.5">
                  <GitCommit className="h-3.5 w-3.5 text-amber-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] uppercase tracking-wider text-amber-400/80 font-medium">Cost per commit</div>
                  <div className="text-lg font-bold tabular-nums text-amber-400">${costPerCommit.toFixed(2)}</div>
                  <div className="text-[10px] text-muted-foreground">~14 commits/day avg</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Model Pricing Reference */}
      <Card className="border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Model Pricing Reference</CardTitle>
          <CardDescription className="text-[10px]">
            Per million tokens &mdash; for equivalent API cost calculations
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/30 text-muted-foreground">
                  <th className="text-left py-1.5 font-medium">Model</th>
                  <th className="text-right py-1.5 font-medium">Input</th>
                  <th className="text-right py-1.5 font-medium">Output</th>
                  <th className="text-right py-1.5 font-medium">Cache Read</th>
                  <th className="text-right py-1.5 font-medium">Cache Create</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(MODEL_PRICING).map(([model, pricing]) => {
                  const shortName = model.replace("claude-", "");
                  const color =
                    MODEL_COLORS[shortName as keyof typeof MODEL_COLORS] ||
                    "#6B7280";
                  return (
                    <tr
                      key={model}
                      className="border-b border-border/20 hover:bg-muted/30 transition-colors"
                    >
                      <td className="py-1.5 font-medium">
                        <div className="flex items-center gap-1.5">
                          <div
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: color }}
                          />
                          <span className="text-xs">
                            {shortName.charAt(0).toUpperCase() +
                              shortName.slice(1)}
                          </span>
                        </div>
                      </td>
                      <td className="text-right py-1.5 font-mono text-muted-foreground">
                        ${pricing.input}
                      </td>
                      <td className="text-right py-1.5 font-mono text-muted-foreground">
                        ${pricing.output}
                      </td>
                      <td className="text-right py-1.5 font-mono text-muted-foreground">
                        ${pricing.cacheRead}
                      </td>
                      <td className="text-right py-1.5 font-mono text-muted-foreground">
                        ${pricing.cacheCreation}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
