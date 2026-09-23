import type { Env } from "./types";

/**
 * 文件夹管理核心逻辑 —— 供 admin API（管理后台）与 public（文件夹直链）共用。
 *
 * 目录模型与 WebDAV 模块保持一致（虚拟目录）：
 *   - files.path：文件所在目录，根目录为 "/"（旧数据由迁移补默认值 "/"）
 *   - directories 表：显式创建的目录（新建文件夹写入）；同时兼容"隐式目录"
 *     （只要某目录下有文件，即使不在 directories 表里也算存在 —— 与 webdav.directoryExists 一致）
 *
 * ⚠️ 所有 LIKE 查询都必须用 escapeLike + ESCAPE '\'，否则路径中的 % _ 会导致越权匹配。
 */

/* ═══════════ 路径规范化 ═══════════ */

/** 目录路径规范化：与 webdav.normPath 语义一致。输入应为已解码的字面路径；非法输入返回 null。 */
export function normalizeDirPath(p: string): string | null {
  if (typeof p !== "string") return null;
  let s = p.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!s.startsWith("/")) return null;
  if (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1);
  // 逐段校验：拒绝 .. 与空段、非法字符
  const segments = s.split("/").filter(Boolean);
  for (const seg of segments) {
    if (seg === "." || seg === "..") return null;
    if (validateFolderName(seg) !== null) return null;
  }
  return "/" + segments.join("/");
}

/**
 * 校验单级文件夹名。
 * 返回 null = 合法；返回字符串 = 错误提示（中文）。
 * 规则：1-80 字符；禁止 \\ / : * ? " < > | 与控制字符；
 *       禁止 "." ".."；禁止首尾空格；禁止以 "." 结尾（Windows 语义兼容）。
 */
