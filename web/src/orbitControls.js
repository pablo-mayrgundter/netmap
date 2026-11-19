// Mouse and keys the way three.js's OrbitControls has them, for both views.
//   left drag            orbit: across rotates about y, up/down about x.
//                        On the globe that turns the Earth about its axis and
//                        tilts it north-south (the camera orbits its centre);
//                        on the map, the ground's vertical (bearing) and the
//                        screen's horizontal (pitch) about the screen centre.
//   right (or shift/ctrl/cmd + left) drag   pan: the ground follows the pointer
//   wheel                zoom (toward the pointer)
// One finger on a touch screen pans, as before. Rotation is linear in the
// drag, like OrbitControls, rather than deck's and MapLibre's (which scale
// with where on the screen the drag started).
//
// The pure parts (the drag-to-angle rate, the globe's strafe) are here so
// `npm test` can check them; main.js wires the views.

import { _GlobeController as GlobeController } from '@deck.gl/core';

/** Degrees of bearing or pitch per viewport height of drag. */
export const ORBIT_DEG_PER_HEIGHT = 180;

/** The bearing and pitch change for a drag of (dx, dy) px in a viewport `height` px tall. */
export function orbitDelta(dx, dy, height) {
  const k = ORBIT_DEG_PER_HEIGHT / Math.max(1, height);
  // Drag right: the near ground follows the pointer (the map turns
  // counter-clockwise, bearing up). Drag up: tilt toward the horizon.
  return { bearing: dx * k, pitch: -dy * k };
}

/** Whether a mouse drag pans (right button, or a modifier held) rather than orbits. */
export const isPanDrag = (e) => e.button === 2 || !!(e.shiftKey || e.ctrlKey || e.metaKey);

/**
 * The globe's centre moved `deg` degrees of arc toward the screen's right
 * (negative: left) at `bearing` (degrees clockwise from north at the top).
 */
export function strafeGlobe({ longitude, latitude, bearing = 0 }, deg) {
  const b = (bearing * Math.PI) / 180;
  const lat = Math.max(-85, Math.min(85, latitude - deg * Math.sin(b)));
  const lon = longitude + (deg * Math.cos(b)) / Math.max(0.05, Math.cos((latitude * Math.PI) / 180));
  return { longitude: ((((lon + 180) % 360) + 360) % 360) - 180, latitude: lat };
}

// deck's globe zoom is scaled by latitude; its own pan compensates the same way.
const MAX_LATITUDE = 85.051129;
const zoomAdjust = (lat) => Math.log2(Math.PI * Math.cos((Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * Math.PI) / 180));

// deck's globe: the Earth's radius at zoom 0 (common units = px at scale 1),
// and the camera's distance from the point it looks at, in viewport heights.
const GLOBE_RADIUS = 256;
const GLOBE_ALTITUDE = 1.5;

/** An orbit drag's turn per pixel far from the Earth, radians (celestiary's). */
export const ORBIT_RAD_PER_PX = 0.005;
const MIN_ROTATE_SCALE = 1e-6;

/**
 * celestiary's proximity scale for an orbit drag (its DESIGN.md, "Proximity-
 * scaled orbit drag"): 1 - exp(-alt / R), floored at 1e-6 and capped at 1.
 * Near the ground it is alt / R, so a drag sweeps a similar share of the
 * visible patch at any height; from a few radii out it is 1.
 */
export const rotateScale = (alt, R) => Math.min(1, Math.max(MIN_ROTATE_SCALE, 1 - Math.exp(-alt / R)));

/**
 * The globe's camera after an orbit drag of (dx, dy) px from `start`, like
 * OrbitControls about the Earth's centre: across turns the Earth about its
 * axis (y, the poles), up/down about the screen's x axis (latitude, at north
 * up). The ground follows the pointer, at ORBIT_RAD_PER_PX scaled by the
 * camera's height over the ground (rotateScale).
 */
export function orbitGlobe({ longitude, latitude, zoom, altitude = GLOBE_ALTITUDE }, dx, dy, height) {
  const R = GLOBE_RADIUS * Math.pow(2, zoom - zoomAdjust(latitude)); // px
  const alt = altitude * height; // px, to the ground at the centre
  const k = ((ORBIT_RAD_PER_PX * rotateScale(alt, R)) * 180) / Math.PI; // degrees a pixel
  const lat = Math.max(-89, Math.min(89, latitude + dy * k));
  const lon = longitude - dx * k;
  return {
    longitude: ((((lon + 180) % 360) + 360) % 360) - 180,
    latitude: lat,
    zoom: zoom + zoomAdjust(lat) - zoomAdjust(latitude),
  };
}

/**
 * deck's globe controller with OrbitControls' buttons: a mouse's left drag
 * orbits the Earth (orbitGlobe), its right drag (or a modified left) pans;
 * touch pans with one finger.
 */
export class OrbitGlobeController extends GlobeController {
  _onPanStart(event) {
    // deck pans on the "alternate" drag (right button or a function key)
    // when dragMode is 'rotate', and on the plain one when it's 'pan'.
    this.dragMode = event.srcEvent?.pointerType === 'mouse' ? 'rotate' : 'pan';
    const { longitude, latitude, zoom, altitude } = this.controllerState.getViewportProps();
    this._orbitStart = { longitude, latitude, zoom, altitude };
    return super._onPanStart(event);
  }

  _onPanRotate(event) {
    if (!this.dragRotate || !this.isDragging() || !this._orbitStart) return false;
    const next = orbitGlobe(this._orbitStart, event.deltaX, event.deltaY, this.props.height);
    this.updateViewport(this.controllerState._getUpdatedState(next), { transitionDuration: 0 }, { isDragging: true, isRotating: true });
    return true;
  }

  _onPanRotateEnd() {
    if (!this.isDragging()) return false;
    this._orbitStart = null;
    this.updateViewport(this.controllerState.rotateEnd(), { transitionDuration: 0 }, { isDragging: false, isRotating: false });
    return true;
  }
}

/**
 * OrbitControls' mouse on a MapLibre map: left drag orbits, right drag pans.
 * MapLibre keeps touch, the wheel and double-click. Its own mouse drags are
 * kept from starting; the click a drag ends with is swallowed, so a drag
 * doesn't also pick what's under the pointer.
 */
export function wireMapOrbit(map) {
  const root = map.getContainer();
  const canvas = map.getCanvasContainer();
  let drag = null;
  let swallowClick = false;
  root.addEventListener(
    'mousedown',
    (e) => {
      if (!canvas.contains(e.target) || (e.button !== 0 && e.button !== 2)) return;
      e.stopPropagation(); // MapLibre's drag pan and drag rotate
      drag = { x: e.clientX, y: e.clientY, pan: isPanDrag(e), moved: false };
      swallowClick = false;
      canvas.style.cursor = 'grabbing';
    },
    true,
  );
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (!dx && !dy) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    drag.moved = true;
    if (drag.pan) map.panBy([-dx, -dy], { duration: 0 });
    else {
      const d = orbitDelta(dx, dy, root.clientHeight);
      map.jumpTo({ bearing: map.getBearing() + d.bearing, pitch: Math.max(0, Math.min(map.getMaxPitch(), map.getPitch() + d.pitch)) });
    }
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    swallowClick = drag.moved;
    drag = null;
    canvas.style.cursor = '';
  });
  root.addEventListener(
    'click',
    (e) => {
      if (swallowClick) e.stopPropagation();
      swallowClick = false;
    },
    true,
  );
  root.addEventListener('contextmenu', (e) => canvas.contains(e.target) && e.preventDefault());
}
