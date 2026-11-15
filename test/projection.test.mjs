import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { addProjection } from "../src/projection.js";

const closeMatrix = (a, b) => a.elements.forEach((n, i) => assert.ok(Math.abs(n - b.elements[i]) < 1e-9));

test("concert projections keep independent visibility and poses on a shared stage", () => {
  const scene = new THREE.Scene();
  const stage = new THREE.Mesh(new THREE.PlaneGeometry(4, 3), new THREE.MeshBasicMaterial());
  stage.visible = false;
  scene.add(stage);
  const source = new THREE.Texture({ width: 1920, height: 1080 });
  const first = addProjection(scene, source, [stage], { pos: [0, 1, 2], yaw: 10 });
  const second = addProjection(scene, source, [stage], { pos: [2, 1, 2], yaw: -10, enabled: false });
  try {
    assert.equal(first.material.visible, true);
    assert.equal(second.material.visible, false);
    assert.equal(first.params.extend, 0);
    assert.equal(first.material.uniforms.opacity.value, 1);
    const otherPose = second.material.uniforms.projView.value.clone();
    first.update({ enabled: false, opacity: 0.4 });
    second.update({ enabled: true });
    assert.equal(first.material.visible, false);
    assert.equal(second.material.visible, true);
    assert.equal(second.material.uniforms.opacity.value, 1);
    closeMatrix(second.material.uniforms.projView.value, otherPose);
    first.dispose();
    assert.equal(stage.children.length, 1);
    assert.equal(stage.visible, true);
  } finally {
    second.dispose();
    source.dispose();
    stage.geometry.dispose();
    stage.material.dispose();
  }
  assert.equal(stage.children.length, 0);
  assert.equal(stage.visible, false);
});

test("party tracking and framing support rotations, zoom, matrix overrides and overlay strength", () => {
  const scene = new THREE.Scene();
  const stage = new THREE.Mesh(new THREE.PlaneGeometry(4, 3), new THREE.MeshBasicMaterial());
  scene.add(stage);
  const source = new THREE.Texture({ width: 1280, height: 720 });
  const projection = addProjection(scene, source, [stage], { fov: 50 });
  try {
    const initial = projection.material.uniforms.projView.value.clone();
    const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
    projection.aim(turn, 0.8);
    assert.ok(projection.cam.quaternion.angleTo(turn) < 1e-7);
    assert.ok(projection.cam.fov < 50);
    const custom = new THREE.Matrix4().makeScale(2, 3, 1);
    projection.aimMatrix(custom);
    projection.update({ opacity: 0.8, overlay: 0.5, extend: 1 });
    closeMatrix(projection.material.uniforms.projView.value, custom);
    assert.equal(projection.material.uniforms.opacity.value, 0.4);
    assert.equal(projection.material.uniforms.extend.value, 1);
    projection.aim(new THREE.Quaternion(), 1);
    closeMatrix(projection.material.uniforms.projView.value, initial);
  } finally {
    projection.dispose(); source.dispose(); stage.geometry.dispose(); stage.material.dispose();
  }
});
