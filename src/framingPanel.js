// On-screen sliders for placing the video in the room: where the frame sits (turn, tilt, roll,
// size) and how it looks (edge blur, opacity, brightness...). Opened with the "Framing" button.
//
//   addFramingPanel(projection, { world: "world", initial: { yaw: 30 } });
//
// Settings are remembered per world folder in this browser (localStorage). "Copy link" gives a
// URL with the same settings as ?proj... values, to open on a phone or share with the team.
// Hidden in Cardboard mode (index.html).

const CONTROLS = [
  // key, label, min, max, step
  ["yaw", "Turn left / right", -180, 180, 0.5],
  ["pitch", "Tilt up / down", -60, 60, 0.5],
  ["roll", "Roll", -30, 30, 0.5],
  ["fov", "Size (field of view)", 10, 120, 0.5],
  ["fade", "Edge blur", 0, 0.5, 0.01],
  ["extend", "Fill beyond frame", 0, 3, 0.05],
  ["opacity", "Opacity", 0, 1, 0.01],
  ["brightness", "Brightness", 0.2, 2, 0.01],
  ["saturation", "Color", 0, 1.5, 0.01],
  ["shading", "Room shading", 0, 1, 0.01],
];
const KEYS = [...CONTROLS.map((c) => c[0]), "overlay"];
const STORE_PREFIX = "party-framing:";

import { Vector3 } from "three";

const CSS = `
#framing-toggle { position: fixed; top: 10px; right: 10px; z-index: 20; font-size: 13px; padding: 6px 10px; border-radius: 6px; border: 1px solid #fff8; background: #0008; color: #fff; }
#framing { position: fixed; top: 46px; right: 10px; z-index: 20; width: 250px; max-height: calc(100% - 60px); overflow-y: auto; box-sizing: border-box; padding: 10px 12px; border-radius: 8px; background: #000b; font-size: 12px; touch-action: pan-y; }
#framing[hidden] { display: none; }
#framing label { display: block; margin-bottom: 8px; }
#framing .row { display: flex; justify-content: space-between; }
#framing input[type=range] { width: 100%; margin: 2px 0 0; }
#framing .buttons { display: flex; gap: 6px; margin-top: 4px; }
#framing button { flex: 1; font-size: 12px; padding: 6px 4px; border-radius: 6px; border: 1px solid #fff8; background: #0008; color: #fff; }
body.cardboard #framing, body.cardboard #framing-toggle { display: none !important; }
`;

function readSaved(world) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_PREFIX + world) || "null");
    return saved && typeof saved === "object" ? saved : null;
  } catch {
    return null; // private window or blocked storage: just start from the defaults
  }
}

// What this browser saved for the world earlier, limited to the panel's own keys.
export function savedFraming(world) {
  const saved = readSaved(world);
  if (!saved) return {};
  return Object.fromEntries(KEYS.filter((k) => Number.isFinite(saved[k])).map((k) => [k, saved[k]]));
}

// The viewer's own camera, separate from the projector: a wider field of view shows more of the
// room around the video, and stepping back moves the head away from the original camera spot.
const VIEW = [
  ["viewFov", "Zoom out (viewer FOV)", 40, 160, 1],
  ["back", "Step back (m)", 0, 10, 0.05],
];

export function addFramingPanel(projection, { world, initial = {}, viewer = null, paint = false }) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);

  const toggle = document.createElement("button");
  toggle.id = "framing-toggle";
  toggle.textContent = "Framing";
  const panel = document.createElement("div");
  panel.id = "framing";
  panel.hidden = true;
  toggle.onclick = () => { panel.hidden = !panel.hidden; };

  const inputs = {};
  const show = (key) => {
    const value = projection.params[key];
    inputs[key].range.value = value;
    inputs[key].out.textContent = Number(value).toFixed(key === "yaw" || key === "pitch" || key === "roll" || key === "fov" ? 1 : 2);
  };
  const save = () => {
    try {
      localStorage.setItem(STORE_PREFIX + world, JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, projection.params[k]]))));
    } catch { /* storage blocked: the sliders still work for this visit */ }
  };

  const controls = paint ? [...CONTROLS, ["overlay", "Overlay layer (sharpness)", 0, 1, 0.01]] : CONTROLS;
  for (const [key, label, min, max, step] of controls) {
    const wrap = document.createElement("label");
    const row = document.createElement("div");
    row.className = "row";
    const name = document.createElement("span");
    name.textContent = label;
    const out = document.createElement("span");
    row.append(name, out);
    const range = document.createElement("input");
    Object.assign(range, { type: "range", min, max, step });
    range.addEventListener("input", () => {
      projection.update({ [key]: Number(range.value) });
      show(key);
      save();
    });
    wrap.append(row, range);
    panel.appendChild(wrap);
    inputs[key] = { range, out };
    show(key);
  }

  if (viewer) {
    const { camera, rig } = viewer;
    const base = rig.position.clone();
    const back = new Vector3(Math.sin(rig.rotation.y), 0, Math.cos(rig.rotation.y)); // opposite of where the viewer faces
    const view = { viewFov: camera.fov, back: 0, ...(readSaved(world + ":view") || {}) };
    const apply = () => {
      camera.fov = view.viewFov;
      camera.updateProjectionMatrix();
      rig.position.copy(base).addScaledVector(back, view.back);
    };
    for (const [key, label, min, max, step] of VIEW) {
      const wrap = document.createElement("label");
      const row = document.createElement("div");
      row.className = "row";
      const name = document.createElement("span");
      name.textContent = label;
      const out = document.createElement("span");
      row.append(name, out);
      const range = document.createElement("input");
      Object.assign(range, { type: "range", min, max, step, value: view[key] });
      out.textContent = Number(view[key]).toFixed(key === "back" ? 2 : 0);
      range.addEventListener("input", () => {
        view[key] = Number(range.value);
        out.textContent = view[key].toFixed(key === "back" ? 2 : 0);
        apply();
        try { localStorage.setItem(STORE_PREFIX + world + ":view", JSON.stringify(view)); } catch { /* storage blocked */ }
      });
      wrap.append(row, range);
      panel.appendChild(wrap);
    }
    apply();
  }

  const buttons = document.createElement("div");
  buttons.className = "buttons";
  const reset = document.createElement("button");
  reset.textContent = "Reset";
  reset.onclick = () => {
    try { localStorage.removeItem(STORE_PREFIX + world); } catch { /* nothing saved */ }
    projection.update({ ...initial });
    KEYS.forEach(show);
  };
  const copy = document.createElement("button");
  copy.textContent = "Copy link";
  copy.onclick = async () => {
    const url = new URL(location.href);
    for (const key of KEYS) url.searchParams.set("proj" + key[0].toUpperCase() + key.slice(1), String(+Number(projection.params[key]).toFixed(3)));
    try {
      await navigator.clipboard.writeText(url.href);
      copy.textContent = "Copied";
    } catch {
      prompt("Copy this link:", url.href); // clipboard blocked (some phones)
    }
    setTimeout(() => { copy.textContent = "Copy link"; }, 1500);
  };
  buttons.append(reset, copy);
  panel.appendChild(buttons);

  document.body.append(toggle, panel);
  return { panel, refresh: () => KEYS.forEach(show) };
}
