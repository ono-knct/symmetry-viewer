"""One-shot PyVista CLI using the normal whole-space plan and schedule."""
import json
from pathlib import Path
import time

import numpy as np
import pyvista as pv

from crystal_viewer.model_export import prepare_view, export_view
from crystal_viewer.viewer.model_pyvista import ModelPyVistaViewer
from crystal_viewer.viewer.model_view import elements
from crystal_viewer.viewer.cli_helpers import parse_selected_atoms, print_operations, print_mapping


def run_cli(args, parser):
    payload = json.loads(Path(args.json_path).read_text(encoding="utf-8"))
    view = prepare_view(payload, path=args.json_path, tolerance_cart=.1, host="pyvista_cli")
    if args.operation is not None:
        if args.operation not in view.snapshot.model.correspondence.operation_indices:
            parser.error("unknown operation index")
        view.dispatch("state", dict(view.snapshot.identity(), update=dict(operation_index=args.operation)))
    if args.list_operations or args.show_mapping:
        exported = export_view(view)
        if args.list_operations:
            print_operations(exported["render_data"], exported["atom_mappings"])
        else:
            print_mapping(exported["atom_mappings"], args.operation)
        return 0
    plan = view.api._plan(view.snapshot, view.request())
    geometry = elements(plan)
    if args.list_elements:
        if args.operation is None:
            print("Use --operation with --list-elements.")
        else:
            print(f"=== Symmetry Elements for operation {args.operation} (common plan) ===")
            print(json.dumps(geometry, indent=2))
        return 0
    if args.animate and args.operation is None:
        parser.error("--animate requires --operation")
    if args.element_index is not None:
        if args.operation is None:
            parser.error("--element-index requires --operation")
        if type(args.element_index) is not int or args.element_index < 0 or not any(
                args.element_index < len(geometry[k]) for k in ("axes", "planes", "centers")):
            parser.error("--element-index is not available in the selected operation's common plan")
    if not np.isfinite(args.animation_speed) or args.animation_speed <= 0 or not np.isfinite(args.animation_fps) or args.animation_fps <= 0:
        parser.error("positive finite animation speed and fps required")
    selected = parse_selected_atoms(args.selected_atoms)
    if args.selected_atom is not None:
        selected = tuple(dict.fromkeys((*selected, args.selected_atom)))
    if args.representative_atom is not None and args.representative_atom not in view.snapshot.model.correspondence.atom_indices:
        parser.error("unknown representative atom")
    if not selected and args.animation_scope == "representative":
        selected = (args.representative_atom if args.representative_atom is not None else view.data["atoms"][0]["index"],)
    view.dispatch("state", dict(view.snapshot.identity(), update=dict(display_mode=args.display_mode,
        scope="selected_displayed" if selected else "displayed", selected_atoms=list(selected),
        include_boundary_images=False, cell_origin_mode="corner")))
    plotter = pv.Plotter(off_screen=args.off_screen or args.screenshot is not None or args.animation_output is not None)
    viewer = ModelPyVistaViewer(view, plotter=plotter)
    viewer.draw_atoms, viewer.draw_cell, viewer.draw_symmetry = not args.no_atoms, not args.no_cell, not args.no_elements
    try:
        show_all = args.operation is None and not args.no_elements
        if show_all:
            viewer.draw_symmetry = False
        viewer.sync()
        if show_all:
            all_elements = dict(axes=[], planes=[], centers=[])
            for candidate in view.snapshot.plans:
                if candidate.mode == "default":
                    geometry = elements(candidate)
                    for key in all_elements:
                        all_elements[key].extend(geometry[key])
            if view.snapshot.model.continuous is not None:
                group = view.snapshot.model.continuous
                all_elements["axes"].append(dict(point_cart=group.center, direction_cart=group.direction))
            viewer.element_actors = viewer.draw_elements(all_elements)
        if args.show_displacements:
            from crystal_viewer.viewer.playback_schedule import evaluate_schedule
            ends = viewer.starts.copy()
            ends[viewer.moving] = evaluate_schedule(viewer.scene.plan, viewer.scene.schedule, viewer.starts[viewer.moving], 1)
            for start, end in zip(viewer.starts[viewer.moving], ends[viewer.moving]):
                if np.linalg.norm(end-start) > 1e-10:
                    plotter.add_mesh(pv.Line(start, end), color="#e6a23c", line_width=2)
        if args.animate and args.no_atoms:
            print("Animation skipped because atoms are hidden.")
            return 0
        if args.animate:
            frames = max(args.animation_frames, 2)
            fps = max(float(args.animation_fps), 1.)*max(float(args.animation_speed), .05)
            if args.animation_output is not None:
                args.animation_output.parent.mkdir(parents=True, exist_ok=True)
                plotter.open_gif(str(args.animation_output), fps=fps)
            plotter.show(auto_close=False, interactive_update=True)
            for frame in range(frames):
                viewer.set_progress(frame/(frames-1))
                if args.animation_output is not None:
                    plotter.write_frame()
                else:
                    plotter.update()
                    time.sleep(1/fps)
            if args.animation_output is not None:
                print(f"Wrote {args.animation_output}")
            else:
                plotter.show(auto_close=False)
        elif args.screenshot is not None:
            args.screenshot.parent.mkdir(parents=True, exist_ok=True)
            plotter.show(screenshot=str(args.screenshot), auto_close=False)
            print(f"Wrote {args.screenshot}")
        else:
            plotter.show()
        return 0
    finally:
        plotter.close()
