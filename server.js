const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_CLIP_SECONDS = 60 * 60;
const YT_DLP = process.env.YT_DLP_PATH || "yt-dlp";
let activeDownload = false;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return ["youtube.com", "m.youtube.com", "youtu.be"].includes(host);
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

async function downloadClip(req, res) {
  if (activeDownload) {
    return json(res, 429, { error: "目前有另一個片段正在處理，請稍後再試。" });
  }

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
  if (end - start > MAX_CLIP_SECONDS) {
    return json(res, 400, { error: "單次下載片段最多 60 分鐘。" });
  }

  const jobDir = path.join(os.tmpdir(), `yt-clip-${randomUUID()}`);
  const outputTemplate = path.join(jobDir, "clip.%(ext)s");
  await fs.promises.mkdir(jobDir, { recursive: true });
  activeDownload = true;

  const args = [
    "--no-playlist",
    "--no-warnings",
    "--download-sections", `*${start.toFixed(3)}-${end.toFixed(3)}`,
    "--force-keyframes-at-cuts",
    "--merge-output-format", "mp4",
    "--format", "bv*+ba/b",
    "--output", outputTemplate,
    "--print", "after_move:filepath",
    url,
  ];

  const process = spawn(YT_DLP, args, { windowsHide: true });
  let stdout = "";
  let stderr = "";
  process.stdout.on("data", (data) => { stdout += data; });
  process.stderr.on("data", (data) => { stderr += data; });

  const cleanup = () => {
    activeDownload = false;
    return fs.promises.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  };
  res.on("close", () => {
    if (!res.writableEnded && !process.killed) process.kill();
  });

  process.on("error", async (error) => {
    await cleanup();
    if (error.code === "ENOENT") {
      return json(res, 503, { error: "伺服器尚未安裝 yt-dlp。請先依 README 完成安裝。" });
    }
    return json(res, 500, { error: "無法啟動下載工具。" });
  });

  process.on("close", async (code) => {
    if (res.writableEnded) return cleanup();
    if (code !== 0) {
      await cleanup();
      const detail = /ffmpeg/i.test(stderr)
        ? "伺服器需要安裝 ffmpeg 才能裁切影片。"
        : "YouTube 無法提供此影片，可能是私人、受限或連結已失效。";
      return json(res, 422, { error: detail });
    }

    const reportedPath = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
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
  });
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
    return json(res, 200, { status: "ok" });
  }
  if (req.method === "POST" && req.url === "/api/download") return downloadClip(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  json(res, 405, { error: "Method not allowed" });
});

server.listen(PORT, () => {
  console.log(`YouTube Clipper running at http://localhost:${PORT}`);
});
