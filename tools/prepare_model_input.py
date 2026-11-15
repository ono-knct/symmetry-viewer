"""Acquire structure inputs for API2; does not create a display export."""
import argparse
import json
from pathlib import Path

import _bootstrap  # noqa: F401
from crystal_viewer.source_inputs import crystal_input_from_cif, crystal_cell_input, molecule_input_from_file


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", type=Path)
    parser.add_argument("--cell-setting", choices=("native", "primitive", "conventional"))
    parser.add_argument("--mode", choices=("crystal", "molecule"), default="crystal")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "molecule" and args.cell_setting:
        parser.error("molecular input does not support cell conversion")
    result = (crystal_cell_input(json.loads(args.path.read_text(encoding="utf-8")), args.cell_setting)
              if args.cell_setting else
              (molecule_input_from_file(args.path) if args.mode == "molecule" else crystal_input_from_cif(args.path)))
    args.output.write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
