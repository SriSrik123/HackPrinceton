// "Paint" mode: instead of drawing the video as a layer on the room mesh, colour the room's own
// splats from the video. Every splat is projected into the video frame from the projector's spot;
// the ones that land inside the frame take the video's colour there, fading out toward the edge.
// So the video becomes part of the room: it is lit and shaped by the splats, with no separate layer,
// and nothing outside the frame changes.
//
//   const paint = addSplatPaint(splat, projection);   // projection = addProjection(...) from projection.js
//   paint.update();                                    // every frame (main.js does this)
//
// The framing (turn, tilt, size, edge fade, opacity, brightness, colour) is still the projection's
// own params, so the Framing panel and ?proj... URL values keep working. Set the projection's
// `enabled` to false so its overlay does not draw as well.
//
// Limits: a splat takes ONE colour from the video, so the picture is only as sharp as the splat
// count (the 500k file gives roughly 150k to 250k splats inside the frame), and it is exactly
// right only from the projector's spot. Move the viewer and the colours slide along the room's
// surfaces, which is the cost of having no separate layer.

import { dyno } from "@sparkjsdev/spark";

const {
  dynoBlock, Gsplat, splitGsplat, combineGsplat, dynoMat4, dynoFloat, dynoSampler2D,
  mul, div, add, sub, mix, min, max, smoothstep, select, greaterThan, texture,
  split, combine, extendVec, swizzle, dot, dynoConst, vec3, clamp, length,
} = dyno;

const LUMA = [0.2126, 0.7152, 0.0722];
const EXTEND_STRENGTH = 0.9, EXTEND_BLUR = 5; // same look as the overlay's fill (projection.js)

export function addSplatPaint(splat, projection) {
  const uniforms = projection.material.uniforms;
  const projView = dynoMat4(uniforms.projView.value.clone());
  const map = dynoSampler2D(uniforms.map.value);
  const fade = dynoFloat(0.2);
  const extend = dynoFloat(0);
  const strength = dynoFloat(1);
  const brightness = dynoFloat(1);
  const saturation = dynoFloat(1);

  const f = (x) => dynoConst("float", x);

  splat.worldModifier = dynoBlock({ gsplat: Gsplat }, { gsplat: Gsplat }, ({ gsplat }) => {
    const { center, rgb } = splitGsplat(gsplat).outputs;

    // Where this splat falls in the video frame, 0 to 1 in both directions.
    const clip = mul(projView, extendVec(center, f(1)));
    const c = split(clip).outputs;
    const invW = div(f(1), max(c.w, f(1e-4)));
    const u = add(mul(mul(c.x, invW), f(0.5)), f(0.5));
    const v = add(mul(mul(c.y, invW), f(0.5)), f(0.5));
    const uv = combine({ vectorType: "vec2", x: u, y: v });

    // Soft edge: distance to the nearest border, same as the overlay shader in projection.js.
    const edge = min(min(u, sub(f(1), u)), min(v, sub(f(1), v)));
    const aFrame = smoothstep(f(0), max(fade, f(1e-3)), edge);

    // Past the frame: the nearest video pixels, blurred, fading with distance (projection.js "extend").
    const inside = clamp(uv, f(0), f(1));
    const outside = length(sub(uv, inside));
    const aExtRaw = mul(sub(f(1), smoothstep(f(0), max(extend, f(1e-3)), outside)), f(EXTEND_STRENGTH));
    const aExt = select(greaterThan(extend, f(0)), aExtRaw, f(0));
    const aAll = add(aFrame, mul(aExt, sub(f(1), aFrame)));
    let a = mul(strength, aAll);
    a = select(greaterThan(c.w, f(1e-4)), a, f(0)); // behind the projector: untouched

    // The video's colour there, with the same brightness and colour controls as the overlay.
    const frameColor = swizzle(texture(map, inside), "rgb");
    const fillColor = swizzle(texture(map, inside, f(EXTEND_BLUR)), "rgb");
    const weighted = add(mul(frameColor, aFrame), mul(fillColor, mul(aExt, sub(f(1), aFrame))));
    let color = mul(div(weighted, max(aAll, f(1e-4))), brightness);
    const gray = dot(color, vec3(dynoConst("vec3", LUMA)));
    color = mix(combine({ vectorType: "vec3", x: gray, y: gray, z: gray }), color, saturation);

    return { gsplat: combineGsplat({ gsplat, rgb: mix(rgb, color, a) }) };
  });
  splat.updateGenerator?.();

  // Pushes the projection's current values into the shader, and asks Spark to recolour the splats
  // only when something changed (a new video frame or a moved slider), not every render.
  let lastTime = -1, lastKey = "";
  function update() {
    const p = projection.params;
    const view = uniforms.projView.value;
    const video = uniforms.map.value?.image;
    const time = video && "currentTime" in video ? video.currentTime : 0;
    const key = `${view.elements.join(",")}|${p.fade}|${p.extend}|${p.opacity}|${p.brightness}|${p.saturation}`;
    if (key === lastKey && time === lastTime) return;
    lastKey = key;
    lastTime = time;
    projView.value.copy(view);
    map.value = uniforms.map.value;
    fade.value = p.fade;
    extend.value = p.extend;
    strength.value = p.opacity;
    brightness.value = p.brightness;
    saturation.value = p.saturation;
    splat.updateVersion();
  }

  return { update };
}
