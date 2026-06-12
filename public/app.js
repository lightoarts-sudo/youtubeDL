const $ = (selector) => document.querySelector(selector);
const elements = {
  url: $("#url"), load: $("#load"), error: $("#url-error"), empty: $("#empty-state"), player: $("#player"),
  startTime: $("#start-time"), endTime: $("#end-time"), startRange: $("#start-range"), endRange: $("#end-range"),
  fill: $("#range-fill"), durationLabel: $("#duration-label"), clipDuration: $("#clip-duration"),
  setStart: $("#set-start"), setEnd: $("#set-end"), preview: $("#preview"), download: $("#download"),
  downloadMeta: $("#download-meta"), status: $("#status"), progressPanel: $("#progress-panel"),
  progressStage: $("#progress-stage"), progressPercent: $("#progress-percent"), progressBar: $("#progress-bar"),
  historyList: $("#history-list"), clearHistory: $("#clear-history"),
};

const HISTORY_KEY = "framecut-download-history-v1";
let player;
let duration = 0;
let title = "YouTube 影片";
let previewTimer;
let apiReady = false;
window.onYouTubeIframeAPIReady = () => { apiReady = true; };

function videoIdFromUrl(value) {
  try {
    const url = new URL(value.trim());
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return url.pathname.split("/")[1];
    if (["youtube.com", "m.youtube.com"].includes(host)) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      return url.pathname.match(/^\/(shorts|embed|live)\/([^/?]+)/)?.[2] || null;
    }
  } catch {}
  return null;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseTime(value) {
  const parts = value.trim().split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) return NaN;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : NaN;
}

function selectedTimes() { return { start: Number(elements.startRange.value), end: Number(elements.endRange.value) }; }

function updateSelection(source) {
  let { start, end } = selectedTimes();
  if (source === "start" && start > end - 1) start = Math.max(0, end - 1);
  if (source === "end" && end < start + 1) end = Math.min(duration, start + 1);
  elements.startRange.value = start;
  elements.endRange.value = end;
  elements.startTime.value = formatTime(start);
  elements.endTime.value = formatTime(end);
  elements.clipDuration.textContent = formatTime(end - start);
  elements.fill.style.left = `${duration ? start / duration * 100 : 0}%`;
  elements.fill.style.width = `${duration ? (end - start) / duration * 100 : 0}%`;
  elements.downloadMeta.textContent = `${formatTime(start)} — ${formatTime(end)} · MP4`;
}

function setStatus(message, isError = false) {
  elements.status.textContent = message;
  elements.status.style.color = isError ? "#a32b16" : "#4f7042";
  elements.status.classList.toggle("show", Boolean(message));
}

function setProgress(stage, percent) {
  const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  elements.progressPanel.hidden = false;
  elements.progressStage.textContent = stage;
  elements.progressPercent.textContent = `${value}%`;
  elements.progressBar.style.width = `${value}%`;
}

function readHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; } catch { return []; }
}

function saveHistory(item) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify([item, ...readHistory()].slice(0, 30)));
  renderHistory();
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function renderHistory() {
  const history = readHistory();
  elements.clearHistory.disabled = history.length === 0;
  if (!history.length) {
    elements.historyList.innerHTML = '<div class="history-empty">尚無下載紀錄。完成的影片片段會顯示在這裡。</div>';
    return;
  }
  elements.historyList.innerHTML = history.map((item) => `
    <article class="history-item">
      <div class="history-status ${item.status}">${item.status === "success" ? "完成" : "失敗"}</div>
      <div class="history-info"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.range)} · ${escapeHtml(item.date)}</p>${item.error ? `<small>${escapeHtml(item.error)}</small>` : ""}</div>
      <div class="history-size">${item.size || "—"}</div>
    </article>`).join("");
}

function onPlayerReady(event) {
  duration = event.target.getDuration();
  title = event.target.getVideoData().title || "YouTube 影片";
  elements.startRange.max = duration;
  elements.endRange.max = duration;
  elements.startRange.value = 0;
  elements.endRange.value = duration;
  elements.durationLabel.textContent = formatTime(duration);
  elements.preview.disabled = false;
  elements.download.disabled = false;
  updateSelection();
}