export function validateFolderName(name: string): string | null {
  if (typeof name !== "string") return "文件夹名不能为空";
  const n = name.trim();
  if (!n) return "文件夹名不能为空";
  if (n.length > 80) return "文件夹名过长（最多 80 字符）";
  if (n === "." || n === "..") return "文件夹名不合法";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(n)) return "文件夹名包含非法字符";
  if (/[\\/:*?"<>|]/.test(n)) return "文件夹名不能包含 \\ / : * ? \" < > |";
  if (n !== name.trimEnd() || n.endsWith(".")) return "文件夹名不能以空格或点结尾";
  return null;
}

/** LIKE 模式转义：\ % _ → 供 `LIKE ?1 ESCAPE '\'` 使用 */
export function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** 生成"目录本身及其所有后代"的 LIKE 模式（已转义），匹配 path 本身用等值查询 */
export function likeUnder(path: string): string {
  return escapeLike(path === "/" ? "/" : path + "/") + "%";
}

/** 目录在 DB 中的规范化全路径（父目录 + 名称） */
export function joinDirPath(parent: string, name: string): string {
  const p = parent === "/" ? "" : parent;
  return `${p}/${name}`;
}

/**
 * 把文件夹直链 URL 里的内部路径参数解析为受控绝对路径（防路径穿越）。
 *   resolveInsideFolder("/photos", "2024/ particularly a.jpg") → "/photos/2024/ particularly a.jpg"
 *   resolveInsideFolder("/photos", "../secrets")               → null（越界拒绝）
 *   resolveInsideFolder("/photos", "")                         → "/photos"
 * 校验：逐段拒绝 ".."/"."、非法字符、反斜杠；构造性保证结果位于 folderPath 之内。
 */
export function resolveInsideFolder(folderPath: string, raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return folderPath;
  // 输入应已被 URLSearchParams / JSON 解码，这里不再 decode（避免含 % 的名称被二次解码）
  const s = String(raw);
  if (s.includes("\\")) return null;
  const segments = s.split("/").filter(Boolean);
  if (segments.length === 0) return folderPath;
  for (const seg of segments) {
    if (seg === "." || seg === "..") return null;
    if (validateFolderName(seg) !== null) return null;
  }
  return joinDirPath(folderPath, segments.join("/"));
}

/* ═══════════ 存在性判断 ═══════════ */

/**
 * 目录是否存在（与 webdav.directoryExists 语义一致）：
 *   - "/" 恒存在
 *   - directories 表有记录
 *   - 有文件直接位于该目录（path = 目录）
 *   - 有文件位于更深层（path LIKE 目录/%）
 */
export async function dirExists(env: Env, path: string): Promise<boolean> {
  if (path === "/") return true;
  const explicit = await env.db
    .prepare("SELECT 1 FROM directories WHERE path = ?1")
    .bind(path)
    .first();
  if (explicit) return true;
  const child = await env.db
    .prepare("SELECT 1 FROM files WHERE path = ?1 LIMIT 1")
    .bind(path)
    .first();
  if (child) return true;
  const deeper = await env.db
    .prepare(`SELECT 1 FROM files WHERE path LIKE ?1 ESCAPE '\\' LIMIT 1`)
    .bind(likeUnder(path))
    .first();
  return !!deeper;
}

/** 目录是否被显式创建过（directories 表有记录） */
export async function isExplicitDir(env: Env, path: string): Promise<boolean> {
  if (path === "/") return true;
  const row = await env.db
    .prepare("SELECT 1 FROM directories WHERE path = ?1")
    .bind(path)
    .first();
  return !!row;
}

/* ═══════════ 列表与统计 ═══════════ */

export interface FolderEntry {
  path: string;
  name: string;
  /** 递归文件数 */
  file_count: number;
  /** 递归总字节数 */
  total_bytes: number;
  explicit: boolean;
  /** 该文件夹当前有效直链的 token（/d/:token）；无则 null */
  direct_link_id: string | null;
}

export interface FolderListing {
  path: string;
  folders: FolderEntry[];
  files: {
    id: string;
    name: string;
    size: number;
    mime: string;
    uploaded_at: number;
    share_count: number;
    download_count: number;
    /** 该文件当前有效直链的 token（/d/:token）；无则 null */
    direct_link_id: string | null;
  }[];
}

/**
 * "有效直链"条件（与创建直链的幂等复用判断保持一致）：
 *   未撤销 + 未过期 + 未达次数上限。fragment 中的 ?1 为 expires 比较占位。
 */
const ACTIVE_DL_COND =
  `revoked = 0 AND (expires_at IS NULL OR expires_at > ?DL_NOW)
   AND (max_downloads IS NULL OR download_count < max_downloads)`;

/**
 * 列出某目录的直接子项（子文件夹 + 文件）。
 * 子文件夹来源 = directories 表 ∪ 文件路径推导（与 WebDAV 一致）。
 * 每个文件夹带递归文件数 / 字节数（供 UI 展示与删除确认），
 * 文件/文件夹均附带 direct_link_id（是否有有效直链，驱动前端"生成/查看直链"按钮状态）。
 */
export async function listFolder(env: Env, path: string): Promise<FolderListing> {
  const p = path === "/" ? "/" : path.replace(/\/+$/, "") || "/";
  const now = Date.now();

  // ① 直接子文件（带分享聚合 + 有效直链子查询，与原 /api/admin/files 的相关子查询模式一致）
  const { results: fileRows } = await env.db
    .prepare(
      `SELECT f.id, f.name, f.size, f.mime, f.path, f.uploaded_at,
              (SELECT COUNT(*) FROM shares s WHERE s.file_id = f.id) AS share_count,
              (SELECT COALESCE(SUM(s.download_count), 0) FROM shares s WHERE s.file_id = f.id) AS download_count,
              (SELECT dl.id FROM direct_links dl
               WHERE dl.file_id = f.id AND dl.folder_path IS NULL AND dl.revoked = 0
                 AND (dl.expires_at IS NULL OR dl.expires_at > ?2)
                 AND (dl.max_downloads IS NULL OR dl.download_count < dl.max_downloads)
               ORDER BY dl.created_at DESC LIMIT 1) AS direct_link_id
       FROM files f WHERE f.path = ?1 ORDER BY f.uploaded_at DESC`
    )
    .bind(p, now)
    .all<{
      id: string; name: string; size: number; mime: string; path: string;
      uploaded_at: number; share_count: number; download_count: number;
      direct_link_id: string | null;
    }>();

  // ② 拉取当前目录子树内所有文件路径（用于推导子目录 + 递归计数）
  const { results: underRows } = await env.db
    .prepare(`SELECT path, size FROM files WHERE path LIKE ?1 ESCAPE '\\'`)
    .bind(likeUnder(p))
    .all<{ path: string; size: number }>();

  // ③ 显式目录
  const { results: dirRows } = await env.db
    .prepare(`SELECT path FROM directories WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'`)
    .bind(p, likeUnder(p))
    .all<{ path: string }>();

  // 推导直接子目录：取子树路径中当前目录后的第一段。
  // 注意 files.path 是"文件所在目录"，可能恰好等于某个子目录本身（如 /photos/2024），
  // rest 无更深斜杠时该文件属于 rest 这个子目录，同样要计入。
  const prefixLen = p === "/" ? 1 : p.length + 1; // "/foo" 之后从下标 5 开始；根从 1 开始
  const stats = new Map<string, { count: number; bytes: number }>();
  for (const row of underRows) {
    const rest = row.path.slice(prefixLen);
    if (!rest) continue; // path === 当前目录的文件（已在直接子文件查询里返回）
    const firstSeg = rest.split("/")[0];
    if (!firstSeg) continue;
    const acc = stats.get(firstSeg) ?? { count: 0, bytes: 0 };
    acc.count += 1;
    acc.bytes += row.size ?? 0;
    stats.set(firstSeg, acc);
  }
  const explicitSet = new Set<string>();
  for (const row of dirRows) {
    if (row.path === p) continue;
    const rest = row.path.slice(prefixLen);
    const firstSeg = rest.split("/")[0];
    if (firstSeg) explicitSet.add(firstSeg);
  }

  const names = Array.from(new Set([...stats.keys(), ...explicitSet])).sort((a, b) =>
    a.localeCompare(b)
  );

  // ④ 批量查询这些子文件夹的有效直链（一次 IN 查询，逐个映射）
  const childPaths = names.map((name) => joinDirPath(p, name));
  const folderLinks = new Map<string, string>();
  if (childPaths.length) {
    const placeholders = childPaths.map((_, i) => `?${i + 1}`).join(",");
    const cond = ACTIVE_DL_COND.replace("?DL_NOW", `?${childPaths.length + 1}`);
    const { results: dlRows } = await env.db
      .prepare(
        `SELECT id, folder_path FROM direct_links
         WHERE folder_path IN (${placeholders}) AND ${cond}
         ORDER BY created_at DESC`
      )
      .bind(...childPaths, now)
      .all<{ id: string; folder_path: string }>();
    for (const row of dlRows ?? []) {
      if (!folderLinks.has(row.folder_path)) folderLinks.set(row.folder_path, row.id);
    }
  }

  const folders: FolderEntry[] = names.map((name) => {
    const st = stats.get(name) ?? { count: 0, bytes: 0 };
    return {
      path: joinDirPath(p, name),
      name,
      file_count: st.count,
      total_bytes: st.bytes,
      explicit: explicitSet.has(name),
      direct_link_id: folderLinks.get(joinDirPath(p, name)) ?? null,
    };
  });

  return {
    path: p,
    folders,
    files: (fileRows ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      size: f.size,
      mime: f.mime,
      uploaded_at: f.uploaded_at,
      share_count: f.share_count,
      download_count: f.download_count,
      direct_link_id: f.direct_link_id ?? null,
    })),
  };
}

