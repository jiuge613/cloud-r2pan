import type { Env } from "./types";

/**
 * 在线文本编辑 —— 纯函数模块（零依赖，风格与 folders.ts 一致）
 *
 * 判定规则（供 GET/PUT /api/admin/files/:id/content 双端强制校验）：
 *   1. 大小上限：MAX_TEXT_EDIT_BYTES（默认 2 MB，避免 Worker 内存与浏览器卡顿）
 *   2. 二进制 MIME 一票否决（image/* video/* audio/* 压缩包等，即使扩展名像文本）
 *   3. MIME 以 text/ 开头，或扩展名在白名单内 → 可编辑
 *
 * 编码策略：
 *   读取时按 BOM 识别 UTF-8 / UTF-16LE / UTF-16BE 并解码；
 *   保存时统一以 UTF-8（无 BOM）写回 —— 内容不丢，编码规范化。
 */

/** 单文件在线编辑大小上限（字节）：2 MB */
export const MAX_TEXT_EDIT_BYTES = 2 * 1024 * 1024;

/** 明确的二进制 MIME 前缀/全名 —— 一票否决（优先级高于扩展名白名单） */
const BINARY_MIME_PREFIXES = ["image/", "video/", "audio/"];
const BINARY_MIME_EXACT = new Set([
  "application/zip", "application/gzip", "application/x-tar", "application/x-7z-compressed",
  "application/x-rar-compressed", "application/vnd.rar", "application/pdf",
  // 注意：application/octet-stream 不否决（很多文本上传被标成它，交给扩展名判断）
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/x-msdownload", "application/x-executable", "application/x-iso9660-image",
  "application/vnd.android.package-archive",
]);

/** 可编辑扩展名白名单（小写、不含点） */
const TEXT_EXTS = new Set([
  // 通用文本
  "txt", "text", "log", "nfo", "srt", "vtt", "csv", "tsv",
  // 标记 / 文档
  "md", "markdown", "mdx", "rst", "adoc", "org", "tex", "html", "htm", "xhtml", "xml", "svg",
  // 数据 / 配置
  "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "properties", "env",
  "editorconfig", "gitignore", "gitattributes", "npmrc", "babelrc", "prettierrc", "eslintrc",
  // 脚本 / 程序源码
  "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx",
  "css", "scss", "sass", "less", "styl",
  "sh", "bash", "zsh", "fish", "bat", "cmd", "ps1", "psm1",
  "py", "pyw", "rb", "pl", "lua", "php", "phtml",
  "go", "rs", "java", "kt", "kts", "scala", "groovy", "gradle",
  "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "cs", "m", "mm",
  "swift", "dart", "vue", "svelte", "astro",
  "sql", "r", "jl", "ex", "exs", "erl", "hrl", "clj", "cljs", "hs", "ml", "fs", "fsx",
  "vb", "vbs", "asm", "s", "sol", "zig", "nim", "cr", "v", "odin",
  // 构建 / 其他
  "makefile", "cmake", "dockerfile", "ipynb", "lock", "diff", "patch", "graphql", "gql", "proto", "prisma",
]);

/** 无扩展名的常见文本文件名（小写全名） */
const TEXT_BASENAMES = new Set([
  "makefile", "dockerfile", "cmakelists.txt", "license", "licence", "readme", "changelog",
  "authors", "contributors", "notice", "version", "todo", "install", "uninstall",
]);

/** 取小写扩展名 */
export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

/** 是否文本类 MIME（不含一票否决判断） */
export function isTextMime(mime: string | null | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase().split(";")[0].trim();
  if (m.startsWith("text/")) return true;
  const TEXT_MIMES = new Set([
    "application/json", "application/json5", "application/ld+json",
    "application/javascript", "application/x-javascript", "application/ecmascript",
    "application/typescript", "application/xml", "application/xhtml+xml", "application/atom+xml",
    "application/rss+xml", "application/x-yaml", "application/yaml", "application/toml",
    "application/x-sh", "application/x-shellscript", "application/sql",
    "application/x-httpd-php", "application/x-perl", "application/x-python",
    "application/x-latex",
    "application/graphql", "application/x-ndjson", "application/ndjson",
    "application/rss", "application/x-www-form-urlencoded",
  ]);
  if (TEXT_MIMES.has(m)) return true;
  // +xml / +json 后缀的注册子类型（如 image/svg+xml 已被前缀否决，application/rss+xml 命中上面）
  return /\+(xml|json)$/.test(m);
}

export interface EditableCheck {
  editable: boolean;
  /** 不可编辑的原因（用于 415 提示），可编辑时为 null */
  reason: "too_large" | "binary_type" | null;
}

/**
 * 判定文件是否适合在线编辑。
 * 规则顺序：大小 → 二进制 MIME 一票否决 → text/* MIME → 扩展名/文件名白名单。
 * mime 为 octet-stream 等未知类型时，交给扩展名判断（很多上传的文本被标成通用二进制）。
 */
export function checkEditable(name: string, mime: string | null | undefined, size: number): EditableCheck {
  if (size > MAX_TEXT_EDIT_BYTES) return { editable: false, reason: "too_large" };
  const m = (mime ?? "").toLowerCase().split(";")[0].trim();
  if (m) {
    if (BINARY_MIME_PREFIXES.some((p) => m.startsWith(p)) || BINARY_MIME_EXACT.has(m)) {
      // image/svg+xml 例外：svg 本质是文本
      if (!(m === "image/svg+xml" || m.startsWith("image/svg"))) {
        return { editable: false, reason: "binary_type" };
      }
    }
  }
  if (isTextMime(m)) return { editable: true, reason: null };
  const ext = extOf(name);
  if (TEXT_EXTS.has(ext)) return { editable: true, reason: null };
  const base = (name || "").toLowerCase();
  if (!ext && TEXT_BASENAMES.has(base)) return { editable: true, reason: null };
  return { editable: false, reason: "binary_type" };
}

/** 便捷封装：只关心是/否 */
export function isEditableFile(name: string, mime: string | null | undefined, size: number): boolean {
  return checkEditable(name, mime, size).editable;
}

export interface DecodedText {
  text: string;
  /** 源编码（保存时统一写回 UTF-8，此字段仅用于提示） */
  encoding: "utf-8" | "utf-16le" | "utf-16be";
}

/**
 * 解码文本内容：按 BOM 识别 UTF-8 / UTF-16LE / UTF-16BE，无 BOM 按 UTF-8 宽松解码。
 * UTF-8 BOM 会被剥掉（保存时写回无 BOM UTF-8）。
 */
export function decodeText(buf: ArrayBuffer): DecodedText {
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(bytes.subarray(2)), encoding: "utf-16le" };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(bytes.subarray(2)), encoding: "utf-16be" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8" };
  }
  return { text: new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes), encoding: "utf-8" };
}
