"""Browser projections of a published ModelSession. No legacy decompositions.

Display replication and appearance helpers operate only on the reconstructed
geometry. Source fields are used exclusively for descriptive metadata.
"""
from dataclasses import asdict
from copy import copy, deepcopy
from fractions import Fraction
import itertools
import json
import math
import re
import threading

import numpy as np

from crystal_viewer.viewer.model_session import ModelConflict, operation_id
from crystal_viewer.viewer.render_state import initial_render_state, apply_render_state_update, preserved_render_state
from crystal_viewer.viewer.operation_notation import name_plan, NotationContext
from crystal_viewer.viewer.plan_presentation import present_plan
from crystal_viewer.viewer.playback_schedule import ReferencePoints, build_schedule, evaluate_schedule, model_structure_span_A
from crystal_viewer.viewer.custom_plan import check_plan, plan_components, compose_plans
from crystal_viewer.viewer.operation_plan import _finite_plan
from crystal_viewer.viewer.cell_placement import placement_choices
from crystal_viewer.affine_math import compose

# Browser checks use an internal Cartesian radius for numerical input error.
# Explicit API tolerances remain supported by the existing compatibility path.
CUSTOM_ATOM_MATCH_TOLERANCE_A = 1e-5


def response_data(helpers, body):
    """Detach response values and reject invalid JSON without an encode/decode."""
    def convert(value):
        if type(value) not in (type(None), str, bool, int, float, list, tuple, dict):
            value = helpers.to_jsonable(value)
        if value is None or type(value) in (str, bool, int):
            return value
        if type(value) is float:
            if not math.isfinite(value):
                raise ValueError("non-finite model display data")
            return value
        elif type(value) in (list, tuple):
            return [convert(item) for item in value]
        elif type(value) is dict:
            return {str(key): convert(item) for key, item in value.items()}
        else:
            raise TypeError(f"invalid model display data: {type(value).__name__}")
    return convert(body)


def position_labels(presentation):
    """Coordinate spelling of the common geometry, without inferring fractions.

    Fractions come only from the already validated presentation. Numeric
    coefficients remain numeric; no low-index direction is substituted.
    """
    labels = []
    for stage in presentation.stages:
        if stage.kind == "affine":
            labels.append(dict(kind="affine", coordinates=[], coordinate_formula=list(stage.coordinate_formula)))
            continue
        if stage.kind == "translation":
            if any(Fraction(n.text) != 0 for n in stage.translation):
                labels.append(dict(kind="translation", coordinates=[n.text for n in stage.translation],
                                   coordinate_formula=list(stage.coordinate_formula)))
            continue
        values = (*stage.point, *stage.direction)
        rational = all(n.provenance == "rational_candidate" for n in values)
        def number(value):
            if value == 0: return "0"
            if value.denominator == 1: return str(value.numerator)
            return str(value) if rational else repr(float(value))
        def expression(constant, terms):
            text = ""
            for coefficient, variable in terms:
                if not coefficient: continue
                magnitude = abs(coefficient)
                term = variable if magnitude == 1 else f"({number(magnitude)})*{variable}"
                text += (("-" if coefficient < 0 else "+") if text else "-" if coefficient < 0 else "")+term
            if constant:
                text += (("-" if constant < 0 else "+") if text else "-" if constant < 0 else "")+number(abs(constant))
            return text or "0"
        if stage.kind == "rotation":
            point = [Fraction(n.text) for n in stage.point]
            direction = [Fraction(n.text) for n in stage.direction]
            pivot = next(i for i in (2, 0, 1) if direction[i])
            parameter = "xyz"[next(i for i in range(3) if direction[i])]
            coordinates = [expression(p-point[pivot]*u/direction[pivot], [(u, parameter)]) for p, u in zip(point, direction)]
            # Two independent coordinate constraints describe the same axis
            # without introducing a free parameter in the displayed equation.
            equation_pivot = max(range(3), key=lambda i: abs(direction[i]))
            equations = [dict(coordinate="xyz"[i], expression=expression(
                point[i]-point[equation_pivot]*direction[i]/direction[equation_pivot],
                [(direction[i]/direction[equation_pivot], "xyz"[equation_pivot])]))
                for i in range(3) if i != equation_pivot]
            labels.append(dict(kind="rotation", coordinates=coordinates, parameter=parameter,
                               axis_equations=equations, angle_degrees=stage.angle_degrees.text))
        elif stage.kind == "reflection":
            h = [Fraction(n.text) for n in stage.direction]
            d = Fraction(stage.plane_offset.text)
            rational = rational and stage.plane_offset.provenance == "rational_candidate"
            pivot = next(i for i in range(3) if h[i])
            coordinates = list("xyz")
            coordinates[pivot] = expression(d/h[pivot], [(-h[j]/h[pivot], "xyz"[j]) for j in range(3) if j != pivot])
            labels.append(dict(kind="reflection", coordinates=coordinates))
        elif stage.kind == "inversion":
            labels.append(dict(kind="inversion", coordinates=[n.text for n in stage.point]))
        else:
            raise ValueError("unexpected Standard presentation stage")
        labels[-1]["coordinate_formula"] = list(stage.coordinate_formula)
    return labels


