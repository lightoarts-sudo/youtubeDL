const elements = {
  url: document.querySelector("#url"), load: document.querySelector("#load"), error: document.querySelector("#url-error"),
  empty: document.querySelector("#empty-state"), player: document.querySelector("#player"),
  startTime: document.querySelector("#start-time"), endTime: document.querySelector("#end-time"),
  startRange: document.querySelector("#start-range"), endRange: document.querySelector("#end-range"),
  fill: document.querySelector("#range-fill"), durationLabel: document.querySelector("#duration-label"),
  clipDuration: document.querySelector("#clip-duration"), setStart: document.querySelector("#set-start"),
  setEnd: document.querySelector("#set-end"), preview: document.querySelector("#preview"),
  download: document.querySelector("#download"), downloadMeta: document.querySelector("#download-meta"), status: document.querySelector("#status"),
};

let player;
let duration = 0;
let title = "youtube-clip";
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
      const match = url.pathname.match(/^\/(shorts|embed|live)\/([^/?]+)/);
      return match && match[2];
    }
  } catch { return null; }
  return null;
}

function formatTime(seconds) {
  const safe = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours ? `${hours}:${String(minutes).padStart(2,"0")}:${String(secs).padStart(2,"0")}` : `${String(minutes).padStart(2,"0")}:${String(secs).padStart(2,"0")}`;
}

function parseTime(value) {
  const parts = value.trim().split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) return NaN;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

function selectedTimes() {
  return { start: Number(elements.startRange.value), end: Number(elements.endRange.value) };
}

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

function onPlayerReady(event) {
  duration = event.target.getDuration();
  title = event.target.getVideoData().title || "youtube-clip";
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
  if (!id) { elements.error.textContent = "請輸入有效的 YouTube 影片連結。"; return; }
  if (!apiReady || !window.YT) { elements.error.textContent = "YouTube 播放器仍在載入，請稍後再試。"; return; }
  clearTimeout(previewTimer);
  elements.empty.style.display = "none";
  elements.player.style.display = "block";
  elements.preview.disabled = true;
  elements.download.disabled = true;
  if (player?.loadVideoById) {
    player.loadVideoById(id);
    const waitForMetadata = setInterval(() => {
      const nextDuration = player.getDuration();
      if (nextDuration > 0) { clearInterval(waitForMetadata); onPlayerReady({ target: player }); player.pauseVideo(); }
    }, 250);
  } else {
    player = new YT.Player("player", { videoId: id, playerVars: { rel: 0, modestbranding: 1 }, events: { onReady: onPlayerReady, onError: () => { elements.error.textContent = "這部影片無法播放，請確認影片權限。"; } } });
  }
}

elements.load.addEventListener("click", loadVideo);
elements.url.addEventListener("keydown", (event) => { if (event.key === "Enter") loadVideo(); });
elements.startRange.addEventListener("input", () => updateSelection("start"));
elements.endRange.addEventListener("input", () => updateSelection("end"));

function applyTimeInput(input, range, source) {
  const value = parseTime(input.value);
  if (!Number.isFinite(value)) { input.value = formatTime(range.value); return; }
  range.value = Math.min(duration, value);
  updateSelection(source);
}
elements.startTime.addEventListener("change", () => applyTimeInput(elements.startTime, elements.startRange, "start"));
elements.endTime.addEventListener("change", () => applyTimeInput(elements.endTime, elements.endRange, "end"));
elements.setStart.addEventListener("click", () => { if (player) { elements.startRange.value = player.getCurrentTime(); updateSelection("start"); } });
elements.setEnd.addEventListener("click", () => { if (player) { elements.endRange.value = player.getCurrentTime(); updateSelection("end"); } });

elements.preview.addEventListener("click", () => {
  const { start, end } = selectedTimes();
  clearTimeout(previewTimer);
  player.seekTo(start, true);
  player.playVideo();
  previewTimer = setTimeout(() => player.pauseVideo(), Math.max(0, end - start) * 1000);
});

elements.download.addEventListener("click", async () => {
  const { start, end } = selectedTimes();
  elements.download.disabled = true;
  elements.downloadMeta.textContent = "正在處理影片，請稍候…";
  setStatus("片段正在伺服器處理。影片較長時可能需要幾分鐘。", false);
  try {
    const response = await fetch("/api/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: elements.url.value, start, end, title }) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "下載失敗，請稍後再試。 ");
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `${title || "youtube-clip"}.mp4`;
    link.click();
    URL.revokeObjectURL(objectUrl);
    setStatus("片段已完成並開始下載。", false);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    elements.download.disabled = false;
    updateSelection();
  }
});
