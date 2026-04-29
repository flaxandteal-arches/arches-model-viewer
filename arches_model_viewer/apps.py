from django.apps import AppConfig


class ArchesModelViewerConfig(AppConfig):
    name = "arches_model_viewer"
    is_arches_application = True

    def ready(self):
        _patch_renderer_ext_csv()
        _patch_filelist_path_join()
        # Importing for side effects only — registers @receiver handlers
        # against arches model signals. Standard Django pattern.
        from . import signals  # noqa: F401


def _patch_renderer_ext_csv():
    """
    Upstream arches.app.datatypes.datatypes.FileListDataType.get_compatible_renderers
    compares renderer["ext"] as a single string while renderer["exclude"] is CSV.
    This patch makes `ext` accept a comma-separated list too, so one RENDERERS entry
    can cover many extensions (e.g. the 3D model viewer's stl,obj,gltf,...).

    Bails out silently if upstream has changed shape, so a new arches version doesn't
    silently apply stale logic.
    """
    import inspect
    from pathlib import Path

    from django.conf import settings

    from arches.app.datatypes import datatypes as arches_datatypes

    sentinel = 'extension.lower() == renderer["ext"].lower()'
    src = inspect.getsource(
        arches_datatypes.FileListDataType.get_compatible_renderers
    )
    if sentinel not in src:
        return

    def get_compatible_renderers(self, file_data):
        extension = Path(file_data["name"]).suffix.strip(".")
        compatible = []
        for renderer in settings.RENDERERS:
            renderer_exts = [
                e.strip().lower()
                for e in renderer["ext"].split(",")
                if e.strip()
            ]
            if extension.lower() in renderer_exts:
                compatible.append(renderer["id"])
            else:
                excluded = [e.strip() for e in renderer["exclude"].split(",")]
                if extension not in excluded:
                    renderer_mime = renderer["type"].split("/")
                    file_mime = file_data["type"].split("/")
                    if len(renderer_mime) == 2 and len(file_mime) == 2:
                        renderer_class, renderer_type = renderer_mime
                        file_class = file_mime[0]
                        if (
                            renderer_class.lower() == file_class.lower()
                            and renderer_type == "*"
                        ):
                            compatible.append(renderer["id"])
        return compatible

    arches_datatypes.FileListDataType.get_compatible_renderers = (
        get_compatible_renderers
    )
