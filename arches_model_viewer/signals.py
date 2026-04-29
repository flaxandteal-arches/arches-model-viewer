"""
Side-effects triggered by Arches model saves.

Currently:

- When a Tile is saved that references a `.zip` file tagged with the
  point-cloud renderer, extract the zip into a sibling directory in
  storage so the front-end Potree viewer can read `metadata.json` /
  `cloud.js` from it directly.
"""

import logging
import os
import posixpath
import zipfile
from io import BytesIO

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from django.db.models.signals import post_save
from django.dispatch import receiver

from arches.app.models.models import TileModel

logger = logging.getLogger(__name__)


# Resolved on first use rather than import — settings.RENDERERS is mutable
# during app startup, and we only ever need the UUID once.
_POINT_CLOUD_RENDERER_ID: str | None = None


def _get_point_cloud_renderer_id() -> str | None:
    global _POINT_CLOUD_RENDERER_ID
    if _POINT_CLOUD_RENDERER_ID is None:
        for renderer in getattr(settings, "RENDERERS", []):
            if renderer.get("name") == "pointcloudviewer":
                _POINT_CLOUD_RENDERER_ID = renderer["id"]
                break
    return _POINT_CLOUD_RENDERER_ID


def _iter_file_dicts(tile_data: dict):
    """
    Walk a Tile's `data` dict and yield each file-list file dict.

    The file-list datatype stores values as a list of dicts shaped like
    `{"name": "...", "url": "...", "renderer": "<uuid>", ...}`. Other
    datatypes don't follow that shape, so we filter on it rather than on
    node datatype lookups (which would require a DB hit per tile).
    """
    if not isinstance(tile_data, dict):
        return
    for value in tile_data.values():
        if not isinstance(value, list):
            continue
        for item in value:
            if isinstance(item, dict) and "name" in item and "url" in item:
                yield item


def _zip_target_dir(zip_storage_path: str) -> str:
    """
    `uploadedfiles/abc.zip` → `uploadedfiles/abc/`. Mirrors the convention
    the front-end already expects for `.las`/`.laz` uploads.
    """
    base, _ = os.path.splitext(zip_storage_path)
    return base


_OCTREE_ENTRY_POINTS = ("metadata.json", "cloud.js")


def _is_metadata_artifact(filename: str) -> bool:
    """Skip macOS resource forks / Spotlight metadata that some zip tools add."""
    return filename.startswith("__MACOSX/") or os.path.basename(filename).startswith("._")


def _validate_octree_archive(zf: zipfile.ZipFile) -> str | None:
    """
    Confirm the zip looks like a Potree octree before we touch storage.
    Returns a string prefix to strip from each entry's path during
    extraction (so a single-folder-wrapped octree extracts flat), or
    None if the archive isn't an octree at all.

    Cheap: only inspects the zip's central directory (paths + sizes),
    not the compressed contents.
    """
    real_names = [
        info.filename for info in zf.infolist()
        if not info.is_dir() and not _is_metadata_artifact(info.filename)
    ]
    if not real_names:
        return None

    # Find every directory the entry-point files live in. There must be
    # at least one or this isn't an octree.
    entry_dirs = {
        posixpath.dirname(name)
        for name in real_names
        if posixpath.basename(name) in _OCTREE_ENTRY_POINTS
    }
    if not entry_dirs:
        return None

    # We extract a single octree, so all entry-point files must live in
    # the same directory. Multiple is ambiguous — refuse rather than guess.
    if len(entry_dirs) > 1:
        return None

    prefix = next(iter(entry_dirs))
    if prefix and not prefix.endswith("/"):
        prefix = f"{prefix}/"
    return prefix


def _extract_octree_zip(zip_storage_path: str) -> None:
    """
    Extract a zip from storage into a sibling directory in the same
    storage backend. Idempotent: if the target dir already contains a
    Potree entry point, the call is a no-op. Validates that the archive
    actually contains an octree before writing anything — non-octree
    zips are rejected to avoid leaving orphan blobs behind.
    """
    target_dir = _zip_target_dir(zip_storage_path)

    # Idempotency check — if a previous save already extracted, skip.
    # `default_storage.exists()` works on both FileSystemStorage and
    # AzureStorage; Azure's implementation issues a HEAD per blob.
    for entry in _OCTREE_ENTRY_POINTS:
        if default_storage.exists(posixpath.join(target_dir, entry)):
            logger.debug(
                "Octree already extracted at %s — skipping", target_dir
            )
            return

    with default_storage.open(zip_storage_path, "rb") as f:
        # Read fully into memory. Octree zips are typically 100MB-2GB; if
        # this becomes a problem, switch to `default_storage.path()` on
        # local FS and a temp blob copy on Azure. For now the simple read
        # works on both backends without backend-specific code.
        buf = BytesIO(f.read())

    with zipfile.ZipFile(buf) as zf:
        prefix = _validate_octree_archive(zf)
        if prefix is None:
            logger.warning(
                "Skipping extraction of %s — does not look like a Potree "
                "octree archive (no metadata.json/cloud.js found, or "
                "ambiguous layout)",
                zip_storage_path,
            )
            return

        logger.info(
            "Extracting octree zip %s → %s/ (stripping prefix %r)",
            zip_storage_path, target_dir, prefix,
        )

        for info in zf.infolist():
            if info.is_dir() or _is_metadata_artifact(info.filename):
                continue
            if prefix and not info.filename.startswith(prefix):
                # Stray file outside the detected octree folder; skip
                # rather than scatter it next to the extracted tree.
                continue

            relative = info.filename[len(prefix):] if prefix else info.filename
            # Use posixpath since storage keys are slash-separated even on
            # Windows.
            dest = posixpath.join(target_dir, relative)
            with zf.open(info) as member:
                # Pass through default_storage so backend-specific writing
                # (atomic rename on FS, block-blob upload on Azure) is
                # handled for us.
                default_storage.save(dest, ContentFile(member.read()))


@receiver(post_save, sender=TileModel)
def extract_point_cloud_octree(sender, instance, created, **kwargs):
    """
    On every Tile save, scan its file-list values and extract any zips
    tagged with the point-cloud renderer. Idempotent — re-saving the
    same tile is cheap.
    """
    renderer_id = _get_point_cloud_renderer_id()
    if not renderer_id:
        return

    for file_dict in _iter_file_dicts(getattr(instance, "data", {}) or {}):
        if str(file_dict.get("renderer")) != str(renderer_id):
            continue
        name = file_dict.get("name") or ""
        if not name.lower().endswith(".zip"):
            continue

        storage_path = file_dict.get("path") or os.path.join(
            settings.UPLOADED_FILES_DIR, str(name)
        )

        try:
            _extract_octree_zip(storage_path)
        except Exception:  # noqa: BLE001 — surface the trace, don't block the save
            logger.exception(
                "Failed to extract point-cloud octree for tile %s (file=%s)",
                instance.pk,
                storage_path,
            )
