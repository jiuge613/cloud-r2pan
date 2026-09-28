/**
 * 文件夹管理 + 文件夹直链 行为断言测试
 * 运行: node --experimental-sqlite _test/run.mjs
 * 说明: 用 node:sqlite 构造 D1 兼容 mock，对编译后的 folders.js 做真实 SQL 行为验证。
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const f = require("./build/folders.js");
const ed = require("./build/editable.js");
const st = require("./build/settings.js");

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log("  ✓ " + msg); }
  else { failed++; console.error("  ✗ FAIL: " + msg); }
}
function eq(a, b, msg) { ok(JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)})`); }

/* ═══════════ D1 mock（node:sqlite 之上） ═══════════ */
function makeD1(sqlite) {
  return {
    prepare(sql) {
      const stmt = sqlite.prepare(sql);
      let vals = [];
      const setVals = (v) => { if (v.length > 0) vals = v; };
      const api = {
        bind(...v) { vals = v; return api; },
        // D1 允许 first/all/run 直接传参（等价于 bind 后执行）
        async first(...v) { setVals(v); return stmt.get(...vals) ?? null; },
        async all(...v) { setVals(v); return { results: stmt.all(...vals) }; },
        async run(...v) { setVals(v); const r = stmt.run(...vals); return { meta: { changes: r.changes } }; },
      };
      return api;
    },
    async batch(stmts) { for (const s of stmts) await s.run(); },
  };
}

const SCHEMA = `
CREATE TABLE files (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  size INTEGER NOT NULL, mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  uploaded_at INTEGER NOT NULL, path TEXT NOT NULL DEFAULT '/');
CREATE TABLE shares (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER, max_downloads INTEGER, download_count INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0, password_hash TEXT, download_name TEXT,
  is_market INTEGER NOT NULL DEFAULT 0, market_views INTEGER NOT NULL DEFAULT 0,
  market_title TEXT, market_desc TEXT);
CREATE TABLE direct_links (id TEXT PRIMARY KEY, file_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER, max_downloads INTEGER, download_count INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0, download_name TEXT, notes TEXT, folder_path TEXT);
CREATE TABLE download_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, share_id TEXT NOT NULL,
  file_id TEXT NOT NULL, file_name TEXT NOT NULL, ip TEXT NOT NULL, ua TEXT, browser TEXT,
  os TEXT, country TEXT, bytes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  activation_code TEXT);
CREATE TABLE directories (path TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE traffic_stats (day TEXT PRIMARY KEY, bytes INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0);
`;

function freshEnv() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  const env = { db: makeD1(sqlite) };
  return { sqlite, env };
}

let n = 0;
function addFile(env, path, name, size = 100) {
  const id = "f" + (++n);
  env.db.prepare("INSERT INTO files(id,key,name,size,mime,path,uploaded_at) VALUES(?,?,?,?,?,?,?)")
    .run(id, "files/" + id, name, size, "application/octet-stream", path, Date.now());
  return id;
}
function addDir(env, path) {
  env.db.prepare("INSERT INTO directories(path, created_at) VALUES(?,?)").run(path, Date.now());
}
function addShare(env, fileId) {
  const id = "sh" + (++n);
  env.db.prepare("INSERT INTO shares(id,file_id,created_at,download_count) VALUES(?,?,?,?)").run(id, fileId, Date.now(), 3);
  return id;
}
function addFileLink(env, fileId) {
  const id = "dl" + (++n);
  env.db.prepare("INSERT INTO direct_links(id,file_id,created_at) VALUES(?,?,?)").run(id, fileId, Date.now());
  return id;
}
function addFolderLink(env, folderPath) {
  const id = "fl" + (++n);
  env.db.prepare("INSERT INTO direct_links(id,file_id,created_at,folder_path) VALUES(?,?,?,?)").run(id, "", Date.now(), folderPath);
  return id;
}
function addLog(env, fileId, bytes = 10) {
  env.db.prepare("INSERT INTO download_logs(share_id,file_id,file_name,ip,bytes,created_at) VALUES(?,?,?,?,?,?)")
    .run("s", fileId, "x", "1.2.3.4", bytes, Date.now());
}

/* ═══════════ 1. 纯函数：名称校验 / 路径规范化 / 越界防护 ═══════════ */
console.log("\n[1] validateFolderName");
eq(f.validateFolderName("资料 2024"), null, "中文+空格合法");
eq(f.validateFolderName("Photos"), null, "英文合法");
ok(f.validateFolderName("") !== null, "空名拒绝");
ok(f.validateFolderName("   ") !== null, "纯空格拒绝");
ok(f.validateFolderName("a/b") !== null, "含 / 拒绝");
ok(f.validateFolderName("a\\b") !== null, "含 \\ 拒绝");
ok(f.validateFolderName("a:b") !== null, "含 : 拒绝");
ok(f.validateFolderName('a"b') !== null, "含 \" 拒绝");
ok(f.validateFolderName("a<b>|?*") !== null, "非法字符组拒绝");
ok(f.validateFolderName(".") !== null, "'.' 拒绝");
ok(f.validateFolderName("..") !== null, "'..' 拒绝");
ok(f.validateFolderName("a".repeat(81)) !== null, "81 字符拒绝");
ok(f.validateFolderName("a".repeat(80)) === null, "80 字符合法");
ok(f.validateFolderName("name.") !== null, "结尾点拒绝");
ok(f.validateFolderName("a\u0000b") !== null, "控制字符拒绝");

console.log("\n[2] normalizeDirPath");
eq(f.normalizeDirPath("/a//b/"), "/a/b", "折叠斜杠与尾斜杠");
eq(f.normalizeDirPath("/"), "/", "根目录保持");
eq(f.normalizeDirPath("a/b"), null, "不以 / 开头拒绝");
eq(f.normalizeDirPath("/a/../b"), null, "含 .. 拒绝");
eq(f.normalizeDirPath("/a/."), null, "含 . 拒绝");
eq(f.normalizeDirPath("/a\\b"), "/a/b", "反斜杠按 webdav.normPath 语义转斜杠");
eq(f.normalizeDirPath("/50%"), "/50%", "含 % 的目录名保留（不再二次解码）");

