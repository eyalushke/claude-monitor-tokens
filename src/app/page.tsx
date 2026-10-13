"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell,
} from "recharts";
import {
  Zap, DollarSign, Monitor, Clock, AlertTriangle, Timer,
  TrendingUp, Activity, Shield, ShieldAlert, ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useDateRange } from "@/hooks/use-date-range";
import { TOKEN_COLORS, getModelColor, getModelShortName, estimateCost as estimateCostRaw } from "@/lib/constants";
import { formatNumber, supabaseAvailable } from "@/lib/utils";
import { usePlan } from "@/hooks/use-plan";
import type { DailyAggregate } from "@/lib/supabase/types";

const PROJECT_COLORS = ["#8B5CF6", "#3B82F6", "#10B981", "#F59E0B", "#EF4444", "#EC4899", "#06B6D4", "#84CC16"];

interface AnthropicStatus {
  indicator: "none" | "minor" | "major" | "critical";
  description: string;
}

export default function OverviewV2Page() {
  const { dateStr } = useDateRange();
  const plan = usePlan();
  const [loading, setLoading] = useState(true);
  const [usingSample, setUsingSample] = useState(false);

  const [gaugeUsed, setGaugeUsed] = useState(0);
  const [burnRate, setBurnRate] = useState(0);
  const [resetMinutes, setResetMinutes] = useState<number | null>(null);
  const [costToday, setCostToday] = useState(0);
  const [costPeriod, setCostPeriod] = useState(0);
  const [sessionsToday, setSessionsToday] = useState(0);
  const [messagesToday, setMessagesToday] = useState(0);
  const [toolsToday, setToolsToday] = useState(0);
  const [throttleCount, setThrottleCount] = useState(0);

  const [timelineData, setTimelineData] = useState<any[]>([]);
  const [projectTimelineData, setProjectTimelineData] = useState<any[]>([]);
  const [projectNames, setProjectNames] = useState<string[]>([]);
  const [modelPieData, setModelPieData] = useState<any[]>([]);
  const [recentActivity, setRecentActivity] = useState<any[]>([]);
  const [throttleDates, setThrottleDates] = useState<Set<string>>(new Set());
  const [throttleCountByDate, setThrottleCountByDate] = useState<Record<string, number>>({});

  const [anthropicStatus, setAnthropicStatus] = useState<AnthropicStatus>({ indicator: "none", description: "All Systems Operational" });

  // Fetch Anthropic status
  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await fetch("https://status.anthropic.com/api/v2/status.json");
        if (res.ok) {
          const data = await res.json();
          setAnthropicStatus({
            indicator: data.status?.indicator || "none",
            description: data.status?.description || "Unknown",
          });
        }
      } catch { /* ignore */ }
    }
    fetchStatus();
  }, []);

  useEffect(() => {
    async function fetchData() {
      if (!supabaseAvailable()) { applySampleData(); return; }
      try {
        const { createBrowserClient } = await import("@/lib/supabase/client");
        const supabase = createBrowserClient();

        const [{ data: dailyAggs, error: aggError }, { data: rateLimits }, { data: recentMessages }] = await Promise.all([
          supabase.from("daily_aggregates").select("*").gte("date", dateStr).order("date", { ascending: true }),
          supabase.from("rate_limit_events").select("timestamp, reset_message").order("timestamp", { ascending: false }),
          supabase.from("messages").select("input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, model, timestamp").gte("timestamp", new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString()),
        ]);

        if (aggError || !dailyAggs || dailyAggs.length === 0) { applySampleData(); return; }

        // Throttle dates
        const tDates = new Set<string>();
        const tCounts: Record<string, number> = {};
        let totalThrottles = 0;
        for (const rl of (rateLimits || [])) {
          if (rl.reset_message) {
            const d = rl.timestamp.slice(0, 10);
            tDates.add(d);
            tCounts[d] = (tCounts[d] || 0) + 1;
            totalThrottles++;
          }
        }
        setThrottleDates(tDates);
        setThrottleCountByDate(tCounts);
        setThrottleCount(totalThrottles);

        // Gauge + reset countdown
        const msgs = recentMessages ?? [];
        const recentTokens = msgs.reduce((sum: number, m: any) => sum + m.input_tokens + m.output_tokens + m.cache_read_tokens + m.cache_creation_tokens, 0);
        setGaugeUsed(recentTokens);

        if (msgs.length > 0) {
          const oldest = new Date(msgs[0].timestamp).getTime();
          const windowEnd = oldest + 5 * 60 * 60 * 1000;
          const minsLeft = Math.max(0, Math.round((windowEnd - Date.now()) / 60000));
          setResetMinutes(minsLeft);
          const hoursSinceOldest = Math.max(1, (Date.now() - oldest) / 3_600_000);
          setBurnRate(Math.round(recentTokens / hoursSinceOldest));
        } else {
          setResetMinutes(null);
          setBurnRate(0);
        }

        // Today + period cost
        const today = new Date().toISOString().split("T")[0];
        const todayAggs = (dailyAggs as DailyAggregate[]).filter((r) => r.date === today);
        const todayCostVal = todayAggs.reduce((s, r) => s + estimateCostRaw(r.total_input_tokens, r.total_output_tokens, r.total_cache_read_tokens, r.total_cache_creation_tokens, r.model ?? "claude-opus"), 0);
        setCostToday(todayCostVal);
        setCostPeriod((dailyAggs as DailyAggregate[]).reduce((s, r) => s + estimateCostRaw(r.total_input_tokens, r.total_output_tokens, r.total_cache_read_tokens, r.total_cache_creation_tokens, r.model ?? "claude-opus"), 0));
        setSessionsToday(todayAggs.reduce((s, r) => s + r.session_count, 0));
        setMessagesToday(todayAggs.reduce((s, r) => s + r.message_count, 0));
        setToolsToday(todayAggs.reduce((s, r) => s + r.total_tool_calls, 0));

        // Token timeline
        const dateMap = new Map<string, any>();
        for (const row of dailyAggs as DailyAggregate[]) {
          const d = new Date(row.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          const existing = dateMap.get(d) ?? { date: d, rawDate: row.date, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
          existing.input += row.total_input_tokens;
          existing.output += row.total_output_tokens;
          existing.cacheRead += row.total_cache_read_tokens;
          existing.cacheCreation += row.total_cache_creation_tokens;
          dateMap.set(d, existing);
        }
        setTimelineData(Array.from(dateMap.values()));

        // Project timeline
        const projectDateTotals: Record<string, Record<string, number>> = {};
        const projectTotals: Record<string, number> = {};
        for (const row of dailyAggs as DailyAggregate[]) {
          const d = new Date(row.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          const proj = row.project_name || "unknown";
          const tokens = row.total_input_tokens + row.total_output_tokens;
          if (!projectDateTotals[d]) projectDateTotals[d] = {};
          projectDateTotals[d][proj] = (projectDateTotals[d][proj] || 0) + tokens;
          projectTotals[proj] = (projectTotals[proj] || 0) + tokens;
        }
        const topProjects = Object.entries(projectTotals).sort(([, a], [, b]) => b - a).slice(0, 6).map(([name]) => name);
        setProjectNames(topProjects);

        const projTimeline: any[] = [];
        for (const d of dateMap.keys()) {
          const entry: any = { date: d };
          const dayProjects = projectDateTotals[d] || {};
          let otherTotal = 0;
          for (const [proj, tokens] of Object.entries(dayProjects)) {
            if (topProjects.includes(proj)) entry[proj] = tokens;
            else otherTotal += tokens;
          }
          for (const proj of topProjects) { if (!entry[proj]) entry[proj] = 0; }
          entry["Other"] = otherTotal;
          projTimeline.push(entry);
        }
        setProjectTimelineData(projTimeline);

        // Model pie chart
        const modelTotals: Record<string, number> = {};
        for (const row of dailyAggs as DailyAggregate[]) {
          const shortName = getModelShortName(row.model ?? "unknown");
          const total = row.total_input_tokens + row.total_output_tokens;
          modelTotals[shortName] = (modelTotals[shortName] || 0) + total;
        }
        setModelPieData(Object.entries(modelTotals).map(([name, value]) => ({
          name, value, color: getModelColor(name.toLowerCase()),
        })).sort((a, b) => b.value - a.value));

        // Recent activity
        const activityMap = new Map<string, any>();
        for (const row of dailyAggs as DailyAggregate[]) {
          const d = new Date(row.date).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          const existing = activityMap.get(d) ?? { rawDate: row.date, sessions: 0, messages: 0, tools: 0, tokens: 0, cost: 0 };
          existing.sessions += row.session_count;
          existing.messages += row.message_count;
          existing.tools += row.total_tool_calls;
          existing.tokens += row.total_input_tokens + row.total_output_tokens;
          existing.cost += estimateCostRaw(row.total_input_tokens, row.total_output_tokens, row.total_cache_read_tokens, row.total_cache_creation_tokens, row.model ?? "claude-opus");
          activityMap.set(d, existing);
        }
        setRecentActivity(Array.from(activityMap.entries()).reverse().map(([date, v]) => ({
          date, rawDate: v.rawDate, sessions: v.sessions, messages: v.messages, tools: v.tools,
          tokens: formatNumber(v.tokens), cost: `$${v.cost.toFixed(2)}`,
        })));

        setUsingSample(false);
      } catch { applySampleData(); }
      finally { setLoading(false); }
    }

    function applySampleData() {
      setUsingSample(true);
      setGaugeUsed(54500); setBurnRate(18000); setCostToday(3.07); setCostPeriod(21.40);
      setSessionsToday(7); setMessagesToday(342); setToolsToday(189); setThrottleCount(24); setResetMinutes(127);
      setTimelineData([
        { date: "May 19", input: 4200, output: 18500, cacheRead: 82000, cacheCreation: 12000 },
        { date: "May 20", input: 5800, output: 31200, cacheRead: 145000, cacheCreation: 28000 },
        { date: "May 21", input: 3100, output: 12800, cacheRead: 61000, cacheCreation: 8500 },
        { date: "May 22", input: 8900, output: 45600, cacheRead: 210000, cacheCreation: 35000 },
        { date: "May 23", input: 6400, output: 28300, cacheRead: 168000, cacheCreation: 22000 },
        { date: "May 24", input: 7200, output: 38900, cacheRead: 195000, cacheCreation: 31000 },
        { date: "May 25", input: 3800, output: 21400, cacheRead: 112000, cacheCreation: 16500 },
      ]);
      setProjectTimelineData([
        { date: "May 19", "project-alpha": 15000, "project-beta": 3000, Other: 500 },
        { date: "May 20", "project-alpha": 28000, "project-gamma": 5000, Other: 1200 },
      ]);
      setProjectNames(["project-alpha", "project-beta"]);
      setModelPieData([
        { name: "Opus", value: 91, color: getModelColor("opus") },
        { name: "Sonnet", value: 6, color: getModelColor("sonnet") },
        { name: "Haiku", value: 3, color: getModelColor("haiku") },
      ]);
      setRecentActivity([
        { date: "May 25", rawDate: "2026-05-25", sessions: 7, messages: 342, tools: 189, tokens: "153K", cost: "$3.07" },
        { date: "May 24", rawDate: "2026-05-24", sessions: 11, messages: 567, tools: 312, tokens: "272K", cost: "$5.17" },
      ]);
      setThrottleDates(new Set(["2026-05-24", "2026-05-21"]));
      setThrottleCountByDate({ "2026-05-24": 1, "2026-05-21": 2 });
      setAnthropicStatus({ indicator: "none", description: "All Systems Operational" });
      setLoading(false);
    }

    fetchData();
  }, [dateStr]);

  const windowLimit = plan.tokens;
  const gaugePct = Math.min(100, Math.round((gaugeUsed / windowLimit) * 100));
  const remaining = Math.max(0, windowLimit - gaugeUsed);

  const statusIcon = anthropicStatus.indicator === "none"
    ? <ShieldCheck className="h-3.5 w-3.5 text-green-500" />
    : anthropicStatus.indicator === "minor"
    ? <Shield className="h-3.5 w-3.5 text-yellow-500" />
    : <ShieldAlert className="h-3.5 w-3.5 text-red-500" />;

  const statusColor = anthropicStatus.indicator === "none"
    ? "border-green-500/30 text-green-500"
    : anthropicStatus.indicator === "minor"
    ? "border-yellow-500/30 text-yellow-500"
    : "border-red-500/30 text-red-500";

  if (loading) return <LoadingSkeleton />;

  return (
    <div className="space-y-5">
      {/* Status bar */}
      <div className="flex items-center justify-between">
        {usingSample && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            Showing sample data. Connect Supabase to see live metrics.
          </div>
        )}
        {!usingSample && <div />}
        <Badge variant="outline" className={`gap-1.5 text-[10px] ${statusColor}`}>
          {statusIcon}
          {anthropicStatus.description}
        </Badge>
      </div>

      {/* KPI Row — 5 cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {/* 5hr Window Gauge */}
        <Card className="col-span-2 sm:col-span-1 bg-gradient-to-br from-violet-500/10 to-violet-600/5 border-violet-500/20">
          <CardContent className="pt-4 pb-3">
            <div className="text-[10px] uppercase tracking-wider text-violet-400 font-medium mb-2">5hr Window</div>
            <div className="flex items-end gap-3">
              <span className={`text-3xl font-bold tabular-nums ${gaugePct > 80 ? "text-red-400" : gaugePct > 50 ? "text-yellow-400" : "text-violet-400"}`}>
                {gaugePct}%
              </span>
              <div className="text-[10px] text-muted-foreground pb-1">
                {formatNumber(gaugeUsed)} / {formatNumber(windowLimit)}
              </div>
            </div>
            <Progress value={gaugePct} className="h-1.5 mt-2" />
            <div className="flex items-center gap-1 mt-2 text-[10px] text-muted-foreground">
              <Timer className="h-3 w-3" />
              {resetMinutes !== null
                ? resetMinutes > 0
                  ? `Resets in ${Math.floor(resetMinutes / 60)}h ${resetMinutes % 60}m`
                  : "Window is clear"
                : "No active window"}
            </div>
          </CardContent>
        </Card>

        {/* Burn Rate */}
        <Card className="bg-gradient-to-br from-amber-500/10 to-amber-600/5 border-amber-500/20">
          <CardContent className="pt-4 pb-3">
            <div className="text-[10px] uppercase tracking-wider text-amber-400 font-medium mb-2">Burn Rate</div>
            <div className="text-2xl font-bold tabular-nums text-amber-400">~{formatNumber(burnRate)}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">tokens/hr</div>
            <div className="flex items-center gap-1 mt-2 text-[10px]">
              <TrendingUp className="h-3 w-3" />
              <span className={burnRate > 15000 ? "text-red-400" : "text-green-400"}>
                {burnRate > 15000 ? "High" : "Normal"}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Today's Cost */}
        <Card className="bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border-emerald-500/20">
          <CardContent className="pt-4 pb-3">
            <div className="text-[10px] uppercase tracking-wider text-emerald-400 font-medium mb-2">Today</div>
            <div className="text-2xl font-bold tabular-nums text-emerald-400">${costToday.toFixed(2)}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">equiv. API cost</div>
            <div className="text-[10px] text-muted-foreground mt-2">
              Period: ${costPeriod.toFixed(2)}
            </div>
          </CardContent>
        </Card>

        {/* Sessions */}
        <Card className="bg-gradient-to-br from-blue-500/10 to-blue-600/5 border-blue-500/20">
          <CardContent className="pt-4 pb-3">
            <div className="text-[10px] uppercase tracking-wider text-blue-400 font-medium mb-2">Today</div>
            <div className="text-2xl font-bold tabular-nums text-blue-400">{sessionsToday}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">sessions</div>
            <div className="text-[10px] text-muted-foreground mt-2">
              {messagesToday} msgs &middot; {toolsToday} tools
            </div>
          </CardContent>
        </Card>

        {/* Throttle Events */}
        <Card className={`bg-gradient-to-br ${throttleCount > 0 ? "from-red-500/10 to-red-600/5 border-red-500/20" : "from-green-500/10 to-green-600/5 border-green-500/20"}`}>
          <CardContent className="pt-4 pb-3">
            <div className={`text-[10px] uppercase tracking-wider font-medium mb-2 ${throttleCount > 0 ? "text-red-400" : "text-green-400"}`}>Throttled</div>
            <div className={`text-2xl font-bold tabular-nums ${throttleCount > 0 ? "text-red-400" : "text-green-400"}`}>{throttleCount}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">total events</div>
            <div className="text-[10px] text-muted-foreground mt-2">
              {throttleDates.size} days affected
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Token Timeline — spans 2 cols */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Token Usage Timeline</CardTitle>
            <CardDescription className="text-xs">Stacked by type</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={timelineData}>
                <defs>
                  <linearGradient id="gradCacheRead" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={TOKEN_COLORS.cacheRead} stopOpacity={0.6} />
                    <stop offset="100%" stopColor={TOKEN_COLORS.cacheRead} stopOpacity={0.1} />
                  </linearGradient>
                  <linearGradient id="gradOutput" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={TOKEN_COLORS.output} stopOpacity={0.6} />
                    <stop offset="100%" stopColor={TOKEN_COLORS.output} stopOpacity={0.1} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="date" fontSize={10} tick={{ fill: "#888" }} />
                <YAxis fontSize={10} tick={{ fill: "#888" }} tickFormatter={(v: any) => formatNumber(Number(v))} />
                <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid #333", borderRadius: 8 }} formatter={(value: any) => formatNumber(Number(value))} />
                <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 10 }} />
                <Area type="monotone" dataKey="cacheRead" name="Cache Read" stackId="1" stroke={TOKEN_COLORS.cacheRead} fill="url(#gradCacheRead)" />
                <Area type="monotone" dataKey="cacheCreation" name="Cache Create" stackId="1" stroke={TOKEN_COLORS.cacheCreation} fill={TOKEN_COLORS.cacheCreation} fillOpacity={0.4} />
                <Area type="monotone" dataKey="output" name="Output" stackId="1" stroke={TOKEN_COLORS.output} fill="url(#gradOutput)" />
                <Area type="monotone" dataKey="input" name="Input" stackId="1" stroke={TOKEN_COLORS.input} fill={TOKEN_COLORS.input} fillOpacity={0.4} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Model Distribution — pie chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Model Split</CardTitle>
            <CardDescription className="text-xs">Token allocation</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={160}>
              <PieChart>
                <Pie data={modelPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={40} outerRadius={65} strokeWidth={2} stroke="#1a1a2e">
                  {modelPieData.map((entry: any, i: number) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid #333", borderRadius: 8, fontSize: 11 }} formatter={(v: any) => formatNumber(Number(v))} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex justify-center gap-4 text-[10px]">
              {modelPieData.map((entry: any) => (
                <div key={entry.name} className="flex items-center gap-1.5">
                  <div className="h-2 w-2 rounded-full" style={{ background: entry.color }} />
                  <span className="text-muted-foreground">{entry.name}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Project Timeline */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Token Usage by Project</CardTitle>
          <CardDescription className="text-xs">Top 6 projects + other</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={projectTimelineData}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
              <XAxis dataKey="date" fontSize={10} tick={{ fill: "#888" }} />
              <YAxis fontSize={10} tick={{ fill: "#888" }} tickFormatter={(v: any) => formatNumber(Number(v))} />
              <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid #333", borderRadius: 8 }} formatter={(value: any) => formatNumber(Number(value))} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 10 }} />
              {projectNames.map((name, i) => (
                <Area key={name} type="monotone" dataKey={name} stackId="p" stroke={PROJECT_COLORS[i % PROJECT_COLORS.length]} fill={PROJECT_COLORS[i % PROJECT_COLORS.length]} fillOpacity={0.45} />
              ))}
              <Area type="monotone" dataKey="Other" stackId="p" stroke="#6B7280" fill="#6B7280" fillOpacity={0.2} />
            </AreaChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Recent Activity Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent Activity</CardTitle>
          <CardDescription className="text-xs">Daily summary with throttle events</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-left py-2 font-medium">Date</th>
                  <th className="text-center py-2 font-medium">Status</th>
                  <th className="text-right py-2 font-medium">Sessions</th>
                  <th className="text-right py-2 font-medium">Msgs</th>
                  <th className="text-right py-2 font-medium">Tokens</th>
                  <th className="text-right py-2 font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {recentActivity.map((row: any) => {
                  const wasThrottled = throttleDates.has(row.rawDate);
                  const count = throttleCountByDate[row.rawDate] || 0;
                  return (
                    <tr key={row.date} className={`border-b border-border/30 hover:bg-muted/30 transition-colors ${wasThrottled ? "bg-red-500/5" : ""}`}>
                      <td className="py-2 font-medium">{row.date}</td>
                      <td className="text-center py-2">
                        {wasThrottled ? (
                          <Badge variant="destructive" className="text-[9px] gap-0.5 px-1.5 py-0">
                            <AlertTriangle className="h-2.5 w-2.5" /> {count}x
                          </Badge>
                        ) : (
                          <span className="text-green-500 text-[10px]">OK</span>
                        )}
                      </td>
                      <td className="text-right py-2 tabular-nums">{row.sessions}</td>
                      <td className="text-right py-2 tabular-nums">{row.messages}</td>
                      <td className="text-right py-2 font-mono tabular-nums">{row.tokens}</td>
                      <td className="text-right py-2 font-mono tabular-nums">{row.cost}</td>
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

function LoadingSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}><CardContent className="pt-4 space-y-3"><Skeleton className="h-3 w-16" /><Skeleton className="h-7 w-20" /><Skeleton className="h-2 w-full" /></CardContent></Card>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2"><CardContent className="pt-6"><Skeleton className="h-[240px] w-full" /></CardContent></Card>
        <Card><CardContent className="pt-6"><Skeleton className="h-[240px] w-full" /></CardContent></Card>
      </div>
      <Card><CardContent className="pt-6"><Skeleton className="h-[240px] w-full" /></CardContent></Card>
    </div>
  );
}
