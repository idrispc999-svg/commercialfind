import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = import.meta.dir;
const PUBLIC = join(ROOT, "public");
const DOWNLOADS = process.env.DOWNLOAD_DIR || join(ROOT, "downloads");
const BIN = join(ROOT, "bin");
const YTDLP = process.env.YTDLP_PATH || join(BIN, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
const FFMPEG_DIR = join(BIN, "ffmpeg");
const HOST = process.env.HOST || "127.0.0.1";
// hosted platforms inject PORT; on windows that variable belongs to the desktop app, so ignore it there
const PLATFORM_PORT = process.platform === "linux" ? Number(process.env.PORT) : 0;
const PORT = Number(process.env.COMMERCIALFIND_PORT) || PLATFORM_PORT || 5177;

mkdirSync(DOWNLOADS, { recursive: true });

const jobs = new Map();
const JOB_TTL = 1000 * 60 * 60 * 3;
const MAX_COUNT = 6;
const RUNNING_LIMIT = 3;
const IP_LIMIT = 6;
const IP_WINDOW = 1000 * 60 * 10;
const ipHits = new Map();

/* ---------- helpers ---------- */

function runYtdlp(args, onLine) {
  return new Promise((resolve) => {
    const proc = Bun.spawn([YTDLP, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    });

    let stdout = "";
    let pending = "";
    let stderrTail = "";

    const pump = async (stream, keep) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        if (keep) stdout += text;
        else stderrTail = (stderrTail + text).slice(-2000);
        pending += text;
        let idx;
        while ((idx = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, idx).replace(/\r/g, "").trim();
          pending = pending.slice(idx + 1);
          if (line) onLine?.(line);
        }
      }
    };

    Promise.all([pump(proc.stdout, true), pump(proc.stderr, false)]).then(async () => {
      if (pending.trim()) onLine?.(pending.trim());
      const code = await proc.exited;
      resolve({ code, stdout, stderr: stderrTail });
    });
  });
}

const STOPWORDS = new Set(["the", "a", "an", "of", "for", "and", "ad", "ads", "commercial", "commercials", "tv", "video"]);

function tokens(text) {
  return (text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && !STOPWORDS.has(t));
}

function scoreEntry(entry, queryTokens) {
  const haystackTitle = (entry.title || "").toLowerCase();
  const haystackDesc = (entry.description || "").toLowerCase();
  let score = 0;
  for (const token of queryTokens) {
    if (haystackTitle.includes(token)) score += 3;
    else if (haystackDesc.includes(token)) score += 1;
  }
  return score;
}

function clientIp(req) {
  const forwarded = req.headers.get("x-forwarded-for") || "";
  return forwarded.split(",")[0].trim() || req.headers.get("cf-connecting-ip") || "local";
}

function allowRequest(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((time) => now - time < IP_WINDOW);
  if (hits.length >= IP_LIMIT) return false;
  hits.push(now);
  ipHits.set(ip, hits);
  return true;
}

function runningJobs() {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === "searching" || job.status === "downloading") count++;
  }
  return count;
}

function publicItem(item) {
  return {
    title: item.title,
    channel: item.channel,
    duration: item.duration,
    status: item.status,
    progress: item.progress,
    file: item.file,
    error: item.error || null,
  };
}

function publicJob(job) {
  return {
    id: job.id,
    query: job.query,
    status: job.status,
    message: job.message,
    error: job.error,
    found: job.items.length,
    items: job.items.map(publicItem),
  };
}

/* ---------- job pipeline ---------- */