console.log("\n[3] resolveInsideFolder（文件夹直链防穿越）");
eq(f.resolveInsideFolder("/photos", "2024/a.jpg"), "/photos/2024/a.jpg", "相对路径拼接");
eq(f.resolveInsideFolder("/photos", ""), "/photos", "空 → 根");
eq(f.resolveInsideFolder("/", "a/b.txt"), "/a/b.txt", "根目录直链拼接");
eq(f.resolveInsideFolder("/photos", ".."), null, ".. 拒绝");
eq(f.resolveInsideFolder("/photos", "a/../../b"), null, "中间 .. 拒绝");
eq(f.resolveInsideFolder("/photos", "..%2Fb"), "/photos/..%2Fb", "编码穿越串不解码、按字面处理（不含 ../ 段则放行）");
eq(f.resolveInsideFolder("/photos", "50%.txt"), "/photos/50%.txt", "含 % 文件名不损坏");
ok(f.resolveInsideFolder("/photos", "a\\b") === null, "反斜杠拒绝");

console.log("\n[4] escapeLike / likeUnder");
eq(f.escapeLike("50%_a\\b"), "50\\%\\_a\\\\b", "LIKE 通配符转义");
eq(f.likeUnder("/photos"), "/photos/%", "普通路径模式");
eq(f.likeUnder("/50%"), "/50\\%/%", "% 被转义后仍匹配子树（尾 % 为通配）");

/* ═══════════ 2. listFolder 行为 ═══════════ */
console.log("\n[5] listFolder");
{
  const { env } = freshEnv();
  const rootId = addFile(env, "/", "readme.txt");
  const p1 = addFile(env, "/photos", "p1.jpg", 200);
  const x1 = addFile(env, "/photos/2024", "x.jpg", 300);
  const o1 = addFile(env, "/other", "o.txt", 50);
  addDir(env, "/photos");
  addShare(env, p1);
  addFolderLink(env, "/photos");

  const root = await f.listFolder(env, "/");
  eq(root.folders.map(d => d.name), ["other", "photos"], "根目录子文件夹（推导+显式合并排序）");
  eq(root.files.map(x => x.name), ["readme.txt"], "根目录文件");
  eq(root.folders.find(d => d.name === "photos").file_count, 2, "photos 递归文件数=2（含子目录）");

  const photos = await f.listFolder(env, "/photos");
  eq(photos.folders.map(d => d.name), ["2024"], "photos 下子目录");
  eq(photos.files.map(x => x.name), ["p1.jpg"], "photos 下直接文件");
  eq(photos.files[0].share_count, 1, "p1 分享数=1");
  eq(photos.folders.find(d => d.name === "2024").total_bytes, 300, "2024 递归字节数");

  const empty = await f.listFolder(env, "/other");
  eq(empty.folders.length, 0, "other 无子目录");
  eq(empty.files.length, 1, "other 有 1 个文件");
}

/* ═══════════ 3. folderStats + deleteFolderRecursive 行为 ═══════════ */
console.log("\n[6] folderStats / deleteFolderRecursive");
{
  const { env, sqlite } = freshEnv();
  const p1 = addFile(env, "/photos", "p1.jpg", 200);
  const x1 = addFile(env, "/photos/2024", "x.jpg", 300);
  addFile(env, "/", "root.txt");
  addFile(env, "/other", "o.txt", 50);
  addDir(env, "/photos");
  addDir(env, "/photos/2024");
  const share1 = addShare(env, p1);
  const share2 = addShare(env, x1);
  const link1 = addFileLink(env, p1);          // 文件直链 → 应随删除消失
  const folderLink1 = addFolderLink(env, "/photos"); // 文件夹直链 → 应随删除消失
  const folderLink2 = addFolderLink(env, "/other");  // 无关直链 → 保留
  addLog(env, p1);

  const stats = await f.folderStats(env, "/photos");
  eq(stats.files, 2, "递归统计文件数=2");
  eq(stats.folders, 1, "递归统计子目录数=1（不含自身）");
  eq(stats.bytes, 500, "递归统计字节=500");

  const r = await f.deleteFolderRecursive(env, "/photos");
  ok(r !== null, "删除成功");
  eq(r.files, 2, "返回删除文件数");
  eq(r.folders, 1, "返回删除子目录数");
  eq(r.bytes, 500, "返回删除字节数");
  eq([...r.storageKeys].sort(), ["files/f7", "files/f8"], "返回待删存储 key（p1 与 x.jpg）");

  eq(sqlite.prepare("SELECT COUNT(*) c FROM files WHERE path LIKE '/photos/%'").get().c, 0, "photos 子树文件已清空");
  eq(sqlite.prepare("SELECT COUNT(*) c FROM files WHERE path = '/'").get().c, 1, "根文件保留");
  eq(sqlite.prepare("SELECT COUNT(*) c FROM files WHERE path = '/other'").get().c, 1, "other 文件保留");
  eq(sqlite.prepare("SELECT COUNT(*) c FROM directories WHERE path LIKE '/photos%'").get().c, 0, "photos 目录记录清空");
  eq(sqlite.prepare("SELECT COUNT(*) c FROM shares WHERE id IN ('" + share1 + "','" + share2 + "')").get().c, 0, "级联删除 shares");
  eq(sqlite.prepare("SELECT COUNT(*) c FROM direct_links WHERE id = '" + link1 + "'").get().c, 0, "文件直链级联删除");
  eq(sqlite.prepare("SELECT COUNT(*) c FROM direct_links WHERE id = '" + folderLink1 + "'").get().c, 0, "命中目录的文件夹直链删除");
  eq(sqlite.prepare("SELECT COUNT(*) c FROM direct_links WHERE id = '" + folderLink2 + "'").get().c, 1, "无关文件夹直链保留");
  eq(sqlite.prepare("SELECT COUNT(*) c FROM download_logs WHERE file_id = '" + p1 + "'").get().c, 0, "下载日志级联删除");

  ok((await f.deleteFolderRecursive(env, "/photos")) === null, "删除不存在的文件夹 → null（404 语义）");
  ok((await f.deleteFolderRecursive(env, "/")) === null, "删除根目录 → 拒绝");
}

