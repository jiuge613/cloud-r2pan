/**
 * Cloudflare 官方 R2 用量 —— GraphQL Analytics API 对接
 *
 * 官方面板（R2 → Metrics）显示三项：A 类操作 / B 类操作 / 总存储，
 * 统计周期是"账单周期"（如 September 23 - October 23，由账户订阅日决定），
 * 而非自然月。本地自记账（opstats.ts）的数字与官方天然存在偏差：
 *   - 部署前的历史操作、Workers 内部调用（如 ListObjects 心跳）未被记账
 *   - isolate 回收会丢失少量 pending
 *   - 统计周期口径不同（自然月 vs 账单周期）
 *
 * 因此：配置了 Cloudflare Account ID + API Token（Account Analytics:Read 权限）
 * 后，看板数据以官方 GraphQL 数据为准（对齐官方面板）；未配置时回退本地自记账。
 *
 * 已知特性：官方 analytics 数据有约 15-30 分钟延迟，tooltip 需注明，
 * 避免用户拿它和本地实时记账对比时误以为"显示 0/偏小"是 bug。
 *
 * GraphQL schema（community 验证过的字段）：
 *   r2OperationsAdaptiveGroups { dimensions { actionType } sum { requests } }
 *   r2StorageAdaptiveGroups    { dimensions { datetimeHour } max { payloadSize metadataSize } }
 * 存储量口径 = payloadSize + metadataSize（与官方面板 "总存储" 一致，metadata
 * 约 6.4 KB/对象，这也是为什么官方 6.6 MB 大于本地 SUM(size)）。
 */
import type { Env } from "./types";
import { decryptSecret } from "./crypto";
import type { Settings } from "./settings";

/** Class A（计费写操作）的 actionType 集合 */
const CLASS_A_ACTIONS = new Set([
  "PutObject",
  "CopyObject",
  "CreateMultipartUpload",
  "UploadPart",
  "UploadPartCopy",
  "CompleteMultipartUpload",
  "ListObjects",
  "ListMultipartUploads",
  "ListParts",
  "RestoreObject",
]);
/** Class B（计费读操作） */
const CLASS_B_ACTIONS = new Set(["GetObject", "HeadObject", "HeadBucket"]);

/** Delete / Abort 免费；PutBucket* 前缀属 Class A */
export function classifyAction(actionType: string): "a" | "b" | null {
  if (CLASS_A_ACTIONS.has(actionType)) return "a";
  if (CLASS_B_ACTIONS.has(actionType)) return "b";
  if (actionType.startsWith("PutBucket")) return "a";
  return null; // Delete* / Abort* / 未知类型 —— 免费或不计入
}

export interface BillingCycle {
  /** 周期起点（UTC，含） */
  start: Date;
  /** 周期终点（UTC，= 下一个周期起点，官方显示为 open-ended） */
  end: Date;
  /** 官方面板风格标签，如 "September 23 - October 23" */
  label: string;
}

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * 计算账单周期：cycleDay = 官方面板"September 23 - October 23"里的 23。
 * 今天（UTC）的日期 >= cycleDay → 周期 = 本月 cycleDay ~ 下月 cycleDay；
 * 否则 → 上月 cycleDay ~ 本月 cycleDay。cycleDay 实际取值前先 clamp 到 1-28
 * （29-31 在二月等短月无法表达，D1 读取侧已 clamp，这里兜底再 clamp 一次）。
 */
export function billingCycleRange(cycleDayRaw: number, now: Date = new Date()): BillingCycle {
  const cycleDay = Math.min(28, Math.max(1, Math.round(cycleDayRaw) || 1));
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  const d = now.getUTCDate();

  let startY: number, startM: number;
  if (d >= cycleDay) {
    startY = y; startM = m;
  } else {
    // 上月
    startY = m === 0 ? y - 1 : y;
    startM = m === 0 ? 11 : m - 1;
  }
  const start = new Date(Date.UTC(startY, startM, cycleDay));
  const end = new Date(Date.UTC(startY, startM + 1, cycleDay));

  const label = `${MONTHS_EN[start.getUTCMonth()]} ${start.getUTCDate()} - ${MONTHS_EN[end.getUTCMonth()]} ${end.getUTCDate()}`;
  return { start, end, label };
}

