# License texts shipped with the packaged build

`symmetry_view.spec` copies `linux/` or `windows/` (whichever matches the build)
into `_internal/licenses/`, next to the license files it collects from the
installed Python packages (numpy, scipy, pymatgen, ...) and the PyInstaller
bootloader.

These are the ones no installed package carries: the build runs on a
python-build-standalone CPython, which has these libraries compiled in.

## Where they came from

Each `python-build-standalone/` holds files from `python/licenses/` of the
"full" archive of the release pinned in `build_linux.sh` / `build_windows.ps1`
(the `install_only` archives the builds use do not include them), keeping only
the components that end up in the build according to that archive's
`PYTHON.json`:

- `linux/`: `cpython-3.14.7+20260901-x86_64-unknown-linux-gnu-pgo+lto-full.tar.zst`.
  All extension modules are compiled into `libpython3.14.so`.
- `windows/`: `cpython-3.14.7+20260901-x86_64-pc-windows-msvc-pgo-full.tar.zst`.
  Extension modules are separate `.pyd` files next to their DLLs.

| File | Component | Used by | Linux | Windows |
|---|---|---|---|---|
| `LICENSE.cpython.txt` | CPython | everything | yes | yes |
| `LICENSE.openssl-3.txt` | OpenSSL 3 | `_ssl`, `_hashlib` | yes | yes |
| `LICENSE.libffi.txt` | libffi | `_ctypes` | yes | yes |
| `LICENSE.expat.txt` | expat | `pyexpat` | yes | yes |
| `LICENSE.bzip2.txt` | bzip2 | `_bz2` | yes | yes |
| `LICENSE.liblzma.txt` | xz / liblzma | `_lzma` | yes | yes |
| `LICENSE.mpdecimal.txt` | mpdecimal | `_decimal` | yes | yes |
| `LICENSE.sqlite.txt` | SQLite | `_sqlite3` | yes | yes |
| `LICENSE.zlib.txt` | zlib | `zlib`, `binascii` | yes | yes |
| `LICENSE.libuuid.txt` | libuuid | `_uuid` | yes | |
| `LICENSE.libedit.txt`, `LICENSE.ncurses.txt` | libedit, ncurses | `readline`, `_curses` | yes | |

Two are not in those directories and were fetched from upstream:

- `LICENSE.zstd.txt`: `_zstd` links zstd (BSD-3-Clause per `PYTHON.json`).
  From https://github.com/facebook/zstd/blob/v1.5.7/LICENSE.
- `LICENSE.hacl-star.txt`: CPython's hash functions come from HACL\*
  (`Modules/_hacl/`, "Licensed under the Apache 2.0 and MIT Licenses").
  From https://github.com/hacl-star/hacl-star/blob/main/LICENSE.

## Windows runtime components

Inspect the built files as well as `PYTHON.json`: metadata alone does not identify
all libraries collected by PyInstaller. The inspected Windows package contains
OpenSSL 3 (`libcrypto-3-x64.dll` and `libssl-3-x64.dll`).

The Windows package also includes Microsoft runtime components. These are not
covered by this project's MIT license. Redistribution is subject to the terms
applicable to their source distribution and the build tools used.

| Component | Source comparison for the inspected package |
|---|---|
| `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` | Byte-identical to the pinned python-build-standalone archive above |
| `MSVCP140.dll` (14.40.33810.0) | Byte-identical to the runtime in the NumPy 2.5.2 Windows wheel |
| Renamed `msvcp140-*.dll` in `numpy.libs` and `pandas.libs` | Byte-identical to the runtime in the NumPy 2.5.2 and pandas 3.0.5 Windows wheels |
| `ucrtbase.dll`, `api-ms-win-*.dll` (10.0.26100.1742) | Microsoft UCRT components collected by the Windows build; the exact source directory is not recorded in the ZIP |

The comparison uses the CPython archive hash pinned in `build_windows.ps1` and
the wheel hashes published by PyPI. It identifies matching files, not a grant
of redistribution rights. Check the applicable terms when rebuilding or
redistributing, including the Visual Studio/Build Tools and Windows SDK terms.
Microsoft documents local deployment of UCRT from the Windows SDK's
`Redist/ucrt/DLLs` directory. For a release, retain the collection paths and
confirm that the UCRT files came from a redistributable location.

Official references:

- [Visual C++ redistribution and license terms](https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files)
- [Visual Studio 2022 distributable files](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution)
- [Universal CRT deployment](https://learn.microsoft.com/en-us/cpp/windows/universal-crt-deployment)
- [Microsoft license directory](https://visualstudio.microsoft.com/license-terms/)

## Updating the bundled runtime

Berkeley DB (`_dbm`) and Tcl/Tk (`_tkinter`) are not included in the inspected
packages. Linux `readline` uses libedit. The PyInstaller bootloader has its own
license and distribution exception; its license text is collected separately.

When changing the python-build-standalone release, obtain the matching full
archive, review `PYTHON.json`, and compare it with the generated package.
Recheck the license selection for each platform and keep upstream notices intact.
