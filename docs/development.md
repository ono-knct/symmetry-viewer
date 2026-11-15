# 開発者向け手順

## ソースから起動する

以下はLinuxでの手順です。Git、Python 3.14とvenv、セットアップ時のインターネット接続を用意してください。

```bash
git clone https://github.com/ono-knct/symmetry-viewer.git
cd symmetry-viewer
PYTHON=python3.14 scripts/setup.sh
scripts/serve.sh
```

セットアップは `.venv/` に実行環境を作成し、`requirements.txt` の依存ライブラリをインストールします。
`scripts/serve.sh --mode analysis` または `scripts/serve.sh --mode puzzle` で、指定したモードを直接開けます。
終了は起動した端末でCtrl+Cを押します。

複数のサーバーを使う場合は、空きポートを指定します。次の例は8000番が空いている場合です。

```bash
scripts/serve.sh --no-browser --port 8000
```

ブラウザで `http://127.0.0.1:8000/` を開きます。操作方法は [使い方](usage.md) を参照してください。

## Windows・Linux向けの配布物を作成する

ネット接続のある環境で、リポジトリのルートから実行します。

| 作成する版 | 実行環境・必要なツール | コマンド |
|---|---|---|
| Linux | Linux（x86_64）、Bash、curl、tar | `packaging/build_linux.sh` |
| Windows | Windows（x64）、PowerShell 7、tar | `./packaging/build_windows.ps1` |

作成用のPythonは各スクリプトが取得し、`build/` に配置します。
配布物には `packaging/requirements-build.txt` で版を固定した依存ライブラリを使います。
成果物は `dist/symmetry-viewer/` と、同じ `dist/` 内のZIPまたはtar.gzです。
再実行すると、同名の作成物は置き換わります。

Linuxで作成した配布物の起動とHTTP経由の動作を確認する例：

```bash
build/venv/bin/python packaging/smoke_test.py dist/symmetry-viewer/symmetry-viewer
```

Windowsでは、PowerShellから実行します。

```powershell
build\venv\Scripts\python.exe packaging\smoke_test.py dist\symmetry-viewer\symmetry-viewer.exe
```

この確認は画面の見た目や、すべてのOS・ブラウザでの動作を保証するものではありません。

## Web版を作成する

必要な環境、作成・照合・ローカル配信の手順は [Web版の説明書](../web_static/README.md) を参照してください。
Web版は構造の解析結果を作成時に準備するため、CIF・XYZの任意取り込みには対応していません。

## GitHub Actions

[build.yml](../.github/workflows/build.yml) は、mainへのpushまたは手動実行でWindows・Linux版を作成し、動作確認後に成果物を保存します。
`v`で始まるタグへのpushでは、配布物とチェックサムをGitHub Releasesへ公開します。

[pages.yml](../.github/workflows/pages.yml) は、`v`で始まるタグへのpushまたは手動実行でWeb版を作成し、GitHub Pagesへ公開します。
利用する場合は、リポジトリのSettings → Pages → Sourceを「GitHub Actions」に設定してください。
これらの公開操作は、対象ソース・版番号・文書・成果物の確認を終えてから行ってください。

## 収録データを再生成する

通常の起動には再生成は不要です。モデルの定義や解析条件を変更する場合に実行してください。
以下のコマンドは収録ファイルを上書きするため、先に必要な変更を保存し、実行後に差分を確認します。

```bash
.venv/bin/python tools/generate_example_structures.py
.venv/bin/python tools/regenerate_example_assets.py
```

最初のコマンドは結晶16種・分子8種のCIF・XYZを生成し、構造を検証します。NaClも対象です。
手書きの分子11種（水・ベンゼンなど）は生成・検証の対象外で、このコマンドでは変更されません。
2つ目は収録された結晶16種・分子19種の解析JSONと、構造選択・クイズの出題可否に使う一覧を更新します。
`--clean`を付けると、出力先の直下にある既存JSONを削除してから再生成します。
再生成結果は依存ライブラリの版に影響されるため、配布物と揃える場合は `packaging/requirements-build.txt` の版を使用してください。

モデルの定義は `tools/generate_example_structures.py` の `CRYSTALS`・`MOLECULES` にあります。
生成器の対象である結晶16種・分子8種を上書きせずに検証するには、次のコマンドを使います。

```bash
.venv/bin/python tools/generate_example_structures.py --check-only
```

構造の一覧は [結晶構造](../examples/cif/README.md)・[分子構造](../examples/molecules/README.md)、数値の出典と加工内容は [収録構造の出典](../examples/SOURCES.md) を参照してください。
