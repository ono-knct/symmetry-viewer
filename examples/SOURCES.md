# 同梱構造の出典

2026-11-15更新。結晶16種・分子19種の数値、参照資料、加工内容を記載する。
結晶は下表の参照値を採用している。分子は全件を理想化教材モデルとして扱い、
現行値と文献・データベースによる照合結果を分けて示す。
水は2026-11-14に参照値に合わせてO–H結合を等長化し、2回軸をz軸、分子面をxz面に置いた。
ほかの分子の数値・座標は、下表に示す理想化教材モデルの値である。

## 結晶の構造と生成方法

- **実測構造から再構成**：実験に由来する格子・平均原子位置を用い、対称操作で展開した教材用CIF。熱振動因子・誤差等を省略しており、原著配布ファイルそのものではない。
- **実測格子から構成**：測定された格子定数と結晶型の特殊位置から組み立てた教材モデル。
- **文献集成から構成**：Wyckoffの文献集成をCOD経由で照合した教材モデル。原実験の測定条件まで確認済みとはしない。

以下の長さはÅ、座標は分率座標。座標は生成器に入力する非対称単位であり、
CIFの書き出し時には対称等価位置に置き換わることがある。
全16件を [生成器](../tools/generate_example_structures.py) の`CRYSTALS`表から生成する。
NaClもCODの格子定数・原子位置を表に記録し、他の結晶と同じ手順で再構成する。

