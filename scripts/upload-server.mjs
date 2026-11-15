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
const PIN = process.env.UPLOAD_PIN || "";
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
const pinOk = (given) => {
  if (!PIN) return true;
  const a = Buffer.from(String(given ?? "")), b = Buffer.from(PIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

// ---------------------------------------------------------------------------
// "Find more angles": the page sends a few frames plus a short WAV cut from the clip.
// Grok's speech model transcribes that audio (grok-4.7 itself only takes text and images),
// then grok-4.7 searches X. Links only; nothing is downloaded or built from them.
// ---------------------------------------------------------------------------
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.7";
const STT_MODEL = process.env.XAI_STT_MODEL || "grok-voice-transcribe-2.0";
const ANGLES_CACHE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "concert", "angles-cache.json"); // gitignored folder
const MAX_JSON = 6 * 1024 * 1024;
let angles = { state: "idle", message: "Nothing is running.", result: null, startedAt: null, finishedAt: null };
const setAngles = (patch) => { angles = { ...angles, ...patch }; };
const readCache = () => { try { return JSON.parse(fs.readFileSync(ANGLES_CACHE, "utf8")); } catch { return null; } };

const clean = (v, n = 120) => String(v ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, n);

function anglesPrompt(transcript, hadAudio, name) {
  const heard = !hadAudio
    ? "(no audio could be read from the file)"
    : transcript || "(the clip had audio, but no words came out of it)";
  return `Someone filmed a live music moment and wants other fans' videos of the same moment, from other angles.
The video file is named: ${name || "(no name)"}
Frames from their video are attached.
Transcript of a short stretch of the clip's own audio. It may be sung lyrics, a crowd, or an announcement, and it may be garbled. Treat unclear lines as possible lyrics:
${heard}

1. Work out the artist, song, venue and date from the file name, the frames and the transcript. If it does not look like a live show, say so.
2. Search X at most twice for posts with a video of that same event, ideally the same song. Then stop searching and answer.
3. Reply with ONLY this JSON, no other text:
{"event":"<what you think this is>","confidence":"low|medium|high","posts":[{"url":"https://x.com/<handle>/status/<id>","handle":"@...","description":"<one line>"}]}
Up to 8 posts. Only include posts you actually found. Never invent a URL.`;
}

function parseAngles(text) {
  let out = null;
  try { out = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)); } catch {}
  if (!out || !Array.isArray(out.posts)) { // Grok ignored the format: salvage the links
    const urls = [...new Set(text.match(/https:\/\/(?:x|twitter)\.com\/\w+\/status\/\d+/g) || [])];
    out = { event: "", confidence: "low", posts: urls.map((url) => ({ url, handle: "", description: "" })) };
  }
  out.posts = out.posts.filter((p) => /^https:\/\/(?:x|twitter)\.com\/\w+\/status\/\d+/.test(p?.url)).slice(0, 8)
    .map((p) => ({ url: p.url, handle: clean(p.handle, 40), description: clean(p.description, 200) }));
  out.event = clean(out.event, 200);
  out.confidence = ["low", "medium", "high"].includes(out.confidence) ? out.confidence : "low";
  return out;
}

function wavFromDataUrl(s) {
  const m = typeof s === "string" && s.match(/^data:audio\/wav;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!m) return null;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length < 44 || buf.length > 1_500_000) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  return buf;
}

async function transcribe(wav) {
  const form = new FormData();
  form.append("model", STT_MODEL);
  form.append("vad_threshold", "0"); // a concert is music and crowd, so do not drop non-speech
  form.append("file", new Blob([wav], { type: "audio/wav" }), "clip.wav"); // file must be the last field
  const res = await fetch("https://api.x.ai/v1/stt", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.XAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(res.status === 401 ? "xAI rejected the key (401). Check XAI_API_KEY." : `Could not transcribe the clip (xAI ${res.status}): ${clean(data.error?.message ?? data.error ?? "", 160)}`);
    err.status = res.status;
    throw err;
  }
  return clean(data.text, 800);
}

function messageText(output) {
  return (output ?? []).filter((o) => o.type === "message").flatMap((o) => o.content ?? []).map((c) => c.text ?? "").join("\n");
}

// grok-4.7 reasons at "high" by default, and a quiet non-streaming call gets dropped before it answers.
// Low effort plus a stream keeps the search inside a couple of minutes.
async function askGrok(content) {
  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.XAI_API_KEY}` },
    body: JSON.stringify({
      model: XAI_MODEL,
      store: false,
      stream: true,
      reasoning: { effort: "low" },
      tools: [{ type: "x_search" }],
      input: [{ role: "user", content }],
    }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new Error(res.status === 401 ? "xAI rejected the key (401). Check XAI_API_KEY." : `xAI error ${res.status}: ${clean(data.error?.message ?? data.error ?? "", 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", deltas = "", final = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      if (ev.type === "response.output_text.delta") deltas += ev.delta || "";
      else if (ev.type === "response.completed" || ev.type === "response.incomplete") final = messageText(ev.response?.output) || deltas;
      else if (ev.type === "error" || ev.type === "response.failed") throw new Error(clean(ev.error?.message ?? ev.response?.error?.message ?? "xAI stream failed", 200));
      else if (/tool_call|x_search|search/i.test(`${ev.type} ${ev.item?.name ?? ev.name ?? ""}`)) setAngles({ message: "Grok is searching X." });
    }
  }
  const text = final || deltas;
  if (!text) throw new Error("xAI returned an empty answer.");
  return text;
}

