// Cut-out person: a "stacked alpha" video (colour in the top half, the mask as gray in the bottom
// half) drawn on a flat card standing on the floor, facing the viewer. Plays on iPhone Safari too,
// which a WebM with alpha does not.
//
//   const cutout = addCutout(scene, video, { at: [0, -2.5], height: 1.7, viewer: rig });
//   cutout.update();   // every frame: keeps the card turned toward the viewer
//
// at: [x, z] in metres from the viewer (-z = straight ahead, +x = right). y = 0 is the floor.
// height: card height in metres (the person's full height in the video, head to feet).

import * as THREE from "three";

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform float opacity, brightness;
varying vec2 vUv;
void main() {
  vec3 color = texture2D(map, vec2(vUv.x, 0.5 + vUv.y * 0.5)).rgb;   // top half
  float a = texture2D(map, vec2(vUv.x, vUv.y * 0.5)).r;              // bottom half
  a = smoothstep(0.15, 0.85, a) * opacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(color * brightness, a);
  #include <colorspace_fragment>
}`;

export function addCutout(scene, video, { at = [0, -2.5], height = 1.7, viewer, opacity = 1, brightness = 1 } = {}) {
  const texture = new THREE.VideoTexture(video);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;

  const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / (video.videoHeight / 2) : 0.52;
  const geometry = new THREE.PlaneGeometry(height * aspect, height);
  geometry.translate(0, height / 2, 0); // pivot at the feet
  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: texture }, opacity: { value: opacity }, brightness: { value: brightness } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const card = new THREE.Mesh(geometry, material);
  card.name = "cutout";
  card.renderOrder = 2;
  scene.add(card);

  const target = new THREE.Vector3();
  function place(pos = at) {
    at = pos;
    const yaw = viewer ? viewer.rotation.y : 0;
    const offset = new THREE.Vector3(at[0], 0, at[1]).applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const base = viewer ? viewer.position : new THREE.Vector3();
    card.position.set(base.x + offset.x, 0, base.z + offset.z);
  }
  function update() {
    if (!viewer) return;
    viewer.getWorldPosition(target);
    card.lookAt(target.x, card.position.y, target.z); // turn around Y only, stay upright
  }
  place();
  update();

  return {
    card,
    update,
    place,
    setHeight(h) { card.scale.setScalar(h / height); },
    dispose() { scene.remove(card); geometry.dispose(); material.dispose(); texture.dispose(); },
  };
}
