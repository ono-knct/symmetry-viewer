# 開発者向け手順

## ソースから起動する

以下はLinuxでの手順です。Git、Python 3.11以上、セットアップ時のネット接続が必要です。

```bash
git clone https://github.com/ono-knct/symmetry-viewer.git
cd symmetry-viewer
scripts/setup.sh
scripts/serve.sh
```

`scripts/serve.sh --mode analysis` または `scripts/serve.sh --mode puzzle` で、指定したモードを直接開けます。

## 配布物をビルドする

| 環境 | 必要なツール | コマンド |
|---|---|---|
| Linux（x86_64） | curl、tar | `packaging/build_linux.sh` |
| Windows（x64） | PowerShell 7、tar | `./packaging/build_windows.ps1` |

ネット接続のある環境で、リポジトリのルートから実行します。Pythonと依存ライブラリはビルドスクリプトが取得します。
成果物は `dist/` に作成されます。

[GitHub Actions](../.github/workflows/build.yml)でもビルドと収録例を使った動作確認を行います。成果物はActionsのartifactに保存されます。

## 収録データを再生成する

セットアップ後、リポジトリのルートで実行します。

```bash
.venv/bin/python tools/generate_example_structures.py
.venv/bin/python tools/regenerate_example_assets.py --clean
```

モデルの定義は `tools/generate_example_structures.py` の `CRYSTALS`・`MOLECULES` 表にあります。
結晶・分子の一覧は[結晶構造](../examples/cif/README.md)と[分子構造](../examples/molecules/README.md)、参照資料は[構造データの出典](../examples/SOURCES.md)を参照してください。

NaClは[専用の生成器](../tools/reconstruct_cod_examples.py)を使います。取得元と照合用ハッシュは生成器の `SOURCES` に記載しています。CODから `1000041.cif` を取得して別のディレクトリに保存し、次のコマンドを実行します。

```bash
.venv/bin/python tools/reconstruct_cod_examples.py --source-dir /path/to/cod-downloads
```

再構成後は、上記の `tools/regenerate_example_assets.py --clean` も実行してください。

通常の生成器は、NaClのCIFを上書きしません。
