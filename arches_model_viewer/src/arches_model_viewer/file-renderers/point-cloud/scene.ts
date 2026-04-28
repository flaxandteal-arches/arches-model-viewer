// Pure three.js scene plumbing — no potree, no GUI. Owns the WebGLRenderer,
// scene, both cameras, OrbitControls, and the corner ViewHelper. The
// orchestrator drives it via the returned object: `getCamera()` /
// `getControls()` / `getViewHelper()` always return the *live* instances
// (which are recreated when the camera type changes).

import {
    Clock,
    OrthographicCamera,
    PerspectiveCamera,
    Scene,
    Vector3,
    WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls";
import { ViewHelper } from "three/examples/jsm/helpers/ViewHelper";

const ORTHO_FRUSTUM_SIZE = 20;

export interface Scene3D {
    scene: Scene;
    renderer: WebGLRenderer;
    canvas: HTMLCanvasElement;
    clock: Clock;
    perspectiveCamera: PerspectiveCamera;
    orthographicCamera: OrthographicCamera;
    getCamera(): PerspectiveCamera | OrthographicCamera;
    getControls(): OrbitControls;
    getViewHelper(): ViewHelper;
    switchCamera(toOrthographic: boolean): void;
    setInitialFraming(position: Vector3, target: Vector3): void;
    resetView(): void;
    updateSize(): void;
}

export function createScene(host: HTMLElement): Scene3D {
    const scene = new Scene();

    const perspectiveCamera = new PerspectiveCamera(60, 1, 0.1, 1000);
    perspectiveCamera.position.set(-10, 10, 15);

    const orthographicCamera = new OrthographicCamera(
        -ORTHO_FRUSTUM_SIZE / 2, ORTHO_FRUSTUM_SIZE / 2,
        ORTHO_FRUSTUM_SIZE / 2, -ORTHO_FRUSTUM_SIZE / 2,
        0.1, 1000,
    );
    orthographicCamera.position.set(0, 0, 10);

    let useOrthographic = false;
    let camera: PerspectiveCamera | OrthographicCamera = perspectiveCamera;

    const canvas = document.createElement("canvas");
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    const renderer = new WebGLRenderer({
        canvas,
        alpha: true,
        logarithmicDepthBuffer: true,
        precision: "highp",
        premultipliedAlpha: true,
        antialias: true,
        preserveDrawingBuffer: false,
        powerPreference: "high-performance",
    });
    renderer.autoClear = false;

    let controls = new OrbitControls(camera, canvas);
    let viewHelper = new ViewHelper(camera, canvas);
    const clock = new Clock();

    // Remembered framing for the "Reset View" button. Set once after the
    // cloud is loaded; restored on demand without changing camera type.
    const initialPosition = new Vector3();
    const initialTarget = new Vector3();

    function updateSize() {
        const width = host.clientWidth || 1;
        const height = host.clientHeight || 1;
        renderer.setSize(width, height, false);

        if (useOrthographic) {
            const aspect = width / height;
            orthographicCamera.left = -ORTHO_FRUSTUM_SIZE * aspect / 2;
            orthographicCamera.right = ORTHO_FRUSTUM_SIZE * aspect / 2;
            orthographicCamera.top = ORTHO_FRUSTUM_SIZE / 2;
            orthographicCamera.bottom = -ORTHO_FRUSTUM_SIZE / 2;
            orthographicCamera.updateProjectionMatrix();
        } else {
            perspectiveCamera.aspect = width / height;
            perspectiveCamera.updateProjectionMatrix();
        }
    }

    function switchCamera(toOrthographic: boolean) {
        if (toOrthographic === useOrthographic) return;
        useOrthographic = toOrthographic;

        const previous = camera;
        const next = toOrthographic ? orthographicCamera : perspectiveCamera;
        next.position.copy(previous.position);
        next.quaternion.copy(previous.quaternion);
        camera = next;

        controls.dispose();
        controls = new OrbitControls(camera, canvas);
        viewHelper = new ViewHelper(camera, canvas);

        updateSize();
    }

    function setInitialFraming(position: Vector3, target: Vector3) {
        initialPosition.copy(position);
        initialTarget.copy(target);
    }

    function resetView() {
        perspectiveCamera.position.copy(initialPosition);
        orthographicCamera.position.copy(initialPosition);
        controls.target.copy(initialTarget);
        controls.update();
    }

    return {
        scene,
        renderer,
        canvas,
        clock,
        perspectiveCamera,
        orthographicCamera,
        getCamera: () => camera,
        getControls: () => controls,
        getViewHelper: () => viewHelper,
        switchCamera,
        setInitialFraming,
        resetView,
        updateSize,
    };
}
