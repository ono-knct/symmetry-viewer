from __future__ import annotations

import argparse
import json
from pathlib import Path

import _bootstrap  # noqa: F401

from crystal_viewer.viewer.cell_settings import standardized_payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Reanalyze an exported crystal JSON in a standardized cell setting.")
    parser.add_argument("json_path", type=Path)
    parser.add_argument("--cell-setting", choices=["native", "primitive", "conventional"], required=True)
    parser.add_argument("--output", "-o", type=Path, required=True)
    parser.add_argument("--tolerance-cart", type=float, default=1e-2)
    parser.add_argument("--indent", type=int, default=2)
    parser.add_argument("--require-distinct", action="store_true")
    parser.add_argument("--include-frame-witness", action="store_true")
    parser.add_argument("--legacy-contract", action="store_true", help="Explicit API1 compatibility export.")
    args = parser.parse_args()

    payload = json.loads(args.json_path.read_text(encoding="utf-8"))
    if args.legacy_contract:
        converted = standardized_payload(
            payload,
            args.cell_setting,
            tolerance_cart=args.tolerance_cart,
            require_distinct=args.require_distinct,
            include_frame_witness=args.include_frame_witness,
        )
    else:
        from crystal_viewer.model_export import verified_export_payload
        from crystal_viewer.source_inputs import crystal_cell_input
        from crystal_viewer.viewer.cell_frame import attach_frame_witness
        raw = crystal_cell_input(payload, args.cell_setting)
        before = len(payload["render_data"]["atoms"])
        after = len(raw["render_data"]["atoms"])
        distinct = (after < before if args.cell_setting == "primitive" else
                    after > before if args.cell_setting == "conventional" else True)
        converted = None if args.require_distinct and not distinct else verified_export_payload(raw, tolerance_cart=args.tolerance_cart)
        if converted is not None and args.include_frame_witness:
            attach_frame_witness(payload, converted, symprec=.001, angle_tolerance=5., cell_setting=args.cell_setting)
    if converted is None:
        if args.require_distinct and args.cell_setting == "primitive":
            raise RuntimeError("This structure is already represented as a primitive cell.")
        if args.require_distinct and args.cell_setting == "conventional":
            raise RuntimeError("This structure is already represented as a Bravais cell.")
        raise RuntimeError(f"cell setting {args.cell_setting!r} is not available for this structure")

    from crystal_viewer.model_export import write_verified_export
    write_verified_export(args.output, converted, indent=args.indent)
    print(f"Wrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
