/**
 * R2 操作用量统计 —— Class A（写入 / 列表）/ Class B（读取 / Head）
 *
 * Cloudflare 不通过 R2 binding 暴露当月操作计数，因此在 StorageProvider
 * 装饰层自行记账（删除操作本身免费，不计入）。
 *
 * ═══════════ 落库策略（2026-09-29 修订） ═══════════
 * 旧实现：isolate 内存累计，满 10 次或 15 秒定时器落库。
 * 该策略在 Cloudflare Workers 上等于"长期不更新"，原因有三：
 *   1. 隔离性：pending 是 isolate 级变量。上传落在 A isolate、看板落在 B isolate，
 *      B 的 flushR2Ops 只能刷自己的（空）pending —— 跨 isolate 永远看不到对方增量。
 *   2. 请求分散：Workers 会把不同请求调度到不同实例，单实例 pending 很难攒够阈值，
 *      于是"上传 100 次仍显示 0"完全可能。
 *   3. 无后台执行：请求返回后 setTimeout 回调不保证执行，且回调里的 D1 写入没有
 *      waitUntil 保护，会被静默丢弃。
 *
 * 新实现：**操作发生时同步落库 + 最小落库间隔节流**。
 *   - countR2Op 现在是 async，装饰器 await 它 → 本次请求返回前计数已写入 D1，
 *     任何 isolate 读到的都是最新值（看板实时）。
 *   - 节流：距上次落库不足 MIN_FLUSH_INTERVAL_MS 且未达 FLUSH_THRESHOLD 时不写，
 *     交给定时器兜底 —— 高频读取（Range 分段下载等）下也最多每 N 毫秒写一次 D1。
 *   - 这让 D1 写入量与"时间"而非"操作次数"挂钩，避免吃满 D1 免费写额度。
 *   - 任何记账异常一律吞掉，绝不影响上传/下载主链路。
 *
 * 落库复用 settings 表的月度计数逻辑（addR2Ops，与 addTraffic 同构：
 * 跨月自动清零、batch 事务原子累加），不另建数据通道。
 */
import type { Env } from "./types";
import { addR2Ops } from "./settings";
import type { StorageProvider } from "./storage";

const FLUSH_THRESHOLD = 25;         // 累计满 25 次立即落库（洪峰时不等节流窗口）
const MIN_FLUSH_INTERVAL_MS = 1_500; // 两次 D1 落库的最小间隔（成本保护）
const TIMER_FALLBACK_MS = 2_000;    // 未满足条件时的定时器兜底

let pendingA = 0;
let pendingB = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lastEnv: Env | null = null;
let lastFlushAt = 0;

/** 真正执行一次落库：取出并清零 pending，写入 D1 */
async function flushNow(env: Env): Promise<void> {
  if (pendingA <= 0 && pendingB <= 0) return;
  const a = pendingA;
  const b = pendingB;
  pendingA = 0;
  pendingB = 0;
  lastFlushAt = Date.now();
  await addR2Ops(env, a, b);
}

function doFlush(): void {
  flushTimer = null;
  const env = lastEnv;
  if (!env || (pendingA <= 0 && pendingB <= 0)) return;
  void flushNow(env).catch(() => {
    // 落库失败不抛出 —— 计数丢失可接受，不能影响主请求
  });
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(doFlush, TIMER_FALLBACK_MS);
}

/**
 * 记一次操作并按需落库（kind: "a" = 写/列表，"b" = 读取）
 *
 * 关键点：调用方必须 await —— 这样在该请求返回之前计数已落到 D1，
 * 不会出现"上传成功但看板仍是 0"的跨 isolate 不可见问题。
 */
export async function countR2Op(env: Env, kind: "a" | "b", n = 1): Promise<void> {
  if (kind === "a") pendingA += n;
  else pendingB += n;
  lastEnv = env;

  try {
    if (pendingA + pendingB >= FLUSH_THRESHOLD || Date.now() - lastFlushAt >= MIN_FLUSH_INTERVAL_MS) {
      await flushNow(env);
    } else {
      scheduleFlush();
    }
  } catch {
    // 记账失败绝不影响上传 / 下载主链路
  }
}

/** 强制落库（看板读取前调用；测试也用它触发） */
export async function flushR2Ops(env: Env): Promise<void> {
  try {
    await flushNow(env);
  } catch {
    // 同上：静默
  }
}

/**
 * 包装 StorageProvider，自动分类计数：
 *   Class A —— put（PutObject）、list（ListObjects）
 *   Class B —— get（GetObject）、head（HeadObject）
 *   不计数  —— delete（DeleteObject 属免费操作）
 */
/**
 * 包装 StorageProvider，自动分类计数：
 *   Class A —— put（PutObject）、list（ListObjects）
 *   Class B —— get（GetObject）、head（HeadObject）
 *   不计数  —— delete（DeleteObject 属免费操作）
 *
 * 记账与底层调用并发执行（不增加主链路延迟），但在返回前 await 完成，
 * 保证"本次请求结束前计数已在 D1 里"。底层操作失败同样计数 ——
 * R2 对失败的 Get/Put 请求也一样计入操作次数。
 */
function wrap<T extends unknown[]>(
  env: Env,
  kind: "a" | "b",
  fn: (...args: T) => Promise<any>
): (...args: T) => Promise<any> {
  return async (...args: T) => {
    const counted = countR2Op(env, kind); // 立即发起，与底层 IO 并行
    try {
      const out = await fn(...args);
      await counted;
      return out;
    } catch (e) {
      await counted; // 失败的操作同样计入用量
      throw e;
    }
  };
}

export function countedProvider(env: Env, p: StorageProvider): StorageProvider {
  return {
    kind: p.kind,
    put: wrap(env, "a", (key, body, opts) => p.put(key, body, opts)),
    get: wrap(env, "b", (key, range) => p.get(key, range)),
    head: wrap(env, "b", (key) => p.head(key)),
    list: wrap(env, "a", (opts) => p.list(opts)),
    delete: (key) => p.delete(key),
  };
}
