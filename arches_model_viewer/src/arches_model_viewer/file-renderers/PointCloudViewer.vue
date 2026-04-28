<script setup lang="ts">
import { onMounted, ref } from "vue";
import { AmbientLight, Clock, Euler, OrthographicCamera, PerspectiveCamera, Plane, PlaneHelper, Scene, Vector3, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper';
import { GUI } from 'three/examples/jsm/libs/lil-gui.module.min.js';
import { ClipMode, PointCloudOctree, PointSizeType, Potree, PotreeRenderer, createClipBox } from 'potree-core';

const props = defineProps<{
    url: string;
    name: string;
}>();

const container = ref<HTMLDivElement | null>(null);
const isLoading = ref(true);
const loadStatus = ref("Initialising");
const loadError = ref<string | null>(null);

const potree = new Potree();

// Resolve an Arches `/files/<uuid>` URL to its underlying storage URL.
// The arches file view typically issues a 302 redirect to the actual blob
// URL when remote storage (Azure / S3) is configured. We do a HEAD with
// redirect-follow so the browser resolves the final URL for us, and read
// `response.url` which carries the post-redirect destination.
async function resolveStorageUrl(url: string): Promise<string> {
    if (!url.startsWith("/files/")) return url;  // already a direct URL
    try {
        const response = await fetch(url, { method: "HEAD", redirect: "follow" });
        if (response.url && response.url !== window.location.origin + url) {
            return response.url;
        }
    } catch {
        // fall through and use the original URL — caller handles errors
    }
    return url;
}

// Probes the cloud directory for a Potree entry point. potree-core 2.x
// supports both Potree 2.0 (`metadata.json`) and Potree 1.x (`cloud.js`) — try
// the newer format first.
async function detectEntryPoint(dirUrl: string): Promise<string> {
    for (const candidate of ["metadata.json", "cloud.js"]) {
        try {
            const response = await fetch(dirUrl + candidate, { method: "HEAD" });
            if (response.ok) return candidate;
        } catch {
            // network error — try the next candidate
        }
    }
    throw new Error(`No Potree entry point found at ${dirUrl} (tried metadata.json and cloud.js).`);
}

onMounted(async () => {
    
	let pointClouds: PointCloudOctree[] = [];
	let clipPlanesTarget: PointCloudOctree | null = null;

	// Per axis we use a pair of opposing planes to define a slab — only points
	// between min and max are kept. Each plane's normal points "inward" so
	// CLIP_OUTSIDE discards everything outside the slab.
	const clipPlaneXMin = new Plane(new Vector3( 1, 0, 0), 0);
	const clipPlaneXMax = new Plane(new Vector3(-1, 0, 0), 0);
	const clipPlaneYMin = new Plane(new Vector3(0,  1, 0), 0);
	const clipPlaneYMax = new Plane(new Vector3(0, -1, 0), 0);
	const clipPlaneZMin = new Plane(new Vector3(0, 0,  1), 0);
	const clipPlaneZMax = new Plane(new Vector3(0, 0, -1), 0);
	const planeCenter = new Vector3();
	const planeExtent = new Vector3();

	const clipPlaneState = {
		enableX: false, minX: -1, maxX: 1,
		enableY: false, minY: -1, maxY: 1,
		enableZ: false, minZ: -1, maxZ: 1,
		showHelpers: true,
	};

	// Helpers visualise the slab boundaries; sized to the model after load.
	const clipHelperXMin = new PlaneHelper(clipPlaneXMin, 1, 0xE53935);
	const clipHelperXMax = new PlaneHelper(clipPlaneXMax, 1, 0xE53935);
	const clipHelperYMin = new PlaneHelper(clipPlaneYMin, 1, 0x43A047);
	const clipHelperYMax = new PlaneHelper(clipPlaneYMax, 1, 0x43A047);
	const clipHelperZMin = new PlaneHelper(clipPlaneZMin, 1, 0x1E88E5);
	const clipHelperZMax = new PlaneHelper(clipPlaneZMax, 1, 0x1E88E5);
	const allHelpers = [clipHelperXMin, clipHelperXMax, clipHelperYMin, clipHelperYMax, clipHelperZMin, clipHelperZMax];
	allHelpers.forEach((h) => {
		h.raycast = () => false;
		h.visible = false;
	});

	// potree-core's PointCloudMaterial uses a custom shader and does NOT honour
	// three.js's `material.clippingPlanes`. Real clipping has to go through
	// `setClipBoxes` + `clipMode`. We construct one axis-aligned box that
	// represents the intersection of the enabled slabs; disabled axes get a
	// huge range so they don't constrain the box.
	function updateClipPlanes() {
		if (!clipPlanesTarget) return;
		const HUGE = 1e9;
		const minWorld = new Vector3(
			clipPlaneState.enableX ? planeCenter.x + clipPlaneState.minX * planeExtent.x : -HUGE,
			clipPlaneState.enableY ? planeCenter.y + clipPlaneState.minY * planeExtent.y : -HUGE,
			clipPlaneState.enableZ ? planeCenter.z + clipPlaneState.minZ * planeExtent.z : -HUGE,
		);
		const maxWorld = new Vector3(
			clipPlaneState.enableX ? planeCenter.x + clipPlaneState.maxX * planeExtent.x :  HUGE,
			clipPlaneState.enableY ? planeCenter.y + clipPlaneState.maxY * planeExtent.y :  HUGE,
			clipPlaneState.enableZ ? planeCenter.z + clipPlaneState.maxZ * planeExtent.z :  HUGE,
		);
		const anyEnabled = clipPlaneState.enableX || clipPlaneState.enableY || clipPlaneState.enableZ;
		if (anyEnabled) {
			const size = maxWorld.clone().sub(minWorld);
			const boxCenter = maxWorld.clone().add(minWorld).multiplyScalar(0.5);
			clipPlanesTarget.material.setClipBoxes([createClipBox(size, boxCenter)]);
			clipPlanesTarget.material.clipMode = ClipMode.CLIP_OUTSIDE;
		} else {
			clipPlanesTarget.material.setClipBoxes([]);
			clipPlanesTarget.material.clipMode = ClipMode.DISABLED;
		}
		clipHelperXMin.visible = clipHelperXMax.visible = clipPlaneState.enableX && clipPlaneState.showHelpers;
		clipHelperYMin.visible = clipHelperYMax.visible = clipPlaneState.enableY && clipPlaneState.showHelpers;
		clipHelperZMin.visible = clipHelperZMax.visible = clipPlaneState.enableZ && clipPlaneState.showHelpers;
	}

	function updatePlaneConstant(axis: 'X' | 'Y' | 'Z') {
		const c = axis === 'X' ? planeCenter.x : axis === 'Y' ? planeCenter.y : planeCenter.z;
		const e = axis === 'X' ? planeExtent.x : axis === 'Y' ? planeExtent.y : planeExtent.z;
		const min = axis === 'X' ? clipPlaneState.minX : axis === 'Y' ? clipPlaneState.minY : clipPlaneState.minZ;
		const max = axis === 'X' ? clipPlaneState.maxX : axis === 'Y' ? clipPlaneState.maxY : clipPlaneState.maxZ;
		const minPlane = axis === 'X' ? clipPlaneXMin : axis === 'Y' ? clipPlaneYMin : clipPlaneZMin;
		const maxPlane = axis === 'X' ? clipPlaneXMax : axis === 'Y' ? clipPlaneYMax : clipPlaneZMax;
		// PlaneHelpers visualise where the slab boundaries sit. Inward-pointing
		// normals: min plane drawn at p_axis = c + min*e; max plane at c + max*e.
		minPlane.constant = -(c + min * e);
		maxPlane.constant =  (c + max * e);
		updateClipPlanes();
	}

	// State
	const params = {
		// Camera
		orthographic: false,
		// EDL
		edlEnabled: false,
		edlStrength: 0.4,
		edlRadius: 1.4,
		// Points
		pointSize: 1.0,
		sizeType: 'Adaptive',
	};

	// EDL
	const potreeRenderer = new PotreeRenderer({
		edl: {
			enabled: false,
			pointCloudLayer: 1,
			strength: params.edlStrength,
			radius: params.edlRadius,
			opacity: 1.0,
		},
	});

	// world
	const scene = new Scene();

	let useOrthographicCamera = false;
	const perspectiveCamera = new PerspectiveCamera(60, 1, 0.1, 1000);
	perspectiveCamera.position.set(-10, 10, 15);

	const orthographicFrustrumSize = 20;
	const orthographicCamera = new OrthographicCamera(
		-orthographicFrustrumSize / 2, orthographicFrustrumSize / 2,
		orthographicFrustrumSize / 2, -orthographicFrustrumSize / 2, 0.1, 1000
	);
	orthographicCamera.position.set(0, 0, 10);
	let camera = perspectiveCamera as PerspectiveCamera | OrthographicCamera;

	const canvas = document.createElement('canvas');
	canvas.style.display = 'block';
	canvas.style.width = '100%';
	canvas.style.height = '100%';
	if (!container.value) {
		loadError.value = 'Viewer container not mounted';
		return;
	}
	container.value.appendChild(canvas);

	const renderer = new WebGLRenderer({
		canvas: canvas,
		alpha: true,
		logarithmicDepthBuffer: true,
		precision: 'highp',
		premultipliedAlpha: true,
		antialias: true,
		preserveDrawingBuffer: false,
		powerPreference: 'high-performance',
	});
	allHelpers.forEach((h) => scene.add(h));

	// ---- ViewHelper ----
	let viewHelper = new ViewHelper(camera, canvas);
	const clock = new Clock();

	let controls = new OrbitControls(camera, canvas);

	// Remembered framing so the "Reset View" button can restore it after the
	// cloud has been positioned and the camera has been moved.
	const initialCameraPosition = new Vector3();
	const initialTarget = new Vector3();

    function loadPointCloud(fileName: string, baseUrl: string, position?: Vector3, rotation?: Euler, scale?: Vector3, applyClipPlanes = false) {
            return potree.loadPointCloud(fileName, baseUrl).then(function (pco: PointCloudOctree) {
                const sizeTypeMap: Record<string, PointSizeType> = {
                    'Fixed': PointSizeType.FIXED,
                    'Attenuated': PointSizeType.ATTENUATED,
                    'Adaptive': PointSizeType.ADAPTIVE,
                };
                pco.material.size = params.pointSize;
                pco.material.pointSizeType = sizeTypeMap[params.sizeType] ?? PointSizeType.ADAPTIVE;
                pco.material.shape = 2;
                pco.material.inputColorEncoding = 1;
                pco.material.outputColorEncoding = 1;

                if (position) { pco.position.copy(position); }
                if (rotation) {
                    pco.rotation.copy(rotation);
                } else {
                    // Potree clouds are Z-up; three.js is Y-up. Rotate -90°
                    // around X so the model stands the right way up.
                    pco.rotation.x = -Math.PI / 2;
                }
                if (scale) { pco.scale.copy(scale); }

                console.log('Pointcloud file loaded', pco);
                pco.showBoundingBox = false;

                if (applyClipPlanes) {
                    clipPlanesTarget = pco;
                }

                pco.updateMatrixWorld(true);
                const worldBBox = pco.pcoGeometry.boundingBox.clone().applyMatrix4(pco.matrixWorld);
                const center = worldBBox.getCenter(new Vector3());
                const worldSize = worldBBox.getSize(new Vector3());

                // Frame the cloud: orbit around its centre and pull the camera
                // back far enough to see the whole bounding sphere. This is
                // the standard "fit to model" framing used by most 3D viewers.
                const radius = worldSize.length() * 0.5;
                const fov = (perspectiveCamera.fov * Math.PI) / 180;
                const distance = radius / Math.sin(fov / 2);
                const dir = new Vector3(1, 0.6, 1).normalize();
                perspectiveCamera.position.copy(center).addScaledVector(dir, distance);
                perspectiveCamera.near = Math.max(distance / 1000, 0.01);
                perspectiveCamera.far = distance * 10;
                perspectiveCamera.updateProjectionMatrix();
                orthographicCamera.position.copy(center).addScaledVector(dir, distance);
                controls.target.copy(center);
                controls.update();
                initialCameraPosition.copy(perspectiveCamera.position);
                initialTarget.copy(center);

                if (applyClipPlanes) {
                    planeCenter.copy(center);
                    planeExtent.copy(worldSize).multiplyScalar(0.5);

                    // Size every helper to fully cover the cloud regardless
                    // of which axis it sits on.
                    const helperSize = worldSize.length() * 1.1;
                    allHelpers.forEach((h) => { h.size = helperSize; });

                    updatePlaneConstant('X');
                    updatePlaneConstant('Y');
                    updatePlaneConstant('Z');
                }

                scene.add(pco);
                pointClouds.push(pco);
            });
        }

        // ---- Camera switch ----
        function switchCamera(toOrthographic: boolean) {
            if (toOrthographic === useOrthographicCamera) return;
            useOrthographicCamera = toOrthographic;

            const current = toOrthographic ? perspectiveCamera : orthographicCamera;
            const target = toOrthographic ? orthographicCamera : perspectiveCamera;
            target.position.copy(current.position);
            target.quaternion.copy(current.quaternion);
            camera = target;

            controls.dispose();
            controls = new OrbitControls(camera, canvas);

            viewHelper = new ViewHelper(camera, canvas);

            updateSize();
        }

        function resetView() {
            perspectiveCamera.position.copy(initialCameraPosition);
            orthographicCamera.position.copy(initialCameraPosition);
            controls.target.copy(initialTarget);
            controls.update();
        }

        // ---- gui ----
        const gui = new GUI({ title: 'Viewer', autoPlace: false });
        gui.domElement.classList.add('point-cloud-gui');
        container.value!.appendChild(gui.domElement);

        const guiActions = { resetView };
        gui.add(guiActions, 'resetView').name('Reset View');

        // Camera folder
        const cameraFolder = gui.addFolder('Camera');
        cameraFolder.add(params, 'orthographic').name('Orthographic').onChange((v: boolean) => switchCamera(v));

        // EDL folder
        const edlFolder = gui.addFolder('EDL');
        edlFolder.add(params, 'edlEnabled').name('Enabled').onChange((v: boolean) => {
            potreeRenderer.setEDL({ enabled: v });
        });
        edlFolder.add(params, 'edlStrength', 0, 5, 0.1).name('Strength').onChange((v: number) => {
            potreeRenderer.setEDL({ enabled: params.edlEnabled, strength: v });
        });
        edlFolder.add(params, 'edlRadius', 0, 5, 0.1).name('Radius').onChange((v: number) => {
            potreeRenderer.setEDL({ enabled: params.edlEnabled, radius: v });
        });
        edlFolder.close();

        // Clipping folder — one plane per axis, each with on/off + offset.
        const clipFolder = gui.addFolder('Clipping');
        clipFolder.add(clipPlaneState, 'enableX').name('Clip X').onChange(() => updateClipPlanes());
        clipFolder.add(clipPlaneState, 'minX', -1, 1, 0.01).name('X Min').onChange(() => updatePlaneConstant('X'));
        clipFolder.add(clipPlaneState, 'maxX', -1, 1, 0.01).name('X Max').onChange(() => updatePlaneConstant('X'));
        clipFolder.add(clipPlaneState, 'enableY').name('Clip Y').onChange(() => updateClipPlanes());
        clipFolder.add(clipPlaneState, 'minY', -1, 1, 0.01).name('Y Min').onChange(() => updatePlaneConstant('Y'));
        clipFolder.add(clipPlaneState, 'maxY', -1, 1, 0.01).name('Y Max').onChange(() => updatePlaneConstant('Y'));
        clipFolder.add(clipPlaneState, 'enableZ').name('Clip Z').onChange(() => updateClipPlanes());
        clipFolder.add(clipPlaneState, 'minZ', -1, 1, 0.01).name('Z Min').onChange(() => updatePlaneConstant('Z'));
        clipFolder.add(clipPlaneState, 'maxZ', -1, 1, 0.01).name('Z Max').onChange(() => updatePlaneConstant('Z'));
        clipFolder.add(clipPlaneState, 'showHelpers').name('Show Helpers').onChange(() => updateClipPlanes());

        // Points folder
        const pointsFolder = gui.addFolder('Points');
        pointsFolder.add(params, 'pointSize', 0.1, 5, 0.1).name('Size').onChange((v: number) => {
            for (const pco of pointClouds) pco.material.size = v;
        });
        pointsFolder.add(params, 'sizeType', ['Fixed', 'Attenuated', 'Adaptive']).name('Size Type').onChange((v: string) => {
            const map: Record<string, PointSizeType> = {
                'Fixed': PointSizeType.FIXED,
                'Attenuated': PointSizeType.ATTENUATED,
                'Adaptive': PointSizeType.ADAPTIVE,
            };
            for (const pco of pointClouds) pco.material.pointSizeType = map[v];
        });

        // ---- Render loop ----
        renderer.autoClear = false;

        renderer.setAnimationLoop(() => {
            potree.updatePointClouds(pointClouds, camera, renderer);
            controls.update();

            // autoClear is disabled to allow ViewHelper to overlay on top of the scene.
            // As a result, we must clear manually at the start of each frame.
            renderer.clear();

            if (!params.edlEnabled) {
                renderer.render(scene, camera);
            } else {
                potreeRenderer.render({ renderer, scene, camera, pointClouds });
            }

            // Render ViewHelper
            viewHelper.render(renderer);
            if (viewHelper.animating) viewHelper.update(clock.getDelta());
        });

        function updateSize() {
            const host = container.value;
            const width = host?.clientWidth || 1;
            const height = host?.clientHeight || 1;
            renderer.setSize(width, height, false);

            if (useOrthographicCamera) {
                const aspect = width / height;
                orthographicCamera.left = -orthographicFrustrumSize * aspect / 2;
                orthographicCamera.right = orthographicFrustrumSize * aspect / 2;
                orthographicCamera.top = orthographicFrustrumSize / 2;
                orthographicCamera.bottom = -orthographicFrustrumSize / 2;
                orthographicCamera.updateProjectionMatrix();
            } else {
                perspectiveCamera.aspect = width / height;
                perspectiveCamera.updateProjectionMatrix();
            }
        }

        window.addEventListener('resize', updateSize);
        updateSize();

        // Kick off the point cloud load AFTER the render loop, GUI, and resize
        // wiring are in place. That way the cube/scene is already rendering
        // (so the user sees something other than the loading overlay), and any
        // failure surfaces through loadError instead of leaving us stuck.
        try {
            loadStatus.value = "Resolving file URL";
            const resolvedUrl = await resolveStorageUrl(props.url);

            // For .las / .laz uploads, the source file lives next to a sibling
            // directory of the same name (minus extension) holding the converted
            // Potree octree. e.g. `.../mycloud.las` → cloud at `.../mycloud/`.
            // For direct metadata uploads (.json / cloud.js), use the URL's
            // directory as the cloud root.
            let dirUrl: string;
            let fileName: string;
            const lasMatch = resolvedUrl.match(/^(.+?)\.(las|laz)$/i);
            if (lasMatch) {
                dirUrl = `${lasMatch[1]}/`;
                fileName = await detectEntryPoint(dirUrl);
            } else {
                const lastSlash = resolvedUrl.lastIndexOf("/");
                dirUrl = resolvedUrl.slice(0, lastSlash + 1);
                fileName = resolvedUrl.slice(lastSlash + 1) || await detectEntryPoint(dirUrl);
            }

            loadStatus.value = `Loading ${fileName}`;
            const fullUrl = dirUrl + fileName;
            console.log("Loading point cloud from", fullUrl);

            // Fetch the entry point ourselves first so we can give a useful
            // error when the response isn't what's expected (HTML 404 page,
            // login redirect from auth-protected storage, etc).
            const probe = await fetch(fullUrl);
            if (!probe.ok) {
                throw new Error(`Failed to fetch ${fullUrl} (HTTP ${probe.status}).`);
            }
            // potree-core parses both metadata.json and cloud.js with
            // res.json() — Potree 1.x cloud.js is pure JSON despite the .js
            // extension. If the body isn't JSON, surface a useful snippet.
            const probeText = await probe.text();
            try {
                JSON.parse(probeText);
            } catch {
                const snippet = probeText.slice(0, 300).replace(/\s+/g, " ");
                const looksLikeJs = /^\s*(var|let|const|window\.)/.test(probeText);
                const hint = looksLikeJs
                    ? " (Looks like a legacy JS-style cloud.js — strip the leading `var X = ` so the file is pure JSON.)"
                    : probeText.startsWith("<")
                        ? " (Looks like HTML — likely a 404 page or auth redirect.)"
                        : "";
                throw new Error(`Response from ${fullUrl} is not JSON.${hint} First 300 chars: ${snippet}`);
            }

            await loadPointCloud(fileName, dirUrl, undefined, undefined, undefined, true);
            isLoading.value = false;
        } catch (err) {
            console.error("Point cloud load failed", err);
            loadError.value = err instanceof Error ? err.message : String(err);
            isLoading.value = false;
        }
    });
</script>

<template>
    <div class="point-cloud-wrapper">
        <div ref="container" class="point-cloud-canvas-host"></div>
        <div v-if="isLoading || loadError" class="point-cloud-overlay">
            <div v-if="loadError" class="point-cloud-error">
                <i class="fa fa-exclamation-triangle" aria-hidden="true"></i>
                <div>Failed to load point cloud</div>
                <div class="point-cloud-error-detail">{{ loadError }}</div>
            </div>
            <div v-else class="point-cloud-loader">
                <div class="point-cloud-spinner" aria-hidden="true"></div>
                <div class="point-cloud-status">{{ loadStatus }}</div>
            </div>
        </div>
    </div>
</template>

<style>
.point-cloud-mount {
    width: 100%;
    height: 400px;
}

.point-cloud-mount--full {
    height: calc(100vh - 200px);
}

/* lil-gui customisation. Unscoped so the overrides apply to the GUI's
   internal class names; the .point-cloud-gui prefix keeps it isolated to
   this component's GUI instance. */
.point-cloud-gui.lil-gui {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 10;
    --background-color: rgba(20, 22, 28, 0.92);
    --text-color: #e5e7eb;
    --title-background-color: rgba(96, 165, 250, 0.18);
    --title-text-color: #f5f7fa;
    --widget-color: rgba(255, 255, 255, 0.08);
    --hover-color: rgba(255, 255, 255, 0.14);
    --focus-color: rgba(96, 165, 250, 0.35);
    --number-color: #93c5fd;
    --string-color: #fbbf24;
    --font-size: 12px;
    --input-font-size: 12px;
    --folder-indent: 8px;
    --padding: 6px;
    --spacing: 5px;
    --slider-knob-width: 3px;
    --slider-input-width: 28%;
    --color-input-width: 28%;
    --slider-input-min-width: 40px;
    --color-input-min-width: 40px;
    --folder-closed-arrow: '▸';
    --folder-open-arrow: '▾';
    --widget-border-radius: 4px;
    --scrollbar-width: 6px;
    --title-height: 32px;
    --widget-height: 22px;
    width: 280px;
    border-radius: 8px;
    box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(8px);
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

.point-cloud-gui.lil-gui .title {
    font-weight: 600;
    letter-spacing: 0.02em;
    /* lil-gui sizes titles via --title-height; use horizontal padding only
       and let line-height fill the row so text isn't clipped. */
    padding: 0 10px;
    line-height: var(--title-height);
    --title-height: inherit;
}

.point-cloud-gui.lil-gui .controller {
    padding: 2px 8px;
    align-items: center;
}

.point-cloud-gui.lil-gui .controller .name {
    font-size: 11px;
    opacity: 0.85;
}

.point-cloud-gui.lil-gui button {
    cursor: pointer;
}

/* Vertically centre checkboxes — by default they sit at the top of the
   widget cell, out of line with the controller's label text. */
.point-cloud-gui.lil-gui .controller.boolean .widget {
    display: flex;
    align-items: center;
    height: 100%;
}

.point-cloud-gui.lil-gui .controller.boolean input[type="checkbox"] {
    margin: 0;
    cursor: pointer;
}
</style>

<style scoped>
.point-cloud-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    background: #0b0d12;
    border-radius: 6px;
    overflow: hidden;
}

.point-cloud-canvas-host {
    width: 100%;
    height: 100%;
}


.point-cloud-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(11, 13, 18, 0.75);
    z-index: 5;
    pointer-events: none;
}

.point-cloud-loader {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    color: #e5e7eb;
    font-size: 14px;
}

.point-cloud-spinner {
    width: 40px;
    height: 40px;
    border: 3px solid rgba(255, 255, 255, 0.15);
    border-top-color: #60a5fa;
    border-radius: 50%;
    animation: point-cloud-spin 0.8s linear infinite;
}

@keyframes point-cloud-spin {
    to { transform: rotate(360deg); }
}

.point-cloud-status {
    font-weight: 500;
}

.point-cloud-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: #fca5a5;
    text-align: center;
    padding: 16px;
}

.point-cloud-error .fa {
    font-size: 32px;
}

.point-cloud-error-detail {
    font-size: 12px;
    opacity: 0.8;
}
</style>