| ファイル | 採用した格子・非対称単位 | 分類・条件・出典 |
|---|---|---|
| CsCl.cif | No.221、a=4.123；Cs(0,0,0)、Cl(1/2,1/2,1/2) | 文献集成から構成。Wyckoff [W]、[COD 9008789](https://www.crystallography.net/cod/9008789.html)、pp.85–237。温度不明。 |
| Halite.cif | No.225、a=5.620；Na(0,0,0)、Cl(1/2,1/2,1/2) | X線実測構造から再構成。Abrahams & Bernstein [H]、[COD 1000041](https://www.crystallography.net/cod/1000041.html)、AMCSD 0009295。温度未確認。一般的な室温代表値と同一視しない。 |
| Copper.cif | No.225、a=3.6149；Cu(0,0,0) | 実測格子からfccを構成。Straumanis & Yu [C]、25°C、原著3.61491の丸め。 |
| Iron-alpha.cif | No.229、a=2.8665；Fe(0,0,0) | 文献集成から構成。Wyckoff [W]、[COD 9008536](https://www.crystallography.net/cod/9008536.html)、pp.7–83、298 K。 |
| Iron-gamma.cif | No.225、a=3.5910；Fe(0,0,0) | 文献集成から構成。Wyckoff [W]、[COD 9008469](https://www.crystallography.net/cod/9008469.html)、pp.7–83。温度不明。α鉄と同温度での測定とはしていない。 |
| Magnesium.cif | No.194、a=3.2093,c=5.2103；Mg(1/3,2/3,1/4) | 実測格子からhcpを構成。Straumanis [M]、[COD 9012001](https://www.crystallography.net/cod/9012001.html)、25°C。 |
| Diamond.cif | No.227、a=3.5670；C(0,0,0) | 実測格子から構成。Homほか [D]、多重回折、原著3.566986の丸め。原点選択1。温度未確認。 |
| Graphite.cif | No.194、a=2.464,c=6.711；C(0,0,1/4)、C(1/3,2/3,1/4) | 中性子回折構造から再構成。Trucano & Chen [G]、[COD 9011577](https://www.crystallography.net/cod/9011577.html)、天然試料。温度未確認。 |
| Sphalerite.cif | No.216、a=5.4093；Zn(0,0,0)、S(1/4,1/4,1/4) | 実測格子から構成。Skinner [S]、[COD 9000107](https://www.crystallography.net/cod/9000107.html)、合成試料。温度未確認。 |
| Zincite.cif | No.186、a=3.249858,c=5.206619；Zn(1/3,2/3,0)、O(1/3,2/3,0.3825) | 単結晶X線構造から再構成。Abrahams & Bernstein [Z]、298 K、Li 10 ppm添加の水熱合成試料、等方性精密化モデル。原著のZn(0,0,0)から基底面内で原点を移動。 |
| Fluorite.cif | No.225、a=5.46295；Ca(0,0,0)、F(1/4,1/4,1/4) | 文献集成から構成。Wyckoff [W]、[COD 9009005](https://www.crystallography.net/cod/9009005.html)、pp.239–444。温度不明。 |
| Rutile.cif | No.136、a=4.5937,c=2.9587；Ti(0,0,0)、O(0.30478,0.30478,0) | 中性子粉末回折構造から再構成。Howardほか [T]、[COD 9015662](https://www.crystallography.net/cod/9015662.html)、室温。 |
| Anatase.cif | No.141、a=3.7845,c=9.5143；Ti(0,0,0)、O(0,0,0.20806) | 中性子粉末回折構造から再構成。Howardほか [T]、[COD 9015929](https://www.crystallography.net/cod/9015929.html)、室温、原点選択1。 |
| Perovskite.cif | SrTiO3、No.221、a=3.901；Sr(0,0,0)、Ti(1/2,1/2,1/2)、O(1/2,1/2,0) | 単結晶X線の平均立方構造から再構成。Abramovほか [P]、296(2) K。原著a=3.901(1)。熱振動・局所変位のモデル全体は再現していない。 |
| Quartz.cif | No.154、a=4.916,c=5.4054；Si(0.4697,0,0)、O(0.4135,0.2669,0.1191) | 実測構造から再構成。Levienほか [Q]、[COD 9000775](https://www.crystallography.net/cod/9000775.html)、1 atm。CODと同じ空間群・座標設定。温度未確認。 |
| Pyrite.cif | No.205、a=5.4179；Fe(0,0,0)、S(0.3840,0.3840,0.3840) | X線構造から再構成。Brostigen & Kjekshus [Y]、[COD 5000115](https://www.crystallography.net/cod/5000115.html)。温度未確認。 |

石英はCOD登録のNo.154（P3_221）・非対称単位をそのまま採用し、対称操作で展開した。
掌性を反転する変換は行っていない。Si–O距離は約1.6046、1.6137 Åである。
生成器の標準設定との原点の違いは平行移動で処理し、CIF書き出しでもCODの原点を保持する。

## 文献

- [W] R. W. G. Wyckoff, *Crystal Structures*, 2nd ed., vol.1, Interscience Publishers, New York (1963)。使用箇所とCOD番号は上表。
- [H] S. C. Abrahams, J. L. Bernstein, “Accuracy of an automatic diffractometer. Measurement of the sodium chloride structure factors”, *Acta Cryst.* **18**, 926–932 (1965). [DOI](https://doi.org/10.1107/S0365110X65002244)
- [C] M. E. Straumanis, L. S. Yu, “Lattice parameters, densities, expansion coefficients and perfection of structure of Cu and of Cu–In α phase”, *Acta Cryst.* **A25**, 676–682 (1969). [DOI](https://doi.org/10.1107/S0567739469001549)
- [M] M. E. Straumanis, “The precision determination of lattice constants by the powder and rotation crystal methods and applications”, *J. Appl. Phys.* **20**, 726–734 (1949). [DOI](https://doi.org/10.1063/1.1698520)
- [D] T. Hom, W. Kiszenik, B. Post, “Accurate lattice constants from multiple reflection measurements. II. Lattice constants of germanium, silicon and diamond”, *J. Appl. Cryst.* **8**, 457–458 (1975). [DOI](https://doi.org/10.1107/S0021889875010965)
- [G] P. Trucano, R. Chen, “Structure of graphite by neutron diffraction”, *Nature* **258**, 136–137 (1975). [DOI](https://doi.org/10.1038/258136a0)
- [S] B. J. Skinner, “Unit-cell edges of natural and synthetic sphalerites”, *Am. Mineral.* **46**, 1399–1411 (1961). [COD書誌](https://www.crystallography.net/cod/9000107.html)
- [Z] S. C. Abrahams, J. L. Bernstein, “Remeasurement of the structure of hexagonal ZnO”, *Acta Cryst.* **B25**, 1233–1236 (1969). [DOI](https://doi.org/10.1107/S0567740869003876)
- [T] C. J. Howard, T. M. Sabine, F. Dickson, “Structural and thermal parameters for rutile and anatase”, *Acta Cryst.* **B47**, 462–468 (1991). [DOI](https://doi.org/10.1107/S010876819100335X)
- [P] Yu. A. Abramov, V. G. Tsirelson, V. E. Zavodnik, S. A. Ivanov, I. D. Brown, “The chemical bond and atomic displacements in SrTiO3 from X-ray diffraction analysis”, *Acta Cryst.* **B51**, 942–951 (1995). [DOI](https://doi.org/10.1107/S0108768195003752)
- [Q] L. Levien, C. T. Prewitt, D. J. Weidner, “Structure and elastic properties of quartz at pressure”, *Am. Mineral.* **65**, 920–930 (1980). [COD書誌](https://www.crystallography.net/cod/9000775.html)
- [Y] G. Brostigen, A. Kjekshus, “Redetermined crystal structure of FeS2 (pyrite)”, *Acta Chem. Scand.* **23**, 2186–2188 (1969). [DOI](https://doi.org/10.3891/acta.chem.scand.23-2186)

## データの取得・配布

COD（Crystallography Open Database）のデータ・データベースはCC0で提供される。
原著者とCODの両方を明示する。取得日は2026-10-11で、主サイトとCOD Granadaミラーを利用した。
COD番号・改訂・取得CIFのハッシュは末尾に記載する。

- CODの[取得・CC0の公式説明](https://www.crystallography.net/cod/documents/topic/privacy/COD-privacy-GDPR.pdf)
- CODの解説：S. Gražulis et al., *Nucleic Acids Res.* **40**, D420–D427 (2012). [DOI](https://doi.org/10.1093/nar/gkr900)

COD由来の数値で再構成した教材ファイルと、出版社PDF・図表・原著提供CIFは別に扱う。
出版社PDF・図表は同梱しない。Cu・ダイヤモンド・ZnO・SrTiO3は原著の数値から独自生成しており、
出版社提供ファイルの再配布許諾を得たという表示はしない。
NaClは2026-10-12のCOD直接取得に基づく再構成物へ置き換えた。
配布するNaClの出典と利用条件は、上記CODデータに基づく。

未確認の温度・圧力・試料条件は推測で補っていない。
実験誤差・熱振動因子・占有率を含む精密化データ全体の再現を目的とした教材ではない。

## COD取得記録

取得日：2026-10-11。主サイト／上記CODミラーのCIF本文。ハッシュは取得ファイルのSHA-256。

| COD | Revision | SHA-256 |
|---|---|---|
| 1000041 | 130149 | `911f3d4dd6681af3e650ab3ca24644cef99f6e985cce77dc1d00bc7431272797` |
| 5000115 | 202022 | `2b4f67b13a18079079f987ed2785662a176364ddfae19e10d646da143337344d` |
| 9000107 | 291269 | `ef5cefee3408b89bc093e1df68c7fa7541a7a086bc29e899ba7b060bc14bc753` |
| 9000775 | 291269 | `c0ca15db3734474ddb4f9dfa151e9859bbde1f3ffee662c364363924056bd6e8` |
| 9008469 | 291735 | `d41d6364828f9acc07ef2da246703f81cab476605e5d4c3c5653dda5fc91e77d` |
| 9008536 | 291735 | `2e980f15155921474c1ee77e4fe3dcb76db6a2c93d763f619ac773c9349b044d` |
| 9008789 | 301881 | `776b7702628ce1963c06d88fb7ed0fcd19d48a56654507f28f115e16ec5b20d3` |
| 9009005 | 291735 | `a68f581611fb4920195d6fa75c3eee2b806a68a6d9223993cd5200b542531945` |
| 9011577 | 291877 | `2d4d20772a3d5fd084099ffa8216b6460bde97648dc4528b0e9e41363f8b3ec2` |
| 9012001 | 282053 | `3390cb7a27fa6f969bd8f8a4f0d8a6cf35c5e238e82582376b30d0fda0e13fe1` |
| 9015662 | 292002 | `52ad00a6ac3929868808a8183bbe8fa711e9621b1a1f926a1f7ec7fa83625639` |
| 9015929 | 303136 | `a8f4b1166c0be8532d3cbabba08011de96fa0a85d98c2a71a530722dcb995a62` |

### NaClの再取得と加工（2026-10-12）

主サイトから次のURLを直接取得した。取得時刻は日本時間2026-10-12の
00:25:50。上表の2026-10-11の照合用取得とは区別する。
改訂番号は同じだが取得本文のハッシュは異なるため、取得本文を区別するためハッシュを併記する。
前回のミラー取得本文との差はヘッダーのDate・URLであり、構造データ本文は同一だった。

| ファイル | 取得URL | Revision | 取得本文のSHA-256 |
|---|---|---|---|
| Halite.cif | [COD 1000041](https://www.crystallography.net/cod/1000041.cif) | 130149 | `02d4f4fa315f7b97147256118acc7f9f20190d7246c3ea7209cfb8bd5d6e1fed` |

この取得記録は採用値の出典として保持する。現行NaClはa=5.62、
Na(0,0,0)、Cl(0.5,0.5,0.5)を通常生成器へ渡し、対称等価位置を展開する。
対称操作と原子番号は通常のCIF書き出し・解析で決まり、COD本文や旧JSONの順序に固定しない。
酸化数表記、実験誤差・密度・R因子、熱振動因子は収録しない。
解析JSONも同じCIFから再生成し、過去の幾何注釈や再生経路を個別に引き継がない。

## 分子19種は理想化教材モデル

同梱分子は、点群と対称操作の学習を目的として構成した理想化教材モデルである。
結合長・結合角を設定し、対称形を組み立て、配座を固定している。
参照資料の実測座標や計算最適化座標をそのまま収録したものではない。
表には現行XYZから求めた幾何と、構成・加工の内容、照合資料を示す。
照合資料は数値の妥当性や差を検討するための参照先であり、
現行値を過去にその資料から取得したという履歴まで確認できたことを意味しない。
数値が一致する場合も含め、現行値の元の取得経路は未確認である。

長さはÅ、角度は度。表示値はXYZからの算出値を丸めたもので、測定精度を示す桁数ではない。
点群は教材で意図する静的な配座の点群であり、すべての異性体や分子運動の時間平均を表すものではない。
手書き11件と生成8件の区分は表に示す。生成8件は
[生成器](../tools/generate_example_structures.py)の`MOLECULES`表の内部座標から組み立て、
XYZへ小数点以下6桁で出力する。手書きの座標にも成分の丸めや幾何の小さなずれがある。
等長性や角度のずれが確認された箇所は表中に明記し、理想化を理由に隠さない。

### 現行モデルと照合資料

CCCBDBは気相孤立分子の照合先として使用した。結晶中の分子構造は採用していない。
表中のCAS番号はリンク先のDB検索番号。文献記号は次節に対応する。
全件共通のモデル区分は「理想化教材モデル」であり、参照資料側の実験手法や距離定義とは区別する。

| ファイル・点群 | 現行の主な結合長・角度 | 構成・加工 | 照合資料と確認状況 |
|---|---|---|---|
| `hydrogen_chloride.xyz`・C∞v | HCl=1.274 | 手書き。結合中点を原点とした二原子配置。 | [CCCBDB CAS 7647-01-0](https://cccbdb.nist.gov/expgeom2x.asp?casno=7647010)、[M-D]。¹H³⁵Clの平衡距離r_e、座標表1.2746。 |
| `carbon_dioxide.xyz`・D∞h | CO=1.160、OCO=180 | 手書き。直線・等長。 | [CCCBDB CAS 124-38-9](https://cccbdb.nist.gov/expgeom2x.asp?casno=124389)、[M-H]。参照距離1.162。 |
| `water.xyz`・C2v | OH=0.958、HOH=104.4776 | 手書き折れ線。参照値に合わせて等長化し、2回軸をz軸、分子面をxz面に置いた（2026-11-14。行列が0・±1で書けるように）。 | [CCCBDB CAS 7732-18-5](https://cccbdb.nist.gov/expgeom2x.asp?casno=7732185)、[M-W]。分光解析による平衡構造、0.958/104.4776。 |
| `ammonia.xyz`・C3v | NH≈1.01442、HNH≈106.362 | 手書き三角錐。横成分・高さを設定。一つの反転配座を固定。 | [CCCBDB CAS 7664-41-7](https://cccbdb.nist.gov/expgeom2x.asp?casno=7664417)、[M-H]。参照値1.012/106.67。 |
| `hydrogen_peroxide.xyz`・C2 | OO=1.475、OH=0.950、HOO=94.8、HOOH≈111.5 | 生成。非平面のねじれ配座を固定。 | [CCCBDB CAS 7722-84-1](https://cccbdb.nist.gov/expgeom2x.asp?casno=7722841)、[M-P]。気相IR・内部回転解析。長さ・結合角は一致するが、参照二面角は119.8。現行111.5の直接出典は未確認。 |
| `boron_trifluoride.xyz`・D3h | BF≈1.300、FBF≈120 | 手書き。平面正三角形。 | [CCCBDB CAS 7637-07-2](https://cccbdb.nist.gov/expgeom2x.asp?casno=7637072&charge=0)、[M-K]。r_e=1.307。 |
| `methane.xyz`・Td | CH≈1.089664、HCH≈109.471 | 手書き。±0.629118を成分とする正四面体。 | [CCCBDB CAS 74-82-8](https://cccbdb.nist.gov/expgeom2x.asp?casno=74828&charge=0)、[M-M]。分光解析によるr_e=1.087。 |
| `chlorofluoromethane.xyz`・Cs | CCl=1.759、CF=1.378、CH=1.087、全中心角≈109.471 | 生成。異なる結合長を正四面体方向へ配置。H対の鏡映を保持。 | [CCCBDB CAS 593-70-4](https://cccbdb.nist.gov/expgeom2x.asp?casno=593704&charge=0)、[M-F]。回転スペクトルの同位体置換構造r_s。内部座標表は1.762/1.370/1.090で、角度も理想四面体角とは異なる。 |
| `bromochlorofluoromethane.xyz`・C1 | CBr=1.966、CCl=1.759、CF=1.378、CH=1.087、全中心角≈109.471 | 生成。正四面体方向へ配置。一方の鏡像を固定し、R/Sは未表示。 | [CCCBDB CAS 593-98-6](https://cccbdb.nist.gov/expgeom2x.asp?casno=593986&charge=0)、[M-B]。IR・マイクロ波。参照距離1.928/1.745/1.356/1.088。参照角のうちHを含む3角は拘束値。 |
| `xenon_tetrafluoride.xyz`・D4h | XeF=1.950、90/180 | 手書き。平面正方形。 | [CCCBDB CAS 13709-61-0](https://cccbdb.nist.gov/expgeom2x.asp?casno=13709610)、[M-X]。実験欄の基底振動状態の有効距離r_0=1.935。同論文の計算値とは区別する。 |
| `ethene.xyz`・D2h | CC=1.338、CH≈1.085428、HCH≈117.511、HCC≈121.244 | 手書き。平面・反転を保持し、座標成分を丸める。 | [CCCBDB CAS 74-85-1](https://cccbdb.nist.gov/expgeom2x.asp?casno=74851)、[M-H]。参照値1.339/1.086/117.6/121.2。 |
| `trans_dichloroethene.xyz`・C2h | CC=1.330、CCl=1.725、CH=1.087、CCCl=HCC=121、HCCl=118 | 生成。平面trans。一方を反転して構成。CCClとHCCを等しくするのは教材側の仮定。 | [CCCBDB CAS 156-60-5](https://cccbdb.nist.gov/expgeom2x.asp?casno=156605)、[M-L]。参照値1.354/1.718/1.075、CCCl=123.8。HCCの掲載がなく、全構造の実測との対応は未確認。 |
| `phosphorus_pentafluoride.xyz`・D3h | 軸PF=1.577、赤道PF=1.534、90/120/180 | 生成。三方両錐。誤差・振動振幅を省略した静的モデル。 | [CCCBDB CAS 7647-19-0](https://cccbdb.nist.gov/exp2x.asp?casno=7647190&charge=0)、[M-G]。距離は一致。対応する気相電子回折の原著書誌[M-PF]も確認。 |
| `bromine_pentafluoride.xyz`・C4v | 頂点BrF=1.689、底面側BrF=1.774、頂点–底面角=84.5 | 生成。四角錐の配座を固定。底面側結合を90°とは仮定しない。 | [CCCBDB CAS 7789-30-2](https://cccbdb.nist.gov/expgeom2x.asp?casno=7789302&charge=0)、[M-G]。長さは一致、参照角84.8。 |
| `allene.xyz`・D2d | CC=1.300、CH≈1.092932、CCC=180、HCH≈114.656、HCC≈122.672 | 手書き。末端CH2面を90°に固定。 | [CCCBDB CAS 463-49-0](https://cccbdb.nist.gov/exp2x.asp?casno=463490&charge=0)、[M-H]。参照値1.308/1.087、HCH=118.2、HCC=120.9。 |
| `sulfur_hexafluoride.xyz`・Oh | SF=1.560、90/180 | 手書き。正八面体。 | [CCCBDB CAS 2551-62-4](https://cccbdb.nist.gov/expgeom2x.asp?casno=2551624&charge=0)、[M-K]。参照距離1.561（座標表1.5607）。 |
| `ethane.xyz`・D3d | CC=1.535、CH=1.094、HCH=HCC≈109.471 | 生成。正四面体角を仮定し、ねじれ形（相対回転60°）を固定。 | [CCCBDB CAS 74-84-0](https://cccbdb.nist.gov/expgeom2x.asp?casno=74840&charge=0)、[M-H]。参照値1.536/1.091、HCH=108、HCC=110.91。 |
| `anti_dibromodichloroethane.xyz`・Ci | CC=1.530、CBr=1.966、CCl=1.759、CH=1.094、中心角≈109.471 | 生成。片側を反転してmeso型のanti配座を構成。同種置換基のXCCX二面角は180。 | [PubChem CID 79092](https://pubchem.ncbi.nlm.nih.gov/compound/79092)、CAS 683-68-1は物質同定用。CIDの立体化学は未指定。現行meso/antiの数値の直接出典、実測・計算構造との対応は未確認。 |
| `benzene.xyz`・D6h | CC≈1.396526～1.397000、CH≈1.082000～1.082679、CCC≈119.978～120.011 | 手書き平面六角形。等長・120°に小さなずれがあり、厳密な正六角形ではない。 | [CCCBDB CAS 71-43-2](https://cccbdb.nist.gov/expgeom2x.asp?casno=71432)、[M-H]。参照値CC=1.397、CH=1.084、CCC=HCC=120。 |

水は等長のO–H結合を対称に配置したC2vの教材モデルである。
ベンゼンの点群は通常の解析許容値での表示である。
CCCBDBの過酸化水素の見出しはC2h、エタンはD3hだが、掲載座標を再解析するとそれぞれC2、D3dとなる。
表では掲載座標と配座に対応する点群を用いた。
CH2ClFはDBの内部座標表と直交座標表のC–H距離にも小差があり、上表は内部座標表を照合値として示す。

### 分子の参照文献

CCCBDB：R. D. Johnson III (ed.), *NIST Computational Chemistry Comparison and Benchmark Database*,
NIST Standard Reference Database 101, Release 22 (May 2022)。
[DOI 10.18434/T47C7Z](https://doi.org/10.18434/T47C7Z)。閲覧日2026-10-11。
以下はCCCBDBが引用する原著・集成と、補完して確認した原著書誌である。
原著の全文数値表やすべての測定条件を確認済みという意味ではない。
各実験の温度・圧力は未確認。集成経由のものは原実験の特定も未完である。
平衡距離r_e、基底振動状態の有効距離r_0、同位体置換距離r_s、電子回折距離r_gを同一視しない。

- [M-H] G. Herzberg, *Molecular Spectra and Molecular Structure III: Electronic Spectra and Electronic Structure of Polyatomic Molecules*, Van Nostrand, New York (1966)。気相分子の文献集成。DOI未確認。
- [M-K] K. Kuchitsu (ed.), *Structure of Free Polyatomic Molecules—Basic Data*, Springer (1998)。[DOI](https://doi.org/10.1007/978-3-642-45748-7)。自由分子構造の文献集成。
- [M-G] L. V. Gurvich, I. V. Veyts, C. B. Alcock, *Thermodynamic Properties of Individual Substances*, 4th ed., Hemisphere (1989)。文献集成。DOI未確認。
- [M-L] K. H. Hellwege & A. M. Hellwege (eds.), *Landolt-Börnstein*, Group II, vol.7, *Structure Data of Free Polyatomic Molecules*, Springer (1976)。文献集成。DOI未確認。
- [M-D] NIST Diatomic Spectral Database。[DOI](https://doi.org/10.18434/T4T59X)。HClのCCCBDB実験幾何欄の参照DB。原測定論文は未確認。
- [M-W] A. R. Hoy, P. R. Bunker, “A precise solution of the rotation bending Schrödinger equation for a triatomic molecule with application to the water molecule”, *J. Mol. Spectrosc.* **74**, 1–8 (1979)。[DOI](https://doi.org/10.1016/0022-2852(79)90019-5)。
- [M-M] E. Hirota, “Anharmonic Potential Function and Equilibrium Structure of Methane”, *J. Mol. Spectrosc.* **77**, 213–221 (1979)。[DOI](https://doi.org/10.1016/0022-2852(79)90103-6)。
- [M-P] R. L. Redington, W. B. Olson, P. C. Cross, “Studies of Hydrogen Peroxide: The Infrared Spectrum and the Internal Rotation Problem”, *J. Chem. Phys.* **36**, 1311–1326 (1962)。[DOI](https://doi.org/10.1063/1.1732733)。
- [M-F] S. Blanco, A. Lesarri, J. C. López, J. L. Alonso, A. Guarnieri, “The rotational spectrum of chlorofluoromethane”, *J. Mol. Spectrosc.* **174**, 397–416 (1995)。[DOI](https://doi.org/10.1006/jmsp.1995.0011)。
- [M-B] A. Bauder, A. Beil, D. Luckhaus, F. Müller, M. Quack, “Combined high resolution infrared and microwave study of bromochlorofluoromethane”, *J. Chem. Phys.* **106**, 7558–7570 (1997)。[DOI](https://doi.org/10.1063/1.473759)。
- [M-X] H. Bürger, S. Ma, J. Breidung, W. Thiel, “Ab initio calculations and high resolution infrared investigation on XeF4”, *J. Chem. Phys.* **104**, 4945–4953 (1996)。[DOI](https://doi.org/10.1063/1.471266)。本一覧では実験欄のr_0を照合し、計算構造は採用していない。
- [M-PF] K. W. Hansen, L. S. Bartell, “Electron Diffraction Study of the Structure of PF5”, *Inorg. Chem.* **4**, 1775–1776 (1965)。[DOI](https://doi.org/10.1021/ic50034a023)。DB集成の距離と対応する気相電子回折の原著。原著全文の条件は未確認。

### 分子データの取得・配布条件

CCCBDBの実験値・座標表は無料で閲覧できたが、
[公式説明](https://cccbdb.nist.gov/introx.asp)にはSRD 101の著作権表示がある。
NISTの[著作権・ライセンス説明](https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications)はSRDと非SRDを区別している。
CCCBDBのページ・表・座標ファイルのGitHub再配布を許可する条項は未確認であり、
結晶のCODに適用されるCC0をCCCBDBへ適用しない。

同梱XYZは手書きまたは本プロジェクトの生成器による教材座標である。
DBの座標ファイルをそのまま同梱したものではない。
独自に組み立てた教材モデルの配布と、DB・出版社が提供するファイルの転載は区別する。
無料閲覧や出典の明示を、第三者ファイルの再配布許諾の代わりにはしない。
出版社PDF・図表は同梱しない。
Ci分子のPubChem参照は物質同定に限り、3Dコンフォマーは取得・採用していない。
CSD/CCDC由来の分子ファイルも採用していない。
