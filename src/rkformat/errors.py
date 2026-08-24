"""Exception hierarchy for the rkformat package."""

from __future__ import annotations


class RkfError(Exception):
    """Base class for every error raised by rkformat."""


class RkfFormatError(RkfError):
    """The file is not a well-formed .rkf container."""


class RkfVersionError(RkfError):
    """The container declares a spec MAJOR version this reader cannot handle."""


class RkfValidationError(RkfError):
    """The container parsed, but violates an integrity rule from SPEC.md section 3."""


class RkfSecurityError(RkfError):
    """The container tripped a hardening limit from SPEC.md section 4."""


class RkfAssetError(RkfError):
    """An asset could not be added, found, or resolved."""
