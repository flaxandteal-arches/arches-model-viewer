// lil-gui panel for the point-cloud viewer. Pure DOM-side: takes the
// shared params object (mutated in-place by GUI controls) and a set of
// callbacks, builds the folders, and returns the GUI instance. The
// orchestrator owns lifecycle (mount/unmount) and the params object.

import { GUI } from "three/examples/jsm/libs/lil-gui.module.min.js";
import type { ClipController } from "./clipping";

export interface ViewerParams {
    orthographic: boolean;
    edlEnabled: boolean;
    edlStrength: number;
    edlRadius: number;
    pointSize: number;
    sizeType: "Fixed" | "Attenuated" | "Adaptive";
}

export interface GuiCallbacks {
    onSwitchCamera(toOrthographic: boolean): void;
    onEdlChange(opts: { enabled?: boolean; strength?: number; radius?: number }): void;
    onPointSizeChange(size: number): void;
    onSizeTypeChange(type: ViewerParams["sizeType"]): void;
    onResetView(): void;
    clip: ClipController;
}

export function createGui(host: HTMLElement, params: ViewerParams, cb: GuiCallbacks): GUI {
    const gui = new GUI({ title: "Viewer", autoPlace: false });
    gui.domElement.classList.add("point-cloud-gui");
    host.appendChild(gui.domElement);

    gui.add({ resetView: cb.onResetView }, "resetView").name("Reset View");

    const cameraFolder = gui.addFolder("Camera");
    cameraFolder.add(params, "orthographic").name("Orthographic")
        .onChange((v: boolean) => cb.onSwitchCamera(v));

    const edlFolder = gui.addFolder("EDL");
    edlFolder.add(params, "edlEnabled").name("Enabled")
        .onChange((v: boolean) => cb.onEdlChange({ enabled: v }));
    edlFolder.add(params, "edlStrength", 0, 5, 0.1).name("Strength")
        .onChange((v: number) => cb.onEdlChange({ enabled: params.edlEnabled, strength: v }));
    edlFolder.add(params, "edlRadius", 0, 5, 0.1).name("Radius")
        .onChange((v: number) => cb.onEdlChange({ enabled: params.edlEnabled, radius: v }));
    edlFolder.close();

    const clipFolder = gui.addFolder("Clipping");
    const { state, update, updateAxis } = cb.clip;
    clipFolder.add(state, "enableX").name("Clip X").onChange(update);
    clipFolder.add(state, "minX", -1, 1, 0.01).name("X Min").onChange(() => updateAxis("X"));
    clipFolder.add(state, "maxX", -1, 1, 0.01).name("X Max").onChange(() => updateAxis("X"));
    clipFolder.add(state, "enableY").name("Clip Y").onChange(update);
    clipFolder.add(state, "minY", -1, 1, 0.01).name("Y Min").onChange(() => updateAxis("Y"));
    clipFolder.add(state, "maxY", -1, 1, 0.01).name("Y Max").onChange(() => updateAxis("Y"));
    clipFolder.add(state, "enableZ").name("Clip Z").onChange(update);
    clipFolder.add(state, "minZ", -1, 1, 0.01).name("Z Min").onChange(() => updateAxis("Z"));
    clipFolder.add(state, "maxZ", -1, 1, 0.01).name("Z Max").onChange(() => updateAxis("Z"));
    clipFolder.add(state, "showHelpers").name("Show Helpers").onChange(update);

    const pointsFolder = gui.addFolder("Points");
    pointsFolder.add(params, "pointSize", 0.1, 5, 0.1).name("Size")
        .onChange((v: number) => cb.onPointSizeChange(v));
    pointsFolder.add(params, "sizeType", ["Fixed", "Attenuated", "Adaptive"]).name("Size Type")
        .onChange((v: ViewerParams["sizeType"]) => cb.onSizeTypeChange(v));

    return gui;
}
