from __future__ import annotations

import re
from pathlib import Path

from .atom_mapping import atom_mappings_from_analysis
from .json_export import export_payload
from .molecule_analysis import analyze_molecule_file
from .render_data import render_data_from_analysis
from .source_kinds import SOURCE_KIND_CRYSTAL, SOURCE_KIND_MOLECULE
from .structure_analysis import analyze_cif


DEFAULT_JSON_EXPORT_DIR = Path("exports/json")


def slug_from_path(path: str | Path) -> str:
    stem = Path(path).stem.lower()
    slug = re.sub(r"[^a-z0-9]+", "_", stem).strip("_")
    return slug or "structure"


def default_json_output_path(
    source_path: str | Path,
    output_dir: str | Path = DEFAULT_JSON_EXPORT_DIR,
) -> Path:
    return Path(output_dir) / f"{slug_from_path(source_path)}.json"


def analyze_for_export(path: str | Path, *, mode: str):
    if mode == SOURCE_KIND_CRYSTAL:
        return analyze_cif(path)
    if mode == SOURCE_KIND_MOLECULE:
        return analyze_molecule_file(path)
    raise ValueError(f"unsupported export mode: {mode}")


def build_legacy_export_payload(path, *, mode, tolerance_cart=1e-2):
    """Explicit API1 compatibility only; normal export uses the common model."""
    analysis = analyze_for_export(path, mode=mode)
    render_data = render_data_from_analysis(analysis)
    atom_mappings = atom_mappings_from_analysis(analysis, tolerance_cart=tolerance_cart)
    return export_payload(render_data, atom_mappings, source_kind=mode)


def build_export_payload(path, *, mode, tolerance_cart=1e-2):
    from crystal_viewer.model_export import verified_export_payload
    from crystal_viewer.source_inputs import crystal_input_from_cif, molecule_input_from_file
    if mode == SOURCE_KIND_CRYSTAL:
        source = crystal_input_from_cif(path)
    elif mode == SOURCE_KIND_MOLECULE:
        source = molecule_input_from_file(path)
    else:
        raise ValueError(f"unsupported export mode: {mode}")
    return verified_export_payload(source, tolerance_cart=tolerance_cart)


def export_analysis_to_json(path, *, mode, output_path=None, output_dir=DEFAULT_JSON_EXPORT_DIR,
                            tolerance_cart=1e-2, indent=2):
    from crystal_viewer.model_export import write_verified_export
    payload = build_export_payload(path, mode=mode, tolerance_cart=tolerance_cart)
    resolved_output = Path(output_path) if output_path is not None else default_json_output_path(path, output_dir)
    return write_verified_export(resolved_output, payload, indent=indent)


def export_legacy_analysis_to_json(path, *, mode, output_path=None, output_dir=DEFAULT_JSON_EXPORT_DIR,
                                   tolerance_cart=1e-2, indent=2):
    """Historical asset reproduction and explicit API1 maintenance only."""
    from crystal_viewer.model_export import write_verified_export
    payload = build_legacy_export_payload(path, mode=mode, tolerance_cart=tolerance_cart)
    resolved = Path(output_path) if output_path is not None else default_json_output_path(path, output_dir)
    return write_verified_export(resolved, payload, indent=indent)