export interface FolderStats {
  files: number;
  folders: number;
  bytes: number;
}

/** 递归统计目录下的文件数 / 子目录数 / 总字节数（删除确认弹窗用） */
export async function folderStats(env: Env, path: string): Promise<FolderStats> {
  // 注意：files.path 是"文件所在目录"，必须同时匹配「直接位于该目录」(path = dir)
  // 与「位于更深层」(path LIKE dir/%) 两类
  const filesRow = await env.db
    .prepare(
      `SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS b FROM files
       WHERE path = ?1 OR (path LIKE ?2 ESCAPE '\\' AND path != ?1)`
    )
    .bind(path, likeUnder(path))
    .first<{ c: number; b: number }>();
  const dirRow = await env.db
    .prepare(`SELECT COUNT(*) AS c FROM directories WHERE path LIKE ?1 ESCAPE '\\'`)
    .bind(likeUnder(path))
    .first<{ c: number }>();
  return {
    files: filesRow?.c ?? 0,
    folders: dirRow?.c ?? 0,
    bytes: filesRow?.b ?? 0,
  };
}

/* ═══════════ 删除 ═══════════ */

export interface DeleteFolderResult {
  files: number;
  folders: number;
  bytes: number;
  /** 待删除的存储对象 key（DB 已清理，存储对象由调用方异步删除） */
  storageKeys: string[];
}

