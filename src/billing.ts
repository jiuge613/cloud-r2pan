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
import { billingCycleRange, buildQuery, fetchOfficialUsage, parseOfficialUsage, classifyAction, GRAPHQL_ENDPOINT, type OfficialUsage } from "./cfusage";

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
 *
 * 真实响应里的行名（Cloudflare 会把免费额度标注进 ServiceName）：
 *   "R2 Storage Class A Operations (First 1M included)"
 *   "R2 Storage Class B Operations (First 10M included)"
 *   "R2 Data Storage (First 10GB-Month included)"
 * 注意：操作类行名里同样含 "Storage"，直接按 /storage/ 匹配会先命中 Class A 行，
 * 使存储取到 Requests 单位的行而换算不出字节 —— 因此存储匹配要排除操作类行。
 */
export function mapBillableRows(rows: BillableRow[]) {
  const latest = latestPerService(rows);
  const find = (patterns: RegExp[], reject?: RegExp[]): BillableRow | null => {
    for (const p of patterns) {
      const hit = latest.find(
        (r) =>
          p.test(r.service) &&
          isR2(r) &&
          !(reject ?? []).some((bad) => bad.test(r.service))
      );
      if (hit) return hit;
    }
    return null;
  };

  // 操作类特征：带 "Class A/B" 或 "Operations"
  const OPS_RE = [/class\s*[-_ ]?\s*[ab]\b/i, /operations?\b/i];
  const storage = find([/data\s*storage/i, /\bstorage\b/i, /capacity/i], OPS_RE);
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

/**
 * 从官方 BillingPeriodStart 校准账单周期起始日。
 * 设置里的"周期起始日"可能填错（如默认 1，而真实周期从 23 号开始），
 * 官方返回的 BillingPeriodStart 才是权威值。无法解析 / 超出 1-28 返回 null。
 */
export function detectCycleDay(periodStart: string | null | undefined): number | null {
  if (!periodStart) return null;
  const d = new Date(periodStart);
  if (Number.isNaN(d.getTime())) return null;
  // 防 JS Date 滚动：如 "2026-09-31" 会被解析成 10/1，各字段必须与原文一致
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(periodStart);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
    if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== mo || d.getUTCDate() !== da) return null;
  }
  const day = d.getUTCDate();
  return day >= 1 && day <= 28 ? day : null;
}

