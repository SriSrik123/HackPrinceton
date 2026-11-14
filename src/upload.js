// Upload page for party mode (KAN-15). Talks to scripts/upload-server.mjs through /api.
// The server does the real work and reports an honest state; this page only shows it.

const MAX_BYTES = 100 * 1024 * 1024;
const EXTS = ["mp4", "mov", "webm", "avi"];
const STEPS = ["receiving", "uploading", "building", "downloading", "done"];

const $ = (id) => document.getElementById(id);
const el = { file: $("file"), name: $("name"), pin: $("pin"), pinRow: $("pin-row"), confirm: $("confirm"), start: $("start"),
  formError: $("form-error"), banner: $("banner"), statusCard: $("status-card"), steps: $("steps"), progress: $("upload-progress"),
  msg: $("status-msg"), elapsed: $("elapsed"), open: $("open") };

let server = null;          // last /api/party/status
let localUpload = null;     // { pct } while this browser is sending the file
let startedHere = false;    // true after this tab started a run

const extOf = (file) => (file.name.split(".").pop() || "").toLowerCase();

function formProblem() {
  const file = el.file.files[0];
  if (!file) return "Choose a video first.";
  if (!EXTS.includes(extOf(file))) return "Marble accepts mp4, mov, webm or avi.";
  if (file.size > MAX_BYTES) return `This video is ${(file.size / 1e6).toFixed(0)} MB. Marble's limit is 100 MB. Re-encode it first (see the README).`;
  if (file.size === 0) return "That file is empty.";
  return "";
}

function busy() {
  return localUpload != null || (server && ["receiving", "uploading", "building", "downloading"].includes(server.state));
}

function renderForm() {
  const problem = el.file.files[0] ? formProblem() : "";
  el.formError.textContent = problem;
  const keyMissing = server && !server.keyConfigured;
  const unreachable = server === null;
  el.start.disabled = Boolean(unreachable || keyMissing || busy() || !el.file.files[0] || problem || !el.confirm.checked);
  el.pinRow.hidden = !server?.pinRequired;
  el.banner.hidden = !(unreachable || keyMissing);
  if (unreachable) el.banner.textContent = "Cannot reach the upload server. Start it with: npm run upload-server";
  else if (keyMissing) el.banner.textContent = "The upload server has no WLT_API_KEY, so it cannot start a run. Stop it, export the key and start it again.";
}

function renderStatus() {
  if (!server) return;
  const state = localUpload ? "receiving" : server.state;
  const show = state !== "idle" || startedHere;
  el.statusCard.hidden = !show;
  if (!show) return;

  const index = STEPS.indexOf(state);
  [...el.steps.children].forEach((li, i) => {
    li.className = "";
    if (state === "failed") li.className = i === 0 && !server.startedAt ? "failed" : "";
    else if (i < index || state === "done") li.className = "done";
    else if (i === index) li.className = "active";
  });
  if (state === "failed") {
    // mark the step that was running when it failed
    const last = server.log?.length ? (server.log.some((l) => /^Downloading assets/.test(l)) ? "downloading"
      : server.log.some((l) => /^Generation started/.test(l)) ? "building"
      : server.log.some((l) => /^Preparing upload/.test(l)) ? "uploading" : "receiving") : "receiving";
    el.steps.querySelector(`[data-step="${last}"]`).className = "failed";
  }

  el.progress.hidden = state !== "receiving" || !localUpload;
  if (localUpload) el.progress.value = localUpload.pct;
  el.msg.className = state === "failed" ? "err" : "";
  el.msg.textContent = localUpload ? `Uploading to this computer: ${localUpload.pct}%` : server.message;
  el.open.hidden = state !== "done";
  if (state === "done") el.open.href = `/?r=${server.finishedAt}`; // cache bust so the viewer reloads the new files

  if (server.startedAt && !["done", "failed", "idle"].includes(state)) {
    el.elapsed.textContent = `Running for ${Math.round((Date.now() - server.startedAt) / 1000)} s`;
  } else if (server.startedAt && server.finishedAt) {
    el.elapsed.textContent = `Took ${Math.round((server.finishedAt - server.startedAt) / 1000)} s`;
  } else el.elapsed.textContent = "";
}

async function poll() {
  try {
    const res = await fetch("/api/party/status", { cache: "no-store" });
    server = res.ok ? await res.json() : null;
  } catch {
    server = null;
  }
  renderForm();
  renderStatus();
}

function startUpload() {
  const file = el.file.files[0];
  const problem = formProblem();
  if (problem || !el.confirm.checked) return;

  const params = new URLSearchParams({ ext: extOf(file), name: el.name.value.trim() || "Party video" });
  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/party?${params}`);
  xhr.setRequestHeader("x-confirm", "spend-credits");
  if (el.pin.value) xhr.setRequestHeader("x-pin", el.pin.value);
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) { localUpload = { pct: Math.round((e.loaded / e.total) * 100) }; renderForm(); renderStatus(); }
  };
  xhr.onload = () => {
    localUpload = null;
    if (xhr.status !== 202) {
      let message = `Upload failed (HTTP ${xhr.status}).`;
      try { message = JSON.parse(xhr.responseText).error || message; } catch {}
      el.formError.textContent = message;
    }
    poll();
  };
  xhr.onerror = () => { localUpload = null; el.formError.textContent = "The upload was interrupted."; poll(); };

  startedHere = true;
  localUpload = { pct: 0 };
  el.confirm.checked = false; // each paid run needs a fresh confirmation
  renderForm();
  renderStatus();
  xhr.send(file);
}

el.file.addEventListener("change", renderForm);
el.confirm.addEventListener("change", renderForm);
el.start.addEventListener("click", startUpload);
poll();
setInterval(poll, 2000);
