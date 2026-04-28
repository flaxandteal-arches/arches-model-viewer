// All clip-plane logic for the point-cloud viewer. potree-core's
// PointCloudMaterial uses a custom shader that ignores three.js's standard
// `material.clippingPlanes`, so real clipping has to go through
// `material.setClipBoxes()` + `material.clipMode`. We model the user's
// per-axis on/off + min/max sliders as a single AABB clip box (the
// intersection of the enabled slabs); disabled axes get a huge range so
// they don't constrain the box.
//
// `PlaneHelper` instances are added to the scene purely so the user can
// see the slab boundaries — they're invisible by default and resized to
// the cloud after it loads.

import { Plane, PlaneHelper, Scene, Vector3 } from "three";
import { ClipMode, PointCloudOctree, createClipBox } from "potree-core";

export interface ClipPlaneState {
    enableX: boolean; minX: number; maxX: number;
    enableY: boolean; minY: number; maxY: number;
    enableZ: boolean; minZ: number; maxZ: number;
    showHelpers: boolean;
}

export interface ClipController {
    state: ClipPlaneState;
    helpers: PlaneHelper[];
    setTarget(pco: PointCloudOctree): void;
    setBounds(center: Vector3, halfExtent: Vector3): void;
    sizeHelpersToDiagonal(diagonal: number): void;
    update(): void;
    updateAxis(axis: "X" | "Y" | "Z"): void;
}

export function createClipController(scene: Scene): ClipController {
    const state: ClipPlaneState = {
        enableX: false, minX: -1, maxX: 1,
        enableY: false, minY: -1, maxY: 1,
        enableZ: false, minZ: -1, maxZ: 1,
        showHelpers: true,
    };

    // Per axis we use a pair of opposing planes to define a slab — only
    // points between min and max are kept. Each plane's normal points
    // "inward" so CLIP_OUTSIDE discards everything outside the slab.
    const xMin = new Plane(new Vector3( 1, 0, 0), 0);
    const xMax = new Plane(new Vector3(-1, 0, 0), 0);
    const yMin = new Plane(new Vector3(0,  1, 0), 0);
    const yMax = new Plane(new Vector3(0, -1, 0), 0);
    const zMin = new Plane(new Vector3(0, 0,  1), 0);
    const zMax = new Plane(new Vector3(0, 0, -1), 0);

    const xMinHelper = new PlaneHelper(xMin, 1, 0xE53935);
    const xMaxHelper = new PlaneHelper(xMax, 1, 0xE53935);
    const yMinHelper = new PlaneHelper(yMin, 1, 0x43A047);
    const yMaxHelper = new PlaneHelper(yMax, 1, 0x43A047);
    const zMinHelper = new PlaneHelper(zMin, 1, 0x1E88E5);
    const zMaxHelper = new PlaneHelper(zMax, 1, 0x1E88E5);
    const helpers = [xMinHelper, xMaxHelper, yMinHelper, yMaxHelper, zMinHelper, zMaxHelper];
    helpers.forEach((h) => {
        h.raycast = () => false;
        h.visible = false;
        scene.add(h);
    });

    const center = new Vector3();
    const halfExtent = new Vector3();
    let target: PointCloudOctree | null = null;

    function setTarget(pco: PointCloudOctree) {
        target = pco;
    }

    function setBounds(c: Vector3, h: Vector3) {
        center.copy(c);
        halfExtent.copy(h);
    }

    function sizeHelpersToDiagonal(diagonal: number) {
        helpers.forEach((h) => { h.size = diagonal; });
    }

    function update() {
        if (!target) return;
        const HUGE = 1e9;
        const minWorld = new Vector3(
            state.enableX ? center.x + state.minX * halfExtent.x : -HUGE,
            state.enableY ? center.y + state.minY * halfExtent.y : -HUGE,
            state.enableZ ? center.z + state.minZ * halfExtent.z : -HUGE,
        );
        const maxWorld = new Vector3(
            state.enableX ? center.x + state.maxX * halfExtent.x :  HUGE,
            state.enableY ? center.y + state.maxY * halfExtent.y :  HUGE,
            state.enableZ ? center.z + state.maxZ * halfExtent.z :  HUGE,
        );

        const anyEnabled = state.enableX || state.enableY || state.enableZ;
        if (anyEnabled) {
            const size = maxWorld.clone().sub(minWorld);
            const boxCenter = maxWorld.clone().add(minWorld).multiplyScalar(0.5);
            target.material.setClipBoxes([createClipBox(size, boxCenter)]);
            target.material.clipMode = ClipMode.CLIP_OUTSIDE;
        } else {
            target.material.setClipBoxes([]);
            target.material.clipMode = ClipMode.DISABLED;
        }

        xMinHelper.visible = xMaxHelper.visible = state.enableX && state.showHelpers;
        yMinHelper.visible = yMaxHelper.visible = state.enableY && state.showHelpers;
        zMinHelper.visible = zMaxHelper.visible = state.enableZ && state.showHelpers;
    }

    function updateAxis(axis: "X" | "Y" | "Z") {
        const c = axis === "X" ? center.x : axis === "Y" ? center.y : center.z;
        const e = axis === "X" ? halfExtent.x : axis === "Y" ? halfExtent.y : halfExtent.z;
        const min = axis === "X" ? state.minX : axis === "Y" ? state.minY : state.minZ;
        const max = axis === "X" ? state.maxX : axis === "Y" ? state.maxY : state.maxZ;
        const minPlane = axis === "X" ? xMin : axis === "Y" ? yMin : zMin;
        const maxPlane = axis === "X" ? xMax : axis === "Y" ? yMax : zMax;

        // Inward-pointing normals: min plane drawn at p_axis = c + min*e;
        // max plane at c + max*e. `Plane.constant` in three.js is the
        // signed distance from origin along the *inward* normal.
        minPlane.constant = -(c + min * e);
        maxPlane.constant =  (c + max * e);
        update();
    }

    return {
        state,
        helpers,
        setTarget,
        setBounds,
        sizeHelpersToDiagonal,
        update,
        updateAxis,
    };
}
