/**
 * ═══════════ 官方计费取数 —— 唯一权威数据源 ═══════════
 *
 * 设计原则：**不在本地重复记账**。用量与费用一律取服务商官方接口，
 * 本地只保留「流量」这一笔账（自有网关产生的出口流量，官方账单里没有这一项）。
 *
 * 数据源（都是 Cloudflare 官方，无本地估算）：
 *
 *   ① Billable Usage API（主源，费用 + 用量）
 *      GET https://api.cloudflare.com/client/v4/accounts/{account_id}/billable-usage
 *      ?from=YYYY-MM-DD&to=YYYY-MM-DD
 *      Token 需 Account → Billing: Read
 *      FOCUS 风格字段：ServiceName / PricingQuantity / PricingUnit /
 *                      ContractedCost / CumulatedContractedCost / BillingCurrency /
 *                      BillingPeriodStart / ChargePeriodStart / ChargePeriodEnd
 *      口径：账单周期，数据每日更新。
 *
 *   ② GraphQL Analytics（补充源，仅用量）
 *      见 ./cfusage.ts，Token 需 Account → Account Analytics: Read
 *      口径：与 R2 面板 "A 类操作 / B 类操作 / 总存储" 完全一致，延迟 15-30 分钟。
 *
 * 逐项降级：① 命中 → 用①；① 缺失/失败 → 用②；都拿不到 → available=false，
 * 前端显示"—"并提示去配置，**绝不退化成本地估算值**。
 */
import type { Env } from "./types";
import { decryptSecret } from "./crypto";
import type { Settings } from "./settings";
import { billingCycleRange, fetchOfficialUsage, type OfficialUsage } from "./cfusage";

/* ═══════════ R2 计费规则（Cloudflare 官方 Standard storage 定价） ═══════════
 * 这些是服务商公开的计费参数，用于计算"离免费额度还有多远"，
 * 不是本地记账数据；金额本身仍取自官方接口。
 */
export const R2_LIMIT_CLASS_A = 1_000_000;      // Class A（写 / 列表）
export const R2_LIMIT_CLASS_B = 10_000_000;     // Class B（读取）
export const R2_LIMIT_STORAGE_BYTES = 10 * 1024 ** 3; // 10 GB-月

export type Source = "billable-usage" | "analytics";

/* ═══════════ 纯函数层（可被行为测试直接注入 mock 响应） ═══════════ */

