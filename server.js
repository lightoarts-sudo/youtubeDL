const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_CLIP_SECONDS = 60 * 60;
let activeDownload = false;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function findExecutable() {
  const fileCandidates = [
    process.env.YT_DLP_PATH,
    path.join(
      process.env.LOCALAPPDATA || "",
      "Microsoft", "WinGet", "Packages",
      "yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe",
      "yt-dlp.exe",
    ),
  ].filter(Boolean);
  const installedFile = fileCandidates.find((candidate) => fs.existsSync(candidate));
  if (installedFile) return installedFile;
  const where = spawnSync("where.exe", ["yt-dlp"], { encoding: "utf8", windowsHide: true });
  return where.status === 0 ? where.stdout.trim().split(/\r?\n/)[0] : null;
}

const YT_DLP = findExecutable();

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return url.protocol.startsWith("http") && ["youtube.com", "m.youtube.com", "youtu.be"].includes(host);
  } catch {
    return false;
  }
}

function safeFilename(value) {
  return (value || "youtube-clip")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90) || "youtube-clip";
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 32_000) reject(new Error("Request is too large."));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function runYtDlp(args) {
  return new Promise((resolve) => {
    const child = spawn(YT_DLP, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => resolve({ code: -1, stdout, stderr, error }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function errorMessage(stderr) {
  const detail = stderr.toLowerCase();
  if (detail.includes("could not copy chrome cookie database")) {
    return "Chrome 正在使用 cookie 資料庫。請完全關閉 Chrome 後再下載受限影片。";
  }
  if (detail.includes("sign in to confirm") || detail.includes("not a bot")) {
    return "YouTube 要求登入驗證。請確認 Chrome 已登入 YouTube，完全關閉 Chrome 後重試。";
  }
  if (detail.includes("private video")) return "這是私人影片，目前登入的 Chrome 帳號沒有觀看權限。";
  if (detail.includes("members-only")) return "這是會員影片，目前登入的 Chrome 帳號沒有觀看權限。";
  if (detail.includes("ffmpeg")) return "找不到 ffmpeg，請重新執行本機安裝。";
  if (detail.includes("requested format is not available")) return "YouTube 暫時沒有提供可下載格式，請稍後重試。";
  return "影片下載失敗。請確認影片可播放，或完全關閉 Chrome 後重試。";
}

async function downloadClip(req, res) {
  if (activeDownload) return json(res, 429, { error: "目前有另一個片段正在處理，請稍後再試。" });
  if (!YT_DLP) return json(res, 503, { error: "尚未安裝 yt-dlp，請執行 start-local.cmd。" });

  let payload;
  try {
    payload = JSON.parse(await collectBody(req));
  } catch {
    return json(res, 400, { error: "無法讀取下載設定。" });
  }

  const url = String(payload.url || "");
  const start = Number(payload.start);
  const end = Number(payload.end);
  if (!isYouTubeUrl(url)) return json(res, 400, { error: "請輸入有效的 YouTube 連結。" });
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    return json(res, 400, { error: "結束時間必須晚於開始時間。" });
  }
  if (end - start > MAX_CLIP_SECONDS) return json(res, 400, { error: "單次下載片段最多 60 分鐘。" });

  const jobDir = path.join(os.tmpdir(), `yt-clip-${randomUUID()}`);
  const outputTemplate = path.join(jobDir, "clip.%(ext)s");
  await fs.promises.mkdir(jobDir, { recursive: true });
  activeDownload = true;

  const baseArgs = [
    "--no-playlist", "--no-warnings",
    "--download-sections", `*${start.toFixed(3)}-${end.toFixed(3)}`,
    "--force-keyframes-at-cuts",
    "--merge-output-format", "mp4",
    "--format", "bv*+ba/b",
    "--output", outputTemplate,
    "--print", "after_move:filepath",
    url,
  ];

  const cleanup = () => {
    activeDownload = false;
    return fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  };

  let result = await runYtDlp(baseArgs);
  const needsLogin = /sign in|not a bot|private video|members-only|age-restricted/i.test(result.stderr);
  if (result.code !== 0 && needsLogin) {
    result = await runYtDlp(["--cookies-from-browser", "chrome", ...baseArgs]);
  }

  if (result.code !== 0) {
    await cleanup();
    return json(res, result.error?.code === "ENOENT" ? 503 : 422, { error: errorMessage(result.stderr) });
  }

  const reportedPath = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
  let filePath = reportedPath && path.resolve(reportedPath);
  if (!filePath || !filePath.startsWith(path.resolve(jobDir)) || !fs.existsSync(filePath)) {
    const files = await fs.promises.readdir(jobDir);
    filePath = files.length ? path.join(jobDir, files[0]) : null;
  }
  if (!filePath || !fs.existsSync(filePath)) {
    await cleanup();
    return json(res, 500, { error: "影片處理完成，但找不到輸出檔案。" });
  }

  const filename = `${safeFilename(payload.title)}_${Math.floor(start)}-${Math.floor(end)}.mp4`;
  const size = (await fs.promises.stat(filePath)).size;
  res.writeHead(200, {
    "Content-Type": "video/mp4",
    "Content-Length": size,
    "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res).on("finish", cleanup);
}

function serveStatic(req, res) {
  const requestPath = req.url === "/" ? "/index.html" : new URL(req.url, "http://localhost").pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${requestPath}`);
  if (!filePath.startsWith(path.resolve(PUBLIC_DIR))) return json(res, 403, { error: "Forbidden" });
  fs.readFile(filePath, (error, content) => {
    if (error) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    return json(res, 200, { status: "ok", ytDlp: Boolean(YT_DLP), mode: "local" });
  }
  if (req.method === "POST" && req.url === "/api/download") return downloadClip(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  json(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, HOST, () => {
  console.log(`Framecut running at http://${HOST}:${PORT}`);
});
