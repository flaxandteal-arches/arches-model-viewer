<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";

const props = defineProps<{
    url: string;
    name: string;
}>();

const wrapper = ref<HTMLDivElement | null>(null);
const container = ref<HTMLDivElement | null>(null);
const isLoading = ref(true);
const isFullscreen = ref(false);
const showSettings = ref(false);
const loadStatus = ref("Initialising");
const loadError = ref<string | null>(null);
const pointBudget = ref(2_000_000);
const pointSize = ref(3);
const colorMode = ref("ELEVATION");
const pointSizeType = ref("ADAPTIVE");

// PointColorType enum values (from potree-core source).
// These match the integer constants the material expects.
const COLOR_MODES = {
    RGBA: 0,
    COLOR: 1,
    ELEVATION: 3,
    INTENSITY: 4,
    CLASSIFICATION: 8,
    RETURN_NUMBER: 9,
    SOURCE_ID: 10,
    LOD: 6,
} as const;

const POINT_SIZE_TYPES = {
    FIXED: 0,
    ATTENUATED: 1,
    ADAPTIVE: 2,
} as const;

let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let renderer: THREE.WebGLRenderer | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let controls: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let potree: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pointcloud: any = null;
let animationId = 0;
let resizeObs: ResizeObserver | null = null;

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

// Probes the cloud directory for a Potree 2.0 metadata file.
// Potree 1.x's `cloud.js` format is NOT supported by potree-core 2.x — convert
// older clouds with PotreeConverter v2 to produce metadata.json.
async function detectEntryPoint(dirUrl: string): Promise<string> {
    try {
        const response = await fetch(dirUrl + "metadata.json", { method: "HEAD" });
        if (response.ok) return "metadata.json";
    } catch {
        // ignore, will fall through to default
    }
    return "metadata.json";  // let the loader surface a clear error
}

onMounted(async () => {
    if (!container.value) return;
    try {
        loadStatus.value = "Loading viewer";
        const [potreeMod, controlsMod] = await Promise.all([
            import("potree-core"),
            import("three/examples/jsm/controls/OrbitControls.js"),
        ]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const Potree = (potreeMod as any).Potree;
        const OrbitControls = controlsMod.OrbitControls;

        const w = container.value.clientWidth;
        const h = container.value.clientHeight || 400;

        scene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 10_000);
        camera.position.set(10, 10, 10);

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(w, h);
        container.value.appendChild(renderer.domElement);

        controls = new OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;

        potree = new Potree();
        potree.pointBudget = pointBudget.value;

        loadStatus.value = "Resolving file location";
        // The `url` prop may be an Arches internal `/files/<uuid>` URL that
        // redirects to the actual storage URL. Follow the redirect once so we
        // get the real blob URL, then derive the cloud directory from there.
        const resolvedUrl = await resolveStorageUrl(props.url);

        loadStatus.value = "Loading metadata";
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

        console.log("Loading point cloud from", dirUrl + fileName);

        // potree-core 2.x's loadPointCloud signature:
        //   loadPointCloud(url: string, baseUrl: string)
        //   loadPointCloud(url: string, requestManager: RequestManager)
        // The string overload is the simple path: `url` is the metadata file
        // name and `baseUrl` gets prepended for sibling fetches.
        pointcloud = await potree.loadPointCloud(fileName, dirUrl);
        scene.add(pointcloud);

        // Apply initial render settings — defaults give visible, useful output
        // even for clouds without RGB data (NEON, terrain scans, etc).
        applyRenderSettings();

        // Center camera on the cloud bounding box.
        if (pointcloud.boundingBox) {
            const box = pointcloud.boundingBox.clone()
                .applyMatrix4(pointcloud.matrixWorld);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z);
            const dist = maxDim * 1.5;
            camera.position.copy(center).add(new THREE.Vector3(dist, dist, dist));
            camera.lookAt(center);
            controls.target.copy(center);
            controls.update();
        }

        isLoading.value = false;

        function tick() {
            animationId = requestAnimationFrame(tick);
            if (!potree || !pointcloud || !camera || !renderer || !scene) return;
            potree.updatePointClouds([pointcloud], camera, renderer);
            controls?.update();
            renderer.render(scene, camera);
        }
        tick();

        resizeObs = new ResizeObserver(() => {
            if (!container.value || !renderer || !camera) return;
            const W = container.value.clientWidth;
            const H = container.value.clientHeight;
            renderer.setSize(W, H);
            camera.aspect = W / H;
            camera.updateProjectionMatrix();
        });
        resizeObs.observe(container.value);

        document.addEventListener("fullscreenchange", onFullscreenChange);
    } catch (err) {
        console.error("PointCloudViewer error:", err);
        loadError.value = err instanceof Error ? err.message : String(err);
        isLoading.value = false;
    }
});