export interface BillableRow {
  service: string;
  family: string | null;
  /** 计费量 = PricingQuantity（官方计费口径）；缺失时回退 ConsumedQuantity */
  quantity: number;
  /** 单位 = PricingUnit，从不为空；缺失时回退 ConsumedUnit */
  unit: string;
  /** 该计费周期内的消耗量原始数据 */
  consumedQuantity: number;
  consumedUnit: string;
  /** 本行（本期）费用 */
  cost: number;
  /** 账单周期累计量 / 累计费用（跨-row 汇总，最贴近"本月用了多少、花了多少"） */
  cumulatedQuantity: number;
  cumulatedCost: number;
  currency: string | null;
  chargeStart: string | null;
  chargeEnd: string | null;
  billingPeriodStart: string | null;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/**
 * 解析 Billable Usage API 响应。
 * 兼容两种形态：标准 v4 envelope（{result: [...]}）与裸数组（官方 curl 示例）。
 */
export function parseBillableUsage(json: unknown): BillableRow[] {
  const rawRows = Array.isArray(json)
    ? json
    : (json as { result?: unknown[] } | null)?.result;
  if (!Array.isArray(rawRows)) return [];

  return rawRows.map((raw) => {
    const r = raw as Record<string, unknown>;
    const consumedUnit = str(r.ConsumedUnit) ?? str(r.consumedUnit);
    return {
      service: str(r.ServiceName) ?? str(r.serviceName) ?? "",
      family: str(r.ServiceFamilyName) ?? str(r.x_ProductFamilyName),
      quantity: num(r.PricingQuantity, num(r.ConsumedQuantity, 0)),
      unit: str(r.PricingUnit) ?? consumedUnit ?? "Count",
      consumedQuantity: num(r.ConsumedQuantity, 0),
      consumedUnit: consumedUnit ?? "",
      cost: num(r.ContractedCost, num(r.BilledCost, 0)),
      cumulatedQuantity: num(r.CumulatedPricingQuantity, 0),
      cumulatedCost: num(r.CumulatedContractedCost, 0),
      currency: str(r.BillingCurrency),
      chargeStart: str(r.ChargePeriodStart),
      chargeEnd: str(r.ChargePeriodEnd),
      billingPeriodStart: str(r.BillingPeriodStart),
    };
  });
}

/** 同名 Service 可能有多行（每个 charge period 一行）→ 取 chargeEnd 最新的一行 */
export function latestPerService(rows: BillableRow[]): BillableRow[] {
  const map = new Map<string, { row: BillableRow; t: number }>();
  for (const row of rows) {
    if (!row.service) continue;
    const key = row.service.toLowerCase();
    const t = Date.parse(row.chargeEnd ?? row.chargeStart ?? "") || 0;
    const prev = map.get(key);
    if (!prev || t >= prev.t) map.set(key, { row, t });
  }
  return [...map.values()].map((v) => v.row);
}

const isR2 = (row: BillableRow) =>
  /\br2\b/i.test(row.family ?? "") || /\br2\b/i.test(row.service);

/**
 * ServiceName → 本项目关心的三个 R2 计费项。
 * 官方 ServiceName 文案会迭代，因此用"关键词匹配 + R2 家族校验"而不是写死等号。
 */
export function mapBillableRows(rows: BillableRow[]) {
  const latest = latestPerService(rows);
  const find = (patterns: RegExp[]): BillableRow | null => {
    for (const p of patterns) {
      const hit = latest.find((r) => p.test(r.service) && isR2(r));
      if (hit) return hit;
    }
    return null;
  };

  const storage = find([/\bstorage\b/i, /capacity/i]);
  const classA = find([/class\s*[-_ ]?\s*a\b/i]);
  const classB = find([/class\s*[-_ ]?\s*b\b/i]);

  const currency =
    latest.find((r) => r.currency)?.currency ?? null;
  // 累计口径：R2 家族单独累计 + 全账户累计（用于说明"整个 Cloudflare 账单"）
  const costR2 = latest.filter(isR2).reduce((s, r) => s + Math.max(0, r.cumulatedCost), 0);
  const costAccount = latest.reduce((s, r) => s + Math.max(0, r.cumulatedCost), 0);
  const periodStart =
    latest.find((r) => r.billingPeriodStart)?.billingPeriodStart ?? null;

  return { storage, classA, classB, currency, costR2, costAccount, periodStart, rowCount: latest.length };
}

/** 单位换算：把官方 quantity 换算成字节。无法可靠换算时返回 null（宁缺勿估） */
export function toBytes(quantity: number, unit: string): number | null {
  const u = (unit || "").toLowerCase().replace(/-?months?$/i, "").trim();
  const base = 1024;
  const mult =
    u === "b" || u === "byte" || u === "bytes" ? 1
    : u === "kb" || u === "kib" ? base
    : u === "mb" || u === "mib" ? base ** 2
    : u === "gb" || u === "gib" ? base ** 3
    : u === "tb" || u === "tib" ? base ** 4
    : null;
  return mult === null ? null : quantity * mult;
}

/** 单位换算：操作次数。单位非计数类（如 GB-month）时返回 null */
export function toCount(quantity: number, unit: string): number | null {
  const u = (unit || "").toLowerCase().trim();
  if (u === "" || /request|count|operation|class|times/i.test(u)) return Math.round(quantity);
  if (/^-?month|gb|byte|second/i.test(u)) return null;
  // 未知单位保守按计数处理（requests 类指标的常见写法）
  return Math.round(quantity);
}

/* ═══════════ 视图构建（后端响应 / 前端渲染的单一形状） ═══════════ */

export interface MetricView {
  available: boolean;
  source: Source | null;
  used: number;
  unit: string;
  limit: number;
  percent: number | null;
  exceeded: boolean;
}

export interface StorageView extends MetricView {
  usedBytes: number | null;
  displayUnit: string;
}

export interface CostView {
  available: boolean;
  currency: string | null;
  /** R2 本账单周期累计费用（官方 ContractedCost / CumulatedContractedCost） */
  r2: number | null;
  /** 全账户本周期累计费用（含 Workers / D1 等其它产品） */
  account: number | null;
  periodStart: string | null;
}

export interface UsageView {
  /** 后端为 S3 兼容存储时无 Cloudflare 账单概念 → false，前端隐藏相关 UI */
  enabled: boolean;
  /** 是否已配置 Account ID + API Token */
  configured: boolean;
  cycleLabel: string;
  cycleStart: string | null;
  cycleEnd: string | null;
  classA: MetricView;
  classB: MetricView;
  storage: StorageView;
  cost: CostView;
}

const unavailableMetric = (limit: number): MetricView => ({
  available: false, source: null, used: 0, unit: "", limit, percent: null, exceeded: false,
});

export function buildUsageView(input: {
  enabled: boolean;
  configured: boolean;
  cycleLabel: string;
  cycleStart: string | null;
  cycleEnd: string | null;
  /** ① billable-usage 解析结果；未配置 / 失败 = null */
  bill: ReturnType<typeof mapBillableRows> | null;
  /** ② GraphQL analytics 官方用量；未配置 / 失败 = null */
  analytics: OfficialUsage | null;
}): UsageView {
  const { bill, analytics } = input;

  const buildMetric = (
    row: BillableRow | null,
    analyticsValue: number | null,
    limit: number,
    fallbackUnit: string
  ): MetricView => {
    const q = row ? toCount(row.cumulatedQuantity || row.quantity, row.unit) : null;
    const used = q !== null ? q : analyticsValue;
    if (used === null || used === undefined) return unavailableMetric(limit);
    const unit = row?.unit || fallbackUnit;
    return {
      available: true,
      source: row ? "billable-usage" : "analytics",
      used,
      unit,
      limit,
      percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null,
      exceeded: used >= limit,
    };
  };

  const classA = buildMetric(bill?.classA ?? null, analytics?.classA ?? null, R2_LIMIT_CLASS_A, "requests");
  const classB = buildMetric(bill?.classB ?? null, analytics?.classB ?? null, R2_LIMIT_CLASS_B, "requests");

  // ── 存储：字节 ──
  let storage: StorageView = {
    ...unavailableMetric(R2_LIMIT_STORAGE_BYTES),
    usedBytes: null,
    displayUnit: "bytes",
  };
  const bRow = bill?.storage ?? null;
  const bBytes = bRow ? toBytes(bRow.cumulatedQuantity || bRow.quantity, bRow.unit) : null;
  if (bBytes !== null && bRow) {
    storage = {
      available: true,
      source: "billable-usage",
      used: bBytes,
      unit: bRow.unit,
      limit: R2_LIMIT_STORAGE_BYTES,
      percent: Math.min(100, Math.round((bBytes / R2_LIMIT_STORAGE_BYTES) * 100)),
      exceeded: bBytes >= R2_LIMIT_STORAGE_BYTES,
      usedBytes: bBytes,
      displayUnit: bRow.unit,
    };
  } else if (analytics) {
    const used = Math.max(0, Math.round(analytics.storageBytes));
    storage = {
      available: true,
      source: "analytics",
      used,
      unit: "bytes",
      limit: R2_LIMIT_STORAGE_BYTES,
      percent: Math.min(100, Math.round((used / R2_LIMIT_STORAGE_BYTES) * 100)),
      exceeded: used >= R2_LIMIT_STORAGE_BYTES,
      usedBytes: used,
      displayUnit: "bytes",
    };
  }

  // ── 费用：只来自官方接口，本地不做单价换算 ──
  const cost: CostView = bill
    ? {
        available: true,
        currency: bill.currency,
        r2: Math.round(bill.costR2 * 1e6) / 1e6,
        account: Math.round(bill.costAccount * 1e6) / 1e6,
        periodStart: bill.periodStart ?? input.cycleStart,
      }
    : { available: false, currency: null, r2: null, account: null, periodStart: null };

  return {
    enabled: input.enabled,
    configured: input.configured,
    cycleLabel: input.cycleLabel,
    cycleStart: input.cycleStart,
    cycleEnd: input.cycleEnd,
    classA,
    classB,
    storage,
    cost,
  };
}

/* ═══════════ 网络层：缓存 + 单次飞行 + 失败降级 ═══════════ */

const BILLABLE_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";
const CACHE_TTL_MS = 30 * 60 * 1000; // 官方账单数据每日更新 → 30 分钟缓存足够
const FAIL_TTL_MS = 60 * 1000;       // 失败结果缓存 60 秒，避免故障时的请求风暴
const TIMEOUT_MS = 8_000;

let _cache: { at: number; key: string; view: UsageView } | null = null;
let _fail: { at: number; key: string } | null = null;
let _inflight: { key: string; p: Promise<UsageView> } | null = null;

export function invalidateUsageCache(): void {
  _cache = null;
  _fail = null;
  _inflight = null;
}

async function fetchBillableRows(env: Env, settings: Settings, from: string, to: string): Promise<BillableRow[] | null> {
  if (!settings.cfApiTokenCipher) return null;
  let token: string | null = null;
  try {
    token = await decryptSecret(settings.cfApiTokenCipher, env.admin);
  } catch {
    return null;
  }
  if (!token) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const url = `${BILLABLE_ENDPOINT}/${encodeURIComponent(settings.cfAccountId.trim())}/billable-usage?from=${from}&to=${to}`;
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null; // 403 = 缺 Billing:Read；404/400 = 账户不支持；均降级
    const rows = parseBillableUsage(await res.json());
    return rows.length > 0 ? rows : [];
  } catch {
    return null; // 超时 / 网络错误 → 降级到 analytics
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取一次完整用量快照（两个官方源都已编排好）。
 * 任何失败都不会抛错：降级路径在 buildUsageView 里用 available=false 表达。
 */
export async function fetchUsageSnapshot(env: Env, settings: Settings): Promise<UsageView> {
  const accountId = (settings.cfAccountId || "").trim();
  const enabled = (settings.storageProvider || "r2") === "r2";
  const cycle = billingCycleRange(settings.billingCycleDay);
  const configured = Boolean(accountId && settings.cfApiTokenCipher);

  const base = {
    enabled,
    configured,
    cycleLabel: cycle.label,
    cycleStart: cycle.start.toISOString(),
    cycleEnd: cycle.end.toISOString(),
  };
  // 未配置 / 后端非 R2：直接返回不可用视图，不发任何外网请求
  if (!enabled || !configured) {
    return buildUsageView({ ...base, bill: null, analytics: null });
  }

  const key = `${accountId}|${cycle.start.toISOString()}`;
  if (_cache && _cache.key === key && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.view;
  if (_fail && _fail.key === key && Date.now() - _fail.at < FAIL_TTL_MS) {
    return buildUsageView({ ...base, bill: null, analytics: null });
  }
  if (_inflight && _inflight.key === key) return _inflight.p; // 单飞：并发请求合并

  const p = (async (): Promise<UsageView> => {
    // 两个官方源并行；任一失败都独立降级
    const [rows, analytics] = await Promise.all([
      fetchBillableRows(env, settings, cycle.start.toISOString().slice(0, 10), cycle.end.toISOString().slice(0, 10)),
      fetchOfficialUsage(env, settings).catch(() => null),
    ]);
    const view = buildUsageView({
      ...base,
      bill: rows && rows.length > 0 ? mapBillableRows(rows) : null,
      analytics,
    });
    if (view.classA.available || view.classB.available || view.storage.available || view.cost.available) {
      _cache = { at: Date.now(), key, view };
    } else {
      _fail = { at: Date.now(), key };
    }
    return view;
  })();

  _inflight = { key, p };
  try {
    return await p;
  } finally {
    if (_inflight?.p === p) _inflight = null;
  }
}
