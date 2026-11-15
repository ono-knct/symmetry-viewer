# Molecule XYZ Samples

対称性の教材として選んだ分子。教科書に出る分子から、点群がなるべく重ならないように
選んでいる。座標は理想化した幾何で、実測構造でも最適化構造でもない。

| ファイル | 点群 | 原子 | 見どころ |
| --- | --- | --- | --- |
| `hydrogen_chloride.xyz` | C∞v | 2 | 直線・極性 |
| `carbon_dioxide.xyz` | D∞h | 3 | 直線・反転あり |
| `water.xyz` | C2v | 3 | 最も基本的な折れ線 |
| `ammonia.xyz` | C3v | 4 | 三角錐 |
| `hydrogen_peroxide.xyz` | C2 | 4 | 回転のみ。鏡映も反転も無い |
| `boron_trifluoride.xyz` | D3h | 4 | 平面三角形 |
| `methane.xyz` | Td | 5 | 正四面体 |
| `chlorofluoromethane.xyz` | Cs | 5 | 鏡映が 1 枚だけ |
| `bromochlorofluoromethane.xyz` | C1 | 5 | 対称性なし・掌性（クイズには出ない） |
| `xenon_tetrafluoride.xyz` | D4h | 5 | 平面四角形 |
| `ethene.xyz` | D2h | 6 | 平面・直交する 3 本の C2 |
| `trans_dichloroethene.xyz` | C2h | 6 | C2 と σh、その積の反転中心 |
| `phosphorus_pentafluoride.xyz` | D3h | 6 | 三方両錐（平面 BF3 との対比） |
| `bromine_pentafluoride.xyz` | C4v | 6 | 四角錐 |
| `allene.xyz` | D2d | 7 | ねじれた二重結合 |
| `sulfur_hexafluoride.xyz` | Oh | 7 | 正八面体 |
| `ethane.xyz` | D3d | 8 | ねじれ形（重なり形なら D3h） |
| `anti_dibromodichloroethane.xyz` | Ci | 8 | 反転中心だけを持つ |
| `benzene.xyz` | D6h | 12 | 主軸が S6 と S3 の両方を担う |

## 追加・変更のしかた

`water` `ammonia` `methane` `benzene` `ethene` `allene` `boron_trifluoride`
`sulfur_hexafluoride` `xenon_tetrafluoride` `carbon_dioxide` `hydrogen_chloride`
は手書き。それ以外は `tools/generate_example_structures.py` の `MOLECULES` 表からの生成物。

```bash
.venv/bin/python tools/generate_example_structures.py
.venv/bin/python tools/regenerate_example_assets.py --clean
```

点群の判定は解析の許容誤差に依存します。標準の許容誤差は0.3 Åで、
厳密には対称でない座標も、対称な構造として判定される場合があります。
生成器の対象である8分子は、0.3 Åと0.05 Åの両方で指定した点群になることを検証します。
手書きの11分子は生成器の検証対象外です。座標を変更する場合は、結合長・角度と解析条件を確認してください。
