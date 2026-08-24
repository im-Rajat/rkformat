"""rkformat — the `.rkf` compound document: Markdown plus its embedded images.

    from rkformat import RkDocument

    doc = RkDocument.new(title="Notes")
    doc.markdown = "# Notes\n\n"
    asset = doc.add_image("diagram.png", alt="System diagram")
    doc.markdown += asset.markdown_ref()
    doc.save("notes.rkf")
"""

from __future__ import annotations

from .container import RkDocument, is_rkf
from .errors import (
    RkfAssetError,
    RkfError,
    RkfFormatError,
    RkfSecurityError,
    RkfValidationError,
    RkfVersionError,
)
from .manifest import MIMETYPE, SPEC_VERSION, Asset, Manifest

__version__ = "0.1.0"

__all__ = [
    "RkDocument",
    "Asset",
    "Manifest",
    "is_rkf",
    "MIMETYPE",
    "SPEC_VERSION",
    "RkfError",
    "RkfFormatError",
    "RkfVersionError",
    "RkfValidationError",
    "RkfSecurityError",
    "RkfAssetError",
    "__version__",
]
