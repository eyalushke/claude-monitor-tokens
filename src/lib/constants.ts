export const PLAN_LIMITS = {
  pro: { label: "Pro", tokens: 44_000, windowHours: 5, monthlyPrice: 20 },
  max5: { label: "Max5", tokens: 88_000, windowHours: 5, monthlyPrice: 100 },
  max20: { label: "Max20", tokens: 220_000, windowHours: 5, monthlyPrice: 200 },
  team_standard: { label: "Team Standard", tokens: 55_000, windowHours: 5, monthlyPrice: 125 },
  team_premium: { label: "Team Premium", tokens: 88_000, windowHours: 5, monthlyPrice: 150 },
} as const;

export type PlanType = keyof typeof PLAN_LIMITS;

export interface ResolvedPlan {
  type: PlanType;
  label: string;
  tokens: number;
  windowHours: number;
  monthlyPrice: number;
}

function isPlanType(value: string | null | undefined): value is PlanType {
  return !!value && value in PLAN_LIMITS;
}

// Resolve the active plan. Precedence: plan detected by ingest.py (sync_state.plan_type)
// -> NEXT_PUBLIC_PLAN_TYPE -> max5. The numeric env vars override the plan's defaults.
// NEXT_PUBLIC_* must be referenced literally so Next.js inlines them.
export function resolvePlan(detectedPlanType?: string | null): ResolvedPlan {
  const envPlanType = process.env.NEXT_PUBLIC_PLAN_TYPE;
  const type: PlanType = isPlanType(detectedPlanType) ? detectedPlanType : isPlanType(envPlanType) ? envPlanType : "max5";
  const base = PLAN_LIMITS[type];
  return {
    type,
    label: base.label,
    tokens: Number(process.env.NEXT_PUBLIC_PLAN_TOKEN_LIMIT) || base.tokens,
    windowHours: Number(process.env.NEXT_PUBLIC_PLAN_WINDOW_HOURS) || base.windowHours,
    monthlyPrice: Number(process.env.NEXT_PUBLIC_PLAN_MONTHLY_PRICE) || base.monthlyPrice,
  };
}

export const MODEL_COLORS: Record<string, string> = {
  "claude-opus": "#8B5CF6",
  "claude-sonnet": "#3B82F6",
  "claude-haiku": "#10B981",
};

export const MODEL_PRICING = {
  "claude-opus": { input: 15, output: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  "claude-sonnet": { input: 3, output: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  "claude-haiku": { input: 0.25, output: 1.25, cacheRead: 0.025, cacheCreation: 0.3 },
};

// per million tokens

export const TOKEN_COLORS = {
  input: "#3B82F6",
  output: "#10B981",
  cacheRead: "#94A3B8",
  cacheCreation: "#F59E0B",
};

export function getModelColor(modelName: string): string {
  if (modelName.includes("opus")) return MODEL_COLORS["claude-opus"];
  if (modelName.includes("sonnet")) return MODEL_COLORS["claude-sonnet"];
  if (modelName.includes("haiku")) return MODEL_COLORS["claude-haiku"];
  return "#6B7280";
}

export function getModelShortName(modelName: string): string {
  if (modelName.includes("opus")) return "Opus";
  if (modelName.includes("sonnet")) return "Sonnet";
  if (modelName.includes("haiku")) return "Haiku";
  return modelName;
}

export function getModelPricingKey(model: string): keyof typeof MODEL_PRICING {
  if (model.includes("opus")) return "claude-opus";
  if (model.includes("haiku")) return "claude-haiku";
  return "claude-sonnet";
}

export function estimateCost(input: number, output: number, cacheRead: number, cacheCreate: number, model: string = "claude-opus"): number {
  const pricing = MODEL_PRICING[getModelPricingKey(model)];
  return (input * pricing.input + output * pricing.output + cacheRead * pricing.cacheRead + cacheCreate * pricing.cacheCreation) / 1_000_000;
}
