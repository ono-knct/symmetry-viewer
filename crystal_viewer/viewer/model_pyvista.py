"""Optional native renderer of the HTTP host's published model and plans.

No source JSON, legacy operation lookup, decomposition or animation path is
read here. VTK stays on the main thread; each captured scene is one snapshot.
"""
from copy import deepcopy
from dataclasses import dataclass
import json
import time

import numpy as np
import pyvista as pv

from crystal_viewer.viewer.model_session import ModelConflict
from crystal_viewer.viewer.model_view import elements
from crystal_viewer.viewer.playback_schedule import PlaybackSchedule, ApplicationSchedule, evaluate_schedule
from crystal_viewer.viewer.scene_rendering import (
    add_orientation_axes, add_atom_legend, setup_viewer_lighting, viewer_text_color,
)
from crystal_viewer.viewer.operation_labels import camera_up_vector, rotate_vector


@dataclass(frozen=True)
class NativeScene:
    identity: dict
    state: dict
    render: dict
    plan: object
    schedule: object
    moving: tuple
    unit_only: bool
    geometry: dict
    segments: tuple
    boundaries: tuple


def capture_scene(view):
    """Use precisely the display points and timing returned to Three.js."""
    with view.lock:
        view.sync()
        state = deepcopy(view.state)
        if view.snapshot is None:
            return NativeScene({}, state, {}, None, None, (), False, {}, (), ())
        snapshot = view.snapshot
        identity = snapshot.identity()
        render = deepcopy(view.dispatch("render_data", identity))
        custom = state["active_mode"] == "custom" and bool(state.get("custom_op_animate"))
        request = view.request(custom=custom)
        plan = view.api._plan(snapshot, request)
        response = view.dispatch("custom_animation_path" if custom else "animation_path", dict(identity,
            plan_request=request, expected_plan_id=plan.plan_id,
            freeze_range_extensions="1" if state.get("range_highlight") else "0"))
        playback = response["playback"]
        if playback["plan_id"] != plan.plan_id:
            raise ModelConflict("native plan changed")
        raw = playback["schedule"]
        schedule = PlaybackSchedule(**dict(raw, applications=tuple(ApplicationSchedule(**a) for a in raw["applications"])))
        if schedule.plan_id != plan.plan_id or schedule.model_id != snapshot.model.model_id or schedule.frame_id != snapshot.model.frame_id:
            raise ModelConflict("native schedule changed")
        paths = response["paths"]
        path = paths[0]["path"] if paths else {}
        geometry = elements(plan)
        if state["active_mode"] == "custom" and state.get("custom_op_result") and not custom:
            geometry = deepcopy(state["custom_op_result"].get("elements") or geometry)
        view.session.finish(snapshot, {})
        return NativeScene(identity, state, render, plan, schedule,
            tuple(p["source_atom"] for p in paths), bool(path.get("unit_cell_only")), geometry,
            tuple(path.get("segment_elements", ())), tuple(path.get("model_segment_boundaries", ())))


