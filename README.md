# symmetry-viewer

結晶・分子の対称性を学ぶ3D教材です。解析モードで対称操作と原子の動きを観察し、
クイズモードで操作あて・合成・移り先・点群あてを練習できます。
このソースには結晶16種・分子19種を収録しています。
Web版では収録例を利用できます。手元のCIF（結晶）・XYZ（分子）ファイルの取り込みは配布版で利用できます。
Web版の利用環境と作成手順は [Web版の説明書](web_static/README.md) を参照してください。
画面の操作と困ったときの案内は [使い方](docs/usage.md)、ソースからの起動や配布物の作成は [開発者向け手順](docs/development.md) にまとめています。

## 配布版を使う

Windows版は `symmetry-viewer-windows-x64.zip` を展開し、`symmetry-viewer.exe` を開きます。
Linux版は `symmetry-viewer-linux-x86_64.tar.gz` を展開し、端末で `./symmetry-viewer` を実行します。
Pythonなどの追加インストールは不要です。WebGLに対応したブラウザが必要です。
終了はWindowsでは黒いウィンドウを閉じ、Linuxでは端末でCtrl+Cを押します。
ブラウザのタブを閉じるだけでは終了しません。詳細は配布物の `README.txt` を参照してください。

## ソースから起動する

以下はLinuxでの手順です。

```bash
scripts/setup.sh
scripts/serve.sh
```

配布物は `packaging/build_linux.sh` または `packaging/build_windows.ps1` でビルドします。
GitHub Actionsの定義は `.github/workflows/build.yml` です。

## 収録構造とライセンス

数値・出典・加工内容・配布条件は [examples/SOURCES.md](examples/SOURCES.md) を参照してください。
分子19種は理想化教材モデルであり、文献の実測・最適化座標をそのまま収録したものではありません。
NaClはCOD直接取得データから再構成しています。

プログラムは [MITライセンス](LICENSE)です。同梱ライブラリのライセンス文書は配布物の `_internal/licenses/` にあります。
Web版では、作成物の `licenses/README.md` に使用部品のライセンスとソースの取得先をまとめています。
