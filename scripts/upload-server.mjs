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
  send(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Upload server on http://127.0.0.1:${PORT} (Vite proxies /api to it).`);
  if (!process.env.WLT_API_KEY) console.warn("WLT_API_KEY is not set. The page will load but cannot start a run.");
  if (!PIN) console.warn("No UPLOAD_PIN set: anyone who can open the dev server page can start a paid run.");
});