/** 单位换算：操作次数。单位非计数类（如 GB-month）时返回 null */
export function toCount(quantity: number, unit: string): number | null {  const u = (unit || "").toLowerCase().trim();
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
    // 优先取 Analytics（官方面板"X类运营"同源、同一统计窗口，数字与面板一致）；
    // 拿不到时降级用计费接口行。计费行的 PricingQuantity 是"扣免费额度后的计费量"，
    // 额度内恒为 0，真实消耗在 ConsumedQuantity —— 取三个官方数值最大者兜底。
    const qRaw = row
      ? Math.max(row.cumulatedQuantity || 0, row.quantity || 0, row.consumedQuantity || 0)
      : 0;
    const q = row ? toCount(qRaw, row.unit) : null;
    const fromAnalytics = analyticsValue !== null && analyticsValue !== undefined;
    const used = fromAnalytics ? analyticsValue : q;
    if (used === null || used === undefined) return unavailableMetric(limit);
    const unit = fromAnalytics ? fallbackUnit : (row?.unit || fallbackUnit);
    return {
      available: true,
      source: fromAnalytics ? "analytics" : "billable-usage",
      used,
      unit,
      limit,
      percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : null,
      exceeded: used >= limit,
    };
  };

  const classA = buildMetric(bill?.classA ?? null, analytics?.classA ?? null, R2_LIMIT_CLASS_A, "requests");
  const classB = buildMetric(bill?.classB ?? null, analytics?.classB ?? null, R2_LIMIT_CLASS_B, "requests");

  // ── 存储：字节（同样 Analytics 面板同源优先，计费接口的 GB-Month 行兜底）──
  let storage: StorageView = {
    ...unavailableMetric(R2_LIMIT_STORAGE_BYTES),
    usedBytes: null,
    displayUnit: "bytes",
  };
  const bRow = bill?.storage ?? null;
  // 同 buildMetric：计费量在免费额度内可能为 0，真实存储量在 ConsumedQuantity 里，取最大者
  const bQty = bRow
    ? Math.max(bRow.cumulatedQuantity || 0, bRow.quantity || 0, bRow.consumedQuantity || 0)
    : 0;
  const bBytes = bRow ? toBytes(bQty, bRow.unit) : null;
  if (analytics) {
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
  } else if (bBytes !== null && bRow) {
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
    // ① 先取计费接口：提供费用，并用官方 BillingPeriodStart 校准真实账单周期
    //    （设置里的"周期起始日"可能填错，官方 BillingPeriodStart 才是权威值）
    const rows = await fetchBillableRows(
      env, settings,
      cycle.start.toISOString().slice(0, 10),
      cycle.end.toISOString().slice(0, 10)
    );
    const bill = rows && rows.length > 0 ? mapBillableRows(rows) : null;

    let effCycle = cycle;
    const detectedDay = detectCycleDay(bill?.periodStart ?? null);
    if (detectedDay !== null && detectedDay !== Math.round(settings.billingCycleDay)) {
      effCycle = billingCycleRange(detectedDay);
    }

    // ② 用量取 Analytics（官方面板"X类运营/总存储空间"同源、同窗口，数字与面板一致），
    //    按校准后的周期查询；计费接口行仅在 Analytics 不可用时兜底。费用只来自计费接口。
    const analytics = await fetchOfficialUsage(env, settings, effCycle).catch(() => null);

    const view = buildUsageView({
      enabled,
      configured,
      cycleLabel: effCycle.label,
      cycleStart: effCycle.start.toISOString(),
      cycleEnd: effCycle.end.toISOString(),
      bill,
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

/* ═══════════ 连接诊断（设置页「运行诊断」按钮的后端） ═══════════
 * 正常取数路径把所有失败都折叠成 available=false（用户只见「—」），
 * 排障时需要把每一步的真实结果暴露出来：
 *   ① Token 本身是否有效（/user/tokens/verify，仅用户令牌支持）
 *   ② Billable Usage API：HTTP 状态 + 官方 errors + 返回了哪些 ServiceName
 *   ③ GraphQL Analytics：HTTP 状态 + errors + 三个指标原始值
 * 诊断接口绕过缓存，每次点按钮都是真实探测（不给结果写缓存）。
 */

/** 诊断用：从 GraphQL 原始响应提取 actionType → 请求数明细（含归类结果，按请求数降序） */
export function extractOpsBreakdown(json: unknown): { actionType: string; requests: number; klass: "a" | "b" | null }[] {
  type OpGroup = { dimensions: { actionType?: string }; sum?: { requests?: number } };
  const root = json as { data?: { viewer?: { accounts?: { r2OperationsAdaptiveGroups?: OpGroup[] }[] } } };
  const groups: OpGroup[] = root?.data?.viewer?.accounts?.[0]?.r2OperationsAdaptiveGroups ?? [];
  return groups
    .map((g: OpGroup) => ({
      actionType: g.dimensions?.actionType ?? "",
      requests: Math.max(0, Math.round(Number(g.sum?.requests) || 0)),
      klass: classifyAction(g.dimensions?.actionType ?? ""),
    }))
    .sort((x: { requests: number }, y: { requests: number }) => y.requests - x.requests);
}

export interface DiagCheck {
  ok: boolean;
  status: number | null;
  message: string;
}

export interface DiagReport {
  account_id: string;
  account_id_format_ok: boolean;
  token_configured: boolean;
  /** ① 用户令牌有效性（account-owned 令牌不支持此端点，会降级为 skipped） */
  token_verify: DiagCheck & { skipped: boolean };
  /** ② 账单接口 */
  billable_usage: DiagCheck & {
    rowCount: number;
    r2Services: string[];
    allServices: string[];
    /** R2 行的原始数值（排障用：免费额度内 PricingQuantity 可能为 0，真实量在 ConsumedQuantity） */
    r2Details: { service: string; unit: string; cumulatedQuantity: number; quantity: number; consumedQuantity: number; cumulatedCost: number }[];
  };
  /** ③ 用量接口（R2 面板同源） */
  graphql: DiagCheck & {
    classA: number | null;
    classB: number | null;
    storageBytes: number | null;
    /** actionType 明细（排障用：官方面板与本地分类的口径差可在此逐行核对） */
    opsBreakdown: { actionType: string; requests: number; klass: "a" | "b" | null }[];
  };
  cycle: { start: string; end: string; label: string };
  /** 从官方 BillingPeriodStart 校准出的真实周期起始日（与设置不一致说明设置填错了） */
  detected_cycle_day: number | null;
  generated_at: string;
}

/** v4 envelope 的 errors 数组 → 可读消息列表（纯函数，可测） */
export function extractErrors(json: unknown): string[] {
  const errs = (json as { errors?: unknown } | null)?.errors;
  if (!Array.isArray(errs)) return [];
  return errs
    .map((e) => {
      const o = e as { message?: unknown; code?: unknown };
      const msg = typeof o?.message === "string" ? o.message : "";
      return msg ? (o?.code != null ? `${msg} (code ${o.code})` : msg) : JSON.stringify(e);
    })
    .filter(Boolean);
}

const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/i;

async function cfRequest(
  url: string,
  token: string,
  init: RequestInit = {}
): Promise<{ status: number | null; json: unknown | null; error: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: ctrl.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* 非 JSON 响应体 */
    }
    return { status: res.status, json, error: null };
  } catch (e) {
    return { status: null, json: null, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function diagnoseUsage(env: Env, settings: Settings): Promise<DiagReport> {
  const accountId = (settings.cfAccountId || "").trim();
  const cycle = billingCycleRange(settings.billingCycleDay);
  const now = new Date().toISOString();

  let token: string | null = null;
  if (settings.cfApiTokenCipher) {
    try {
      token = await decryptSecret(settings.cfApiTokenCipher, env.admin);
    } catch {
      token = null; // 解密失败（如管理员密码已更换）→ 视同未配置
    }
  }

  const report: DiagReport = {
    account_id: accountId,
    account_id_format_ok: ACCOUNT_ID_RE.test(accountId),
    token_configured: !!settings.cfApiTokenCipher,
    token_verify: { ok: false, status: null, message: "", skipped: true },
    billable_usage: { ok: false, status: null, message: "", rowCount: 0, r2Services: [], allServices: [], r2Details: [] },
    graphql: { ok: false, status: null, message: "", classA: null, classB: null, storageBytes: null, opsBreakdown: [] },
    cycle: {
      start: cycle.start.toISOString().slice(0, 10),
      end: cycle.end.toISOString().slice(0, 10),
      label: cycle.label,
    },
    detected_cycle_day: null,
    generated_at: now,
  };

  if (!token) {
    report.token_verify.message = "token_missing_or_decrypt_failed";
    return report;
  }

  // ── ① Token 有效性（用户令牌专用端点；cfat_ 开头的账户令牌会 400/404，标记 skipped）──
  {
    const r = await cfRequest("https://api.cloudflare.com/client/v4/user/tokens/verify", token);
    const errors = extractErrors(r.json);
    if (r.status === 200 && (r.json as { result?: { status?: string } } | null)?.result?.status === "active") {
      report.token_verify = { ok: true, status: 200, message: "active", skipped: false };
    } else if (r.status === 400 || r.status === 404) {
      // account-owned token（cfat_）不支持 /user/tokens/verify → 不算失败
      report.token_verify = { ok: true, status: r.status, message: "skipped_account_owned_token", skipped: true };
    } else {
      report.token_verify = {
        ok: false,
        status: r.status,
        message: r.error ?? errors.join("; ") ?? "verify_failed",
        skipped: false,
      };
    }
  }

  // ── ② Billable Usage API ──
  {
    const url = `${BILLABLE_ENDPOINT}/${encodeURIComponent(accountId)}/billable-usage?from=${report.cycle.start}&to=${report.cycle.end}`;
    const r = await cfRequest(url, token);
    const errors = extractErrors(r.json);
    if (r.status === 200) {
      const rows = parseBillableUsage(r.json);
      const all = [...new Set(rows.map((x) => x.service).filter(Boolean))];
      const r2Rows = rows.filter(isR2);
      report.detected_cycle_day = detectCycleDay(mapBillableRows(rows)?.periodStart ?? null);
      report.billable_usage = {
        ok: true,
        status: 200,
        message: rows.length > 0 ? `rows=${rows.length}` : "empty_result",
        rowCount: rows.length,
        r2Services: [...new Set(r2Rows.map((x) => x.service).filter(Boolean))],
        allServices: all,
        r2Details: r2Rows.map((x) => ({
          service: x.service,
          unit: x.unit,
          cumulatedQuantity: x.cumulatedQuantity,
          quantity: x.quantity,
          consumedQuantity: x.consumedQuantity,
          cumulatedCost: x.cumulatedCost,
        })),
      };
    } else {
      report.billable_usage = {
        ok: false,
        status: r.status,
        message: r.error ?? (errors.join("; ") || `HTTP ${r.status}`),
        rowCount: 0,
        r2Services: [],
        allServices: [],
        r2Details: [],
      };
    }
  }

  // ── ③ GraphQL Analytics ──
  {
    const r = await cfRequest(GRAPHQL_ENDPOINT, token, {
      method: "POST",
      body: JSON.stringify({
        query: buildQuery(),
        variables: {
          accountTag: accountId,
          start: cycle.start.toISOString(),
          end: cycle.end.toISOString(),
        },
      }),
    });
    const errors = extractErrors(r.json);
    if (r.status === 200 && errors.length === 0) {
      const parsed = parseOfficialUsage(r.json, cycle.label);
      if (parsed) {
        report.graphql = {
          ok: true,
          status: 200,
          message: "ok",
          classA: parsed.classA,
          classB: parsed.classB,
          storageBytes: parsed.storageBytes,
          opsBreakdown: extractOpsBreakdown(r.json),
        };
      } else {
        // HTTP 200 但拿不到 accounts[0]：通常是 Account ID 写错（token 能看到别的账户）
        report.graphql = {
          ok: false,
          status: 200,
          message: "empty_accounts_check_account_id",
          classA: null,
          classB: null,
          storageBytes: null,
          opsBreakdown: [],
        };
      }
    } else {
      report.graphql = {
        ok: false,
        status: r.status,
        message: r.error ?? (errors.join("; ") || `HTTP ${r.status}`),
        classA: null,
        classB: null,
        storageBytes: null,
        opsBreakdown: [],
      };
    }
  }

  return report;
}
