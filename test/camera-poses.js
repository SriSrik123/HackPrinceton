import * as THREE from 'three';

function matrix(rows) {
  const full = rows.length === 3 ? [...rows, [0, 0, 0, 1]] : rows;
  if (full.length !== 4 || full.some(row => row.length !== 4 || row.some(v => !Number.isFinite(v)))) {
    throw new Error('Invalid camera transform');
  }
  return new THREE.Matrix4().set(...full.flat());
}

export function recordedViews(meta, parser) {
  // The saved dataparser transform maps original coordinates to training space.
  // JSON poses already include applied_transform, so undo it before this mapping.
  const applied = meta.applied_transform ?? [[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0]];
  const transform = matrix(parser.transform).multiply(matrix(applied).invert());
  const scale = parser.scale / (meta.applied_scale ?? 1);
  if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('Invalid training scale');
  return [...meta.frames].sort((a, b) => a.file_path.localeCompare(b.file_path)).map(frame => {
    const pose = transform.clone().multiply(matrix(frame.transform_matrix));
    pose.setPosition(new THREE.Vector3().setFromMatrixPosition(pose).multiplyScalar(scale));
    const width = meta.w ?? frame.w;
    const height = meta.h ?? frame.h;
    const fy = meta.fl_y ?? frame.fl_y;
    if (!(width > 0 && height > 0 && fy > 0)) throw new Error('Missing camera intrinsics');
    return {
      name: frame.file_path,
      pose,
      aspect: width / height,
      fov: THREE.MathUtils.radToDeg(2 * Math.atan(height / (2 * fy))),
    };
  });
}
