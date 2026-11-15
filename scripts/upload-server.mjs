#!/usr/bin/env node
// Local helper for the upload page (upload.html). It keeps WLT_API_KEY on this machine and runs the
// whole demo pipeline for one upload: an mp4, up to 4 pictures and a prompt.
//
//   export WLT_API_KEY=...
//   npm run upload-server          (then `npm run dev`, open https://localhost:5173/upload.html)
//
// Steps: video -> 480p mp4 (ffmpeg) -> Marble builds the room from the prompt/pictures (the video is
// NOT sent to Marble, so no people or cake are copied in) -> depth for every frame (scripts/depth-video.py,
// skipped if .depth/ is not set up) -> world.json defaults. Everything lands in public/uploads/<id>/, a
// new folder per run, so the main world in public/world/ is never touched. Each run spends Marble
// credits (about $1.28). The Vite dev server proxies /api here and listens on the LAN, so anyone who
// can open the page can start a run.
//
// API (all JSON):
//   POST /api/party/draft                          -> { id }
//   POST /api/party/file?draft=ID&kind=video|image&ext=mp4     raw file bytes in the body
//   POST /api/party/start   { draft, prompt }      -> 202, then poll status
//   GET  /api/party/status  -> { state, message, world, log, startedAt, finishedAt }

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = Number(process.env.UPLOAD_PORT || 8787);
const MARBLE = path.join(HERE, "marble.mjs");
const DEPTH = path.join(HERE, "depth-video.py");
const DEPTH_PYTHON = path.join(ROOT, ".depth/venv/bin/python");
const UPLOADS = path.join(ROOT, "public/uploads");
const TMP_DIR = path.join(os.tmpdir(), "party-mode-uploads");
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "m4v"]);
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp"]);
const MAX_VIDEO = 500 * 1024 * 1024;
const MAX_IMAGE = 25 * 1024 * 1024;
const MAX_IMAGES = 4;
const BUSY = new Set(["preparing", "building", "downloading", "depth"]);

// One run at a time, so a double click cannot start two paid runs.
let job = { state: "idle", message: "", world: null, log: [], startedAt: null, finishedAt: null };
const setJob = (patch) => { job = { ...job, ...patch }; };
const send = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
};
const fail = (message) => setJob({ state: "failed", message: String(message).slice(0, 400), finishedAt: Date.now() });

const draftDir = (id) => (/^[0-9a-f-]{36}$/.test(id || "") ? path.join(TMP_DIR, id) : null);

// Runs a command, feeding each output line to onLine. Resolves with the exit code and the last error line.
function run(cmd, args, onLine = () => {}, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env });
    let lastErr = "";
    const lines = (stream, fn) => {
      let buf = "";
      stream.on("data", (d) => { buf += d; const parts = buf.split(/\r?\n|\r/); buf = parts.pop(); parts.forEach(fn); });
      stream.on("end", () => buf && fn(buf));
    };
    lines(child.stdout, onLine);
    lines(child.stderr, (l) => { if (l.trim()) lastErr = l.trim(); onLine(l); });
    child.on("error", (e) => resolve({ code: -1, error: e.message }));
    child.on("close", (code) => resolve({ code, error: lastErr }));
  });
}

