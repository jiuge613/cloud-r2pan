import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { folderListPage } = require("./build2/pages.js");

let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log("  ✓ " + m); } else { failed++; console.error("  ✗ FAIL: " + m); } };

const req = new Request("https://demo.example.com/d/abc123?p=%2F2024", { headers: { "accept-language": "zh-CN" } });
const resp = folderListPage(req, {
  siteTitle: 'my<pan>',
  token: "abc123",
  folderPath: "/photos",
  displayName: "我的照片",
  currentPath: "/photos/2024",
  folders: [{ name: '冬"季', sub: "/2024/冬\"季" }],
  files: [
    { name: "<img>.jpg", size: 1536, mime: "image/jpeg", sub: "/2024/<img>.jpg" },
    { name: "a%b.txt", size: 10, mime: "text/plain", sub: "/2024/a%b.txt" },
  ],
  expiresAt: Date.now() + 86400000,
  maxDownloads: 100,
  downloadCount: 3,
});

const html = await resp.text();
ok(resp.status === 200, "HTTP 200");
ok(html.includes("<title>我的照片 · my&lt;pan&gt;</title>"), "标题 + 站点名转义");
ok(!html.includes("<img>.jpg</span>") || !html.includes("<<img>.jpg"), "占位");
ok(html.includes("&lt;img&gt;.jpg"), "文件名 XSS 转义");
ok(html.includes("/d/abc123/download?p=%2F2024%2F%3Cimg%3E.jpg"), "下载链接编码正确");
ok(html.includes("/d/abc123?p=%2F2024%2F%E5%86%AC%22%E5%AD%A3"), "子目录链接编码正确");
ok(html.includes("剩余下载 97 次"), "剩余次数文案");
ok(html.includes("Powered by my&lt;pan&gt;"), "品牌行转义");
ok(!/href="[^"]*"(?=[^<]*<img>)/.test(html.replace(/&lt;/g, "")), "无未转义注入");
ok(html.includes("该文件夹为空") === false, "非空态");
ok(html.includes("1.50 KB"), "文件大小格式化");

// 空文件夹（无语言头 → 默认英文）
const resp2 = folderListPage(new Request("https://x/d/t"), {
  siteTitle: "s", token: "t", folderPath: "/empty", displayName: "empty",
  currentPath: "/empty", folders: [], files: [],
  expiresAt: null, maxDownloads: null, downloadCount: 0,
});
const html2 = await resp2.text();
ok(html2.includes("This folder is empty"), "空文件夹空态文案（默认英文）");

console.log(`\n══ folderListPage: ${passed} 通过, ${failed} 失败 ══`);
process.exit(failed ? 1 : 0);