async function runAngles(frames, audio, name) {
  const started = Date.now();
  try {
    let transcript = "";
    let audioNote = "";
    if (audio) {
      setAngles({ message: "Listening to the clip." });
      try { transcript = await transcribe(audio); }
      catch (e) {
        if (e.status === 401) throw e; // the search uses the same key, so stop here
        audioNote = " The audio could not be transcribed, so this is from the frames.";
      }
      if (!audioNote && !transcript) audioNote = " Nothing intelligible came out of the audio, so this is from the frames.";
    } else audioNote = " This clip had no readable audio, so this is from the frames.";
    setAngles({ message: "Grok is searching X. This takes about a minute or two." });
    const content = [{ type: "input_text", text: anglesPrompt(transcript, Boolean(audio), name) }, ...frames.map((image_url) => ({ type: "input_image", image_url }))];
    const text = await askGrok(content);
    const result = { ...parseAngles(text), transcript, searchedAt: Date.now() };
    if (result.posts.length) fsp.writeFile(ANGLES_CACHE, JSON.stringify(result, null, 2)).catch(() => {}); // backup for the demo
    console.log(`angles: done in ${Math.round((Date.now() - started) / 1000)}s, ${result.posts.length} posts`);
    setAngles({ state: "done", message: (result.posts.length ? `Found ${result.posts.length} posts.` : "Grok found no matching posts.") + audioNote, result, finishedAt: Date.now() });
  } catch (e) {
    const message = e.name === "TimeoutError" ? "Grok did not finish in time. Press Find more angles to try again." : e.message === "fetch failed" ? "Could not reach xAI. Check the internet connection." : e.message;
    console.log(`angles: failed after ${Math.round((Date.now() - started) / 1000)}s: ${clean(message, 200)}`);
    setAngles({ state: "failed", message: clean(message, 300), finishedAt: Date.now() });
  }
}

async function receiveAngles(req, res) {
  if (!process.env.XAI_API_KEY) return send(res, 503, { error: "XAI_API_KEY is not set on the upload server. Add it to .env and restart." });
  if (!pinOk(req.headers["x-pin"])) return send(res, 401, { error: "Wrong or missing PIN." });
  if (angles.state === "searching") return send(res, 409, { error: "A search is already running." });
  let raw = "";
  for await (const chunk of req) { raw += chunk; if (raw.length > MAX_JSON) return send(res, 413, { error: "Request too large." }); }
  let body;
  try { body = JSON.parse(raw); } catch { return send(res, 400, { error: "Bad JSON." }); }
  const frames = (Array.isArray(body.frames) ? body.frames : []).filter((f) => /^data:image\/jpeg;base64,[\w+/=]+$/.test(f)).slice(0, 4);
  const audio = wavFromDataUrl(body.audio);
  const name = clean(body.name, 80);
  if (!frames.length) return send(res, 400, { error: "Choose a video first." });
  setAngles({ state: "searching", message: audio ? "Listening to the clip." : "Grok is searching X. This takes about a minute or two.", result: null, startedAt: Date.now(), finishedAt: null });
  runAngles(frames, audio, name);
  send(res, 202, { ok: true });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/api/angles/status") {
    return send(res, 200, { ...angles, keyConfigured: Boolean(process.env.XAI_API_KEY), pinRequired: Boolean(PIN), cached: readCache() });
  }
  if (req.method === "POST" && url.pathname === "/api/angles") {
    return receiveAngles(req, res).catch((e) => {
      setAngles({ state: "failed", message: `Server error: ${e.message}`, finishedAt: Date.now() });
      if (!res.headersSent) send(res, 500, { error: angles.message });
    });
  }
  const route = `${req.method} ${url.pathname}`;
  const handle = async () => {
    if (route === "GET /api/party/status") return send(res, 200, { ...job, keyConfigured: Boolean(process.env.WLT_API_KEY), pinRequired: Boolean(PIN), maxBytes: MAX_VIDEO });

    if (req.method === "POST" && url.pathname.startsWith("/api/party/") && !pinOk(req.headers["x-pin"])) {
      return send(res, 401, { error: "Wrong or missing PIN." });
    }

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
  console.log(`Upload server on http://127.0.0.1:${server.address().port} (Vite proxies /api to it).`);
  if (!process.env.WLT_API_KEY) console.warn("WLT_API_KEY is not set. The page will load but cannot start a run.");
  if (!process.env.XAI_API_KEY) console.warn("XAI_API_KEY is not set. \"Find more angles\" cannot search.");
  if (!PIN) console.warn("No UPLOAD_PIN set: anyone who can open the dev server page can start a paid run.");
  if (!fs.existsSync(DEPTH_PYTHON)) console.warn("No .depth/ environment: rooms will be built without depth (see scripts/depth-video.py).");
});
