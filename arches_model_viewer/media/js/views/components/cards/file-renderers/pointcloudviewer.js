import ko from 'knockout';
import createVueApplication from 'arches/arches/app/media/js/utils/create-vue-application';
import PointCloudViewer from '@/arches_model_viewer/file-renderers/PointCloudViewer.vue';
import pointCloudViewerTemplate from 'templates/views/components/cards/file-renderers/pointcloudviewer.htm';

ko.bindingHandlers.pointCloudViewer = {
    init: function (element, valueAccessor) {
        const model = ko.unwrap(valueAccessor());
        if (!model || !model.url || !model.name) return;

        let vueApp = null;
        createVueApplication(PointCloudViewer, undefined, {
            url: model.url,
            name: model.name,
        })
            .then((app) => {
                vueApp = app;
                vueApp.mount(element);
            })
            .catch(console.error);

        ko.utils.domNodeDisposal.addDisposeCallback(element, () => {
            if (vueApp) vueApp.unmount();
        });
    },
};

export default ko.components.register('pointcloudviewer', {
    viewModel: function (params) {
        this.params = params;
        const displayContent = ko.unwrap(params.displayContent);
        this.model = displayContent
            ? { url: displayContent.url, name: displayContent.name }
            : null;
    },
    template: pointCloudViewerTemplate,
});