/* ═══════════ 4. LIKE 转义行为：含 % _ 的目录名不会越权匹配 ═══════════ */
console.log("\n[7] LIKE 转义防越权");
{
  const { env, sqlite } = freshEnv();
  addFile(env, "/50%", "pct.txt", 10);
  addFile(env, "/50x", "near.txt", 20);
  addFile(env, "/a_b", "under.txt", 30);
  const r = await f.deleteFolderRecursive(env, "/50%");
  eq(r.files, 1, "只命中 /50% 下的 1 个文件");
  eq(r.bytes, 10, "只命中 pct.txt 的字节");
  eq(sqlite.prepare("SELECT COUNT(*) c FROM files WHERE path = '/50x'").get().c, 1, "/50x 未被误删");
  eq(sqlite.prepare("SELECT COUNT(*) c FROM files WHERE path = '/a_b'").get().c, 1, "/a_b 未被误删");

  // folderStats 同理
  const s2 = await f.folderStats(env, "/a_b");
  eq(s2.files, 1, "folderStats 对含 _ 路径精确匹配");
}

/* ═══════════ 5. 直链状态（direct_link_id）与幂等复用 ═══════════ */
console.log("\n[8] listFolder 直链状态 + 幂等复用条件");
{
  const { env } = freshEnv();
  const fActive = addFile(env, "/", "active.txt");   // 有有效直链
  const fRevoked = addFile(env, "/", "revoked.txt"); // 只有已撤销直链
  const fExpired = addFile(env, "/", "expired.txt"); // 只有已过期直链
  const fMaxed = addFile(env, "/", "maxed.txt");     // 只有已达上限直链
  const fNone = addFile(env, "/", "none.txt");       // 从未生成直链
  const fMulti = addFile(env, "/", "multi.txt");     // 多条直链：旧的过期 + 新的有效 → 取有效的
  addDir(env, "/docs");
  addDir(env, "/dead");
  const ins = (id, fileId, opts = {}) => env.db.prepare(
    "INSERT INTO direct_links(id,file_id,created_at,expires_at,max_downloads,download_count,revoked,folder_path) VALUES(?,?,?,?,?,?,?,?)"
  ).run(id, fileId ?? "", Date.now(), opts.expires ?? null, opts.max ?? null, opts.used ?? 0, opts.revoked ?? 0, opts.folder ?? null);

  ins("dl-a1", fActive);
  ins("dl-r1", fRevoked, { revoked: 1 });
  ins("dl-e1", fExpired, { expires: Date.now() - 1000 });
  ins("dl-m1", fMaxed, { max: 5, used: 5 });
  ins("dl-x1", fMulti, { expires: Date.now() - 1000 });
  ins("dl-x2", fMulti);
  ins("fl-doc1", null, { folder: "/docs" });
  ins("fl-dead", null, { folder: "/dead", revoked: 1 });

  const root = await f.listFolder(env, "/");
  const byName = Object.fromEntries(root.files.map(x => [x.name, x.direct_link_id]));
  eq(byName["active.txt"], "dl-a1", "有效直链 → 返回 token");
  eq(byName["revoked.txt"], null, "仅已撤销直链 → null（按钮回到生成直链）");
  eq(byName["expired.txt"], null, "仅已过期直链 → null");
  eq(byName["maxed.txt"], null, "仅已达上限直链 → null");
  eq(byName["none.txt"], null, "从未生成 → null");
  eq(byName["multi.txt"], "dl-x2", "多条直链取最新有效的一条");
  eq(root.folders.find(d => d.name === "docs").direct_link_id, "fl-doc1", "文件夹有效直链 → token");
  eq(root.folders.find(d => d.name === "dead").direct_link_id, null, "文件夹已撤销直链 → null");

  // 幂等复用判定 SQL（与 admin.ts POST /api/admin/direct-links 完全一致的语义）
  const reuse = env.db.prepare(
    `SELECT id FROM direct_links
     WHERE file_id = ?1 AND folder_path IS NULL AND revoked = 0
       AND (expires_at IS NULL OR expires_at > ?2)
       AND (max_downloads IS NULL OR download_count < max_downloads)
     ORDER BY created_at DESC LIMIT 1`
  );
  eq((await reuse.bind(fActive, Date.now()).first())?.id, "dl-a1", "复用判定：有效直链命中");
  eq(await reuse.bind(fRevoked, Date.now()).first(), null, "复用判定：仅撤销 → 不复用（新建）");
  eq(await reuse.bind(fExpired, Date.now()).first(), null, "复用判定：仅过期 → 不复用");
  eq(await reuse.bind(fMaxed, Date.now()).first(), null, "复用判定：仅满额 → 不复用");
  eq((await reuse.bind(fMulti, Date.now()).first())?.id, "dl-x2", "复用判定：多条取最新有效");
  const folderReuse = env.db.prepare(
    `SELECT id FROM direct_links
     WHERE folder_path = ?1 AND revoked = 0
       AND (expires_at IS NULL OR expires_at > ?2)
       AND (max_downloads IS NULL OR download_count < max_downloads)
     ORDER BY created_at DESC LIMIT 1`
  );
  eq((await folderReuse.bind("/docs", Date.now()).first())?.id, "fl-doc1", "复用判定：文件夹直链命中");
  eq(await folderReuse.bind("/dead", Date.now()).first(), null, "复用判定：文件夹撤销 → 不复用");
}

/* ═══════════ 10. 文件夹直链 · 目录内文件下载查询（public.ts handleDirectFolderDownload 语义） ═══════════ */
{
  const { env, sqlite } = freshEnv();
  addDir(env, "/1234");
  addDir(env, "/1234/sub");
  addFile(env, "/1234", "lx-music-source-v6+(修复).js", 64000);
  addFile(env, "/1234", "Motrix-1.8.19-x64.exe", 65000000);
  addFile(env, "/1234/sub", "deep.txt");
  addFile(env, "/", "rootfile.bin");

  // 模拟列表页链接 /d/:token/download?p=<encodeURIComponent(rel)>，URLSearchParams 解码一次
  const lookup = async (folderPath, rel) => {
    const url = new URL("https://x/d/tok/download?p=" + encodeURIComponent(rel));
    const raw = url.searchParams.get("p");
    const fullPath = f.resolveInsideFolder(folderPath, raw);
    if (fullPath === null || fullPath === folderPath) return null;
    const lastSlash = fullPath.lastIndexOf("/");
    const parentDir = lastSlash <= 0 ? "/" : fullPath.slice(0, lastSlash);
    const baseName = fullPath.slice(lastSlash + 1);
    return env.db.prepare("SELECT id, name FROM files WHERE path = ?1 AND name = ?2")
      .bind(parentDir, baseName).first();
  };

  const hit1 = await lookup("/1234", "lx-music-source-v6+(修复).js");
  ok(hit1 && hit1.name === "lx-music-source-v6+(修复).js", "下载查询：目录+文件名拆分匹配（含 +()中文）");
  ok(await lookup("/1234", "Motrix-1.8.19-x64.exe") !== null, "下载查询：exe 文件命中");
  ok(await lookup("/1234", "sub/deep.txt") !== null, "下载查询：子目录内文件命中");
  ok(await lookup("/", "rootfile.bin") !== null, "下载查询：根目录直链 lastSlash=0 → parent='/' 命中");
  eq(await lookup("/1234", "不存在.exe"), null, "下载查询：不存在的文件 → null（404）");
  eq(await lookup("/1234", "../other.txt"), null, "下载查询：穿越路径被 resolveInsideFolder 拒绝 → null");

  // 回归护栏：旧的错误查询（把完整路径当 files.path）必须查不到 —— 证明 bug 场景真实存在过
  const oldStyle = await env.db.prepare("SELECT id FROM files WHERE path = ?1")
    .bind("/1234/lx-music-source-v6+(修复).js").first();
  eq(oldStyle, null, "回归护栏：旧查询(WHERE path=完整路径)确实查不到 → 已修复的必要性");
}

