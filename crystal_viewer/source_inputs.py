"""Structure acquisition for API2, without legacy geometry or atom mappings.

This is a recorded analysis input, not a complete version-7 display export.
All symmetry proof, correction and presentation belong to the common model.
"""
from copy import deepcopy
from pathlib import Path
from importlib.metadata import version

import numpy as np
import spglib

from crystal_viewer.json_export import to_jsonable
from crystal_viewer.structure_analysis import (
    AnalysisError, load_structure_from_cif, structure_to_spglib_cell,
    convert_structure, convert_space_group,
)


def crystal_input_from_structure(structure, *, source_file, asymmetric_atoms=(),
                                 warnings=(), symprec=1e-3, angle_tolerance=5.):
    dataset = spglib.get_symmetry_dataset(structure_to_spglib_cell(structure),
        symprec=symprec, angle_tolerance=angle_tolerance)
    if dataset is None:
        raise AnalysisError("spglib could not determine symmetry for this structure.")
    rotations = np.asarray(dataset.rotations, dtype=int)
    translations = np.asarray(dataset.translations, dtype=float)
    summary = convert_structure(Path(source_file), structure, asymmetric_atoms=asymmetric_atoms,
        rotations=rotations, translations=translations, equivalent_atoms=dataset.equivalent_atoms)
    group = convert_space_group(dataset)
    B = np.asarray(summary.lattice).T
    inverse = np.linalg.inv(B)
    return dict(model_input_version=1, source_kind="crystal",
        analysis_parameters=dict(symprec_A=float(symprec), angle_tolerance_deg=float(angle_tolerance),
            analyzer="spglib", analyzer_version=spglib.__version__,
            parser="pymatgen", parser_version=version("pymatgen")),
        render_data=dict(metadata=dict(mode="crystal", source_file=str(source_file),
            formula=summary.formula, display_formula=summary.formula,
            symmetry_label=f"{group.number} {group.international}",
            point_group_label=group.point_group, operation_count=len(rotations), warnings=list(warnings)),
            atoms=[to_jsonable(atom) for atom in summary.atoms],
            asymmetric_atoms=[to_jsonable(atom) for atom in summary.asymmetric_atoms],
            unit_cell=dict(lattice=B.T.tolist()),
            operations=[dict(index=index, matrix_frac=W.tolist(), translation_frac=t.tolist(),
                             matrix_cart=(B@W@inverse).tolist(), translation_cart=(B@t).tolist())
                        for index, (W, t) in enumerate(zip(rotations, translations))]))


def crystal_input_from_cif(path, *, symprec=1e-3, angle_tolerance=5.):
    path = Path(path)
    if not path.exists():
        raise AnalysisError(f"CIF file not found: {path}")
    loaded = load_structure_from_cif(path)
    return crystal_input_from_structure(loaded.structure, source_file=path,
        asymmetric_atoms=loaded.asymmetric_atoms or (), warnings=loaded.warnings,
        symprec=symprec, angle_tolerance=angle_tolerance)


def molecule_input_from_file(path, *, tolerance=.3, eigen_tolerance=.01, matrix_tolerance=.1):
    from pymatgen.core import Molecule
    path = Path(path)
    if not path.exists():
        raise AnalysisError(f"molecule file not found: {path}")
    try:
        molecule = Molecule.from_file(path)
    except (ValueError, IndexError) as exc:
        raise AnalysisError("could not parse molecular structure") from exc
    return molecule_input_from_molecule(molecule, source_file=path,
        tolerance=tolerance, eigen_tolerance=eigen_tolerance, matrix_tolerance=matrix_tolerance)


def molecule_input_from_molecule(molecule, *, source_file=None,
                                 tolerance=.3, eigen_tolerance=.01, matrix_tolerance=.1):
    from pymatgen.symmetry.analyzer import PointGroupAnalyzer
    from crystal_viewer.molecule_analysis import (
        convert_molecule, molecule_center_from_analyzer, molecule_line_direction,
        plane_basis_from_normal, schoenflies_point_group_symbol,
    )
    analyzer = PointGroupAnalyzer(molecule, tolerance=tolerance,
        eigen_tolerance=eigen_tolerance, matrix_tolerance=matrix_tolerance)
    center = molecule_center_from_analyzer(molecule, analyzer)
    operations = []
    for index, op in enumerate(analyzer.get_symmetry_operations()):
        W = np.asarray(op.rotation_matrix, dtype=float)
        operations.append(dict(index=index, matrix_cart=W.tolist(),
            translation_cart=(center + op.translation_vector - W@center).tolist()))
    # These representatives complement the analyzer's axial group. The family
    # has no placeholder matrix; its explicit axis is evidence, not drawing data.
    symbol = analyzer.sch_symbol
    if "*" in symbol:
        direction = molecule_line_direction(molecule, center)
        if direction is None:
            raise AnalysisError("continuous molecular symmetry requires an atomic line")
        normal = plane_basis_from_normal(direction)[:, 0]
        operations.append(dict(index=len(operations), kind="rotation_infinite",
            continuous_axis=dict(point_cart=center.tolist(), direction_cart=direction.tolist())))
        normals = [normal, direction] if symbol.startswith("D") else [normal]
        for axis in normals:
            W = np.eye(3)-2*np.outer(axis, axis)
            operations.append(dict(index=len(operations), matrix_cart=W.tolist(),
                translation_cart=(center-W@center).tolist()))
    summary = convert_molecule(source_file, molecule, center)
    label = schoenflies_point_group_symbol(symbol)
    return dict(model_input_version=1, source_kind="molecule",
        analysis_parameters=dict(tolerance_A=float(tolerance), eigen_tolerance=float(eigen_tolerance),
            matrix_tolerance=float(matrix_tolerance), analyzer="pymatgen.PointGroupAnalyzer",
            analyzer_version=version("pymatgen"), parser="pymatgen", parser_version=version("pymatgen")),
        render_data=dict(metadata=dict(mode="molecule", source_file=None if source_file is None else str(source_file),
            formula=summary.formula, display_formula=summary.display_formula,
            symmetry_label=label, point_group_label=label, operation_count=len(operations)),
            atoms=[to_jsonable(atom) for atom in summary.atoms], unit_cell=None, operations=operations))


def crystal_cell_input(payload, mode, *, symprec=1e-3, angle_tolerance=5.):
    from crystal_viewer.viewer.cell_settings import standardized_structure_from_render_data
    from crystal_viewer.viewer.cell_frame import attach_frame_witness
    if not payload.get("render_data", {}).get("unit_cell"):
        raise ValueError("cell conversion requires a crystal input")
    if mode not in ("native", "primitive", "conventional"):
        raise ValueError("unknown cell setting")
    if mode == "native":
        result = deepcopy(payload)
    else:
        trace = {}
        structure = standardized_structure_from_render_data(payload["render_data"], mode,
            symprec=symprec, angle_tolerance=angle_tolerance, _frame_trace=trace)
        if structure is None:
            raise ValueError(f"cell setting {mode!r} is not available for this structure")
        metadata = payload["render_data"].get("metadata", {})
        result = crystal_input_from_structure(structure,
            source_file=metadata.get("source_file") or "standardized_structure",
            warnings=metadata.get("warnings", ()), symprec=symprec, angle_tolerance=angle_tolerance)
    metadata = result["render_data"].setdefault("metadata", {})
    metadata.update(display_cell_setting=mode, display_atom_count=len(result["render_data"]["atoms"]))
    return attach_frame_witness(payload, result, symprec=symprec, angle_tolerance=angle_tolerance,
        cell_setting=mode, source_analyzer=None if mode == "native" else trace["analyzer"])
