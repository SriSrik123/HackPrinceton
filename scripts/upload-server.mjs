#!/usr/bin/env node
// Local helper for the upload page (KAN-15). It keeps WLT_API_KEY on this machine, receives a
// video from the page and runs scripts/marble.mjs on it, so the Marble logic lives in one place.
//
//   export WLT_API_KEY=...
//   npm run upload-server          (then `npm run dev`, open https://localhost:5173/upload.html)
//
// Every run spends Marble credits and replaces the world in public/world/.
//
// Env: UPLOAD_PORT (default 8787), UPLOAD_PIN (optional: the page must send it before a run starts).
// It only listens on 127.0.0.1. The Vite dev server proxies /api to it. Note that the Vite dev
// server listens on the LAN, so anyone who can open the page can start a run; set UPLOAD_PIN
// if the network is shared.
//
// API:
//   GET  /api/party/status           { state, message, log, ... }
//   POST /api/party?ext=mp4&name=X   raw video bytes in the body, header x-confirm: spend-credits

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.UPLOAD_PORT || 8787);
const PIN = process.env.UPLOAD_PIN || "";
const MAX_BYTES = 100 * 1024 * 1024; // Marble's video limit
const EXTS = new Set(["mp4", "mov", "webm", "avi"]);
const MARBLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "marble.mjs");
const TMP_DIR = path.join(os.tmpdir(), "party-mode-uploads");
const BUSY = new Set(["receiving", "uploading", "building", "downloading"]);

// One run at a time, so a double click cannot start two paid runs.
let job = { state: "idle", message: "Nothing is running.", log: [], startedAt: null, finishedAt: null };

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

// Turns marble.mjs's output into a state the page can show.
function onLine(line) {
  if (!line.trim()) return;
  job.log = [...job.log.slice(-39), line];
  let m;
  if (/^Preparing upload/.test(line)) setJob({ state: "uploading", message: "Sending the video to Marble." });
  else if (/^Uploaded\./.test(line)) setJob({ message: "Video is at Marble. Starting the build." });
  else if (/^Generation started/.test(line)) setJob({ state: "building", message: "Marble is building the room. This usually takes about 5 minutes." });
  else if ((m = line.match(/still generating \(([\d.]+) min/))) setJob({ state: "building", message: `Marble is building the room (${m[1]} min so far). Usually about 5 minutes.` });
  else if (/^Done\. world_id/.test(line)) setJob({ message: "Marble finished. Downloading the room." });
  else if (/^Downloading assets/.test(line)) setJob({ state: "downloading", message: "Downloading the room into public/world/." });
}

function runMarble(file, name) {
  const child = spawn(process.execPath, [MARBLE, file, "--name", name], { env: process.env });
  const errLines = [];
  const lines = (stream, fn) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const parts = buf.split("\n");
      buf = parts.pop();
      parts.forEach(fn);
    });
    stream.on("end", () => buf && fn(buf));
  };
  lines(child.stdout, onLine);
  lines(child.stderr, (l) => { if (l.trim()) errLines.push(l.trim()); });
  child.on("error", (e) => {
    setJob({ state: "failed", message: `Could not start the Marble script: ${e.message}`, finishedAt: Date.now() });
  });
  child.on("close", (code) => {
    fsp.rm(file, { force: true }).catch(() => {});
    if (job.state === "failed") return;
    if (code === 0) setJob({ state: "done", message: "Done. The room is in public/world/.", finishedAt: Date.now() });
    else {
      let message = errLines.at(-1) || `The Marble script exited with code ${code}.`;
      if (message === "fetch failed") message = "Could not reach Marble. Check this computer's internet connection and try again.";
      setJob({ state: "failed", message: message.slice(0, 400), finishedAt: Date.now() });
    }
  });
}

async function receiveUpload(req, res, url) {
  if (!process.env.WLT_API_KEY) return send(res, 503, { error: "WLT_API_KEY is not set on the upload server. Stop it, export the key and start it again." });
  if (!pinOk(req.headers["x-pin"])) return send(res, 401, { error: "Wrong or missing PIN." });
  if (req.headers["x-confirm"] !== "spend-credits") return send(res, 400, { error: "Missing confirmation that this run spends Marble credits." });
  if (BUSY.has(job.state)) return send(res, 409, { error: "A run is already in progress." });

  const ext = (url.searchParams.get("ext") || "").toLowerCase();
  if (!EXTS.has(ext)) return send(res, 400, { error: "Marble accepts mp4, mov, webm or avi." });
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > MAX_BYTES) return send(res, 413, { error: "Marble's limit is 100 MB. Re-encode the video first (see the README)." });
  const name = (url.searchParams.get("name") || "Party video").replace(/[\r\n]/g, " ").trim().slice(0, 64) || "Party video";

  // The file name on disk is ours, never the client's.
  await fsp.mkdir(TMP_DIR, { recursive: true });
  const file = path.join(TMP_DIR, `${crypto.randomUUID()}.${ext}`);
  setJob({ state: "receiving", message: "Receiving the video.", log: [], startedAt: Date.now(), finishedAt: null });

  let size = 0;
  try {
    const out = fs.createWriteStream(file);
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BYTES) throw Object.assign(new Error("Marble's limit is 100 MB."), { code: 413 });
      if (!out.write(chunk)) await once(out, "drain");
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    await fsp.rm(file, { force: true });
    setJob({ state: "failed", message: e.code === 413 ? e.message : "The upload was interrupted.", finishedAt: Date.now() });
    if (!res.headersSent && !res.destroyed) send(res, e.code === 413 ? 413 : 400, { error: job.message });
    return;
  }
  if (size === 0) {
    await fsp.rm(file, { force: true });
    setJob({ state: "failed", message: "The file was empty.", finishedAt: Date.now() });
    return send(res, 400, { error: job.message });
  }

  setJob({ state: "uploading", message: "Sending the video to Marble." });
  runMarble(file, name);
  send(res, 202, { ok: true });
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
  if (req.method === "GET" && url.pathname === "/api/party/status") {
    return send(res, 200, {
      ...job,
      keyConfigured: Boolean(process.env.WLT_API_KEY),
      pinRequired: Boolean(PIN),
      maxBytes: MAX_BYTES,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/party") {
    return receiveUpload(req, res, url).catch((e) => {
      setJob({ state: "failed", message: `Server error: ${e.message}`, finishedAt: Date.now() });
      if (!res.headersSent) send(res, 500, { error: job.message });
    });
  }
  if (req.method === "GET" && url.pathname === "/api/angles/status") {
    return send(res, 200, { ...angles, keyConfigured: Boolean(process.env.XAI_API_KEY), pinRequired: Boolean(PIN), cached: readCache() });
  }
  if (req.method === "POST" && url.pathname === "/api/angles") {
    return receiveAngles(req, res).catch((e) => {
      setAngles({ state: "failed", message: `Server error: ${e.message}`, finishedAt: Date.now() });
      if (!res.headersSent) send(res, 500, { error: angles.message });
    });
  }
  send(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Upload server on http://127.0.0.1:${PORT} (Vite proxies /api to it).`);
  if (!process.env.WLT_API_KEY) console.warn("WLT_API_KEY is not set. The page will load but cannot start a run.");
  if (!process.env.XAI_API_KEY) console.warn("XAI_API_KEY is not set. \"Find more angles\" cannot search.");
  if (!PIN) console.warn("No UPLOAD_PIN set: anyone who can open the dev server page can start a paid run.");
});