export interface OfficialUsage {
  classA: number;
  classB: number;
  /** payloadSize + metadataSize（官方"总存储"口径，字节） */
  storageBytes: number;
  /** 周期标签，如 "September 23 - October 23" */
  cycleLabel: string;
}

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";
const CACHE_TTL_MS = 10 * 60 * 1000; // 官方数据本身延迟 15-30 分钟，缓存 10 分钟足够

let _cache: { at: number; data: OfficialUsage | null } | null = null;
let _cacheKey = "";

/** 清空官方数据缓存（测试用 / token 更新后调用） */
export function invalidateUsageCache(): void {
  _cache = null;
  _cacheKey = "";
}

function buildQuery(): string {
  return `query R2Usage($accountTag: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: {accountTag: $accountTag}) {
      r2OperationsAdaptiveGroups(
        filter: {datetime_geq: $start, datetime_leq: $end}
        limit: 10000
      ) {
        dimensions { actionType }
        sum { requests }
      }
      r2StorageAdaptiveGroups(
        filter: {datetime_geq: $start, datetime_leq: $end}
        limit: 1
        orderBy: [datetimeHour_DESC]
      ) {
        dimensions { datetimeHour }
        max { payloadSize metadataSize }
      }
    }
  }
}`;
}

/** 解析 GraphQL 响应 —— 独立导出以便行为测试（mock 响应 → 精确数值） */
export function parseOfficialUsage(json: unknown, cycleLabel: string): OfficialUsage | null {
  const root = json as {
    data?: {
      viewer?: {
        accounts?: {
          r2OperationsAdaptiveGroups?: {
            dimensions: { actionType: string };
            sum: { requests: number };
          }[];
          r2StorageAdaptiveGroups?: {
            dimensions: { datetimeHour: string };
            max: { payloadSize: number; metadataSize: number };
          }[];
        }[];
      };
    };
    errors?: { message: string }[];
  };
  if (root?.errors && root.errors.length > 0) return null;
  const account = root?.data?.viewer?.accounts?.[0];
  if (!account) return null;

  let classA = 0;
  let classB = 0;
  for (const row of account.r2OperationsAdaptiveGroups ?? []) {
    const kind = classifyAction(row.dimensions?.actionType ?? "");
    const n = Math.max(0, Math.round(Number(row.sum?.requests) || 0));
    if (kind === "a") classA += n;
    else if (kind === "b") classB += n;
  }

  let storageBytes = 0;
  const snap = account.r2StorageAdaptiveGroups?.[0];
  if (snap?.max) {
    storageBytes = Math.max(0, Number(snap.max.payloadSize) || 0) + Math.max(0, Number(snap.max.metadataSize) || 0);
  }
  return { classA, classB, storageBytes, cycleLabel };
}

/**
 * 拉取官方用量数据。任何失败（未配置 token、网络错误、GraphQL errors、超时）
 * 都返回 null —— 调用方回退本地自记账，绝不影响看板可用性。
 */
export async function fetchOfficialUsage(env: Env, settings: Settings): Promise<OfficialUsage | null> {
  const accountId = (settings.cfAccountId || "").trim();
  if (!accountId || !settings.cfApiTokenCipher) return null;

  const cycle = billingCycleRange(settings.billingCycleDay);
  const cacheKey = `${accountId}|${cycle.start.toISOString()}`;
  if (_cache && _cacheKey === cacheKey && Date.now() - _cache.at < CACHE_TTL_MS) {
    return _cache.data;
  }

  let token: string | null = null;
  try {
    token = await decryptSecret(settings.cfApiTokenCipher, env.admin);
  } catch {
    return null;
  }
  if (!token) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);  let parsed: OfficialUsage | null = null;
  try {
    const res = await fetch(GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: buildQuery(),
        variables: {
          accountTag: accountId,
          start: cycle.start.toISOString(),
          end: cycle.end.toISOString(),
        },
      }),
      signal: ctrl.signal,
    });
    if (res.ok) {
      parsed = parseOfficialUsage(await res.json(), cycle.label);
    }
  } catch {
    parsed = null; // 网络 / 超时 / 解析失败 —— 回退自记账
  } finally {
    clearTimeout(timer);
  }

  _cache = { at: Date.now(), data: parsed };
  _cacheKey = cacheKey;
  return parsed;
}