async function runJob(job) {
  job.status = "searching";
  job.message = `searching for "${job.query}"...`;

  const searchCount = Math.min(30, job.count * 4 + 6);
  const search = await runYtdlp([
    "--flat-playlist",
    "--dump-single-json",
    "--no-warnings",
    "--ignore-errors",
    `ytsearch${searchCount}:${job.query}`,
  ]);

  let entries = [];
  try {
    const parsed = JSON.parse(search.stdout);
    entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    entries = [];
  }

  const queryTokens = tokens(job.query);
  const candidates = entries
    .filter((entry) => entry && entry.id && entry.title)
    .filter((entry) => !entry.duration || (entry.duration >= 3 && entry.duration <= 900))
    .map((entry) => ({ entry, score: scoreEntry(entry, queryTokens) }))
    .sort((a, b) => b.score - a.score);

  const relevant = candidates.filter((c) => c.score > 0);
  const picked = (relevant.length >= 1 ? relevant : candidates).slice(0, job.count);

  if (picked.length === 0) {
    job.status = "error";
    job.error = "nothing found. try different words.";
    job.message = "";
    return;
  }

  job.items = picked.map(({ entry }) => ({
    videoId: entry.id,
    title: (entry.title || "untitled").trim(),
    channel: (entry.channel || entry.uploader || "").trim(),
    duration: entry.duration || null,
    url: entry.url || `https://www.youtube.com/watch?v=${entry.id}`,
    status: "queued",
    progress: 0,
    file: null,
  }));

  job.status = "downloading";

  for (let i = 0; i < job.items.length; i++) {
    const item = job.items[i];
    item.status = "downloading";
    job.message = `pulling ad ${i + 1} of ${job.items.length}...`;

    const args = [
      "--no-playlist",
      "--no-warnings",
      "--newline",
      "--no-mtime",
      "--retries",
      "3",
      "--socket-timeout",
      "20",
      "--merge-output-format",
      "mp4",
      "-f",
      "bv*[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba/b[ext=mp4]/b",
      "-o",
      join(DOWNLOADS, `${job.id}-${item.videoId}.%(ext)s`),
      `https://www.youtube.com/watch?v=${item.videoId}`,
    ];
    if (existsSync(join(FFMPEG_DIR, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"))) {
      args.unshift("--ffmpeg-location", FFMPEG_DIR);
    }

    const result = await runYtdlp(args, (line) => {
      const match = /\[download\]\s+([\d.]+)%/.exec(line);
      if (match) item.progress = Math.min(99, Math.round(Number(match[1])));
      if (line.startsWith("[Merger]")) item.progress = 99;
    });

    const files = readdirSync(DOWNLOADS).filter(
      (name) => name.startsWith(`${job.id}-${item.videoId}.`) && !name.endsWith(".part")
    );

    if (result.code === 0 && files.length > 0) {
      const best = files
        .map((name) => ({ name, size: statSync(join(DOWNLOADS, name)).size }))
        .sort((a, b) => b.size - a.size)[0];
      item.file = best.name;
      item.progress = 100;
      item.status = "ready";
    } else {
      item.status = "failed";
      item.error = "download failed";
      for (const name of files) {
        try {
          unlinkSync(join(DOWNLOADS, name));
        } catch {}
      }
    }
  }

  const ready = job.items.filter((item) => item.status === "ready");
  job.status = ready.length ? "done" : "error";
  job.message = ready.length
    ? `found ${ready.length} ${ready.length === 1 ? "ad" : "ads"}.`
    : "";
  if (!ready.length) job.error = "the ads could not be downloaded. try again.";
}

/* ---------- media serving ---------- */

const SAFE_FILE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;

function serveMedia(req, filename) {
  if (!SAFE_FILE.test(filename)) return new Response("not found", { status: 404 });

  const path = join(DOWNLOADS, filename);
  if (!existsSync(path)) return new Response("not found", { status: 404 });

  const size = statSync(path).size;
  const type = { ".mp4": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska", ".m4a": "audio/mp4" }[
    extname(filename).toLowerCase()
  ] || "application/octet-stream";

  const headers = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };

  const wantsDownload = new URL(req.url).searchParams.get("download") === "1";
  if (wantsDownload) {
    headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  }

  const range = req.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : size - 1;
      if (!match[1] && match[2]) {
        start = Math.max(0, size - Number(match[2]));
        end = size - 1;
      }
      if (start > end || start >= size) {
        return new Response("range not satisfiable", {
          status: 416,
          headers: { "Content-Range": `bytes */${size}` },
        });
      }
      end = Math.min(end, size - 1);
      return new Response(Bun.file(path).slice(start, end + 1), {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
  }

  return new Response(Bun.file(path), {
    headers: { ...headers, "Content-Length": String(size) },
  });
}

/* ---------- http ---------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function hasFfmpeg() {
  const bundled = join(FFMPEG_DIR, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  return existsSync(bundled) || Boolean(Bun.which("ffmpeg"));
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  async fetch(req) {
    const url = new URL(req.url);
    const path = decodeURIComponent(url.pathname);

    if (req.method === "GET" && path === "/api/health") {
      return json({ ok: true, ytdlp: Boolean(Bun.which(YTDLP) || existsSync(YTDLP)), ffmpeg: hasFfmpeg() });
    }

    if (req.method === "POST" && path === "/api/find") {
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: "bad request" }, 400);
      }

      const query = String(body?.query || "").trim().slice(0, 120);
      const count = Math.max(1, Math.min(MAX_COUNT, Number(body?.count) || 1));

      if (query.length < 2) return json({ error: "type a longer search" }, 400);
      if (!existsSync(YTDLP)) return json({ error: "yt-dlp is missing from bin/" }, 500);
      if (runningJobs() >= RUNNING_LIMIT) {
        return json({ error: "the machine is already pulling a few ads. try again in a minute." }, 429);
      }
      if (!allowRequest(req)) {
        return json({ error: "too many searches from this address. wait a few minutes." }, 429);
      }

      const job = {
        id: crypto.randomUUID(),
        query,
        count,
        status: "searching",
        message: "searching...",
        error: null,
        items: [],
        created: Date.now(),
      };
      jobs.set(job.id, job);
      runJob(job).catch((err) => {
        job.status = "error";
        job.error = String(err?.message || err);
      });

      return json({ id: job.id }, 202);
    }

    if (req.method === "GET" && path.startsWith("/api/job/")) {
      const job = jobs.get(path.slice("/api/job/".length));
      if (!job) return json({ error: "job not found" }, 404);
      return json(publicJob(job));
    }

    if (req.method === "GET" && path.startsWith("/api/media/")) {
      return serveMedia(req, path.slice("/api/media/".length));
    }

    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file(join(PUBLIC, "index.html")));
    }

    if (path.startsWith("/assets/") || path === "/app.js" || path === "/styles.css") {
      const file = Bun.file(join(PUBLIC, path));
      if (await file.exists()) return new Response(file);
      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  },
});

/* ---------- housekeeping ---------- */

function cleanup() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.created > JOB_TTL) jobs.delete(id);
  }
  for (const name of readdirSync(DOWNLOADS)) {
    const path = join(DOWNLOADS, name);
    try {
      if (now - statSync(path).mtimeMs > JOB_TTL) unlinkSync(path);
    } catch {}
  }
  for (const [ip, hits] of ipHits) {
    const fresh = hits.filter((time) => now - time < IP_WINDOW);
    if (fresh.length) ipHits.set(ip, fresh);
    else ipHits.delete(ip);
  }
}

cleanup();
setInterval(cleanup, 1000 * 60 * 10);

console.log(`commercialfind running at http://${HOST}:${server.port}`);
