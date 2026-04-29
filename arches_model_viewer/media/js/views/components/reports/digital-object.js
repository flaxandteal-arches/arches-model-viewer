import "arches_her/arches_her/media/js/views/components/reports/digital-object";
import "views/components/cards/file-renderers/modelviewer";
import "views/components/cards/file-renderers/pointcloudviewer";
import fileRenderers from "file-renderers";
import ko from "knockout";

const MODEL_VIEWER_COMPONENT = "views/components/cards/file-renderers/modelviewer";
const POINT_CLOUD_VIEWER_COMPONENT = "views/components/cards/file-renderers/pointcloudviewer";

function getRendererExtensions(componentPath) {
    const renderer = Object.values(fileRenderers).find(
        (r) => r.component === componentPath,
    );
    return new Set(
        (renderer?.ext || "")
            .split(",")
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean),
    );
}

let upstreamConfig;
ko.components.defaultLoader.getConfig(
    "digital-object-report",
    (config) => { upstreamConfig = config; },
);
const UpstreamViewModel = upstreamConfig.viewModel;

ko.components.unregister("digital-object-report");
ko.components.register("digital-object-report", {
    viewModel: function (params) {
        UpstreamViewModel.call(this, params);
        const modelExts = getRendererExtensions(MODEL_VIEWER_COMPONENT);
        const pointCloudExts = getRendererExtensions(POINT_CLOUD_VIEWER_COMPONENT);
        const ext = (f) => (f.name || "").split(".").pop().toLowerCase();
        this.modelFiles = ko.pureComputed(() =>
            this.files().filter((f) => modelExts.has(ext(f))),
        );
        this.pointCloudFiles = ko.pureComputed(() =>
            this.files().filter((f) => pointCloudExts.has(ext(f))),
        );
    },
    template: upstreamConfig.template,
});