/**
 * 递归删除目录：
 *   1. 收集子树内所有文件的存储 key
 *   2. 级联清理 shares / direct_links / download_logs / files / directories
 *      （用 IN (SELECT ...) 子查询，避免逐文件循环的 N 次往返）
 *   3. 返回统计 + 存储 key 列表，由调用方决定何时删存储对象（推荐 ctx.waitUntil）
 *
 * ⚠️ 不删 "/"；调用前必须先 dirExists，否则返回 null。
 */
export async function deleteFolderRecursive(
  env: Env,
  path: string
): Promise<DeleteFolderResult | null> {
  if (path === "/" || path.length < 2) return null;
  if (!(await dirExists(env, path))) return null;

  const pattern = likeUnder(path);
  const st = await folderStats(env, path);

  // 收集存储 key（必须在 files 删除前查）—— 同时覆盖直接位于目录内与更深层
  const { results: keyRows } = await env.db
    .prepare(`SELECT key FROM files WHERE path = ?1 OR (path LIKE ?2 ESCAPE '\\' AND path != ?1)`)
    .bind(path, pattern)
    .all<{ key: string }>();

  await env.db.batch([
    // 文件夹直链（direct_links.folder_path 命中该目录或其子目录）一并失效
    env.db.prepare(`DELETE FROM direct_links WHERE folder_path = ?1 OR folder_path LIKE ?2 ESCAPE '\\'`)
      .bind(path, pattern),
    env.db.prepare(`DELETE FROM shares WHERE file_id IN (SELECT id FROM files WHERE path = ?1 OR (path LIKE ?2 ESCAPE '\\' AND path != ?1))`)
      .bind(path, pattern),
    env.db.prepare(`DELETE FROM direct_links WHERE file_id IN (SELECT id FROM files WHERE path = ?1 OR (path LIKE ?2 ESCAPE '\\' AND path != ?1))`)
      .bind(path, pattern),
    env.db.prepare(`DELETE FROM download_logs WHERE file_id IN (SELECT id FROM files WHERE path = ?1 OR (path LIKE ?2 ESCAPE '\\' AND path != ?1))`)
      .bind(path, pattern),
    env.db.prepare(`DELETE FROM files WHERE path = ?1 OR (path LIKE ?2 ESCAPE '\\' AND path != ?1)`)
      .bind(path, pattern),
    // 子目录记录 + 目录本身
    env.db.prepare(`DELETE FROM directories WHERE path = ?1 OR path LIKE ?2 ESCAPE '\\'`)
      .bind(path, pattern),
  ]);

  return {
    files: st.files,
    folders: st.folders,
    bytes: st.bytes,
    storageKeys: (keyRows ?? []).map((r) => r.key),
  };
}
