# symmetry-viewer Web版

結晶・分子の対称操作を観察し、クイズで練習できるWeb版です。
結晶16種・分子19種の収録例を利用できます。利用者によるPythonのインストールは不要です。

## 利用環境と制約

WebGLとWebAssemblyに対応したブラウザが必要です。初回は実行環境と教材データを読み込むため、表示まで時間がかかる場合があります。
構造やセルを切り替える際は、読み込みの完了を待って操作してください。

Web版では任意のCIF・XYZファイルを取り込めません。手元の構造ファイルを使う場合は、Windows・Linux向けの配布版を利用してください。

## Web版を作成する

以下はLinuxでの手順です。Python 3.14を用意し、リポジトリのルートで実行してください。
初回の作成には、同梱する実行環境を取得するためのインターネット接続が必要です。

```bash
python3.14 -m venv .venv
.venv/bin/python -m pip install -r packaging/requirements-build.txt
.venv/bin/python web_static/build.py --out build/web-static
.venv/bin/python web_static/check_build.py build/web-static
python3 -m http.server --bind 127.0.0.1 --directory build/web-static 8000
```

8000番ポートが空いている場合、ブラウザで `http://127.0.0.1:8000/` を開いて確認できます。
使用中の場合は別の空きポートを指定してください。HTMLファイルを直接開く `file://` 形式では動作しません。

配信するファイルは `build/web-static/` に作成されます。Webサーバーには、このフォルダの内容をまとめて配置してください。
実行環境とライブラリを含むため、配信時に外部CDNから取得する必要はありません。
GitHub Pages用の作成・配信設定は `.github/workflows/pages.yml` にあります。

## ライセンスと出典

プログラムは [MITライセンス](../LICENSE)です。収録構造の出典・加工内容・利用条件は [examples/SOURCES.md](../examples/SOURCES.md) を参照してください。
Web版の作成物には `licenses/` を同梱します。使用部品の版、ライセンス原文、ソースの取得先は `licenses/README.md` に記載します。
再配布する際も、これらの文書を含めてください。