def result_reading(notation):
    """Name the complete repeated action, independently of its playback stages."""
    kinds = [s.kind for s in notation.geometry.stages if s.kind != "translation"]
    translated = np.linalg.norm(notation.intrinsic_translation) > 1e-10
    reading = ("回反" if kinds == ["rotation", "inversion"] else "回映" if kinds == ["rotation", "reflection"] else
               "らせん" if kinds == ["rotation"] and translated else "回転" if kinds == ["rotation"] else
               "映進" if kinds == ["reflection"] and translated else "鏡映" if kinds == ["reflection"] else
               "反転" if kinds == ["inversion"] else "並進" if translated else "恒等操作")
    order = next((f.rotation_n for f in notation.factors if f.rotation_n), None)
    return f"{order}回{reading}" if "rotation" in kinds and order and order >= 2 else reading


def custom_operation_description(model, plan):
    """Describe the complete checked action without replacing its playback plan."""
    W, t = plan_components(model, plan)
    try:
        canonical = _finite_plan(model, W, t, None, "default", identity_context=dict(custom_plan_id=plan.plan_id), numeric_direction=True)
        notation = name_plan(model, canonical)
    except ValueError:
        # Naming is optional. Never replace the input by a nearby operation or
        # reject a valid playback plan because its conventional name is unknown.
        presentation = dict(symbol="Custom", reading="入力した変換", position_labels=[],
            motion_labels=position_labels(present_plan(model, plan)), geometry="", notation_order=1,
            rotation_angle_deg=0, translation_label="", notes=[], plan_id=plan.plan_id)
        B = np.array(model.lattice).T if model.periodic else np.eye(3)
        return dict(index=None, custom=True, description_available=False, symbol="Custom", continuous=False,
            matrix_frac=W.tolist() if model.periodic else None, translation_frac=t.tolist() if model.periodic else None,
            matrix_cart=(B@W@np.linalg.inv(B)).tolist(), translation_cart=(B@t).tolist(),
            presentations={mode: presentation for mode in ("default", "rotoinversion", "rotoreflection")})
    labels = position_labels(notation.geometry)
    symbol = notation.name.split("; full t=")[0].replace("bar(", "-").replace(")", "").replace("C_", "C").replace("S_", "S").removesuffix("^-1")
    rotation = next((s for s in canonical.stages if s.kind == "rotation"), None)
    presentation = dict(symbol=symbol, reading=result_reading(notation), position_labels=labels,
        motion_labels=position_labels(present_plan(model, plan)),
        geometry=position_text(labels) if model.periodic else "",
        notation_order=next((f.rotation_n for f in notation.factors if f.rotation_n), 1),
        rotation_angle_deg=float(np.degrees(rotation.angle_rad)) if rotation else 0,
        translation_label="", notes=[], plan_id=plan.plan_id)
    if model.periodic:
        presentation.update(operation_name_fields(notation, labels, symbol, mode="default"))
    B = np.array(model.lattice).T if model.periodic else np.eye(3)
    return dict(index=None, custom=True, symbol=symbol, continuous=False,
        matrix_frac=W.tolist() if model.periodic else None, translation_frac=t.tolist() if model.periodic else None,
        matrix_cart=(B@W@np.linalg.inv(B)).tolist(), translation_cart=(B@t).tolist(),
        presentations={mode: presentation for mode in ("default", "rotoinversion", "rotoreflection")})


def display_coordinate(expression):
    """Typeset validated coordinate coefficients; keep executable labels intact."""
    def coefficient(match):
        value, variable = match.groups()
        if "/" in value:
            fraction = Fraction(value)
            numerator = "" if fraction.numerator == 1 else str(fraction.numerator)
            return numerator+variable+"/"+str(fraction.denominator)
        return ("("+value+")" if "e" in value.lower() else value)+variable
    return re.sub(r"\(([^()]+)\)\*([xyz])", coefficient, expression)


def position_text(labels, *, named=False):
    def coordinates(item):
        return ", ".join(display_coordinate(value) for value in item["coordinates"])
    if named:
        roles = dict(rotation="軸", reflection="面", inversion="中心")
        return " / ".join(roles[item["kind"]]+" ("+coordinates(item)+")" for item in labels if item["kind"] != "translation")
    return "; ".join(coordinates(item) for item in labels if item["kind"] != "translation")


def operation_name_fields(notation, labels, symbol, *, mode):
    """IT A (2015), 1.4.2.1: operation symbol, intrinsic vector, location.

    Axis-type filter symbols remain separate. Read the validated spelling of
    the full intrinsic vector; never reduce it modulo a lattice translation.
    """
    active = [item for item in labels if item["kind"] != "translation"]
    if len(active) == 1 and active[0]["kind"] == "rotation":
        symbol = str(next(f.rotation_n for f in notation.factors if f.rotation_n is not None))
    symbol = symbol.removesuffix("+t")
    translation = next((item for item in labels if item["kind"] == "translation"), None)
    vector = ""
    if translation is not None:
        values = tuple(Fraction(value) for value in translation["coordinates"])
        simple_glide = symbol in ("a", "b", "c") and values == tuple(
            Fraction(1, 2) if i == "abc".index(symbol) else Fraction(0) for i in range(3))
        if not simple_glide:
            vector = "("+", ".join(translation["coordinates"])+")"
    result = dict(operation_symbol=symbol, translation_label=vector, geometry=position_text(labels, named=mode != "default"))
    if mode == "default":
        result["itc_symbol"] = symbol
    return result