onBeforeUnmount(() => {
    cancelAnimationFrame(animationId);
    resizeObs?.disconnect();
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    pointcloud?.dispose?.();
    renderer?.dispose();
    renderer?.domElement.remove();
    scene?.clear();
    scene = camera = renderer = controls = potree = pointcloud = null;
});

function resetView() {
    if (!camera || !controls || !pointcloud) return;
    if (!pointcloud.boundingBox) return;
    const box = pointcloud.boundingBox.clone()
        .applyMatrix4(pointcloud.matrixWorld);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist = maxDim * 1.5;
    camera.position.copy(center).add(new THREE.Vector3(dist, dist, dist));
    camera.lookAt(center);
    controls.target.copy(center);
    controls.update();
}

function onFullscreenChange() {
    isFullscreen.value = !!document.fullscreenElement;
}

function toggleFullscreen() {
    if (!wrapper.value) return;
    if (!document.fullscreenElement) {
        wrapper.value.requestFullscreen?.();
    } else {
        document.exitFullscreen?.();
    }
}

watch([pointSize, colorMode, pointSizeType], applyRenderSettings);

function applyRenderSettings() {
    if (!pointcloud) return;
    const mat = pointcloud.material;
    if (!mat) {
        console.warn("PointCloudViewer: pointcloud has no material yet");
        return;
    }

    mat.size = pointSize.value;
    const colorTypeId = COLOR_MODES[colorMode.value as keyof typeof COLOR_MODES];
    if (colorTypeId !== undefined) mat.pointColorType = colorTypeId;
    const sizeTypeId = POINT_SIZE_TYPES[
        pointSizeType.value as keyof typeof POINT_SIZE_TYPES
    ];
    if (sizeTypeId !== undefined) mat.pointSizeType = sizeTypeId;

    // For elevation colouring, set the gradient range to the cloud's z extent
    // so colours actually span the data. The material exposes both individual
    // heightMin/heightMax setters and a combined elevationRange [min, max] —
    // we set both to be safe across versions.
    if (colorMode.value === "ELEVATION" && pointcloud.boundingBox) {
        const box = pointcloud.boundingBox;
        try {
            mat.heightMin = box.min.z;
            mat.heightMax = box.max.z;
            mat.elevationRange = [box.min.z, box.max.z];
        } catch (err) {
            console.warn("PointCloudViewer: elevation range set failed:", err);
        }
    }

    // Force a shader update — some potree-core versions require it.
    if ("needsUpdate" in mat) mat.needsUpdate = true;

    console.log("PointCloudViewer settings applied:", {
        size: mat.size,
        pointColorType: mat.pointColorType,
        pointSizeType: mat.pointSizeType,
        heightMin: mat.heightMin,
        heightMax: mat.heightMax,
    });
}

function bumpBudget(delta: number) {
    pointBudget.value = Math.max(250_000, pointBudget.value + delta);
    if (potree) potree.pointBudget = pointBudget.value;
}

function onPointBudgetChange() {
    if (potree) potree.pointBudget = pointBudget.value;
}
</script>

