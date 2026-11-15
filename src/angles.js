// "Find more angles" page (angles.html). Talks to scripts/upload-server.mjs through /api/angles.
const $ = (id) => document.getElementById(id);

// The browser pulls a few frames and a short stretch of the clip's own audio. The server
// transcribes that audio, then Grok searches X. No artist or venue fields.
const A = { file: $("angles-file"), go: $("angles-go"), msg: $("angles-msg"), event: $("angles-event"), heard: $("angles-heard"),
  list: $("angles-list"), banner: $("angles-banner"), cache: $("angles-cache"), pin: $("angles-pin"), pinRow: $("angles-pin-row") };
let aStatus = null;
let aGrabbing = false;

// 3 JPEG frames (at 15%, 50%, 85% of the clip), 512 px wide, as data URLs.
async function grabFrames(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.preload = "auto"; video.src = url;
  try {
    await new Promise((ok, no) => { video.onloadedmetadata = ok; video.onerror = () => no(new Error("The browser cannot read this video.")); });
    const canvas = document.createElement("canvas");
    canvas.width = 512; canvas.height = Math.round(512 * (video.videoHeight / video.videoWidth)) || 288;
    const frames = [];
    for (const f of [0.15, 0.5, 0.85]) {
      video.currentTime = Math.min((video.duration || 0) * f, Math.max(0, (video.duration || 0) - 0.05));
      await new Promise((ok, no) => { video.onseeked = ok; video.onerror = () => no(new Error("Could not read a frame from this video.")); });
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.7));
    }
    return frames;
  } finally { URL.revokeObjectURL(url); }
}

// ~24s of mono 16 kHz WAV from 20% into the clip, where the song usually is. Data URL, or null.
function encodeWav(samples, sampleRate) {
  const bytes = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) bytes.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); bytes.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  bytes.setUint32(16, 16, true); bytes.setUint16(20, 1, true); bytes.setUint16(22, 1, true);
  bytes.setUint32(24, sampleRate, true); bytes.setUint32(28, sampleRate * 2, true);
  bytes.setUint16(32, 2, true); bytes.setUint16(34, 16, true); str(36, "data");
  bytes.setUint32(40, samples.length * 2, true);
  for (let i = 0, o = 44; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    bytes.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes.buffer;
}

async function grabAudio(file) {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    if (!decoded.duration || !decoded.numberOfChannels) return null;
    const rate = 16000;
    const start = Math.min(decoded.duration * 0.2, Math.max(0, decoded.duration - 8));
    const length = Math.min(24, decoded.duration - start);
    const offline = new OfflineAudioContext(1, Math.ceil(length * rate), rate);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start(0, start, length);
    const rendered = await offline.startRendering();
    const pcm = rendered.getChannelData(0);
    let bin = "";
    const raw = new Uint8Array(encodeWav(pcm, rate));
    for (let i = 0; i < raw.length; i += 0x8000) bin += String.fromCharCode(...raw.subarray(i, i + 0x8000));
    return `data:audio/wav;base64,${btoa(bin)}`;
  } catch {
    return null;
  } finally { await ctx.close().catch(() => {}); }
}

function showResult(r) {
  A.event.textContent = r.event ? `Grok thinks this is: ${r.event} (confidence: ${r.confidence})` : "";
  A.heard.textContent = r.transcript ? `Heard: ${r.transcript}` : "";
  A.list.replaceChildren(...(r.posts || []).map((p) => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = p.url; a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = p.url;
    li.append(a, document.createElement("br"), `${p.handle} ${p.description}`.trim());
    return li;
  }));
}

function renderAngles() {
  const s = aStatus;
  const busyA = aGrabbing || s?.state === "searching";
  A.pinRow.hidden = !s?.pinRequired;
  A.banner.hidden = !(s === null || !s.keyConfigured);
  A.banner.textContent = s === null ? "Cannot reach the upload server. Start it with: npm run upload-server" : "The upload server has no XAI_API_KEY. Add it to .env and restart the server.";
  A.go.disabled = Boolean(!s || !s.keyConfigured || busyA || !A.file.files[0]);
  A.cache.hidden = !s?.cached || busyA;
  if (aGrabbing) { A.msg.className = "muted"; A.msg.textContent = "Reading the video..."; }
  else if (s && s.state !== "idle") {
    A.msg.className = s.state === "failed" ? "err" : "muted";
    A.msg.textContent = s.state === "searching" ? `${s.message} (${Math.round((Date.now() - s.startedAt) / 1000)} s)` : s.message;
    if (s.state === "done" && s.result) showResult(s.result);
  }
}

async function pollAngles() {
  try { const res = await fetch("/api/angles/status", { cache: "no-store" }); aStatus = res.ok ? await res.json() : null; } catch { aStatus = null; }
  renderAngles();
}

async function startAngles() {
  const file = A.file.files[0];
  if (!file) { A.msg.className = "err"; A.msg.textContent = "Choose a video first."; return; }
  if (aGrabbing || aStatus?.state === "searching") return;
  A.list.replaceChildren(); A.event.textContent = ""; A.heard.textContent = "";
  aGrabbing = true; renderAngles();
  let frames, audio;
  try { [frames, audio] = await Promise.all([grabFrames(file), grabAudio(file)]); }
  catch (e) { aGrabbing = false; A.msg.className = "err"; A.msg.textContent = e.message; renderAngles(); return; }
  aGrabbing = false;
  const headers = { "Content-Type": "application/json" };
  if (A.pin.value) headers["x-pin"] = A.pin.value;
  let res;
  try { res = await fetch("/api/angles", { method: "POST", headers, body: JSON.stringify({ frames, audio, name: file.name }) }); }
  catch { A.msg.className = "err"; A.msg.textContent = "Cannot reach the upload server. Start it with: npm run upload-server"; renderAngles(); return; }
  if (!res.ok) { A.msg.className = "err"; A.msg.textContent = (await res.json().catch(() => ({}))).error || `Failed (HTTP ${res.status}).`; renderAngles(); return; }
  pollAngles();
}

A.file.addEventListener("change", () => { renderAngles(); startAngles(); });
A.go.addEventListener("click", startAngles);
A.cache.addEventListener("click", () => { A.msg.className = "muted"; A.msg.textContent = "Showing the last saved result."; showResult(aStatus.cached); });
pollAngles();
setInterval(pollAngles, 2000);
