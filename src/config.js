// Viewer settings. Every value here can also be overridden from the URL, e.g.
//   https://<laptop-ip>:5173/?splat=100k&flip=0&cam=0,0.2,0&yaw=90&debug=1
// so you can tweak things on the phone without rebuilding.

export const defaults = {
  // Which folder under public/ to load the world from (world.json, splats, collider.glb, video).
  world: "world",

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

  // Follow the camera's pan with the projector, using public/world/rotation.json when it exists
  // (made by: npm run track). ?track=0 pins the video to its first-frame spot for comparison.
  track: true,

  // Hide parts of the splat (people, stray objects). Boxes in viewer meters, centre then size,
  // separated by ";":  ?cut=1.2,0.9,-1.5,0.8,1.6,0.8;-1,1,-2,0.5,1,0.5
  // Axes: +x right, +y up, -z forward from the viewer (y = 0 is the floor).
  cut: "",

  // With a rotation track: pin the video to where its first frame sits in the room, stretching
  // it if needed, so the people at the table stay on their spots. ?anchor=0 uses the camera's
  // clean rotation instead (no stretch, but the people drift off Marble's copies of them).
  anchor: true,

  // Colour the room's splats from the video instead of drawing it as a layer (src/splatPaint.js).
  // world.json can switch it on with "paint": true; ?paint=0 turns it off for comparison.
  paint: false,

  // Depth mesh (src/depthMesh.js): the video as real geometry at the depths in world.json "depth", so
  // each Cardboard eye sees a slightly different view. ?depth=1 to turn on, ?depthScale=1.2 to stretch distances.
  depth: false,
  depthScale: 1,

  // Tracked people (src/trackedPeople.js): when public/world/tracks.json exists (npm run track-people),
  // each person VitTrack followed becomes a cut-out card in the room instead of the flat overlay.
  // ?people=0 goes back to the overlay. Uses depthScale for their distances.
  people: true,

  // Cut-out person card (src/cutout.js), used when world.json has "cutout". Where it stands, in metres
  // from the viewer ("x,z", -z = ahead), and its height in metres. Empty / 0 = world.json values.
  cutout: "",
  cutoutH: 0,

  // Where the viewer starts, "x,z" metres from the Marble origin (+x right, -z ahead). Empty = world.json "start".
  start: "",

  // Shows the collider mesh as a wireframe plus axes, to check alignment.
  debug: false,
};

function parseValue(key, raw) {
  const def = defaults[key];
  if (typeof def === "boolean") return raw === "1" || raw === "true";
  if (typeof def === "number") return Number(raw);
  if (key === "cut") return raw;
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
