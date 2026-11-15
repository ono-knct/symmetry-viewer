"""Bounded conversion results and verified, on-disk bundled cell conversions."""
from __future__ import annotations

import ast
from collections import OrderedDict
from functools import lru_cache
import gzip
import hashlib
from importlib.metadata import PackageNotFoundError, version
from importlib.util import resolve_name
import json
import os
from pathlib import Path
import re
import zlib


PRECOMPUTED_VERSION = 1
PROJECT_ROOT = Path(__file__).resolve().parents[2]


def payload_digest(payload: dict) -> str:
    # An example loaded from a CIF uses an absolute source path, while the
    # shipped export uses a relative one. Location must not invalidate otherwise
    # identical bundled data (and imports outside this directory stay distinct).
    render_data = payload.get("render_data") or {}
    metadata = render_data.get("metadata") or {}
    source = metadata.get("source_file")
    if isinstance(source, str) and Path(source).is_absolute():
        try:
            relative = Path(source).relative_to(PROJECT_ROOT / "examples" / "cif")
        except ValueError:
            pass
        else:
            payload = {**payload, "render_data": {**render_data, "metadata": {
                **metadata, "source_file": f"examples/cif/{relative.as_posix()}",
            }}}
    data = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def conversion_key(payload: dict, mode: str, tolerance_cart: float) -> str:
    return payload_digest({"input": payload_digest(payload), "mode": mode,
                           "tolerance_cart": float(tolerance_cart), "version": PRECOMPUTED_VERSION})


class CellSettingCache:
    """Own at most two payloads; callers serialize access with the state lock.

    Values are shared with the active session and must remain read-only. Only
    successful conversions enter the cache, after the request is still current.
    """
    def __init__(self) -> None:
        self._results: OrderedDict[str, dict] = OrderedDict()

    def get(self, key: str) -> dict | None:
        value = self._results.get(key)
        if value is not None:
            self._results.move_to_end(key)
        return value

    def put(self, key: str, payload: dict) -> None:
        self._results[key] = payload
        self._results.move_to_end(key)
        while len(self._results) > 2:
            self._results.popitem(last=False)

    def clear(self) -> None:
        self._results.clear()

    def __len__(self) -> int:
        return len(self._results)


@lru_cache(maxsize=1)
def analysis_signature(project_root: Path) -> str:
    """Sign conversion dependencies, not unrelated viewers or HTTP/UI code.

    Follow local imports (including function-local ones) without importing the
    analysis stack. The legacy core is loaded by filename, so it is an explicit
    root. The preparation script and worker define the conversion parameters
    and serialization contract and are signed as well.
    """
    paths = _analysis_source_paths(project_root)
    paths.update(project_root / name for name in (
        "tools/precompute_cell_settings.py", "tools/export_cell_setting_json.py",
    ))
    digest = hashlib.sha256()
    for path in sorted(paths):
        digest.update(path.relative_to(project_root).as_posix().encode())
        digest.update(path.read_bytes())
    configured = os.environ.get("SYMMETRY_VIEW_LEGACY_CORE")
    if configured:
        digest.update(configured.encode())
        digest.update(Path(configured).read_bytes())
    for name in ("numpy", "pymatgen", "spglib", "scipy"):
        try:
            installed = version(name)
        except PackageNotFoundError:
            installed = "unavailable"
        digest.update(f"{name}={installed}".encode())
    return digest.hexdigest()


def _analysis_source_paths(project_root: Path) -> set[Path]:
    pending = ["crystal_viewer.viewer.cell_settings", "crystal_viewer.legacy.symmetry_core"]
    paths = set()
    while pending:
        name = pending.pop()
        path = project_root.joinpath(*name.split(".")).with_suffix(".py")
        if not path.is_file():
            path = project_root.joinpath(*name.split("."), "__init__.py")
        if not path.is_file() or path in paths:
            continue
        paths.add(path)
        # Package initializers execute too, even for `from ... import name`.
        pending.extend(".".join(name.split(".")[:i]) for i in range(1, len(name.split("."))))
        package = name if path.name == "__init__.py" else name.rpartition(".")[0]
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                modules = [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom):
                base = resolve_name("." * node.level + (node.module or ""), package) if node.level else (node.module or "")
                modules = [base, *(base + "." + alias.name for alias in node.names)]
            else:
                continue
            pending.extend(module for module in modules if module.startswith("crystal_viewer."))
    return paths


def read_precomputed_cell(project_root: Path, base_payload: dict, source_payload: dict,
                          mode: str, tolerance_cart: float, key: str) -> dict | None:
    """Missing, stale, imported or damaged data falls back to normal conversion."""
    try:
        source = Path(base_payload["render_data"]["metadata"]["source_file"])
        if not source.is_absolute():
            source = project_root / source
        source = source.resolve()
        if source.parent != (project_root / "examples" / "cif").resolve() or source.suffix.lower() != ".cif":
            return None
        directory = project_root / "exports" / "cells" / source.stem.lower()
        index = json.loads((directory / "index.json").read_text(encoding="utf-8"))
        if (index["version"] != PRECOMPUTED_VERSION
                or index["tolerance_cart"] != float(tolerance_cart)
                or index["base_digest"] != payload_digest(base_payload)
                or index["source_sha256"] != hashlib.sha256(source.read_bytes()).hexdigest()
                or index["analysis_signature"] != analysis_signature(project_root)):
            return None
        # A key encodes the entire current input, including atom/operation order.
        if key != conversion_key(source_payload, mode, tolerance_cart):
            return None
        result_digest = index["transitions"].get(key, "")
        if not re.fullmatch(r"[0-9a-f]{64}", result_digest):
            return None
        result = json.loads(gzip.decompress((directory / f"{result_digest}.json.gz").read_bytes()))
        if payload_digest(result) != result_digest:
            return None
        result["render_data"]["metadata"]["source_file"] = source_payload["render_data"]["metadata"]["source_file"]
        return result
    except (OSError, ValueError, KeyError, TypeError, AttributeError, EOFError, zlib.error):
        return None