function loadVideo() {
  const id = videoIdFromUrl(elements.url.value);
  elements.error.textContent = "";
  setStatus("");
  if (!id) return void (elements.error.textContent = "請輸入有效的 YouTube 影片連結。");
  if (!apiReady || !window.YT) return void (elements.error.textContent = "YouTube 播放器仍在載入，請稍後再試。");
  clearTimeout(previewTimer);
  elements.empty.style.display = "none";
  elements.player.style.display = "block";
  elements.preview.disabled = true;
  elements.download.disabled = true;
  if (player?.loadVideoById) {
    player.loadVideoById(id);
    const wait = setInterval(() => {
      if (player.getDuration() > 0) { clearInterval(wait); onPlayerReady({ target: player }); player.pauseVideo(); }
    }, 250);
  } else {
    player = new YT.Player("player", { videoId: id, playerVars: { rel: 0, modestbranding: 1 }, events: { onReady: onPlayerReady, onError: () => { elements.error.textContent = "這部影片無法播放，請確認影片權限。"; } } });
  }
}

async function pollProgress(jobId, stopSignal) {
  while (!stopSignal.done) {
    try {
      const response = await fetch(`/api/progress/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      if (response.ok) {
        const progress = await response.json();
        setProgress(progress.stage || "處理中", progress.percent || 0);
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

elements.load.addEventListener("click", loadVideo);
elements.url.addEventListener("keydown", (event) => { if (event.key === "Enter") loadVideo(); });
elements.startRange.addEventListener("input", () => updateSelection("start"));
elements.endRange.addEventListener("input", () => updateSelection("end"));
function applyTime(input, range, source) { const value = parseTime(input.value); if (!Number.isFinite(value)) return updateSelection(); range.value = Math.min(duration, value); updateSelection(source); }
elements.startTime.addEventListener("change", () => applyTime(elements.startTime, elements.startRange, "start"));
elements.endTime.addEventListener("change", () => applyTime(elements.endTime, elements.endRange, "end"));
elements.setStart.addEventListener("click", () => { if (player) { elements.startRange.value = player.getCurrentTime(); updateSelection("start"); } });
elements.setEnd.addEventListener("click", () => { if (player) { elements.endRange.value = player.getCurrentTime(); updateSelection("end"); } });
elements.preview.addEventListener("click", () => { const { start, end } = selectedTimes(); clearTimeout(previewTimer); player.seekTo(start, true); player.playVideo(); previewTimer = setTimeout(() => player.pauseVideo(), (end - start) * 1000); });
elements.clearHistory.addEventListener("click", () => { localStorage.removeItem(HISTORY_KEY); renderHistory(); });

elements.download.addEventListener("click", async () => {
  const { start, end } = selectedTimes();
  const range = `${formatTime(start)} — ${formatTime(end)}`;
  const jobId = crypto.randomUUID();
  const stopSignal = { done: false };
  elements.download.disabled = true;
  setProgress("建立處理工作", 2);
  setStatus("影片正在本機處理，請保持此頁面開啟。", false);
  pollProgress(jobId, stopSignal);
  try {
    const response = await fetch("/api/download", { method: "POST", headers: { "Content-Type": "application/json", "X-Job-ID": jobId }, body: JSON.stringify({ url: elements.url.value, start, end, title, jobId }) });
    if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "下載失敗，請稍後再試。"); }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${title}.mp4`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    setProgress("下載完成", 100);
    setStatus("片段已完成並開始下載。", false);
    saveHistory({ title, range, date: new Date().toLocaleString("zh-TW"), status: "success", size: `${(blob.size / 1024 / 1024).toFixed(1)} MB`, url: elements.url.value });
  } catch (error) {
    setProgress("處理失敗", 100);
    setStatus(error.message, true);
    saveHistory({ title, range, date: new Date().toLocaleString("zh-TW"), status: "failed", error: error.message, url: elements.url.value });
  } finally {
    stopSignal.done = true;
    elements.download.disabled = false;
    updateSelection();
  }
});

renderHistory();