// Turns marble.mjs's output into what the page shows.
function onMarbleLine(line) {
  if (!line.trim()) return;
  job.log = [...job.log.slice(-39), line];
  let m;
  if (/^Generation started/.test(line)) setJob({ state: "building", message: "Building the room" });
  else if ((m = line.match(/still generating \(([\d.]+) min/))) setJob({ state: "building", message: `Building the room (${m[1]} min)` });
  else if (/^Downloading assets/.test(line)) setJob({ state: "downloading", message: "Downloading the room" });
}

async function runPipeline(dir, prompt) {
  const id = `${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const out = path.join(UPLOADS, id);
  const world = `uploads/${id}`;
  try {
    await fsp.mkdir(out, { recursive: true });
    const files = await fsp.readdir(dir);
    const videoFile = files.find((f) => f.startsWith("video."));
    const pictures = files.filter((f) => f.startsWith("image-")).sort().map((f) => path.join(dir, f));
    if (!videoFile) throw new Error("No video was uploaded.");

    // 1. a browser-safe, phone-sized copy of the video (also keeps depth fast)
    setJob({ state: "preparing", message: "Preparing the video", world });
    const video = path.join(dir, "play.mp4");
    const ff = await run("ffmpeg", ["-y", "-v", "error", "-i", path.join(dir, videoFile), "-vf", "scale=-2:'min(480,ih)'", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", video]);
    if (ff.code !== 0) throw new Error(`Could not read that video${ff.error ? `: ${ff.error}` : "."}`);

    // 2. the room, from the prompt and pictures (never from the video)
    const args = [MARBLE, "--out", out, "--video", video, "--name", "Party room"];
    if (prompt) args.push("--prompt", prompt);
    if (pictures.length) args.push("--images", pictures.join(","));
    if (!prompt && !pictures.length) {
      args.push("--prompt", "A photorealistic, empty, cozy room in warm evening light. No people, no food, nothing on the table.");
    }
    setJob({ state: "building", message: "Building the room" });
    const marble = await run(process.execPath, args, onMarbleLine);
    if (marble.code !== 0) {
      throw new Error(marble.error === "fetch failed" ? "Could not reach Marble. Check the internet connection." : marble.error || "Marble failed.");
    }

    // 3. depth for every frame, if the tool is installed
    const meta = JSON.parse(await fsp.readFile(path.join(out, "world.json"), "utf8"));
    meta.paint = true;
    meta.projection = { yaw: 0, pitch: 0, roll: 0, fov: 50, fade: 0.25, extend: 1 };
    if (fs.existsSync(DEPTH_PYTHON)) {
      setJob({ state: "depth", message: "Adding depth" });
      const depth = await run(DEPTH_PYTHON, [DEPTH, path.join(out, "source.mp4"), "--metric", "--fp32", "--input-size", "364"], (l) => {
        job.log = [...job.log.slice(-39), l];
      });
      if (depth.code === 0) meta.depth = { video: "depth-metric.mp4", json: "depth-metric.json" };
      else job.log = [...job.log.slice(-39), `depth skipped: ${depth.error}`]; // the room still works without it
    }
    await fsp.writeFile(path.join(out, "world.json"), JSON.stringify(meta, null, 2));

    setJob({ state: "done", message: "", world, finishedAt: Date.now() });
  } catch (e) {
    fail(e.message);
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readJson(req) {
  let size = 0, text = "";
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error("Request too large.");
    text += chunk;
  }
  return text ? JSON.parse(text) : {};
}

async function receiveFile(req, res, url) {
  const dir = draftDir(url.searchParams.get("draft"));
  if (!dir || !fs.existsSync(dir)) return send(res, 400, { error: "Unknown upload. Reload the page." });
  const kind = url.searchParams.get("kind");
  const ext = (url.searchParams.get("ext") || "").toLowerCase();
  const isVideo = kind === "video";
  if (!isVideo && kind !== "image") return send(res, 400, { error: "Bad file kind." });
  if (!(isVideo ? VIDEO_EXTS : IMAGE_EXTS).has(ext)) {
    return send(res, 400, { error: isVideo ? "Use an mp4, mov or webm video." : "Use jpg, png or webp pictures." });
  }
  const limit = isVideo ? MAX_VIDEO : MAX_IMAGE;
  if (Number(req.headers["content-length"] || 0) > limit) return send(res, 413, { error: `That file is too large (limit ${limit / 1048576} MB).` });

  const existing = (await fsp.readdir(dir)).filter((f) => f.startsWith("image-")).length;
  if (!isVideo && existing >= MAX_IMAGES) return send(res, 400, { error: `At most ${MAX_IMAGES} pictures.` });
  // The name on disk is ours, never the client's.
  const file = path.join(dir, isVideo ? `video.${ext}` : `image-${existing + 1}.${ext}`);
  let size = 0;
  try {
    const outStream = fs.createWriteStream(file);
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error("Too large."), { code: 413 });
      if (!outStream.write(chunk)) await once(outStream, "drain");
    }
    await new Promise((resolve, reject) => outStream.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    await fsp.rm(file, { force: true });
    return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? "That file is too large." : "The upload was interrupted." });
  }
  if (size === 0) {
    await fsp.rm(file, { force: true });
    return send(res, 400, { error: "That file is empty." });
  }
  send(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const route = `${req.method} ${url.pathname}`;
  const handle = async () => {
    if (route === "GET /api/party/status") return send(res, 200, job);

    if (route === "POST /api/party/draft") {
      if (BUSY.has(job.state)) return send(res, 409, { error: "A room is already being built. Wait for it to finish." });
      if (!process.env.WLT_API_KEY) return send(res, 503, { error: "WLT_API_KEY is not set. Stop the server, export the key and start it again." });
      const id = crypto.randomUUID();
      await fsp.mkdir(path.join(TMP_DIR, id), { recursive: true });
      return send(res, 200, { id });
    }

    if (route === "POST /api/party/file") return receiveFile(req, res, url);

    if (route === "POST /api/party/start") {
      const body = await readJson(req);
      const dir = draftDir(body.draft);
      if (!dir || !fs.existsSync(dir)) return send(res, 400, { error: "Unknown upload. Reload the page." });
      if (BUSY.has(job.state)) return send(res, 409, { error: "A room is already being built." });
      const prompt = String(body.prompt || "").replace(/[\r\n]+/g, " ").trim().slice(0, 1000);
      setJob({ state: "preparing", message: "Preparing the video", world: null, log: [], startedAt: Date.now(), finishedAt: null });
      runPipeline(dir, prompt); // not awaited: the page polls /status
      return send(res, 202, { ok: true });
    }

    send(res, 404, { error: "Not found" });
  };
  handle().catch((e) => {
    fail(`Server error: ${e.message}`);
    if (!res.headersSent) send(res, 500, { error: e.message });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Upload server on http://127.0.0.1:${PORT} (Vite proxies /api to it).`);
  if (!process.env.WLT_API_KEY) console.warn("WLT_API_KEY is not set. The page will load but cannot start a run.");
  if (!fs.existsSync(DEPTH_PYTHON)) console.warn("No .depth/ environment: rooms will be built without depth (see scripts/depth-video.py).");
});