def elements(plan):
    result = dict(axes=[], planes=[], centers=[])
    for stage in plan.stages:
        if stage.kind == "rotation":
            result["axes"].append(dict(point_cart=stage.center, direction_cart=stage.direction,
                rotation_sign=float(np.sign(stage.angle_rad)) if abs(stage.angle_rad) < np.pi-1e-8 else None,
                angle_deg=float(np.degrees(stage.angle_rad))))
        elif stage.kind == "reflection":
            normal = np.array(stage.direction)
            seed = np.eye(3)[np.argmin(abs(normal))]
            u = np.cross(normal, seed); u /= np.linalg.norm(u)
            v = np.cross(normal, u)
            result["planes"].append(dict(point_cart=stage.center, normal_cart=stage.direction,
                basis1_cart=u.tolist(), basis2_cart=v.tolist()))
        elif stage.kind == "inversion":
            result["centers"].append(dict(point_cart=stage.center))
        elif stage.kind == "translation":
            result["glide_translation_cart"] = stage.translation
    geometric = next((s for s in plan.stages if s.kind in ("rotation", "reflection")), None)
    result.update(view_direction_cart=geometric.direction if geometric else None,
                  focus_point_cart=geometric.center if geometric else None)
    return result


class ModelView:
    def __init__(self, api, helpers=None, *, display_mode="source", initial_operation=None, pyvista_enabled=False):
        if helpers is None:
            from crystal_viewer.viewer import model_helpers as helpers
        self.api = api
        self.session = api.session
        self.helpers = helpers
        self.display_mode = display_mode
        self.initial_operation = initial_operation
        self.pyvista_enabled = bool(pyvista_enabled)
        self.lock = threading.RLock()
        self.snapshot = None
        self.state = initial_render_state(helpers.empty_viewer_payload(), initial_operation=None, display_mode=display_mode)
        self.data = helpers.empty_viewer_payload()["render_data"]
        self.operations = []
        self.custom_request = None
        self.state.update(pyvista_enabled=self.pyvista_enabled, reset_revision=0)

    def sync(self, initial=None):
        try:
            snapshot = self.session.snapshot()
        except ModelConflict:
            if self.snapshot is not None:
                self.snapshot = None
                self.state = initial_render_state(self.helpers.empty_viewer_payload(), initial_operation=None, display_mode=self.display_mode)
                self.data = self.helpers.empty_viewer_payload()["render_data"]
                self.operations = []
                self.custom_request = None
                self.state.update(pyvista_enabled=self.pyvista_enabled, reset_revision=0)
            return
        if snapshot is self.snapshot:
            return
        self.adopt(self.prepare(snapshot))

    def prepare(self, snapshot):
        """Build and validate a detached projection, without publishing it."""
        staged = copy(self)
        staged.state = deepcopy(self.state)
        try:
            staged._project(snapshot)
            # Exercise the same drawing adapter before an invalid species/style
            # can replace the active model.
            response_data(self.helpers, dict(
                atoms=self.helpers.atom_api_items(staged.data["atoms"]),
                render_payload=staged._render_payload(), state=staged.state,
            ))
        except (KeyError, TypeError, AttributeError) as exc:
            raise ValueError(f"invalid model display data: {exc}") from exc
        return staged

    def adopt(self, staged):
        """Install a prepared projection while the caller holds this view's lock."""
        self.snapshot, self.data, self.operations = staged.snapshot, staged.data, staged.operations
        self.state, self.custom_request = staged.state, staged.custom_request

    def _project(self, snapshot):
        model = snapshot.model
        B = np.array(model.lattice).T if model.periodic else np.eye(3)
        context = json.loads(snapshot.load_context_json or "{}")
        metadata = json.loads(snapshot.source.payload_json)["render_data"].get("metadata", {}).copy()
        metadata.update(json.loads(snapshot.derived_metadata_json))
        metadata["cell_representative_policy"] = json.loads(snapshot.representatives_json)["policy"] if snapshot.representatives_json else None
        if model.periodic:
            from crystal_viewer.symmetry_model import _cell_parameters
            lengths, angles = _cell_parameters(B)
            metadata["lattice_parameters"] = dict(zip(("a", "b", "c", "alpha", "beta", "gamma"), [*lengths, *angles]))
        atoms = [dict(json.loads(species), index=index, frac=list(x) if model.periodic else None,
                      cart=(B@x).tolist()) for index, species, x in
                 zip(model.correspondence.atom_indices, model.species, model.positions)]
        source_atoms = {a["index"]: a for a in json.loads(snapshot.source.payload_json)["render_data"]["atoms"]}
        for atom in atoms:
            atom["asymmetric_index"] = source_atoms[atom["index"]].get("asymmetric_index")
            if "atomic_number" not in atom:
                from pymatgen.core import Element
                atom["atomic_number"] = Element(atom["element"]).Z
        cell = None
        if model.periodic:
            vertices = list(itertools.product((0, 1), repeat=3))
            cell = dict(lattice=model.lattice, vertices_cart=(np.array(vertices)@B.T).tolist(),
                        edges=[(i, j) for i, a in enumerate(vertices) for j, b in enumerate(vertices)
                               if i < j and sum(x != y for x, y in zip(a, b)) == 1])
        self.data = dict(atoms=atoms, operations=[], unit_cell=cell, metadata=metadata)
        self.data.update(bounds_min=np.min([a["cart"] for a in atoms], axis=0).tolist(),
                         bounds_max=np.max([a["cart"] for a in atoms], axis=0).tolist())
        self.operations = []
        notation_context = NotationContext(model)
        for index in model.correspondence.operation_indices:
            presentations = {}
            default = None
            for mode in ("default", "rotoinversion", "rotoreflection"):
                request = dict(snapshot.identity(), operation_index=index, operation_id=operation_id(model, index), mode=mode)
                if model.matrices[model.correspondence.operation_indices.index(index)] is None:
                    request["family_angle_rad"] = np.pi/2
                plan = self.api._plan(snapshot, request)
                notation = name_plan(model, plan, context=notation_context)
                p = notation.geometry
                rotation = next((s for s in plan.stages if s.kind == "rotation"), None)
                symbol = notation.name.split("; full t=")[0].replace("bar(", "-").replace(")", "").replace("C_", "C").replace("S_", "S")
                if model.matrices[model.correspondence.operation_indices.index(index)] is None:
                    symbol = "C∞"
                symbol = symbol.removesuffix("^-1")
                kinds = [s.kind for s in plan.stages if s.kind != "translation"]
                if model.continuous is not None and kinds == ["reflection"]:
                    normal = next(s.direction for s in plan.stages if s.kind == "reflection")
                    projection = abs(float(np.dot(normal, model.continuous.direction)))
                    if projection < 1e-9:
                        symbol = "sigma_v"
                    elif abs(projection-1) < 1e-9:
                        symbol = "sigma_h"
                translated = np.linalg.norm(notation.intrinsic_translation) > 1e-10
                reading = ("回反" if kinds == ["rotation", "inversion"] else "回映" if kinds == ["rotation", "reflection"] else
                           "らせん" if kinds == ["rotation"] and translated else "回転" if kinds == ["rotation"] else
                           "映進" if kinds == ["reflection"] and translated else "鏡映" if kinds == ["reflection"] else
                           "反転" if kinds == ["inversion"] else "並進" if translated else "恒等操作")
                if translated and len(kinds) > 1:
                    symbol += "+t"
                if not kinds and translated:
                    symbol = "t"
                order = None if "family_angle_rad" in request else next((f.rotation_n for f in notation.factors if f.rotation_n), 1)
                if rotation and order and order >= 2:
                    reading = f"{order}回" + reading
                notes = []
                if "family_angle_rad" in request:
                    notes.append("C∞は軸まわりの連続回転。表示の共通計画には90°の代表を使います。")
                if mode == "rotoreflection" and default and default["kind"] == "inversion":
                    direction_name = "c方向" if model.periodic else "読込時のz方向"
                    notes.append(f"分解用の軸は、反転中心を通る{direction_name}の軸。反転を回映に分解する軸は一意に決まらない。")
                if mode == "rotoinversion" and default and default["kind"] in ("mirror", "glide"):
                    notes.append(("分解用の反転中心は、セル内の対象面上でセル中心に最も近い点。" if snapshot.representatives_json else
                                  "分解用の反転中心は、座標原点から対象の面へ垂線を下ろした点。") +
                                 "鏡映を回反に分解する反転中心は一意に決まらない。")
                labels = position_labels(p)
                presentations[mode] = dict(symbol=symbol, reading=reading,
                    motion_steps=[dict(kind=s.kind,
                        angle_degrees=float(np.degrees(s.angle_rad)) if s.kind == "rotation" else None)
                        for s in plan.stages if s.kind != "translation" or np.linalg.norm(s.translation) > 1e-10],
                    geometry=position_text(labels, named=mode != "default") if model.periodic else "",
                    position_labels=labels,
                    translation_label="("+", ".join(p.stages[-1].translation[i].text for i in range(3))+")" if symbol.endswith("+t") else "",
                    notation_order=order,
                    rotation_angle_deg=float(np.degrees(rotation.angle_rad)) if rotation else 0,
                    notes=notes, plan_id=plan.plan_id,
                    type_rank=(6 if len([s for s in plan.stages if s.kind not in ("translation",)]) > 1 else
                               1 if rotation else 3 if any(s.kind == "reflection" for s in plan.stages) else
                               5 if any(s.kind == "inversion" for s in plan.stages) else
                               7 if np.linalg.norm(notation.intrinsic_translation) > 1e-10 else 0))
                if model.periodic:
                    presentations[mode].update(operation_name_fields(notation, labels, symbol, mode=mode))
                if mode == "default":
                    default_geometry = p
                    W, t = model.operation_components(index, family_angle_rad=request.get("family_angle_rad"))
                    default = dict(index=index, operation_id=request["operation_id"],
                        matrix_frac=W.tolist() if model.periodic else None,
                        translation_frac=t.tolist() if model.periodic else None,
                        matrix_cart=(B@W@np.linalg.inv(B)).tolist(), translation_cart=(B@t).tolist(),
                        symbol=symbol, display_symbol=symbol, label=symbol,
                        kind="continuous_rotation" if "family_angle_rad" in request else
                            "identity" if not kinds and not translated else "translation" if not kinds else
                            ("screw" if translated else "rotation") if kinds == ["rotation"] else
                            ("glide" if translated else "mirror") if kinds == ["reflection"] else
                            "inversion" if kinds == ["inversion"] else
                            "rotoinversion" if kinds == ["rotation", "inversion"] else "rotoreflection",
                        continuous="family_angle_rad" in request, order=presentations[mode]["notation_order"],
                        element_summary=p.factorization_text, itc_like_summary=p.factorization_text)
            default["presentations"] = presentations
            # Classify direction families using only this verified model and
            # the default plan's presented geometry, never source elements.
            presented = default_geometry
            stage = next((s for s in presented.stages if s.kind in ("rotation", "reflection")), None)
            kind = "axis" if stage and stage.kind == "rotation" else "plane" if stage else "none"
            vector = [float(n.model_numeric_value) for n in stage.direction] if stage else []
            if default["kind"] == "translation":
                kind = "translation"
                vector = default["translation_frac"] if model.periodic else default["translation_cart"]
            default["direction_sort_key"] = kind+":"+" ".join(str(v) for v in vector) if vector else "center" if any(s.kind == "inversion" for s in presented.stages) else "none"
            default["direction_label"] = default["direction_sort_key"]
            default["element_sort_key"] = presented.factorization_text
            self.operations.append(default)
        self.data["operations"] = self.operations
        if model.periodic:
            from crystal_viewer.viewer.operation_labels import add_direction_families
            add_direction_families(self.data, self.operations)
        old = self.state
        rebuild = self.snapshot is not None and context.get("root_load_revision") == json.loads(self.snapshot.load_context_json or "{}").get("root_load_revision")
        self.state = initial_render_state(dict(render_data=self.data, source_kind="crystal" if model.periodic else "molecule"),
            initial_operation=self.initial_operation if self.snapshot is None else None,
            display_mode=self.display_mode, preserved=preserved_render_state(old) if rebuild else None)
        self.state.update(snapshot.identity(), json_path=context.get("json_path", ""),
            view_revision=0,
            reset_revision=0, pyvista_enabled=self.pyvista_enabled,
            reload_request_id=snapshot.structure_revision, cell_setting_mode=context.get("cell_setting", "native"),
            cell_origin_frac=context.get("origin_frac", [0, 0, 0]), model_change=json.loads(snapshot.model_change_json or "null"))
        if snapshot.representatives_json:
            self.state["cell_origin_mode"] = "center" if context.get("representative_cell_lower", 0.) == -.5 else "corner"
        provenance = json.loads(snapshot.source.analysis_context_json).get("provenance", {})
        change = self.state["model_change"] or {}
        if rebuild and provenance.get("entrypoint") in ("cell_placement", "reference_cell") and change.get("status") == "verified":
            relation = change["correspondence"]
            pairs = relation["atoms"]
            # Preserve placement UI only through a verified bijection. A cell
            # merge/split or an unavailable frame never reuses atom numbers.
            mapping = {p["source_atom"]: p["target_atom"] for p in pairs}
            if (relation["from_model_id"] == self.snapshot.model.model_id
                    and relation["to_model_id"] == model.model_id
                    and len(pairs) == len(mapping) == len(set(mapping.values())) == len(model.positions)
                    and len(mapping) == len(self.snapshot.model.positions)):
                self.state["selected_atoms"] = [mapping[i] for i in old["selected_atoms"]]
                self.state["scope"] = old["scope"]
                for key in ("atom_colors", "atom_hidden"):
                    self.state[key] = {str(mapping[int(i)]): value for i, value in old[key].items() if int(i) in mapping}
                for key in ("element_colors", "element_hidden", "range_highlight"):
                    self.state[key] = deepcopy(old[key])
                operations = [p["target_operation"] for p in relation["operations"]
                    if p["source_operation"] == old["operation_index"]
                    and not any(p["source_cell_lift"])
                    and (not any(p["target_cell_shift"]) or
                         (snapshot.representatives_json and self.snapshot.representatives_json))]
                if len(operations) == 1:
                    self.state["operation_index"] = operations[0]
        self.state["cell_placement"] = provenance.get("placement", "initial")
        self.state["cell_placement_atom"] = provenance.get("atom_index")
        self.state["cell_placement_target"] = provenance.get("target")
        self.snapshot = snapshot
        self.custom_request = None

    def bundle(self, initial=None):
        with self.lock:
            if initial is not None and "model_id" in initial:
                self.session.snapshot(initial)
            self.sync(initial)
            body = dict(ok=True, model_snapshot=self.session.initial(self.snapshot) if self.snapshot else None,
                        operations=self.operations, atoms=self.helpers.atom_api_items(self.data["atoms"]), state=self.state,
                        render_payload=self._render_payload(include_operations=False))
            if self.snapshot:
                body["render_payload"] = self.session.finish(self.snapshot, body["render_payload"])
                self.session.finish(self.snapshot, {})
            return response_data(self.helpers, body)

    def _render_payload(self, *, include_operations=True):
        s = self.state
        # The exchange bundle already contains the presentation operations.
        # Only the browser combines them; never serialize that list twice here.
        data = self.data if include_operations else {k: v for k, v in self.data.items() if k != "operations"}
        result = dict(source_kind=s["source_kind"], coordinate_space="cartesian", render_data=data,
            display_mode=s["display_mode"], cell_origin_mode=s["cell_origin_mode"],
            view_revision=s.get("view_revision", 0),
            display_atoms=self.helpers.display_atom_api_items(self.data, display_mode=s["display_mode"],
                cell_origin_mode=s["cell_origin_mode"], include_boundary_images=s["include_boundary_images"],
                element_hidden=s["element_hidden"], atom_hidden=s["atom_hidden"]),
            display_unit_cell=self.helpers.display_unit_cell_api_item(self.data, display_mode=s["display_mode"], cell_origin_mode=s["cell_origin_mode"]),
            atom_styles=self.helpers.atom_render_style_items(self.data, element_colors=s["element_colors"], atom_colors=s["atom_colors"]))
        return result

    def request(self, *, custom=False, index=None):
        snapshot = self.snapshot
        if custom:
            if self.custom_request is None:
                raise ValueError("Check the Custom operation first")
            return self.custom_request
        index = self.state["operation_index"] if index is None else int(index)
        request = dict(snapshot.identity(), operation_index=index, operation_id=operation_id(snapshot.model, index), mode=self.state["improper_mode"])
        if self.operations[ next(i for i, op in enumerate(self.operations) if op["index"] == index) ]["continuous"]:
            request["family_angle_rad"] = np.pi/2
        return request

    def custom(self, item):
        if item.get("type") == "operation":
            return dict(self.request(index=item["index"]), mode="default")
        kind = item.get("op_type", item.get("type"))
        params = dict(item.get("op_params", item.get("params", {})))
        if kind == "matrix":
            params["W"] = np.asarray(params["W"]).reshape(3, 3).tolist()
        return dict(self.snapshot.identity(), custom=dict(kind=kind, params=params))

    def _apply_state_update(self, update):
        """Validate against this projection; also usable before publication."""
        if (self.snapshot and self.snapshot.representatives_json and "cell_origin_mode" in update
                and update["cell_origin_mode"] != self.state["cell_origin_mode"]):
            raise ValueError("reference cell change requires a model transaction")
        next_state = deepcopy(self.state)
        next_custom = self.custom_request
        if "custom_sequence_token" in update:
            token = update["custom_sequence_token"]
            if not isinstance(token, str) or not token:
                raise ValueError("a nonempty Custom sequence token is required")
            if not update.get("clear_custom_check") and token != self.state.get("custom_sequence_token"):
                raise ModelConflict("Custom sequence changed")
            next_state["custom_sequence_token"] = token
        if "operation_index" in update:
            self.request(index=update["operation_index"])
        if update.get("clear_custom_check"):
            next_custom = None
            next_state.update(custom_op_result=None, custom_op_animate=None)
        if update.get("custom_op_animate"):
            request = update["custom_op_animate"]
            candidate = (dict(self.snapshot.identity(), sequence=[self.custom(i) for i in request["sequence_items"]])
                         if request.get("sequence_items") else self.custom(dict(op_type=request["op_type"], op_params=request["op_params"])))
            self.api._plan(self.snapshot, candidate)
            next_custom = candidate
        apply_render_state_update(next_state, update)
        if next_state["improper_mode"] not in ("default", "rotoinversion", "rotoreflection"):
            raise ValueError("unknown decomposition mode")
        count = next_state["operation_repetitions"]
        if type(count) is not int or not 1 <= count <= 120:
            raise ValueError("1..120 integer repetitions required")
        if self.snapshot and any(type(i) is not int or i not in self.snapshot.model.correspondence.atom_indices for i in next_state["selected_atoms"]):
            raise ValueError("unknown selected atom")
        if self.snapshot:
            self.helpers.update_view_coordinate_state(self.data, next_state, update)
        self.helpers.display_fractional_bounds(next_state["display_mode"], next_state["cell_origin_mode"])
        next_state["view_revision"] = self.state.get("view_revision", 0)+1
        if update.get("reset"):
            next_state["reset_revision"] = self.state.get("reset_revision", 0)+1
        self.state, self.custom_request = next_state, next_custom

    def dispatch(self, path, payload, *, verified_plan=None, plan_groups=None):
        with self.lock:
            self.sync()
            if self.snapshot:
                self.snapshot.require(payload)
            if path == "bootstrap":
                return self.bundle()
            if path == "plan":
                return self.api.respond("/api/plan", payload)
            if path == "state":
                update = payload.get("update", {})
                if update:
                    self._apply_state_update(update)
                result = dict(self.state)
            elif path == "operations":
                result = dict(operations=self.operations, summaries_ready=True)
            elif path == "atoms":
                result = dict(atoms=self.helpers.atom_api_items(self.data["atoms"]))
            elif path == "render_data":
                result = self._render_payload()
            elif path == "cell_placement":
                selected = self.state["selected_atoms"]
                result = dict(choices=placement_choices(self.data, selected[0]) if len(selected) == 1 else [])
            elif path in ("powers", "custom_powers"):
                model = self.snapshot.model
                custom = path == "custom_powers"
                plan = self.api._plan(self.snapshot, self.request(custom=custom, index=payload.get("operation_index")))
                if custom and (not (self.state.get("custom_op_result") or {}).get("is_symmetry")
                        or payload.get("expected_plan_id") != plan.plan_id):
                    raise ModelConflict("checked Custom symmetry plan required")
                if "plan_request" in payload and self.api._plan(self.snapshot, payload["plan_request"]).plan_id != plan.plan_id:
                    raise ModelConflict("view selection changed")
                B = np.array(model.lattice).T if model.periodic else np.eye(3)
                steps = []
                complete = False
                base = plan_components(model, plan) if custom else model.operation_components(
                    plan.operation_index, family_angle_rad=np.pi/2 if
                    next(op for op in self.operations if op["index"] == plan.operation_index)["continuous"] else None)
                total = (np.eye(3), np.zeros(3))
                for n in range(1, 121):
                    combined = compose_plans(model, [plan]*n).plan
                    total = compose(base, total)
                    W, t = total
                    plan_W, plan_t = plan_components(model, combined)
                    if np.max(abs(W-plan_W)) > 1e-9 or np.max(abs(B@(t-plan_t))) > 1e-8:
                        raise ValueError("plan and complete model operation disagree")
                    match, shift = None, None
                    for op in self.operations:
                        if op["continuous"]:
                            continue
                        A, v = model.operation_components(op["index"])
                        delta = t-v
                        if np.max(abs(W-A)) <= 1e-9 and np.max(abs(delta-(np.rint(delta) if model.periodic else 0))) <= 1e-8:
                            match, shift = op, np.rint(delta).astype(int).tolist() if model.periodic else None
                            break
                    try:
                        result_plan = _finite_plan(model, W, t, None, "default",
                            identity_context=dict(input_plan_id=combined.plan_id), numeric_direction=custom)
                        reading = result_reading(name_plan(model, result_plan))
                    except ValueError:
                        if not custom:
                            raise
                        reading = "入力した変換"
                        match, shift = None, None
                    step = dict(n=n, W=W.tolist(), t=t.tolist(), match=match, latticeShift=shift,
                        result_reading=reading,
                        cartesian=dict(W=(B@W@np.linalg.inv(B)).tolist(), t=(B@t).tolist()), plan_id=combined.plan_id)
                    steps.append(step)
                    complete = np.max(abs(W-np.eye(3))) <= 1e-9 and np.max(abs(t-(np.rint(t) if model.periodic else 0))) <= 1e-8
                    if complete and n >= 2:
                        break
                result = dict(steps=steps, complete=bool(complete), plan_id=plan.plan_id)
            elif path in ("check_operation", "compose_operations"):
                if "custom_sequence_token" in payload and (
                        payload["custom_sequence_token"] != self.state.get("custom_sequence_token")
                        or self.state["active_mode"] != "custom"):
                    raise ModelConflict("Custom sequence changed")
                request = (dict(self.snapshot.identity(), sequence=[self.custom(i) for i in payload["sequence_items"]])
                           if path == "compose_operations" else self.custom(payload))
                plan = self.api._plan(self.snapshot, request)
                if path == "check_operation" and payload.get("build_only"):
                    W, t = plan_components(self.snapshot.model, plan)
                    B = np.array(self.snapshot.model.lattice).T if self.snapshot.model.periodic else np.eye(3)
                    return self.session.finish(self.snapshot, dict(W_frac=W.tolist(), t_frac=t.tolist(),
                        matrix_cart=(B@W@np.linalg.inv(B)).tolist(), translation_cart=(B@t).tolist(), plan_id=plan.plan_id))
                tolerance = CUSTOM_ATOM_MATCH_TOLERANCE_A
                if "tolerance" in payload:
                    tolerance, error = self.helpers.custom_operation_tolerance(payload["tolerance"])
                    if error:
                        raise ValueError(error)
                check = check_plan(self.snapshot.model, plan, mapping_tolerance_A=tolerance)
                B = np.array(self.snapshot.model.lattice).T if self.snapshot.model.periodic else np.eye(3)
                mapped, unmapped = [], []
                by_index = {a["index"]: a for a in self.data["atoms"]}
                for atom in check.atom_checks:
                    source = by_index[atom.atom_index]
                    entry = dict(source=atom.atom_index, element=source["element"], source_frac=source.get("frac") or source["cart"], transformed_frac=atom.transformed)
                    if len(atom.candidates) == 1:
                        target, image, residual = atom.candidates[0]
                        mapped.append(dict(entry, target=target, target_frac=by_index[target].get("frac"),
                                           target_image=image, distance=residual))
                    else:
                        model = self.snapshot.model
                        B = np.array(model.lattice).T if model.periodic else np.eye(3)
                        candidates = []
                        # Exact closest-cell image search (not component rounding
                        # in oblique cells), only for diagnostic nearest points.
                        for other in self.data["atoms"]:
                            if source["element"] != other["element"]:
                                continue
                            x = other["frac"] if model.periodic else other["cart"]
                            delta = np.array(atom.transformed)-x
                            radius = float(np.linalg.norm(B@(delta-np.rint(delta) if model.periodic else delta)))+1e-9
                            if model.periodic:
                                bound = np.linalg.norm(np.linalg.inv(B), axis=1)*radius
                                ranges = [range(int(np.ceil(d-b-1e-12)), int(np.floor(d+b+1e-12))+1) for d, b in zip(delta, bound)]
                                for image in itertools.product(*ranges):
                                    residual = float(np.linalg.norm(B@(delta-image)))
                                    candidates.append((residual, other["index"], (np.array(x)+image).tolist()))
                            else:
                                candidates.append((radius-1e-9, other["index"], x))
                        distance, nearest, coord = min(candidates)
                        unmapped.append(dict(entry, nearest_atom=nearest, nearest_frac=coord, distance=distance, candidate_count=len(atom.candidates)))
                result = dict(is_symmetry=check.is_symmetry, total=len(check.atom_checks), mapped=mapped, unmapped=unmapped,
                    mapped_count=len(mapped), unmapped_count=len(unmapped), W_frac=check.matrix, t_frac=check.translation,
                    matrix_cart=(B@np.array(check.matrix)@np.linalg.inv(B)).tolist(), translation_cart=(B@check.translation).tolist(),
                    matrix_issue="Not an isometry" if check.isometry_residual > check.numeric_tolerance else None,
                    elements=elements(plan), sequence_items=payload.get("sequence_items"), plan_id=plan.plan_id, check=asdict(check))
                if check.is_symmetry:
                    result["operation"] = custom_operation_description(self.snapshot.model, plan)
                if payload.get("store_custom_result"):
                    self.custom_request = request
                    self.state["custom_op_result"] = result
            elif path in ("animation_path", "custom_animation_path", "atom_motion", "symmetry_elements"):
                if not self.snapshot:
                    return dict(paths=[], entries=[], axes=[], planes=[], centers=[])
                model = self.snapshot.model
                custom = path == "custom_animation_path"
                request = self.request(custom=custom, index=payload.get("operation_index")) if verified_plan is None else {}
                plan = self.api._plan(self.snapshot, request) if verified_plan is None else verified_plan
                plan.require_model(model)
                if verified_plan is None and "plan_request" in payload and self.api._plan(self.snapshot, payload["plan_request"]).plan_id != plan.plan_id:
                    raise ModelConflict("view selection changed")
                if "expected_plan_id" in payload and payload["expected_plan_id"] != plan.plan_id:
                    raise ModelConflict("Custom plan changed")
                if path == "symmetry_elements":
                    result = dict(elements(plan), plan_id=plan.plan_id)
                else:
                    B = np.array(model.lattice).T if model.periodic else np.eye(3)
                    selected = set(self.state["selected_atoms"])
                    scope = self.state["scope"]
                    indices = list(model.correspondence.atom_indices)
                    moving = indices[:1] if scope == "representative" else [i for i in indices if i in selected] if scope.startswith("selected") else indices
                    if custom:
                        moving = self.state["custom_op_animate"]["atom_indices"]
                    unit_only = scope in ("representative", "unit_cell", "selected")
                    if custom:
                        unit_only = self.state["custom_op_animate"].get("unit_cell_only", False)
                    display = self.helpers.display_atom_api_items(self.data, display_mode=self.state["display_mode"],
                        cell_origin_mode=self.state["cell_origin_mode"], include_boundary_images=self.state["include_boundary_images"],
                        element_hidden=self.state["element_hidden"], atom_hidden=self.state["atom_hidden"])
                    lower = -.5 if self.state["cell_origin_mode"] == "center" else 0.
                    freeze_extensions = str(payload.get("freeze_range_extensions", "0")) == "1"
                    points = [a["cart"] for a in display if a["source_atom"] in moving and (not unit_only or a["is_primary_image"])
                        and not (freeze_extensions and a["frac"] is not None and
                            (np.any(np.asarray(a["frac"]) < lower-1e-9) or np.any(np.asarray(a["frac"]) > lower+1+1e-9)))]
                    refs = ReferencePoints(model.model_id, model.frame_id, tuple(tuple(float(v) for v in x) for x in points))
                    span = model_structure_span_A(model)
                    schedule = build_schedule(model, plan, refs, scene_span_A=span, repetitions=int(self.state["operation_repetitions"]))
                    playback = self.session.finish(self.snapshot, dict(plan_id=plan.plan_id, plan=asdict(plan), schedule=asdict(schedule), references=asdict(refs)))
                    groups = list(plan_groups) if plan_groups else [plan]
                    if custom and "sequence" in request:
                        groups = [self.api._plan(self.snapshot, item) for item in request["sequence"]]
                    segment_elements, segment_boundaries = [], []
                    elapsed = 0.
                    for app in schedule.applications:
                        offset = 0
                        for j, group in enumerate(groups):
                            end = offset+len(group.stages)
                            elapsed += sum(app.stage_durations_seconds[offset:end])
                            if j == len(groups)-1:
                                elapsed += app.presentation_hold_seconds
                            segment_elements.append(elements(group))
                            segment_boundaries.append(elapsed/schedule.duration_seconds if schedule.duration_seconds else 1.)
                            offset = end
                    result = dict(playback=playback, plan_id=plan.plan_id, paths=[dict(source_atom=i, path=dict(type="model_plan", unit_cell_only=unit_only)) for i in moving],
                        animation_duration_seconds=schedule.duration_seconds, maximum_travel_distance=0,
                        application_boundaries=(np.cumsum([a.duration_seconds for a in schedule.applications])/schedule.duration_seconds).tolist() if schedule.duration_seconds else [],
                        animate_id=(self.state.get("custom_op_animate") or {}).get("animate_id"))
                    if custom or plan_groups or len(schedule.applications) > 1:
                        for item in result["paths"]:
                            item["path"].update(segment_elements=segment_elements, model_segment_boundaries=segment_boundaries)
                    if path == "atom_motion":
                        starts = np.array([a["cart"] for a in self.data["atoms"]])
                        ends = evaluate_schedule(plan, schedule, starts, 1)
                        W, t = plan_components(model, plan)
                        entries = []
                        for atom, end in zip(self.data["atoms"], ends):
                            target = None
                            coord = np.linalg.solve(B, end)
                            for other, x, species in zip(self.data["atoms"], model.positions, model.species):
                                delta = coord-x
                                if model.periodic:
                                    delta -= np.rint(delta)
                                if atom["element"] == other["element"] and np.linalg.norm(B@delta) < 1e-8:
                                    target = other["index"]
                                    break
                            entries.append(dict(source_atom=atom["index"], target_atom=target, start_frac=atom["frac"], start_cart=atom["cart"],
                                target_cart=end.tolist(), target_frac=coord.tolist() if model.periodic else None, stages=[]))
                        result["entries"] = entries
            else:
                raise ValueError("unsupported model view endpoint: "+path)
            if self.snapshot:
                result = {k: v for k, v in result.items() if k not in self.snapshot.identity()}
                return self.session.finish(self.snapshot, result)
            return result
