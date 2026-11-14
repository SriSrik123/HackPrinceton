#!/usr/bin/env node
// Upload a local video to World Labs Marble, wait for the world, download the assets.
//
// Usage:
//   export WLT_API_KEY=...            (never hardcode the key)
//   node scripts/marble.mjs path/to/party.mp4 [--name "Party 2016"] [--model marble-1.1]
//   node scripts/marble.mjs --op <operation_id>     resume polling a world that's already generating
//   node scripts/marble.mjs --world <world_id>      just (re)download assets of a finished world
//
// Output goes to public/world/ so the viewer picks it up:
//   splat-100k.spz, splat-500k.spz, collider.glb, world.json, source.<ext> (copy of your video)
//
// Every generate call costs Marble credits. Running this spends money on your account.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = (process.env.WLT_API_BASE || "https://api.worldlabs.ai") + "/marble/v1"; // base override is only for local testing
const KEY = process.env.WLT_API_KEY;
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/world");
const MAX_BYTES = 100 * 1024 * 1024; // generate docs: "Maximum video size: 100MB"
const POLL_MS = Number(process.env.WLT_POLL_MS || 10_000);
const MIME = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", avi: "video/x-msvideo" };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function api(method, route, body) {
  const res = await fetch(API + route, {
    method,
    headers: { "WLT-Api-Key": KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${method} ${route} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function uploadVideo(filePath) {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_BYTES) {
    throw new Error(`Video is ${(stat.size / 1e6).toFixed(1)} MB; Marble's limit is 100 MB. Trim or re-encode it first (see README).`);
  }
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!MIME[ext]) console.warn(`Warning: .${ext} isn't in Marble's listed video formats (mp4, webm, mov, avi).`);

  // file_name max 64 chars per the API reference
  const fileName = path.basename(filePath).slice(-64);
  console.log(`Preparing upload for ${fileName} (${(stat.size / 1e6).toFixed(1)} MB)...`);
  const prep = await api("POST", "/media-assets:prepare_upload", { file_name: fileName, kind: "video", extension: ext });

  // The overview page shows media_asset.id, the reference page shows media_asset.media_asset_id. Accept both.
  const assetId = prep.media_asset?.media_asset_id ?? prep.media_asset?.id;
  const info = prep.upload_info;
  if (!assetId || !info?.upload_url) throw new Error("Unexpected prepare_upload response: " + JSON.stringify(prep));

  const headers = { ...(info.required_headers || {}) };
  if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type") && MIME[ext]) headers["Content-Type"] = MIME[ext];

  console.log("Uploading...");
  const bytes = await fs.readFile(filePath);
  const put = await fetch(info.upload_url, { method: info.upload_method || "PUT", headers, body: bytes });
  if (!put.ok) throw new Error(`Upload failed: HTTP ${put.status} ${(await put.text()).slice(0, 300)}`);
  console.log(`Uploaded. media_asset_id = ${assetId}`);
  return assetId;
}

async function generate(assetId, name, model) {
  const body = {
    display_name: name.slice(0, 64),
    world_prompt: { type: "video", video_prompt: { source: "media_asset", media_asset_id: assetId } },
  };
  if (model) body.model = model;

  // The docs say the asset must be READY, but there's no status field to check.
  // So if generate rejects it right after upload, wait and retry a few times.
  for (let attempt = 1; ; attempt++) {
    try {
      const op = await api("POST", "/worlds:generate", body);
      console.log(`Generation started. operation_id = ${op.operation_id}`);
      console.log(`(If this script dies, resume with: node scripts/marble.mjs --op ${op.operation_id})`);
      return op.operation_id;
    } catch (e) {
      if (e.status === 402) throw new Error("Marble says insufficient credits (HTTP 402). Add credits on the World Labs platform.");
      if (attempt >= 4 || ![400, 409, 422].includes(e.status)) throw e;
      console.warn(`Generate rejected (${e.status}), maybe the upload isn't ready yet. Retrying in 15s...`);
      await sleep(15_000);
    }
  }
}

async function waitForWorld(opId) {
  const started = Date.now();
  for (;;) {
    const op = await api("GET", `/operations/${opId}`);
    if (op.done) {
      if (op.error) throw new Error(`Generation failed: ${op.error.code ?? ""} ${op.error.message ?? JSON.stringify(op.error)}`);
      const worldId = op.response?.world_id ?? op.metadata?.world_id;
      if (op.cost?.total_credits != null) console.log(`Cost: ${op.cost.total_credits} credits`);
      console.log(`Done. world_id = ${worldId}`);
      return worldId;
    }
    const pct = op.metadata?.progress ?? op.metadata?.progress_percentage;
    const mins = ((Date.now() - started) / 60000).toFixed(1);
    console.log(`  still generating (${mins} min${pct != null ? `, progress ${JSON.stringify(pct)}` : ""})`);
    await sleep(POLL_MS);
  }
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed for ${file}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(path.join(OUT_DIR, file), buf);
  console.log(`  saved ${file} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

async function downloadWorld(worldId, videoPath) {
  // The operation's response snapshot can have empty fields, so read the world itself.
  const world = await api("GET", `/worlds/${worldId}`);
  const a = world.assets || {};
  const spz = a.splats?.spz_urls || {};
  await fs.mkdir(OUT_DIR, { recursive: true });

  console.log("Downloading assets to public/world/ ...");
  if (spz["100k"]) await download(spz["100k"], "splat-100k.spz"); else console.warn("  no 100k SPZ in assets");
  if (spz["500k"]) await download(spz["500k"], "splat-500k.spz"); else console.warn("  no 500k SPZ in assets");
  if (a.mesh?.collider_mesh_url) await download(a.mesh.collider_mesh_url, "collider.glb");
  else console.warn("  no collider mesh in assets");

  let videoFile = null;
  if (videoPath) {
    videoFile = "source" + path.extname(videoPath).toLowerCase();
    await fs.copyFile(videoPath, path.join(OUT_DIR, videoFile));
    console.log(`  copied your video to ${videoFile}`);
  } else {
    // keep an earlier copy if there is one
    try {
      const prev = JSON.parse(await fs.readFile(path.join(OUT_DIR, "world.json"), "utf8"));
      videoFile = prev.video ?? null;
    } catch {}
  }

  const meta = {
    world_id: world.world_id,
    display_name: world.display_name,
    world_marble_url: world.world_marble_url,
    caption: a.caption ?? null,
    semantics_metadata: a.splats?.semantics_metadata ?? null,
    spz_keys: Object.keys(spz),
    video: videoFile,
    downloaded_at: new Date().toISOString(),
  };
  await fs.writeFile(path.join(OUT_DIR, "world.json"), JSON.stringify(meta, null, 2));
  console.log("  saved world.json");
  console.log(`\nView it on Marble too: ${world.world_marble_url}`);
}

async function main() {
  if (!KEY) {
    console.error("Set WLT_API_KEY first, e.g. export WLT_API_KEY=your_key (see README).");
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  const videoPath = args._[0];

  if (args.world) return downloadWorld(args.world, videoPath);
  if (args.op) return downloadWorld(await waitForWorld(args.op), videoPath);
  if (!videoPath) {
    console.error("Usage: node scripts/marble.mjs <video.mp4> [--name NAME] [--model marble-1.1]");
    process.exit(1);
  }
  const assetId = await uploadVideo(videoPath);
  const opId = await generate(assetId, args.name || path.basename(videoPath), args.model || "marble-1.1");
  const worldId = await waitForWorld(opId);
  await downloadWorld(worldId, videoPath);
}

main().catch((e) => {
  console.error("\n" + e.message);
  process.exit(1);
});
