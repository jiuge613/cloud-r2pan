/**
 * 文件夹管理 + 文件夹直链 行为断言测试
 * 运行: node --experimental-sqlite _test/run.mjs
 * 说明: 用 node:sqlite 构造 D1 兼容 mock，对编译后的 folders.js 做真实 SQL 行为验证。
 */
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const f = require("./build/folders.js");
const ed = require("./build/editable.js");
const st = require("./build/settings.js");
const ops = require("./build/opstats.js");

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

console.log("\n[9] addR2Ops —— 月度计数累加 / 跨月重置 / 首次写入");
{
  const { env } = freshEnv();

  // 首次计数：settings 行不存在 → INSERT 分支直接写入
  await st.addR2Ops(env, 3, 5);
  eq(await getVal(env, "r2_class_a_used"), "3", "首次 Class A 计数 = 3");
  eq(await getVal(env, "r2_class_b_used"), "5", "首次 Class B 计数 = 5");
  eq(await getVal(env, "r2_ops_month"), CUR_MONTH, "统计月份 = 当月");

  // 同月累加
  await st.addR2Ops(env, 2, 7);
  eq(await getVal(env, "r2_class_a_used"), "5", "同月 Class A 累加 3+2=5");
  eq(await getVal(env, "r2_class_b_used"), "12", "同月 Class B 累加 5+7=12");

  // 零增量不写库
  await st.addR2Ops(env, 0, 0);
  eq(await getVal(env, "r2_class_a_used"), "5", "零增量无副作用");

  // 跨月重置：把月份拨回过去，再计数 → 从增量起算（不是累加旧值）
  env.db.prepare("UPDATE settings SET value = '2000-01' WHERE key = 'r2_ops_month'").run();
  await st.addR2Ops(env, 100, 200);
  eq(await getVal(env, "r2_class_a_used"), "100", "跨月 Class A 重置为增量 100");
  eq(await getVal(env, "r2_class_b_used"), "200", "跨月 Class B 重置为增量 200");
  eq(await getVal(env, "r2_ops_month"), CUR_MONTH, "统计月份已同步到当月");

  // getSettings 内存兜底：DB 月份停在旧月 → 读取即归零
  const { env: env2 } = freshEnv();
  await st.addR2Ops(env2, 42, 43);
  env2.db.prepare("UPDATE settings SET value = '1999-12' WHERE key = 'r2_ops_month'").run();
  const s2 = await readSettings(env2);
  eq(s2.r2ClassAUsed, 0, "getSettings 跨月兜底：Class A 读取为 0");
  eq(s2.r2ClassBUsed, 0, "getSettings 跨月兜底：Class B 读取为 0");
  const s3 = await readSettings(env2);
  eq(s3.r2OpsMonth, CUR_MONTH, "跨月兜底后 r2OpsMonth 返回当月（与 trafficMonth 行为一致）");
}

console.log("\n[10] countedProvider —— Class A/B 分类计数、实时落库与节流");
{
  const { env } = freshEnv();
  const calls = [];
  const fake = {
    kind: "r2",
    async put(k, b, o) { calls.push(["put", k]); if (o && o.throwIt) throw new Error("boom"); return { size: 1 }; },
    async get(k) { calls.push(["get", k]); return null; },
    async head(k) { calls.push(["head", k]); return null; },
    async list(o) { calls.push(["list", o?.prefix ?? ""]); return { entries: [], truncated: false }; },
    async delete(k) { calls.push(["delete", k]); },
  };
  const p = ops.countedProvider(env, fake);

  // ── 干净起点：清空遗留 pending，并跨过节流窗口（MIN_FLUSH_INTERVAL_MS = 1500） ──
  await ops.flushR2Ops(env);
  await new Promise((r) => setTimeout(r, 1600));

  // ① 核心回归：**单次**上传就必须落库。
  //    旧策略（内存攒够 10 次 + 15s 定时器）下此断言必失败——那正是
  //    线上"上传了文件但标题栏写入量一直是 0"的根因（跨 isolate 攒不够、
  //    定时器在 Workers 里不保证触发）。
  await p.put("a.txt", new Uint8Array([1]), {});
  eq(await getVal(env, "r2_class_a_used"), "1", "单次 put 立即落库（Class A +1，看板可实时感知）");

  // ② 节流窗口内的连续读取 → 合并写盘，不逐次打 D1（成本保护仍在）
  for (let i = 0; i < 4; i++) await p.get("a.txt");
  // ① 已写入过一次 → b 计数行存在且为 "0"（addR2Ops 同时 upsert 两个计数列）
  const bBefore = await getVal(env, "r2_class_b_used");
  eq(bBefore, "0", "节流窗口内的读取合并累积，未逐次写库");
  await ops.flushR2Ops(env); // 手动取出 pending
  eq(await getVal(env, "r2_class_b_used"), "4", "Class B = 4 次 get（合并计数不丢失）");

  // ③ head / list / delete 的分类正确性
  await p.head("a.txt");            // Class B
  await p.list({ prefix: "d/" });   // Class A
  await p.delete("a.txt");          // 删除免费，不计数
  await ops.flushR2Ops(env);
  eq(await getVal(env, "r2_class_a_used"), "2", "Class A = put + list = 2 次");
  eq(await getVal(env, "r2_class_b_used"), "5", "Class B = get×4 + head = 5 次");
  eq(calls.length, 8, "全部 8 次调用都透传给底层 provider");
  ok(calls.some(c => c[0] === "delete"), "delete 正常透传（免费不计入统计）");

  // ④ 累计满阈值（FLUSH_THRESHOLD = 25）→ 无视节流窗口立即自动落库
  await ops.flushR2Ops(env);
  for (let i = 0; i < 25; i++) await p.get("b.txt");
  // ⑤ 底层操作失败同样计入用量（R2 对失败的 Get/Put 也计操作次数），
  //    且异常必须原样透传给调用方，不能被记账逻辑吞掉
  await ops.flushR2Ops(env);
  const aBefore = Number(await getVal(env, "r2_class_a_used"));
  let threw = null;
  try { await p.put("boom.txt", new Uint8Array([1]), { throwIt: true }); } catch (e) { threw = e; }
  ok(threw instanceof Error, "底层 put 抛错时异常原样透传");
  await ops.flushR2Ops(env);
  eq(Number(await getVal(env, "r2_class_a_used")), aBefore + 1, "失败的 put 同样计入 Class A");

  // 覆盖性：createStorageProvider 工厂返回的 provider 已包计数装饰器
  const { createStorageProvider } = require("./build/storage.js");
  const { env: env3 } = freshEnv();
  const fakeR2 = {
    put: async () => ({ size: 1, httpEtag: "e" }),
    get: async () => null,
    head: async () => null,
    list: async () => ({ objects: [], truncated: false }),
    delete: async () => {},
  };
  const prov = await createStorageProvider({ r2: fakeR2, db: env3.db }, { storageProvider: "r2" });
  eq(prov.kind, "r2", "工厂返回 R2 provider");
  await prov.put("x", new Uint8Array([1]), {});
  ok(prov.put !== fakeR2.put, "工厂产物已被计数装饰器包装");
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

console.log(`\n══════════ 结果: ${passed} 通过, ${failed} 失败 ══════════`);
process.exit(failed > 0 ? 1 : 0);
