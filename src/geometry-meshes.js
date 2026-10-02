import * as THREE from 'three';

// Update equal-sized Line2 data in place: no GPU buffers or distance arrays are
// recreated when a particle/annotation moves. Return false for a topology change.
export function updateLinePoints(line, points) {
  const geometry = line.geometry, starts = geometry.getAttribute('instanceStart'), ends = geometry.getAttribute('instanceEnd');
  if (!starts || starts.count !== points.length - 1) return false;
  for (let i = 0; i < starts.count; i++) { starts.setXYZ(i, ...points[i]); ends.setXYZ(i, ...points[i + 1]); }
  starts.data.needsUpdate = true; geometry.computeBoundingBox(); geometry.computeBoundingSphere();
  const ds = geometry.getAttribute('instanceDistanceStart'), de = geometry.getAttribute('instanceDistanceEnd');
  if (!ds || ds.count !== starts.count) line.computeLineDistances();
  else {
    let distance = 0;
    for (let i = 0; i < starts.count; i++) { ds.setX(i, distance); distance += Math.hypot(...points[i + 1].map((value, j) => value - points[i][j])); de.setX(i, distance); }
    ds.data.needsUpdate = true;
  }
  return true;
}

export function arrowConeGeometry() {
  const geometry = new THREE.ConeGeometry(1, 1, 20); geometry.translate(0, -.5, 0); return geometry;
}
