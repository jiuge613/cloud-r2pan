/**
 * R2 操作用量统计 —— Class A（写入 / 列表）/ Class B（读取 / Head）
 *
 * Cloudflare 不通过 R2 binding 暴露当月操作计数，因此在 StorageProvider
 * 装饰层自行记账（删除操作本身免费，不计入）。
 *
 * 为什么不逐次落库：Class B（读取）在网盘场景可能高频发生（直链下载、
 * Range 分段、缩略图等），每次操作都打一次 D1 会白白消耗写入配额。
 * 因此采用 isolate 内存累计 + 批量落库：
 *   - 累计满 FLUSH_THRESHOLD 次立即落库
 *   - 未满阈值时由定时器在 FLUSH_INTERVAL_MS 后兜底落库
 *   - /api/admin/stats 读取前先 flushR2Ops() 强制落库，保证看板及时
 *   - isolate 回收最多丢失未落库的少量计数（对用量估算完全可接受）
 *
 * 落库复用 settings 表的月度计数逻辑（addR2Ops，与 addTraffic 同构：
 * 跨月自动清零、batch 事务原子累加），不另建数据通道。
 */
import type { Env } from "./types";
import { addR2Ops } from "./settings";
import type { StorageProvider } from "./storage";

const FLUSH_THRESHOLD = 10;        // 累计满 10 次立即落库
const FLUSH_INTERVAL_MS = 15_000;  // 未满阈值时最长 15 秒落库一次

let pendingA = 0;
let pendingB = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastEnv: Env | null = null;

function doFlush(): void {
  flushTimer = null;
  const env = lastEnv;
  if (!env || (pendingA <= 0 && pendingB <= 0)) return;
  void flushR2Ops(env).catch(() => {
    // 落库失败不抛出 —— 计数丢失可接受，不能影响主请求
  });
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(doFlush, FLUSH_INTERVAL_MS);
}

/** 记一次操作（kind: "a" = 写/列表，"b" = 读取） */
export function countR2Op(env: Env, kind: "a" | "b", n = 1): void {
  if (kind === "a") pendingA += n;
  else pendingB += n;
  lastEnv = env;
  if (pendingA + pendingB >= FLUSH_THRESHOLD) {
    doFlush();
  } else {
    scheduleFlush();
  }
}

/** 强制落库（看板读取前调用；测试也用它触发） */
export async function flushR2Ops(env: Env): Promise<void> {
  const a = pendingA;
  const b = pendingB;
  if (a <= 0 && b <= 0) return;
  pendingA = 0;
  pendingB = 0;
  await addR2Ops(env, a, b);
}

/**
 * 包装 StorageProvider，自动分类计数：
 *   Class A —— put（PutObject）、list（ListObjects）
 *   Class B —— get（GetObject）、head（HeadObject）
 *   不计数  —— delete（DeleteObject 属免费操作）
 */
export function countedProvider(env: Env, p: StorageProvider): StorageProvider {
  return {
    kind: p.kind,
    async put(key, body, opts) {
      countR2Op(env, "a");
      return p.put(key, body, opts);
    },
    async get(key, range) {
      countR2Op(env, "b");
      return p.get(key, range);
    },
    async head(key) {
      countR2Op(env, "b");
      return p.head(key);
    },
    async list(opts) {
      countR2Op(env, "a");
      return p.list(opts);
    },
    async delete(key) {
      return p.delete(key);
    },
  };
}
