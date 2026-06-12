# Framecut

YouTube 影片預覽與片段下載工具。請僅下載你擁有權利或已獲授權使用的內容，並遵守 YouTube 服務條款。

## 需求

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation)
- [ffmpeg](https://ffmpeg.org/download.html)，且兩者都可由終端機直接執行

Windows 可使用：

```powershell
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

## 啟動

```powershell
cd youtube-clipper
npm.cmd start
```

瀏覽器開啟 `http://localhost:3000`。

## Render 部署

專案包含 `Dockerfile` 與 `render.yaml`。連結 GitHub repository 後，可在 Render 使用 Blueprint 建立服務；Docker 映像會自動安裝 `yt-dlp` 與 `ffmpeg`。

若 `yt-dlp.exe` 不在 PATH，可設定 `YT_DLP_PATH`：

```powershell
$env:YT_DLP_PATH = "C:\tools\yt-dlp.exe"
npm.cmd start
```
