# symmetry-viewer

結晶・分子の対称性を学ぶための3D教材です。対称操作の記号と原子の動きを対応づけて観察できます。

- **解析モード**：対称操作を選び、回転軸・鏡映面・対称中心と原子の動きを観察します。
- **クイズモード**：操作あて・合成・移り先・点群あての問題を通して、対称操作の見方や考え方を練習します。

結晶16種・分子19種を収録しています。手元のCIF（結晶）やXYZ（分子）も読み込めます。

## ダウンロード

| パソコン | ダウンロード |
|---|---|
| Windows 10 / 11（64ビット） | [Windows版（ZIP）](https://github.com/ono-knct/symmetry-viewer/releases/latest/download/symmetry-viewer-windows-x64.zip) |
| Linux（x86_64、glibc 2.27以上） | [Linux版（tar.gz）](https://github.com/ono-knct/symmetry-viewer/releases/latest/download/symmetry-viewer-linux-x86_64.tar.gz) |

Pythonなどの追加インストールは不要です。WebGLに対応したブラウザ（Edge・Chrome・Firefoxなど）で使います。
Releaseの `Source code` は開発者向けです。

## ドキュメント

- [使い方](docs/usage.md)：起動、基本操作、困ったときの対処
- [構造データの出典](examples/SOURCES.md)：収録モデルと参照資料
- [開発者向け手順](docs/development.md)：ソースからの起動と配布物のビルド

不具合は[Issues](https://github.com/ono-knct/symmetry-viewer/issues)へ報告してください。

## ライセンス

プログラムと分子モデル（XYZ）は[MITライセンス](LICENSE)です。構造データの詳細は[出典と配布条件](examples/SOURCES.md)を参照してください。