class ModelPyVistaViewer:
    def __init__(self, model_view, *, plotter=None):
        self.view = model_view
        self.plotter = plotter if plotter is not None else pv.Plotter()
        for renderer in self.plotter.renderers:
            renderer.UseDepthPeelingOff()
        self.draw_atoms = True
        self.draw_cell = True
        self.draw_symmetry = True
        self.scene = None
        self.progress = 0.
        self.starts = np.empty((0, 3))
        self.current = self.starts.copy()
        self.moving = np.zeros(0, dtype=bool)
        self.groups = []
        self.element_actors = []
        self.element_key = None
        self._version = None
        self._clock = time.monotonic()
        self._hold = 0.
        self._reset_clock = False
        self._camera_ids = {}

    def update_state(self, update, *, expected=None):
        with self.view.lock:
            self.view.sync()
            identity = self.view.snapshot.identity() if self.view.snapshot else {}
            if expected is not None and (identity != expected.identity or
                self.view.state.get("view_revision", 0) != expected.state.get("view_revision", 0)):
                return False
            self.view.dispatch("state", dict(identity, update=update))
            return True

    def show(self, *, interactive_update=False):
        self.sync()
        self.plotter.add_key_event("space", lambda: self.update_state(dict(playing=not self.view.state["playing"])))
        self.plotter.add_key_event("r", lambda: self.update_state(dict(reset=True, playing=False)))
        self.plotter.add_timer_event(max_steps=1000000, duration=100, callback=self.on_timer)
        self.plotter.show(interactive_update=interactive_update, auto_close=not interactive_update)

    def sync(self):
        with self.view.lock:
            self.view.sync()
            identity = self.view.snapshot.identity() if self.view.snapshot else {}
            version = (identity.get("structure_revision"), self.view.state.get("view_revision", 0))
            if version == self._version:
                return False
            scene = capture_scene(self.view)
        old = self.scene
        self.scene = scene
        self._version = version
        changed_model = old is None or old.identity != scene.identity
        changed_plan = old is None or (old.plan.plan_id if old.plan else None) != (scene.plan.plan_id if scene.plan else None)
        changed_schedule = old is None or (old.schedule.schedule_id if old.schedule else None) != (scene.schedule.schedule_id if scene.schedule else None)
        if changed_model or changed_plan or changed_schedule or old.state.get("reset_revision") != scene.state.get("reset_revision"):
            self.progress = 0.
            self._hold = 0.
            self._reset_clock = True
        if changed_model:
            self._camera_ids = {}
        suppressed = self.plotter.suppress_rendering
        self.plotter.suppress_rendering = True
        try:
            self.rebuild(reset_camera=changed_model)
            self.apply_camera_requests()
            self.set_progress(self.progress)
        finally:
            self.plotter.suppress_rendering = suppressed
        self._clock = time.monotonic()
        return True

    def rebuild(self, *, reset_camera):
        camera = self.plotter.camera_position
        self.plotter.clear()
        self.groups = []; self.element_actors = []; self.element_key = None
        scene = self.scene
        s = scene.state
        setup_viewer_lighting(self.plotter, background_mode=s["background_mode"])
        # VTK's shadow pass conflicts with translucent symmetry planes on the
        # Mesa renderer used by the comparison window.
        self.plotter.disable_shadows()
        items = scene.render.get("display_atoms", [])
        self.starts = np.array([a["cart"] for a in items], dtype=float).reshape(-1, 3)
        self.current = self.starts.copy()
        self.moving = np.array([a["source_atom"] in scene.moving and (not scene.unit_only or a["is_primary_image"]) for a in items], dtype=bool)
        lower = -.5 if s["cell_origin_mode"] == "center" else 0.
        extensions = [bool(s.get("range_highlight") and a["frac"] is not None and
            (np.any(np.array(a["frac"]) < lower-1e-9) or np.any(np.array(a["frac"]) > lower+1+1e-9))) for a in items]
        self.moving &= ~np.array(extensions, dtype=bool)
        styles = {a["index"]: a for a in scene.render.get("atom_styles", [])}
        grouped = {}
        for i, item in enumerate(items):
            style = styles[item["source_atom"]]
            grouped.setdefault((style["color"], style["radius"], .22 if extensions[i] else 1.), []).append(i)
        for (color, radius, opacity), indices in (grouped.items() if self.draw_atoms else ()):

            sphere = pv.Sphere(radius=radius, theta_resolution=16, phi_resolution=10)
            template = np.asarray(sphere.points).copy()
            faces = np.asarray(sphere.faces).reshape(-1, 4)
            offsets = np.arange(len(indices))[:, None, None]*len(template)
            all_faces = np.broadcast_to(faces, (len(indices), *faces.shape)).copy()
            all_faces[:, :, 1:] += offsets
            points = (template[None, :, :]+self.starts[indices, None, :]).reshape(-1, 3)
            mesh = pv.PolyData(points, all_faces.reshape(-1))
            self.plotter.add_mesh(mesh, color=color, opacity=opacity, smooth_shading=True)
            self.groups.append((indices, template, mesh))
        cell = scene.render.get("display_unit_cell")
        if cell and self.draw_cell:
            vertices = np.array(cell["vertices_cart"])
            for a, b in cell["edges"]:
                self.plotter.add_mesh(pv.Line(vertices[a], vertices[b]), color="#7f8c8d", line_width=2)
        data = scene.render.get("render_data", {})
        if data.get("atoms"):
            add_orientation_axes(self.plotter, unit_cell=data.get("unit_cell"))
            if s["legend_visible"]:
                add_atom_legend(self.plotter, data, element_colors=s["element_colors"], background_mode=s["background_mode"])
        self.plotter.camera.parallel_projection = s["projection_mode"] == "parallel"
        if reset_camera and len(items):
            self.plotter.reset_camera()
        else:
            self.plotter.camera_position = camera
        if self.draw_atoms:
            self.draw_markers()
        if s.get("show_trajectories") and scene.plan is not None and np.any(self.moving):
            times = set(np.linspace(0, 1, 49))
            if scene.schedule.duration_seconds:
                times.update(t/scene.schedule.duration_seconds for t in scene.schedule.step_boundaries_seconds)
            samples = [evaluate_schedule(scene.plan, scene.schedule, self.starts[self.moving], t) for t in sorted(times)]
            for i, line in enumerate(np.array(samples).transpose(1, 0, 2)):
                if np.max(np.linalg.norm(line-line[0], axis=1)) > 1e-10:
                    self.plotter.add_mesh(pv.lines_from_points(line), name=f"model-trajectory-{i}", color="#94a3b8", line_width=1)

    def draw_markers(self):
        scene = self.scene
        s = scene.state
        selected = set(s["selected_atoms"])
        unmapped = {a["source"] for a in (s.get("custom_op_result") or {}).get("unmapped", [])} if s["active_mode"] == "custom" else set()
        styles = {a["index"]: a for a in scene.render.get("atom_styles", [])}
        for item in scene.render.get("display_atoms", []):
            index = item["source_atom"]
            if item["is_primary_image"] and (index in selected or index in unmapped):
                marker = pv.Sphere(center=item["cart"], radius=styles[index]["radius"]*1.12,
                                   theta_resolution=16, phi_resolution=10)
                self.plotter.add_mesh(marker, style="wireframe", color="#ff8a80" if index in unmapped else "#c08020", opacity=.5)

    def set_progress(self, progress):
        scene = self.scene
        self.progress = float(np.clip(progress, 0, 1))
        self.current = self.starts.copy()
        if scene.plan is not None and np.any(self.moving):
            self.current[self.moving] = evaluate_schedule(scene.plan, scene.schedule, self.starts[self.moving], self.progress)
        for indices, template, mesh in self.groups:
            mesh.points = (template[None, :, :]+self.current[indices, None, :]).reshape(-1, 3)
        geometry = scene.geometry
        segment = 0
        if scene.segments:
            segment = next((i for i, end in enumerate(scene.boundaries) if self.progress <= end+1e-12), len(scene.segments)-1)
            geometry = scene.segments[segment]
        if not self.draw_symmetry:
            geometry = {}
        key = json.dumps(geometry, sort_keys=True)
        if key != self.element_key:
            for actor in self.element_actors:
                self.plotter.remove_actor(actor, render=False)
            self.element_actors = self.draw_elements(geometry)
            self.element_key = key
        self.plotter.add_text(self.status(), name="model-status", position="upper_left", font_size=10,
                              color=viewer_text_color(scene.state["background_mode"]), render=False)

    def draw_elements(self, geometry):
        actors = []
        span = max(float(np.max(np.ptp(self.starts, axis=0))), 1.) if len(self.starts) else 1.
        for axis in geometry.get("axes", []):
            point, direction = np.array(axis["point_cart"]), np.array(axis["direction_cart"])
            actors.append(self.plotter.add_mesh(pv.Line(point-span*.75*direction, point+span*.75*direction), color="#58d68d", line_width=5, render=False))
        for plane in geometry.get("planes", []):
            p = np.array(plane["point_cart"])
            u, v = np.array(plane["basis1_cart"])*span*.45, np.array(plane["basis2_cart"])*span*.45
            mesh = pv.PolyData(np.array([p-u-v, p+u-v, p+u+v, p-u+v]), [4, 0, 1, 2, 3])
            actors.append(self.plotter.add_mesh(mesh, color="#bc9cff", opacity=.25, render=False))
        for center in geometry.get("centers", []):
            actors.append(self.plotter.add_mesh(pv.Octahedron(center=center["point_cart"], radius=max(.1, min(span*.04, .3))), color="#ff5f57", render=False))
        translation = np.array(geometry.get("glide_translation_cart", [0, 0, 0]))
        if np.linalg.norm(translation) > 1e-10:
            actors.append(self.plotter.add_mesh(pv.Arrow(start=self.center(), direction=translation, scale=float(np.linalg.norm(translation))), color="#e6a23c", render=False))
        return actors

    def status(self):
        if not self.scene.identity:
            return self.scene.state.get("import_status") or "Select a structure in the browser"
        s = self.scene.state
        return (f"{self.scene.render['render_data']['metadata'].get('formula', '')} | "
                f"{s['active_mode']} op {s['operation_index']} | {s['improper_mode']} x{s['operation_repetitions']}\n"
                f"{self.progress:.0%} | speed {s['speed']:g} | model {s['structure_revision']}")

    def center(self):
        return (np.max(self.starts, axis=0)+np.min(self.starts, axis=0))/2 if len(self.starts) else np.zeros(3)

    def set_camera_view(self, direction, center=None):
        direction = np.asarray(direction, dtype=float)
        if direction.shape != (3,) or not np.all(np.isfinite(direction)) or np.linalg.norm(direction) < 1e-12:
            raise ValueError("nonzero finite view direction required")
        direction /= np.linalg.norm(direction)
        center = self.center() if center is None else np.asarray(center, dtype=float)
        radius = max(float(np.max(np.linalg.norm(self.starts-center, axis=1))) if len(self.starts) else 1., 1.)
        distance = radius/max(np.tan(np.radians(self.plotter.camera.view_angle)/2), .01)*1.15
        self.plotter.camera_position = [center+direction*distance, center, camera_up_vector(direction)]
        self.plotter.camera.parallel_scale = radius*1.15
        self.plotter.reset_camera_clipping_range()

    def apply_camera_requests(self):
        s = self.scene.state
        data = self.scene.render.get("render_data", {})
        B = np.array(data["unit_cell"]["lattice"]).T if data.get("unit_cell") else np.eye(3)
        for key in ("reset_view_request_id", "view_request_id", "view_direction_request_id", "view_plane_request_id", "camera_request_id"):
            value = s.get(key)
            if value is None or value == self._camera_ids.get(key):
                continue
            self._camera_ids[key] = value
            try:
                if key == "view_direction_request_id":
                    self.set_camera_view(B@np.array(s["view_direction_frac"]))
                elif key == "view_plane_request_id":
                    self.set_camera_view(np.linalg.solve(B.T, np.array(s["view_plane_hkl"])))
                elif key == "view_request_id":
                    g = self.scene.geometry
                    direction = g.get("view_direction_cart")
                    if direction is None:
                        direction = g.get("glide_translation_cart")
                    if direction is not None and np.linalg.norm(direction) > 1e-12:
                        self.set_camera_view(direction, g.get("focus_point_cart"))
                elif key == "reset_view_request_id":
                    camera = self.plotter.camera
                    shift = self.center()-np.array(camera.focal_point)
                    camera.position = np.array(camera.position)+shift
                    camera.focal_point = self.center()
                    self.plotter.reset_camera_clipping_range()
                else:
                    self.rotate_camera(s["camera_direction"], float(s["camera_angle"]))
            except (ValueError, TypeError, np.linalg.LinAlgError) as exc:
                self.update_state(dict(import_status=f"Camera: {exc}"), expected=self.scene)

    def rotate_camera(self, direction, angle):
        camera = self.plotter.camera
        radius = np.array(camera.position)-camera.focal_point
        up = np.array(camera.up)
        view = -radius/np.linalg.norm(radius)
        right = np.cross(view, up)
        choices = {"left": (up, -1), "right": (up, 1), "up": (right, -1), "down": (right, 1),
                   "roll-left": (view, -1), "roll-right": (view, 1)}
        if direction not in choices:
            return
        axis, sign = choices[direction]
        angle = np.radians(np.clip(angle, 0, 180))*sign
        if not direction.startswith("roll-"):
            camera.position = np.array(camera.focal_point)+rotate_vector(radius, axis, angle)
        camera.up = rotate_vector(up, axis, angle)
        self.plotter.reset_camera_clipping_range()

    def on_timer(self, _step=0):
        now = time.monotonic()
        elapsed = max(0., now-self._clock)
        try:
            changed = self.sync()
        except ModelConflict:
            return  # A whole newer snapshot will be captured on the next tick.
        self._clock = now
        scene = self.scene
        if scene.plan is not None and scene.state["playing"]:
            duration = scene.schedule.duration_seconds
            if self._reset_clock:
                elapsed = 0.
            self._reset_clock = False
            if self._hold:
                consumed = min(self._hold, elapsed)
                self._hold -= consumed; elapsed -= consumed
            delta = elapsed*max(.1, float(scene.state["speed"]))
            target = min(1., self.progress+delta/duration) if duration else 1.
            boundaries = [b/duration for b in scene.schedule.step_boundaries_seconds] if duration and scene.state["pause_at_breakpoints"] else []
            stop = next((b for b in boundaries if self.progress+1e-10 < b < target+1e-10), None)
            if stop is not None:
                target = stop
                self.update_state(dict(playing=False), expected=scene)
            elif duration:
                applications = np.cumsum([a.duration_seconds for a in scene.schedule.applications])[:-1]/duration
                boundary = next((b for b in applications if self.progress+1e-10 < b <= target+1e-10), None)
                if boundary is not None:
                    target = boundary
                    self._hold = .2
            self.set_progress(target)
            if target >= 1:
                self.update_state(dict(playing=False), expected=scene)
            changed = True
        # PyVista's timer observer renders once after this callback. Geometry
        # exchange is batched above, rather than rendered once per added actor.
