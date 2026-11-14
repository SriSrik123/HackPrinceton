// Viewer settings. Every value here can also be overridden from the URL, e.g.
//   https://<laptop-ip>:5173/?splat=100k&flip=0&cam=0,0.2,0&yaw=90&debug=1
// so you can tweak things on the phone without rebuilding.

export const defaults = {
  // Which Marble splat to load: "500k" (sharper) or "100k" (lighter, use if the phone stutters)
  splat: "500k",

  // Marble SPZ files are in an OpenCV-style frame (Y down). Marble's own viewer and Spark's
  // examples rotate them 180 degrees around X. If the room shows up upside down, set this to false.
  flip: true,

  // Extra 180 degree X flip for the collider GLB only, on top of `flip`.
  // Leave false unless debug mode shows the wireframe upside down relative to the splat.
  colliderFlip: false,

  // Apply semantics_metadata (metric_scale_factor + ground_plane_offset) from world.json so
  // 1 unit = 1 meter and the floor is at y = 0. Matters in VR because eye spacing is in meters.
  metricScale: true,

  // Where the viewer's head sits. "origin" = where the raw Marble origin lands after flip/scale,
  // which should be the original camera's spot (assumption, check it with debug=1).
  // Or give explicit world coordinates in meters: [x, y, z]
  cam: "origin",

  // Which way the viewer faces at the start, in degrees around the vertical axis (0 = -Z).
  yaw: 0,

  // Eye separation for the Cardboard fallback (meters). Most people are 0.06 to 0.07.
  eyeSep: 0.064,

  // Shows the collider mesh as a wireframe plus axes, to check alignment.
  debug: false,
};

function parseValue(key, raw) {
  const def = defaults[key];
  if (typeof def === "boolean") return raw === "1" || raw === "true";
  if (typeof def === "number") return Number(raw);
  if (key === "cam" && raw !== "origin") return raw.split(",").map(Number);
  return raw;
}

export function loadConfig() {
  const cfg = { ...defaults };
  const params = new URLSearchParams(location.search);
  for (const key of Object.keys(defaults)) {
    if (params.has(key)) cfg[key] = parseValue(key, params.get(key));
  }
  return cfg;
}