/* ═══════════ 11. 在线文本编辑 · 可编辑判定与解码（src/editable.ts） ═══════════ */
{
  const MB = 1024 * 1024;
  // —— 应可编辑 ——
  ok(ed.isEditableFile("notes.txt", "text/plain", 100), "txt + text/plain → 可编辑");
  ok(ed.isEditableFile("README.md", "text/markdown", 5000), "md → 可编辑");
  ok(ed.isEditableFile("app.js", "application/javascript", 8000), "js + javascript mime → 可编辑");
  ok(ed.isEditableFile("data.json", "application/json", 300), "json → 可编辑");
  ok(ed.isEditableFile("config.yaml", "application/octet-stream", 200), "octet-stream + yaml 扩展名 → 可编辑（扩展名兜底）");
  ok(ed.isEditableFile("Dockerfile", "application/octet-stream", 200), "无扩展名 Dockerfile → 可编辑");
  ok(ed.isEditableFile("LICENSE", "", 100), "无扩展名 LICENSE → 可编辑");
  ok(ed.isEditableFile("logo.svg", "image/svg+xml", 4000), "svg（文本本质）→ 可编辑");
  ok(ed.isEditableFile("data.csv", "", 1.5 * MB), "csv ≤ 2MB → 可编辑");
  ok(!ed.isEditableFile("noext", "application/octet-stream", 50), "无扩展名 + octet-stream → 不可编辑");

  // —— 应拒绝：类型 ——
  ok(!ed.isEditableFile("photo.jpg", "image/jpeg", 100), "image/* 一票否决（即使扩展名伪装成文本）");
  ok(!ed.isEditableFile("clip.mp4", "video/mp4", 100), "video/* → 不可编辑");
  ok(!ed.isEditableFile("song.mp3", "audio/mpeg", 100), "audio/* → 不可编辑");
  ok(!ed.isEditableFile("arch.zip", "application/zip", 100), "zip → 不可编辑");
  ok(!ed.isEditableFile("doc.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 100), "docx → 不可编辑");
  ok(!ed.isEditableFile("setup.exe", "application/x-msdownload", 100), "exe → 不可编辑");
  ok(!ed.isEditableFile("trap.txt", "image/png", 100), "png mime + .txt 扩展名 → 二进制 MIME 优先，不可编辑");
  ok(!ed.isEditableFile("virus.txt", "application/x-msdownload", 100), "exe mime + .txt 扩展名 → 不可编辑");

  // —— 应拒绝：大小 ——
  ok(!ed.isEditableFile("big.txt", "text/plain", 2 * MB + 1), "超过 2MB 上限 → 不可编辑");
  ok(ed.isEditableFile("edge.txt", "text/plain", 2 * MB), "恰好 2MB → 可编辑");
  eq(ed.checkEditable("big.txt", "text/plain", 3 * MB).reason, "too_large", "reason: too_large");
  eq(ed.checkEditable("movie.mp4", "video/mp4", 100).reason, "binary_type", "reason: binary_type");

  // —— 解码 ——
  const enc = new TextEncoder();
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...enc.encode("hello 你好")]);
  eq(ed.decodeText(bom.buffer.slice(0)).text, "hello 你好", "解码：UTF-8 BOM 被剥除");
  eq(ed.decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]).buffer).text, "hi", "解码：UTF-16LE BOM");
  eq(ed.decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]).buffer).text, "hi", "解码：UTF-16BE BOM");
  eq(ed.decodeText(enc.encode("plain").buffer.slice(0)).text, "plain", "解码：无 BOM 按 UTF-8");
  eq(ed.decodeText(enc.encode("中文内容").buffer.slice(0)).encoding, "utf-8", "解码：encoding 字段");
}

/* ═══════════ R2 Class A / Class B 操作用量统计 ═══════════ */
const CUR_MONTH = new Date().toISOString().slice(0, 7);

async function getVal(env, key) {
  const r = await env.db.prepare("SELECT value FROM settings WHERE key = ?").first(key);
  return r ? r.value : null;
}
async function readSettings(env) {
  st.invalidateSettingsCache();
  return st.getSettings(env);
}

