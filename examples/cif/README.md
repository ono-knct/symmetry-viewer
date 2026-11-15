# Crystal Examples

結晶の対称性を学ぶため、代表的な物質から原子数の少ない構造を収録しています。

全16種の文献・COD番号・採用値・測定条件・モデルの区分は
[構造の出典](../SOURCES.md)を参照。石英はCOD登録と同じNo.154（P3_221）の実測構造から再構成。

| ファイル | 空間群 | 原子 | 見どころ |
|---|---|---|---|
| `Halite.cif` | 225 Fm-3m | 8 | 岩塩型。最も基本的な立方晶 |
| `CsCl.cif` | 221 Pm-3m | 2 | 2 原子だけの単純立方 |
| `Copper.cif` | 225 Fm-3m | 4 | 面心立方最密充填 |
| `Iron-alpha.cif` | 229 Im-3m | 2 | 体心立方。体心の並進が単独で見える |
| `Iron-gamma.cif` | 225 Fm-3m | 4 | γ鉄（オーステナイト）。α鉄のBCCとの比較 |
| `Magnesium.cif` | 194 P6_3/mmc | 2 | 六方最密。6₃ らせん軸 |
| `Diamond.cif` | 227 Fd-3m | 8 | d 映進とらせんが最も豊富 |
| `Graphite.cif` | 194 P6_3/mmc | 4 | Mg と同じ空間群を層状構造で |
| `Sphalerite.cif` | 216 F-43m | 8 | 閃亜鉛鉱。反転中心を持たない |
| `Zincite.cif` | 186 P6_3mc | 4 | ウルツ鉱。極性 6mm、c 映進 |
| `Fluorite.cif` | 225 Fm-3m | 12 | 1 つの空間群に 2 種類のサイト対称 |
| `Rutile.cif` | 136 P4_2/mnm | 6 | 4₂ らせんと n 映進が 6 原子で見える |
| `Anatase.cif` | 141 I4_1/amd | 12 | TiO₂の別多形。ルチルとの結晶構造比較 |
| `Perovskite.cif` | 221 Pm-3m | 5 | 理想ペロブスカイト（SrTiO3） |
| `Quartz.cif` | 154 P3_221 | 9 | 掌性。3₂ らせん、鏡映なし |
| `Pyrite.cif` | 205 Pa-3 | 12 | 立方晶だが 4 回軸を持たない m-3 |

## 追加・変更のしかた

全16種が **生成物**。手で編集せず、表を直して再生成する。

```bash
.venv/bin/python tools/generate_example_structures.py             # 書き出す
.venv/bin/python tools/generate_example_structures.py --check-only # 検証だけ
.venv/bin/python tools/regenerate_example_assets.py --clean        # JSON とカタログを更新
```

出典・格子定数・Wyckoff 位置は `tools/generate_example_structures.py` の
`CRYSTALS` 表にある。生成後に空間群・原子数・組成を読み直して照合するので、
空間群・原子数・組成の不整合を検出する。数値の出典との一致や座標設定の正しさは、
出典資料と原子間距離も確認する。

ファイル名は表示名と出力JSON名の元になります。新しく追加する場合は、空白や括弧を含まない名前にしてください。

NaClも他の結晶と同じ生成・解析手順を使う。
格子定数・原子位置の出典は [SOURCES](../SOURCES.md) を参照。
