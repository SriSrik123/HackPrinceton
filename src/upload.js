// Upload page: one mp4, up to 4 pictures and a prompt. Talks to scripts/upload-server.mjs through /api.
// The server does the work (transcode, Marble room, depth) and reports where it is; this page only shows it.

const MAX_IMAGES = 4;
const $ = (id) => document.getElementById(id);
const el = {
  drop: $("drop"), title: $("drop-title"), sub: $("drop-sub"), video: $("video"), images: $("images"), pics: $("pics"),
  pin: $("pin"), pinRow: $("pin-row"), prompt: $("prompt"), go: $("go"), bar: $("bar"), msg: $("msg"), open: $("open"),
};

let images = [];          // File[]
let running = false;      // this tab is uploading or waiting on a run
let timer = null;

let msgIsError = false;
const say = (text, error = false) => {
  msgIsError = error;
  el.msg.textContent = text;
  el.msg.className = error ? "err" : "";
  el.msg.setAttribute("aria-live", error ? "assertive" : "polite"); // errors interrupt a screen reader, progress does not
};
const ready = () => Boolean(el.video.files[0]) && !running;
function refresh() {
  el.go.disabled = !ready();
  el.go.textContent = running ? "Creating\u2026" : "Create";
  el.go.setAttribute("aria-busy", String(running));
  // Say why Create is off instead of leaving it silently grey.
  if (!running && !msgIsError && el.open.hidden) say(el.video.files[0] ? "" : "Add an mp4 to start.");
}

// ---- video box ------------------------------------------------------------
function showVideo(file) {
  el.drop.classList.toggle("has", Boolean(file));
  el.title.textContent = file ? file.name : "Add mp4";
  el.sub.textContent = file ? `${(file.size / 1e6).toFixed(1)} MB, tap to change` : "Drop your video here or tap to choose";
  if (msgIsError) say("");
  refresh();
}
el.video.addEventListener("change", () => showVideo(el.video.files[0]));
for (const type of ["dragenter", "dragover"]) el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.add("over"); });
for (const type of ["dragleave", "drop"]) el.drop.addEventListener(type, (e) => { e.preventDefault(); el.drop.classList.remove("over"); });
el.drop.addEventListener("drop", (e) => {
  const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v)$/i.test(f.name));
  if (!file) return;
  const list = new DataTransfer();
  list.items.add(file);
  el.video.files = list.files;
  showVideo(file);
});

// ---- pictures -------------------------------------------------------------
function renderPics() {
  [...el.pics.querySelectorAll(".thumb")].forEach((n) => n.remove());
  const add = el.pics.querySelector("label");
  images.forEach((file, i) => {
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    thumb.setAttribute("role", "img");
    thumb.setAttribute("aria-label", `Image ${i + 1}: ${file.name}`);
    thumb.style.backgroundImage = `url(${URL.createObjectURL(file)})`;
    const x = document.createElement("button");
    x.type = "button";
    x.setAttribute("aria-label", `Remove image ${i + 1}`);
    x.onclick = () => { images.splice(i, 1); renderPics(); (el.pics.querySelector(".thumb button") ?? el.images).focus(); };
    thumb.appendChild(x);
    el.pics.insertBefore(thumb, add);
  });
  add.hidden = images.length >= MAX_IMAGES;
}
el.images.addEventListener("change", () => {
  images = [...images, ...el.images.files].slice(0, MAX_IMAGES);
  el.images.value = "";
  renderPics();
});

// ---- sending --------------------------------------------------------------
function post(url, body, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    if (el.pin.value) xhr.setRequestHeader("x-pin", el.pin.value);
    if (body && !(body instanceof Blob)) xhr.setRequestHeader("Content-Type", "application/json");
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded);
    xhr.onload = () => {
      let json = {};
      try { json = JSON.parse(xhr.responseText); } catch {}
      xhr.status < 300 ? resolve(json) : reject(new Error(json.error || `Failed (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Cannot reach the upload server. Run: npm run upload-server"));
    xhr.send(body instanceof Blob ? body : body ? JSON.stringify(body) : undefined);
  });
}

const extOf = (file) => (file.name.split(".").pop() || "").toLowerCase();

async function create() {
  const video = el.video.files[0];
  if (!video) return;
  running = true;
  el.open.hidden = true;
  el.open.setAttribute("href", "/");
  el.bar.hidden = false;
  el.bar.value = 0;
  refresh();
  try {
    const { id } = await post("/api/party/draft");
    const files = [{ file: video, kind: "video" }, ...images.map((file) => ({ file, kind: "image" }))];
    const total = files.reduce((sum, f) => sum + f.file.size, 0);
    let done = 0;
    for (const { file, kind } of files) {
      say("Uploading");
      await post(`/api/party/file?draft=${id}&kind=${kind}&ext=${encodeURIComponent(extOf(file))}`, file, (loaded) => {
        el.bar.value = Math.round(((done + loaded) / total) * 100);
      });
      done += file.size;
    }
    el.bar.removeAttribute("value"); // indeterminate while the server works
    await post("/api/party/start", { draft: id, prompt: el.prompt.value.trim() });
    poll();
    timer = setInterval(poll, 2000);
  } catch (e) {
    fail(e.message);
  }
}

function fail(message) {
  clearInterval(timer);
  running = false;
  el.bar.hidden = true;
  say(message, true);
  refresh();
}

async function poll() {
  let job;
  try {
    job = await (await fetch("/api/party/status", { cache: "no-store" })).json();
  } catch {
    return; // a missed poll is fine, the next one will tell
  }
  if (job.state === "failed") return fail(job.message);
  if (job.state === "done") {
    clearInterval(timer);
    running = false;
    el.bar.hidden = true;
    say("");
    el.open.href = `/?world=${job.world}`;
    el.open.hidden = false;
    refresh();
    el.open.focus(); // keyboard and screen reader users land on the next step
    return;
  }
  say(job.message);
}

// Keep optional PIN protection available with the draft-based upload workflow.
fetch("/api/party/status", { cache: "no-store" })
  .then((res) => res.json())
  .then((status) => { el.pinRow.hidden = !status.pinRequired; })
  .catch(() => {});

el.go.addEventListener("click", create);
renderPics();
refresh();

// The room behind the card. Loaded last so the form never waits for it; if it fails the page stays plain dark.
import("./uploadBackdrop.js")
  .then((m) => m.startBackdrop($("bg"), new URLSearchParams(location.search).get("world") || "world"))
  .catch((e) => console.warn("[upload] background unavailable", e));
