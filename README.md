# arches-model-viewer

3D model viewer for Arches `file-list` datatypes, powered by [online-3d-viewer](https://github.com/kovacsv/Online3DViewer). Renders glTF, glb, obj, stl, ply, 3ds, fbx, dae, 3mf, ifc, step and more directly inside Arches resource cards and reports.

Includes:
- A `modelviewer` file renderer (registered via a one-time `settings.RENDERERS` snippet — see below).
- A patched `file-viewer.js` that lets one renderer match many extensions (CSV `ext`).
- A monkey-patched `FileListDataType.get_compatible_renderers` so the same CSV semantics apply server-side.
- A monkey-patched `FileListDataType.transform_value_for_tile` to fix an upstream path-join bug.
- A drop-in patch of the **arches-her** `digital-object` report that renders 3D files inline alongside the existing files table.

## Requirements

- Arches >= 8.1
- arches-her (the digital-object report patch targets it)

## Installation

```bash
pip install arches-model-viewer
```

Then add to your project's `INSTALLED_APPS` and `ARCHES_APPLICATIONS`. **Order matters**: place `arches_model_viewer` **after** `arches_her` so its template/JS overrides take precedence.

```python
INSTALLED_APPS = (
    ...,
    "arches_her",
    "arches_model_viewer",  # must come after arches_her
)

ARCHES_APPLICATIONS = (
    ...,
    "arches_her",
    "arches_model_viewer",  # must come after arches_her
)
```

Update the dependencies in the pyproject.toml

```
[project]
dependencies = [
    "arches>=8.0",
    "arches-model-viewer @ git+https://github.com/flaxandteal-arches/arches-model-viewer.git",
]
```

On the JS side, install the npm dependency in your project:

```bash
npm install online-3d-viewer
```

(The app declares it but webpack resolves dependencies at the project level.)

Rebuild the bundle (`npm run build_development` or restart the dev server) and the viewer becomes active.

## Register the renderer

Add the following entry to your project's `settings.RENDERERS`. The CSV `ext` semantics rely on this app's monkey-patches, which are applied automatically at startup.

```python
RENDERERS = [
    # ... your existing renderers ...
    {
        "name": "modelviewer",
        "title": "3D Model Viewer",
        "description": "Displays 3D models via Online 3D Viewer",
        "id": "7c8b3e1a-2d9f-4a6b-8e5c-1f3d7a9b2e0c",
        "iconclass": "fa fa-cube",
        "component": "views/components/cards/file-renderers/modelviewer",
        "type": "model/*",
        "ext": (
            "stl,3dm,3ds,3mf,amf,bim,brep,dae,fbx,fcstd,"
            "gltf,glb,ifc,iges,step,obj,off,ply,wrl"
        ),
        "exclude": "",
    },
]
```

You'll also want these extensions in your project's `FILE_TYPES` if file-type checking is enabled:

```python
FILE_TYPES = [
    # ...
    "stl", "3dm", "3ds", "3mf", "amf", "bim", "brep", "dae", "fbx", "fcstd",
    "gltf", "glb", "ifc", "iges", "step", "obj", "off", "ply", "wrl",
    # ...
]
```

To support fewer or more 3D formats, edit the `ext` CSV.

## Using the viewer outside the file-list card

The Knockout binding `modelViewer` is registered globally as soon as the app's JS module loads. To use it on any page:

```js
import "views/components/cards/file-renderers/modelviewer";
```

then in your template:

```html
<div class="model-viewer-mount" data-bind="modelViewer: { url: someUrl, name: 'thing.stl' }"></div>
```

Two size variants are provided:

- `.model-viewer-mount` — 400px tall, suitable for inline use in reports.
- `.model-viewer-mount.model-viewer-mount--full` — viewport-height, for dedicated viewer pages.

## What the app overrides

This app ships overrides at the same paths as core arches and arches-her, relying on webpack's project-overrides-application-overrides-core lookup. Overridden files:

- `media/js/views/components/cards/file-viewer.js` — patches `getDefaultRenderers` to accept CSV `ext`.
- `templates/views/components/reports/digital-object.htm` — adds a `modelFiles` block to the arches-her digital-object report.
- `media/js/views/components/reports/digital-object.js` — wraps the arches-her viewmodel to expose `modelFiles`.

If your project already overrides any of these, your project files will take precedence (project > application > core).

## Drift safety

The Python monkey-patches use a sentinel-string check against the upstream source. If a future arches release rewrites either method, the patches no-op rather than apply stale logic. You'll see your 3D viewer stop rendering — that's the signal to update this app.
