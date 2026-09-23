/**
 * 文件夹管理 + 文件夹直链 行为断言测试
 * 运行: node --experimental-sqlite _test/run.mjs
 * 说明: 用 node:sqlite 构造 D1 兼容 mock，对编译后的 folders.js 做真实 SQL 行为验证。
 */
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(import.meta.url);
const f = require("./build/folders.js");

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

console.log(`\n══════════ 结果: ${passed} 通过, ${failed} 失败 ══════════`);
process.exit(failed > 0 ? 1 : 0);