<template>
    <div ref="wrapper" class="point-cloud-wrapper">
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
        <div class="point-cloud-controls">
            <button type="button" title="Reset view" @click="resetView">
                <i class="fa fa-undo" aria-hidden="true"></i>
            </button>
            <button
                type="button"
                title="Decrease point budget"
                @click="bumpBudget(-500_000)"
            >
                <i class="fa fa-minus" aria-hidden="true"></i>
            </button>
            <button
                type="button"
                title="Increase point budget"
                @click="bumpBudget(500_000)"
            >
                <i class="fa fa-plus" aria-hidden="true"></i>
            </button>
            <button
                type="button"
                title="Settings"
                :class="{ active: showSettings }"
                @click="showSettings = !showSettings"
            >
                <i class="fa fa-cog" aria-hidden="true"></i>
            </button>
            <button
                type="button"
                :title="isFullscreen ? 'Exit fullscreen' : 'Fullscreen'"
                @click="toggleFullscreen"
            >
                <i
                    :class="isFullscreen ? 'fa fa-compress' : 'fa fa-expand'"
                    aria-hidden="true"
                ></i>
            </button>
        </div>

        <div v-if="showSettings" class="point-cloud-settings">
            <label>
                <span>Colour by</span>
                <select v-model="colorMode">
                    <option value="ELEVATION">Elevation</option>
                    <option value="RGBA">RGB</option>
                    <option value="INTENSITY">Intensity</option>
                    <option value="CLASSIFICATION">Classification</option>
                    <option value="RETURN_NUMBER">Return number</option>
                    <option value="SOURCE_ID">Source / flight line</option>
                    <option value="LOD">LOD (debug)</option>
                </select>
            </label>
            <label>
                <span>Point size</span>
                <input
                    type="range" min="0.1" max="10" step="0.1"
                    v-model.number="pointSize"
                />
                <span class="point-cloud-settings-value">{{ pointSize.toFixed(1) }}</span>
            </label>
            <label>
                <span>Sizing</span>
                <select v-model="pointSizeType">
                    <option value="ADAPTIVE">Adaptive</option>
                    <option value="ATTENUATED">Attenuated (perspective)</option>
                    <option value="FIXED">Fixed</option>
                </select>
            </label>
            <label>
                <span>Point budget</span>
                <input
                    type="range" min="250000" max="10000000" step="250000"
                    v-model.number="pointBudget"
                    @input="onPointBudgetChange"
                />
                <span class="point-cloud-settings-value">
                    {{ (pointBudget / 1_000_000).toFixed(2) }}M
                </span>
            </label>
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

.point-cloud-controls {
    --btn-size: 36px;
    position: absolute;
    top: 10px;
    right: 10px;
    display: flex;
    gap: calc(var(--btn-size) * 0.15);
    padding: calc(var(--btn-size) * 0.15);
    background: rgba(20, 22, 28, 0.75);
    backdrop-filter: blur(8px);
    border-radius: calc(var(--btn-size) * 0.22);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
    z-index: 10;
}

.point-cloud-controls button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: var(--btn-size);
    height: var(--btn-size);
    font-size: calc(var(--btn-size) * 0.5);
    padding: 0;
    border: none;
    border-radius: calc(var(--btn-size) * 0.15);
    background: transparent;
    color: #e5e7eb;
    cursor: pointer;
    transition: background 0.15s ease;
}

.point-cloud-controls button:hover {
    background: rgba(255, 255, 255, 0.12);
}

.point-cloud-controls button.active {
    background: rgba(96, 165, 250, 0.25);
    color: #93c5fd;
}

.point-cloud-settings {
    position: absolute;
    top: 60px;
    right: 10px;
    z-index: 11;
    width: 260px;
    padding: 14px;
    background: rgba(20, 22, 28, 0.92);
    backdrop-filter: blur(8px);
    border-radius: 8px;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.4);
    color: #e5e7eb;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.point-cloud-settings label {
    display: grid;
    grid-template-columns: 1fr;
    gap: 4px;
}

.point-cloud-settings label > span:first-child {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    opacity: 0.7;
}

.point-cloud-settings select,
.point-cloud-settings input[type="range"] {
    width: 100%;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 4px;
    color: #e5e7eb;
    padding: 4px 6px;
    font-size: 12px;
}

.point-cloud-settings input[type="range"] {
    padding: 0;
}

.point-cloud-settings-value {
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    opacity: 0.7;
    text-align: right;
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