console.log("\n[9] 本地操作记账已移除 —— 工厂不包装饰器、D1 不产生操作计数");
{
  const { env } = freshEnv();
  const { createStorageProvider } = require("./build/storage.js");
  const fakeR2 = {
    put: async () => ({ size: 1, httpEtag: "e" }),
    get: async () => null,
    head: async () => null,
    list: async () => ({ objects: [], truncated: false }),
    delete: async () => {},
  };
  const prov = await createStorageProvider({ r2: fakeR2, db: env.db }, { storageProvider: "r2" });
  eq(prov.kind, "r2", "工厂返回 R2 provider");
  ok(
    !/opstats|countedProvider/.test(fs.readFileSync("src/storage.ts", "utf8")),
    "storage.ts 不再引用计数装饰器（下列行为断言进一步印证）"
  );

  // 走一遍全部操作类型，settings 表里不应出现任何操作计数字段
  await prov.put("x", new Uint8Array([1]), {});
  await prov.get("x");
  await prov.head("x");
  await prov.list({});
  await prov.delete("x");
  eq(await getVal(env, "r2_class_a_used"), null, "put/list 之后不写 r2_class_a_used");
  eq(await getVal(env, "r2_class_b_used"), null, "get/head 之后不写 r2_class_b_used");
  eq(await getVal(env, "r2_ops_month"), null, "不再写 r2_ops_month");

  // 数据类型层面也已移除
  ok(st.addR2Ops === undefined, "settings 模块不再导出 addR2Ops");
  const s = await readSettings(env);
  ok(!("r2ClassAUsed" in s), "Settings 类型不再含 r2ClassAUsed");
  ok(!("r2ClassBUsed" in s), "Settings 类型不再含 r2ClassBUsed");
  ok(!("r2OpsMonth" in s), "Settings 类型不再含 r2OpsMonth");
  // 唯一保留的本地账仍然可用；且这是全新空库（从未保存过设置）——覆盖
  // "traffic_used_bytes 行不存在导致 UPDATE 影响 0 行、流量记不上"的旧缺陷
  eq(await getVal(env, "traffic_used_bytes"), null, "前置条件：新库没有流量计数行");
  await st.addTraffic(env, 64);
  eq(await getVal(env, "traffic_used_bytes"), "64", "新库首笔流量落库成功（addTraffic 先补行再累加）");
  await st.addTraffic(env, 36);
  eq(await getVal(env, "traffic_used_bytes"), "100", "同月继续累加 64+36=100");
}

