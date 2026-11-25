const form = document.getElementById("find-form");
const queryInput = document.getElementById("query");
const countSelect = document.getElementById("count");
const goButton = form.querySelector(".go");

const loading = document.getElementById("loading");
const loadingText = document.getElementById("loading-text");
const loadingBar = document.getElementById("loading-bar");
const errorBox = document.getElementById("error");
const resultsHead = document.getElementById("results-head");
const resultsNote = document.getElementById("results-note");
const results = document.getElementById("results");

let pollTimer = null;
let currentJob = null;
let localDownloader = false;

async function checkHost() {
  try {
    const res = await fetch("/api/health");
    if (res.ok) {
      localDownloader = true;
      return;
    }
  } catch {}
  document.getElementById("host-note").hidden = false;
}

checkHost();

/* ---------------- music ---------------- */

const audio = document.getElementById("theme");
const musicButton = document.getElementById("music-toggle");
audio.volume = 0.32;

let musicWanted = true;

function paintMusic() {
  const on = !audio.paused;
  musicButton.textContent = on ? "music: on" : "music: off";
  musicButton.setAttribute("aria-pressed", String(on));
}

function playMusic() {
  audio.play().then(paintMusic).catch(() => paintMusic());
}

musicButton.addEventListener("click", () => {
  musicWanted = audio.paused;
  if (audio.paused) playMusic();
  else {
    audio.pause();
    paintMusic();
  }
});

audio.addEventListener("play", paintMusic);
audio.addEventListener("pause", paintMusic);

playMusic();

// browsers block autoplay until the first tap: start on that tap unless the visitor turned music off.
document.addEventListener(
  "pointerdown",
  () => {
    if (musicWanted && audio.paused) playMusic();
  },
  { passive: true }
);

/* ---------------- helpers ---------------- */

function formatDuration(seconds) {
  if (!seconds) return "ad";
  const m = Math.floor(seconds / 60);
  const s = String(Math.floor(seconds % 60)).padStart(2, "0");
  return `${m}:${s}`;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = "";
}

function setBusy(busy) {
  goButton.disabled = busy;
  goButton.textContent = busy ? "working..." : "find ads";
}

function renderItem(item) {
  const article = document.createElement("article");
  article.className = "card";

  const video = document.createElement("video");
  video.src = `/api/media/${encodeURIComponent(item.file)}`;
  video.controls = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "metadata";
  article.appendChild(video);

  const meta = document.createElement("div");
  meta.className = "meta";

  const title = document.createElement("h3");
  title.textContent = item.title;
  meta.appendChild(title);

  const sub = document.createElement("p");
  sub.className = "sub";
  const bits = [formatDuration(item.duration)];
  if (item.channel) bits.push(item.channel);
  sub.textContent = bits.join(" · ");
  meta.appendChild(sub);

  const save = document.createElement("a");
  save.className = "save";
  save.href = `/api/media/${encodeURIComponent(item.file)}?download=1`;
  save.download = item.file;
  save.textContent = "save video";
  meta.appendChild(save);

  article.appendChild(meta);
  return article;
}

function renderPending(item) {
  const box = document.createElement("div");
  box.className = "queue";
  box.dataset.video = item.title;
  const strong = document.createElement("strong");
  strong.textContent = item.title;
  const line = document.createElement("span");
  line.textContent =
    item.status === "failed"
      ? "failed to download"
      : `pulling... ${item.progress || 0}%`;
  box.append(strong, line);
  return box;
}

/* ---------------- job flow ---------------- */

function render(job) {
  results.textContent = "";

  const total = job.items.length;
  const ready = job.items.filter((item) => item.status === "ready");
  const failed = job.items.filter((item) => item.status === "failed");

  for (const item of job.items) {
    if (item.status === "ready" && item.file) results.appendChild(renderItem(item));
    else if (item.status !== "queued" || total > 0) results.appendChild(renderPending(item));
  }

  if (total > 0) {
    resultsHead.hidden = false;
    resultsNote.textContent = `${ready.length}/${total} ad${total === 1 ? "" : "s"} pulled${
      failed.length ? ` · ${failed.length} failed` : ""
    }`;
  }

  if (job.status === "done" || job.status === "error") {
    loading.hidden = true;
    setBusy(false);
    if (job.error) showError(job.error);
  } else {
    loading.hidden = false;
    loadingText.textContent = job.message || "working...";
    const progress = total
      ? Math.round(
          job.items.reduce((sum, item) => {
            if (item.status === "ready") return sum + 100;
            if (item.status === "downloading") return sum + (item.progress || 0);
            if (item.status === "failed") return sum + 100;
            return sum;
          }, 0) / total
        )
      : 6;
    loadingBar.style.width = `${Math.min(100, Math.max(4, progress))}%`;
  }
}

async function poll(jobId) {
  try {
    const res = await fetch(`/api/job/${jobId}`);
    if (!res.ok) throw new Error("lost the job");
    const job = await res.json();
    if (job.id !== currentJob) return;
    render(job);
    if (job.status === "done" || job.status === "error") {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch (err) {
    clearInterval(pollTimer);
    pollTimer = null;
    loading.hidden = true;
    setBusy(false);
    showError(String(err.message || err));
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const query = queryInput.value.trim();
  if (query.length < 2) return;

  clearError();
  results.textContent = "";
  resultsHead.hidden = true;
  loading.hidden = false;
  loadingText.textContent = "tuning the antenna...";
  loadingBar.style.width = "6%";
  setBusy(true);

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  try {
    const res = await fetch("/api/find", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, count: Number(countSelect.value) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "search failed");

    currentJob = data.id;
    pollTimer = setInterval(() => poll(data.id), 700);
    poll(data.id);
  } catch (err) {
    loading.hidden = true;
    setBusy(false);
    showError(
      localDownloader
        ? String(err.message || err)
        : "this hosted copy can't run yt-dlp. the downloader only runs locally: bun run start"
    );
  }
});

queryInput.focus();
