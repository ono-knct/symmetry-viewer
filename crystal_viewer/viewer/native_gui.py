from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import logging
import pyvista as pv

# PyVista/VTK can emit repetitive warnings through the Python logger.
# Suppress them here so the console stays readable.
logging.getLogger("pyvista").setLevel(logging.ERROR)
logging.getLogger("vtkmodules").setLevel(logging.ERROR)

if os.environ.get("CRYSTAL_VIEWER_VTK_WARNINGS") != "1":
    try:
        pv.set_error_output_file(os.devnull)
    except Exception:
        pass
    try:
        import vtk

        vtk.vtkObject.GlobalWarningDisplayOff()
    except Exception:
        pass

from crystal_viewer.model_export import prepare_view
from crystal_viewer.viewer.cli_helpers import parse_selected_atoms
from crystal_viewer.viewer.model_pyvista import ModelPyVistaViewer


class NativePyVistaViewer(ModelPyVistaViewer):
    def __init__(self, json_path, *, scope="all", selected_atoms=(), display_mode="source",
                 initial_operation=None, plotter=None):
        self.json_path = Path(json_path)
        payload = json.loads(self.json_path.read_text(encoding="utf-8"))
        view = prepare_view(payload, path=self.json_path, tolerance_cart=.1, host="native_gui")
        self.selected_atoms = tuple(selected_atoms)
        if any(type(i) is not int or i not in view.snapshot.model.correspondence.atom_indices for i in self.selected_atoms):
            raise ValueError("unknown selected atom")
        update = dict(scope=self._scope(scope), selected_atoms=list(selected_atoms), display_mode=display_mode,
                      cell_origin_mode="center", include_boundary_images=False)
        if initial_operation is not None:
            if type(initial_operation) is not int or initial_operation not in view.snapshot.model.correspondence.operation_indices:
                raise ValueError("unknown operation index")
            update["operation_index"] = initial_operation
        view.dispatch("state", dict(view.snapshot.identity(), update=update))
        super().__init__(view, plotter=plotter)

    def _scope(self, scope):
        if scope not in ("all", "displayed", "unit_cell", "representative", "selected", "selected_displayed"):
            raise ValueError("unknown animation scope")
        return "displayed" if scope == "all" else "representative" if scope == "selected" and not self.selected_atoms else scope

    def rebuild(self, *, reset_camera):
        super().rebuild(reset_camera=reset_camera)
        # Plotter.clear removes the widget representations from the renderer,
        # while keeping the enabled widget objects. Reattach their existing
        # representations instead of recreating controls or callbacks.
        values = (self.operations.index(self.current_operation()), self.view.state["speed"])
        for widget, value in zip(self.plotter.widgets.slider_widgets, values):
            enabled = widget.GetEnabled()
            widget.SetEnabled(False)
            widget.GetRepresentation().SetValue(float(value))
            widget.SetEnabled(enabled)

    @property
    def operations(self):
        return self.view.operations

    def current_operation(self):
        return next(op for op in self.operations if op["index"] == self.view.state["operation_index"])

    def set_operation_position(self, position):
        position = max(0, min(int(position), len(self.operations)-1))
        self.update_state(dict(operation_index=self.operations[position]["index"], reset=True, playing=False))
        self.sync()
        self.plotter.render()

    def on_operation_slider(self, value):
        self.set_operation_position(round(value))

    def on_speed_slider(self, value):
        self.update_state(dict(speed=max(.1, min(float(value), 4.))))

    def next_operation(self):
        self.set_operation_position(self.operations.index(self.current_operation())+1)

    def previous_operation(self):
        self.set_operation_position(self.operations.index(self.current_operation())-1)

    def toggle_play(self):
        self.update_state(dict(playing=not self.view.state["playing"]))

    def reset_animation(self):
        self.update_state(dict(reset=True, playing=False))
        self.sync()
        self.plotter.render()

    def set_scope(self, scope):
        self.update_state(dict(scope=self._scope(scope), reset=True, playing=False))
        self.sync()
        self.plotter.render()

    def add_controls(self):
        self.plotter.add_slider_widget(self.on_operation_slider, rng=[0, max(len(self.operations)-1, 0)],
            value=self.operations.index(self.current_operation()), title="operation",
            pointa=(.03, .08), pointb=(.45, .08), style="modern")
        self.plotter.add_slider_widget(self.on_speed_slider, rng=[.1, 4.], value=1., title="speed",
            pointa=(.55, .08), pointb=(.95, .08), style="modern")
        for key, callback in (("n", self.next_operation), ("p", self.previous_operation),
                ("1", lambda: self.set_scope("all")), ("2", lambda: self.set_scope("representative")),
                ("3", lambda: self.set_scope("selected"))):
            self.plotter.add_key_event(key, callback)

    def show(self, *, interactive_update=False):
        self.sync()
        self.add_controls()
        super().show(interactive_update=interactive_update)


def main() -> int:
    parser = argparse.ArgumentParser(description="Native PyVista GUI for exported symmetry JSON.")
    parser.add_argument("json_path", type=Path)
    parser.add_argument("--operation", type=int, default=None, help="Initial operation index.")
    parser.add_argument("--list-operations", action="store_true", help="Print operations and exit.")
    parser.add_argument("--list-atoms", action="store_true", help="Print atoms and exit.")
    parser.add_argument(
        "--scope",
        choices=("all", "representative", "selected", "unit_cell", "displayed"),
        default="all",
        help="Initial animation scope.",
    )
    parser.add_argument(
        "--selected-atoms",
        nargs="+",
        default=None,
        help="Source atom indices for selected scope. Accepts spaces or commas.",
    )
    parser.add_argument(
        "--expanded",
        action="store_true",
        help="Show quarter-cell periodic display clones. Slower, but useful for boundary checks.",
    )
    args = parser.parse_args()

    if args.list_operations or args.list_atoms:
        payload = json.loads(args.json_path.read_text(encoding="utf-8"))
        view = prepare_view(payload, path=args.json_path, tolerance_cart=.1, host="native_gui")
        if args.list_operations:
            print("=== Operations (verified common model) ===")
            for operation in view.operations:
                print(f"{operation['index']:3d}: {operation['label']} kind={operation['kind']} "
                      f"order={operation['order']} mapping=verified")
        if args.list_atoms:
            print_atoms(view.data)
        return 0

    selected_atoms = parse_selected_atoms(args.selected_atoms)
    scope = args.scope
    if scope == "selected" and not selected_atoms:
        scope = "representative"

    display_mode = "expanded_quarter" if args.expanded else "source"
    app = NativePyVistaViewer(
        args.json_path,
        scope=scope,
        selected_atoms=selected_atoms,
        display_mode=display_mode,
        initial_operation=args.operation,
    )
    app.show()
    return 0


def print_atoms(render_data: dict) -> None:
    print("=== Atoms ===")
    for atom in render_data["atoms"]:
        frac = atom.get("frac")
        frac_text = f" frac={frac}" if frac is not None else ""
        asym = atom.get("asymmetric_index")
        asym_text = f" asym={asym}" if asym is not None else ""
        print(
            f"{atom['index']:4d}: {atom['element']} "
            f"cart={atom['cart']}{frac_text}{asym_text}"
        )


if __name__ == "__main__":
    raise SystemExit(main())