console.log("\n[10] billing —— 官方账单接口：字段映射 / 单位换算 / 数据源降级");
{
  const bl = require("./build/billing.js");

  // ① Billable Usage API 响应解析（官方 v4 envelope）
  const resp = {
    success: true,
    errors: [],
    result: [
      { ServiceName: "R2 Class A Operations", ServiceFamilyName: "R2", PricingQuantity: 30, PricingUnit: "Requests", ConsumedQuantity: 30, ConsumedUnit: "Requests", ContractedCost: 0.000135, CumulatedPricingQuantity: 71, CumulatedContractedCost: 0.000255, BillingCurrency: "USD", BillingPeriodStart: "2026-09-23T00:00:00Z", ChargePeriodStart: "2026-09-23T00:00:00Z", ChargePeriodEnd: "2026-09-24T00:00:00Z" },
      { ServiceName: "R2 Class B Operations", ServiceFamilyName: "R2", PricingQuantity: 100, PricingUnit: "Requests", ConsumedQuantity: 100, ConsumedUnit: "Requests", ContractedCost: 0, CumulatedPricingQuantity: 223, CumulatedContractedCost: 0, BillingCurrency: "USD", ChargePeriodStart: "2026-09-23T00:00:00Z", ChargePeriodEnd: "2026-09-24T00:00:00Z" },
      { ServiceName: "R2 Storage", ServiceFamilyName: "R2", PricingQuantity: 0.002, PricingUnit: "GB-month", ConsumedQuantity: 0.002, ConsumedUnit: "GB-month", ContractedCost: 0, CumulatedPricingQuantity: 0.0063, CumulatedContractedCost: 0, BillingCurrency: "USD", ChargePeriodStart: "2026-09-23T00:00:00Z", ChargePeriodEnd: "2026-09-24T00:00:00Z" },
      { ServiceName: "Workers Standard", ServiceFamilyName: "Workers", PricingQuantity: 5, PricingUnit: "GB-seconds", ConsumedQuantity: 5, ConsumedUnit: "GB-seconds", ContractedCost: 0.5, CumulatedPricingQuantity: 9, CumulatedContractedCost: 1.25, BillingCurrency: "USD", ChargePeriodStart: "2026-09-23T00:00:00Z", ChargePeriodEnd: "2026-09-24T00:00:00Z" },
    ],
  };
  const rows = bl.parseBillableUsage(resp);
  eq(rows.length, 4, "解析出 4 行（含非 R2 产品）");
  eq(rows[0].service, "R2 Class A Operations", "ServiceName 字段映射");
  eq(rows[0].unit, "Requests", "PricingUnit 字段映射");
  eq(rows[0].cumulatedQuantity, 71, "CumulatedPricingQuantity 映射为周期累计量");
  eq(rows[0].cumulatedCost, 0.000255, "CumulatedContractedCost 映射为累计费用");
  eq(rows[0].currency, "USD", "BillingCurrency 字段映射");
  eq(bl.parseBillableUsage({}), [], "空响应 → 空数组（不抛错）");
  eq(bl.parseBillableUsage(null), [], "null 响应 → 空数组（不抛错）");
  eq(bl.parseBillableUsage(resp.result).length, 4, "兼容裸数组形态");

  // 同名 Service 多行（每日一行）→ 取最新 chargeEnd 的那行做"截止当前"累计
  const dup = [
    { ServiceName: "R2 Class A Operations", ServiceFamilyName: "R2", PricingQuantity: 1, PricingUnit: "Requests", ContractedCost: 0, CumulatedPricingQuantity: 10, CumulatedContractedCost: 0, ChargePeriodEnd: "2026-09-24T00:00:00Z" },
    { ServiceName: "R2 Class A Operations", ServiceFamilyName: "R2", PricingQuantity: 1, PricingUnit: "Requests", ContractedCost: 0, CumulatedPricingQuantity: 99, CumulatedContractedCost: 0, ChargePeriodEnd: "2026-09-25T00:00:00Z" },
  ];
  eq(bl.latestPerService(bl.parseBillableUsage(dup))[0].cumulatedQuantity, 99, "同名多行取 chargeEnd 最新的一行");

  // ② ServiceName → 指标匹配（不写死字符串，按关键词 + R2 家族校验）
  const m = bl.mapBillableRows(rows);
  eq(m.classA.service, "R2 Class A Operations", "Class A 行命中");
  eq(m.classB.service, "R2 Class B Operations", "Class B 行命中");
  eq(m.storage.service, "R2 Storage", "存储行命中");
  eq(m.currency, "USD", "币种取 BillingCurrency");
  eq(Math.round(m.costR2 * 1e6) / 1e6, 0.000255, "R2 费用只累加 R2 家族");
  eq(Math.round(m.costAccount * 1e6) / 1e6, 1.250255, "账户费用累加全部产品");
  eq(m.periodStart, "2026-09-23T00:00:00Z", "账单周期起点透传");
  eq(bl.mapBillableRows([]).rowCount, 0, "空行列表 → 无命中行");

  // ③ 单位换算：可换算才换算，不能换算返回 null（宁缺勿估）
  eq(bl.toBytes(1, "GB-month"), 1024 ** 3, "GB-month → 字节（可与 10 GB 免费额度比对）");
  eq(bl.toBytes(1, "GB"), 1024 ** 3, "GB → 字节");
  eq(bl.toBytes(512, "MB"), 512 * 1024 ** 2, "MB → 字节");
  eq(bl.toBytes(1, "furlongs"), null, "未知单位 → null");
  eq(bl.toCount(71.4, "Requests"), 71, "Requests → 整数计数");
  eq(bl.toCount(3, "GB-month"), null, "存储类单位不能被当成操作次数");

  // ③b 真实账号响应（ServiceName 带免费额度标注）—— 回归护栏
  // 操作类行名自身含 "Storage"（"R2 Storage Class A Operations"），
  // 早期实现会让「总存储」先命中 Class A 行（单位 Requests → 换算不出字节 → 降级/显示"—"）。
  const realRows = bl.parseBillableUsage({
    result: [
      { ServiceName: "R2 Storage Class A Operations (First 1M included)", ServiceFamilyName: "R2 Storage", PricingQuantity: 29, PricingUnit: "Requests", ConsumedQuantity: 29, ConsumedUnit: "Requests", ContractedCost: 0, CumulatedPricingQuantity: 29, CumulatedContractedCost: 0, BillingCurrency: "USD", BillingPeriodStart: "2026-09-01T00:00:00Z", ChargePeriodStart: "2026-09-28T00:00:00Z", ChargePeriodEnd: "2026-09-29T00:00:00Z" },
      { ServiceName: "R2 Storage Class B Operations (First 10M included)", ServiceFamilyName: "R2 Storage", PricingQuantity: 242, PricingUnit: "Requests", ConsumedQuantity: 242, ConsumedUnit: "Requests", ContractedCost: 0, CumulatedPricingQuantity: 242, CumulatedContractedCost: 0, BillingCurrency: "USD", ChargePeriodStart: "2026-09-28T00:00:00Z", ChargePeriodEnd: "2026-09-29T00:00:00Z" },
      { ServiceName: "R2 Data Storage (First 10GB-Month included)", ServiceFamilyName: "R2 Storage", PricingQuantity: 0.0061, PricingUnit: "GB-Month", ConsumedQuantity: 0.0061, ConsumedUnit: "GB-Month", ContractedCost: 0, CumulatedPricingQuantity: 0.0061, CumulatedContractedCost: 0, BillingCurrency: "USD", ChargePeriodStart: "2026-09-28T00:00:00Z", ChargePeriodEnd: "2026-09-29T00:00:00Z" },
    ],
  });
  const rm = bl.mapBillableRows(realRows);
  eq(rm.storage.service, "R2 Data Storage (First 10GB-Month included)", "真实行名：存储命中 Data Storage（不被 Class A 行抢走）");
  eq(rm.classA.service, "R2 Storage Class A Operations (First 1M included)", "真实行名：Class A 命中");
  eq(rm.classB.service, "R2 Storage Class B Operations (First 10M included)", "真实行名：Class B 命中");
  const base = {
    enabled: true, configured: true,
    cycleLabel: "September 23 - October 23",
    cycleStart: "2026-09-23T00:00:00Z", cycleEnd: "2026-10-23T00:00:00Z",
  };

  // 真实行名下的视图构建：存储必须来自官方计费接口，而不是被挤到降级路径
  const rv = bl.buildUsageView({ ...base, bill: rm, analytics: null });
  eq(rv.storage.source, "billable-usage", "真实行名：存储取自官方计费接口（不再被动降级）");
  eq(rv.storage.usedBytes, bl.toBytes(0.0061, "GB-Month"), "真实行名：GB-Month → 字节");
  eq(rv.classA.used, 29, "真实行名：Class A = 29");
  eq(rv.classB.used, 242, "真实行名：Class B = 242");

  // ③c 免费额度内的行：PricingQuantity / CumulatedPricingQuantity 是"扣免费额度后的计费量"= 0，
  //     真实消耗在 ConsumedQuantity —— 视图必须取消耗量，否则顶栏显示 0（线上实测踩坑）
  const freeRows = bl.parseBillableUsage({
    result: [
      { ServiceName: "R2 Storage Class A Operations (First 1M included)", ServiceFamilyName: "R2 Storage", PricingQuantity: 0, PricingUnit: "Requests", ConsumedQuantity: 12, ConsumedUnit: "Requests", ContractedCost: 0, CumulatedPricingQuantity: 0, CumulatedContractedCost: 0, BillingCurrency: "USD", ChargePeriodEnd: "2026-09-29T00:00:00Z" },
      { ServiceName: "R2 Data Storage (First 10GB-Month included)", ServiceFamilyName: "R2 Storage", PricingQuantity: 0, PricingUnit: "GB-Month", ConsumedQuantity: 0.0061, ConsumedUnit: "GB-Month", ContractedCost: 0, CumulatedPricingQuantity: 0, CumulatedContractedCost: 0, BillingCurrency: "USD", ChargePeriodEnd: "2026-09-29T00:00:00Z" },
    ],
  });
  const fm = bl.mapBillableRows(freeRows);
  const fv = bl.buildUsageView({ ...base, bill: fm, analytics: null });
  eq(fv.classA.used, 12, "免费额度内：计费量=0 → 取消耗量 12（而非显示 0）");
  eq(fv.storage.source, "billable-usage", "免费额度内：存储仍来自官方计费接口");
  eq(fv.storage.usedBytes, bl.toBytes(0.0061, "GB-Month"), "免费额度内：存储取消耗量换算字节");
  eq(fv.cost.r2, 0, "免费额度内费用为 0 是真实官方值，保持透传");

  // ③d 数据源优先级：官方面板同源的 Analytics 优先（窗口/口径与面板一致），
  //     计费接口行仅在 Analytics 不可用时兜底；费用仍只来自计费接口
  const vBoth = bl.buildUsageView({
    ...base, bill: rm,
    analytics: { classA: 119, classB: 253, storageBytes: 6909000, cycleLabel: "September 23 - October 23" },
  });
  eq(vBoth.classA.source, "analytics", "A 类优先取面板同源的 Analytics");
  eq(vBoth.classA.used, 119, "A 类 = 面板数值 119");
  eq(vBoth.classB.used, 253, "B 类 = 面板数值 253");
  eq(vBoth.storage.source, "analytics", "存储优先取面板同源口径");
  eq(vBoth.storage.usedBytes, 6909000, "存储 = 面板的总存储空间字节");
  eq(vBoth.cost.available, true, "费用仍来自计费接口");

  // ④ 主源：官方计费接口
  const v = bl.buildUsageView({ ...base, bill: m, analytics: null });
  eq(v.classA.source, "billable-usage", "Class A 优先取官方计费接口");
  eq(v.classA.used, 71, "Class A = 71（与官方面板一致）");
  eq(v.classB.used, 223, "Class B = 223");
  eq(Math.round(v.storage.usedBytes), Math.round(0.0063 * 1024 ** 3), "存储 GB-month 换算为字节");
  eq(v.classA.exceeded, false, "71 < 100 万 → 未超免费额度");
  eq(v.cost.available, true, "费用可用");
  eq(v.cost.currency, "USD", "币种透传");
  eq(v.cost.r2, 0.000255, "R2 金额直接来自官方 ContractedCost");

  // ⑤ 降级：计费接口没有 R2 明细 → 用同一家服务商的 R2 用量接口（仍非本地估算）
  const analytics = { classA: 5, classB: 9, storageBytes: 6600000, cycleLabel: "September 23 - October 23" };
  const workersOnly = bl.mapBillableRows(bl.parseBillableUsage({ result: [resp.result[3]] }));
  const v2 = bl.buildUsageView({ ...base, bill: workersOnly, analytics });
  eq(v2.classA.source, "analytics", "Class A 降级到 R2 用量接口");
  eq(v2.classA.used, 5, "降级后仍取官方数值（非本地估算）");
  eq(v2.classB.used, 9, "同理 Class B");
  eq(v2.storage.usedBytes, 6600000, "存储降级到 analytics 的字节口径");
  eq(v2.cost.available, true, "无 R2 明细时账户级费用依然可用");
  eq(v2.cost.r2, 0, "R2 分项费用为 0");

  // ⑥ 两个官方源都拿不到 → available=false，绝不用本地数值填充
  const v3 = bl.buildUsageView({
    enabled: true, configured: false, cycleLabel: "September 23 - October 23",
    cycleStart: null, cycleEnd: null, bill: null, analytics: null,
  });
  eq(v3.classA.available, false, "无官方数据 → Class A 标记为不可用");
  eq(v3.classB.available, false, "同理 Class B");
  eq(v3.storage.available, false, "同理存储");
  eq(v3.storage.usedBytes, null, "不可用时 storage 不返回任何字节数");
  eq(v3.classA.used, 0, "不可用量恒为 0（前端显示破折号占位）");
  eq(v3.classA.percent, null, "不可用时百分比为 null");
  eq(v3.cost.available, false, "费用不可用");
  eq(v3.cost.r2, null, "金额不做本地单价换算 → null");

  // ⑦ S3 后端：不存在 Cloudflare 账单 → 前端据此隐藏相关胶囊
  const v4 = bl.buildUsageView({ ...base, enabled: false, bill: null, analytics: null });
  eq(v4.enabled, false, "S3 后端 → usage.enabled=false");

  // ⑧ 迁移语句清理遗留的本地计数行
  const { env: envClean } = freshEnv();
  envClean.db.prepare("INSERT INTO settings(key, value) VALUES('r2_class_a_used','123')").run();
  envClean.db.prepare("INSERT INTO settings(key, value) VALUES('r2_ops_month','2026-09')").run();
  envClean.db.prepare("INSERT INTO settings(key, value) VALUES('traffic_used_bytes','7')").run();
  envClean.db.prepare("DELETE FROM settings WHERE key IN ('r2_class_a_used', 'r2_class_b_used', 'r2_ops_month')").run();
  eq(await getVal(envClean, "r2_class_a_used"), null, "迁移清理：旧 Class A 计数行被删除");
  eq(await getVal(envClean, "r2_ops_month"), null, "迁移清理：旧统计月份行被删除");
  eq(await getVal(envClean, "traffic_used_bytes"), "7", "迁移清理：流量账不受影响");
}

