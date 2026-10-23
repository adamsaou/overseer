import { PerspectiveCamera, Vector3 } from "three";
import { smoothstep, spring, springStep } from "./math.js";

// A long lens (18 degrees) about 14 units out on desktop, framing by distance rather than by zoom,
// and a lens shift that puts the subject on its zone instead of turning the camera toward it.

export const FOV = 18;
const TAN = Math.tan((FOV * Math.PI) / 360);
const DEG = Math.PI / 180;

export function createCameraRig() {
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 200);
  const yaw = spring();
  const pitch = spring();
  const look = new Vector3();
  const rig = {
    camera,
    distance: 14,
    // css px per world unit at the current subject distance
    pixelsPerUnit: 1,
    projectionScale: 1,
    update(pose, view, pointer, dt, time, still) {
      springStep(yaw, still ? 0 : pointer.nx * 1.2 * DEG * pose.parallax, 2.6, dt);
      springStep(pitch, still ? 0 : -pointer.ny * 0.8 * DEG * pose.parallax, 2.6, dt);
      const dolly = still ? 1 : 1 - 0.03 * smoothstep(0, 60, time) * pose.dolly;
      const distance = pose.distance * dolly;
      const a = pose.yaw + yaw.x;
      const b = pose.pitch + pitch.x;
      look.set(pose.tx, pose.ty, pose.tz);
      camera.position.set(
        look.x + distance * Math.sin(a) * Math.cos(b),
        look.y + distance * Math.sin(b),
        look.z + distance * Math.cos(a) * Math.cos(b),
      );
      camera.up.set(0, 1, 0);
      camera.lookAt(look);
      camera.aspect = view.w / view.h;
      camera.setViewOffset(view.w, view.h, view.w / 2 - pose.sx, view.h / 2 - pose.sy, view.w, view.h);
      camera.updateMatrixWorld(true);
      rig.distance = distance;
      rig.projectionScale = view.h / (2 * TAN);
      rig.pixelsPerUnit = rig.projectionScale / distance;
    },
  };
  return rig;
}

// Distance at which a world unit at the subject spans `ppu` css px.
export function distanceFor(ppu, viewH) {
  return viewH / (2 * TAN * Math.max(1e-6, ppu));
}

// Distance at which a subject of `radius` world units fills `fill` of the zone's smaller side.
export function fitDistance(radius, zone, viewH, fill = 0.9) {
  const side = Math.max(1, Math.min(zone.w, zone.h));
  return (radius * viewH) / (TAN * fill * side);
}

// Distance at which a box of half sizes (w, h) world units fits `fill` of the zone on both axes.
export function fitBox(w, h, zone, viewH, fill = 0.9) {
  const ppu = Math.min((fill * Math.max(1, zone.w)) / (2 * w), (fill * Math.max(1, zone.h)) / (2 * h));
  return viewH / (2 * TAN * ppu);
}

// Projects a world point to css px (top-left origin) and its view depth.
const scratch = new Vector3();
export function project(camera, view, x, y, z, out) {
  scratch.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
  out.depth = -scratch.z;
  scratch.applyMatrix4(camera.projectionMatrix);
  out.x = (scratch.x * 0.5 + 0.5) * view.w;
  out.y = (0.5 - scratch.y * 0.5) * view.h;
  return out;
}