console.log("\n[11] addTraffic 语句顺序修复 —— 跨月清零真正生效");
{
  const { env } = freshEnv();
  // 预置：上月已用 500
  env.db.prepare("INSERT INTO settings(key, value) VALUES('traffic_used_bytes', '500')").run();
  env.db.prepare("INSERT INTO settings(key, value) VALUES('traffic_month', '2000-01')").run();

  // 跨月：本月第一次计数 → 应从 0 起算（旧实现先写月份会导致累加成 600）
  await st.addTraffic(env, 100);
  eq(await getVal(env, "traffic_used_bytes"), "100", "跨月首笔流量 = 100（重置而非 500+100）");

  // 同月累加
  await st.addTraffic(env, 50);
  eq(await getVal(env, "traffic_used_bytes"), "150", "同月累加 100+50=150");
  const ts = await env.db.prepare("SELECT bytes, downloads FROM traffic_stats WHERE day = ?").first(new Date().toISOString().slice(0, 10));
  eq(ts, { bytes: 150, downloads: 2 }, "traffic_stats 每日汇总正确");
}

console.log("\n[12] cfusage —— 官方用量对接：actionType 分类 / 账单周期 / GraphQL 响应解析");
{
  const cf = require("./build/cfusage.js");

  // ① actionType → Class A / B 分类（对齐 Cloudflare 计费口径）
  for (const a of ["PutObject", "CopyObject", "ListObjects", "CreateMultipartUpload", "UploadPart", "ListParts", "PutBucketCors"])
    eq(cf.classifyAction(a), "a", `classifyAction(${a}) = Class A`);
  for (const a of ["GetObject", "HeadObject", "HeadBucket"])
    eq(cf.classifyAction(a), "b", `classifyAction(${a}) = Class B`);
  for (const a of ["DeleteObject", "DeleteObjects", "AbortMultipartUpload", "UnknownAction"])
    eq(cf.classifyAction(a), null, `classifyAction(${a}) = 不计费`);

  // ② 账单周期（对齐官方面板 "September 23 - October 23" 的口径）
  const inCycle = cf.billingCycleRange(23, new Date("2026-09-29T10:00:00Z"));
  eq(inCycle.start.toISOString().slice(0, 10), "2026-09-23", "9/29 且 cycleDay=23 → 周期从本月 23 日起");
  eq(inCycle.end.toISOString().slice(0, 10), "2026-10-23", "周期终点 = 下月 23 日");
  eq(inCycle.label, "September 23 - October 23", "周期标签与官方面板一致");
  const beforeCycle = cf.billingCycleRange(23, new Date("2026-09-15T00:00:00Z"));
  eq(beforeCycle.start.toISOString().slice(0, 10), "2026-08-23", "9/15 < 23 → 周期从上月 23 日起");
  const natural = cf.billingCycleRange(1, new Date("2026-09-29T00:00:00Z"));
  eq(natural.start.toISOString().slice(0, 10), "2026-09-01", "cycleDay=1 → 自然月");
  eq(cf.billingCycleRange(31).start.getUTCDate(), 28, "cycleDay 31 clamp 到 28（短月安全）");
  eq(cf.billingCycleRange(0).start.getUTCDate(), 1, "cycleDay 0 → 回退 1");

  // ③ GraphQL 响应解析：模拟官方面板截图数值（A=71 / B=223 / 总存储 6.6 MB）
  const mockResp = {
    data: { viewer: { accounts: [{
      r2OperationsAdaptiveGroups: [
        { dimensions: { actionType: "PutObject" }, sum: { requests: 30 } },
        { dimensions: { actionType: "ListObjects" }, sum: { requests: 41 } },
        { dimensions: { actionType: "GetObject" }, sum: { requests: 200 } },
        { dimensions: { actionType: "HeadObject" }, sum: { requests: 23 } },
        { dimensions: { actionType: "DeleteObject" }, sum: { requests: 999 } }, // 免费，不累加
      ],
      r2StorageAdaptiveGroups: [
        { dimensions: { datetimeHour: "2026-09-29T08:00:00Z" }, max: { payloadSize: 6920601.6, metadataSize: 0 } },
      ],
    }] } },
  };
  // 让数值凑整：改用精确数
  mockResp.data.viewer.accounts[0].r2StorageAdaptiveGroups[0].max.payloadSize = 6600000;
  const u = cf.parseOfficialUsage(mockResp, "September 23 - October 23");
  eq(u.classA, 71, "官方响应解析 Class A = 30+41 = 71（Delete 999 不计入）");
  eq(u.classB, 223, "官方响应解析 Class B = 200+23 = 223");
  eq(u.storageBytes, 6600000, "存储 = payloadSize + metadataSize");
  eq(u.cycleLabel, "September 23 - October 23", "周期标签透传");
  eq(cf.parseOfficialUsage({ errors: [{ message: "bad token" }] }, ""), null, "GraphQL errors → null（回退自记账）");
  eq(cf.parseOfficialUsage({ data: { viewer: { accounts: [] } } }, ""), null, "无 accounts → null");
  eq(cf.parseOfficialUsage({}, ""), null, "空数据（无 accounts）→ null 回退自记账，不抛错");

  // ④ settings：billing_cycle_day 读取 clamp（1-28）
  const { env: env4 } = freshEnv();
  env4.db.prepare("INSERT INTO settings(key, value) VALUES('billing_cycle_day', '99')").run();
  const s4 = await readSettings(env4);
  eq(s4.billingCycleDay, 28, "billing_cycle_day=99 → clamp 28");
  env4.db.prepare("UPDATE settings SET value = '0' WHERE key = 'billing_cycle_day'").run();
  eq((await readSettings(env4)).billingCycleDay, 1, "billing_cycle_day=0 → 回退 1");
}

console.log("\n[13] usage/diag —— 连接诊断：错误提取 / 未配置短路 / 账户 ID 格式校验");
{
  const bl = require("./build/billing.js");

  // ① v4 envelope errors → 可读消息
  eq(bl.extractErrors({ errors: [{ message: "Authentication error", code: 1000 }] }),
    ["Authentication error (code 1000)"], "extractErrors：message + code 拼接");
  eq(bl.extractErrors({ errors: [] }), [], "extractErrors：空 errors → 空数组");
  eq(bl.extractErrors(null), [], "extractErrors：null 响应不抛错");
  eq(bl.extractErrors({}), [], "extractErrors：无 errors 字段 → 空数组");

  // ④ 账单周期自校准：官方 BillingPeriodStart 才是权威周期（设置可能填错）
  eq(bl.detectCycleDay("2026-09-23T00:00:00Z"), 23, "BillingPeriodStart 9/23 → 周期日 23");
  eq(bl.detectCycleDay("2026-09-01T00:00:00Z"), 1, "周期日 1 合法");
  eq(bl.detectCycleDay(null), null, "无 periodStart → null");
  eq(bl.detectCycleDay("not-a-date"), null, "无法解析 → null");
  eq(bl.detectCycleDay("2026-09-31T00:00:00Z"), null, "非法日期 → null");

  // ⑤ 未配置 Token：短路返回，不发起任何网络请求（fetch 被替换成炸弹验证）
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("网络请求不应发生"); };
  try {
    const { env: envD } = freshEnv();
    const noToken = {
      storageProvider: "r2",
      cfAccountId: "a".repeat(32),
      cfApiTokenCipher: null,
      billingCycleDay: 23,
    };
    const r = await bl.diagnoseUsage(envD, noToken);
    eq(r.account_id_format_ok, true, "32 位 hex Account ID → 格式通过");
    eq(r.token_configured, false, "未配置 Token → token_configured=false");
    eq(r.token_verify.message, "token_missing_or_decrypt_failed", "未配置 → 短路消息");
    eq(r.cycle.start.length, 10, "周期起点为 YYYY-MM-DD（billable-usage 参数格式）");

    // ③ Account ID 格式校验：仪表盘截断值（非 32 位）应被标记
    const r2 = await bl.diagnoseUsage(envD, { ...noToken, cfAccountId: "ada2381253cac9e69c" });
    eq(r2.account_id_format_ok, false, "18 位截断 Account ID → 格式校验失败");
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log(`\n══════════ 结果: ${passed} 通过, ${failed} 失败 ══════════`);
process.exit(failed > 0 ? 1 : 0);
