# 構造データの出典

結晶16種・分子19種の参照資料とモデルの作成方法をまとめています。格子定数・原子座標は各CIF／XYZ、生成用のパラメータは[モデル定義](https://github.com/ono-knct/symmetry-viewer/blob/v1.0.0/tools/generate_example_structures.py)に記載しています。

## 結晶

文献の格子定数と原子位置をもとに、対称等価な位置へ原子を配置した教材用モデルです。熱振動や測定誤差を省略した、静的な原子配置として扱います。

| ファイル | 作成方法 | 出典 |
|---|---|---|
| `CsCl.cif` | 文献集成から構成 | Wyckoff [W]、[COD 9008789](https://www.crystallography.net/cod/9008789.html) |
| `Halite.cif` | X線回折構造から再構成 | Abrahams・Bernstein [H]、[COD 1000041](https://www.crystallography.net/cod/1000041.html) |
| `Copper.cif` | 実測格子とfccの原子位置から構成 | Straumanis・Yu [C]、25°C |
| `Iron-alpha.cif` | 文献集成から構成 | Wyckoff [W]、[COD 9008536](https://www.crystallography.net/cod/9008536.html)、298 K |
| `Iron-gamma.cif` | 文献集成から構成 | Wyckoff [W]、[COD 9008469](https://www.crystallography.net/cod/9008469.html) |
| `Magnesium.cif` | 実測格子とhcpの原子位置から構成 | Straumanis [M]、[COD 9012001](https://www.crystallography.net/cod/9012001.html)、25°C |
| `Diamond.cif` | 実測格子と空間群の特殊位置から構成 | Homほか [D] |
| `Graphite.cif` | 中性子回折構造から再構成 | Trucano・Chen [G]、[COD 9011577](https://www.crystallography.net/cod/9011577.html) |
| `Sphalerite.cif` | 実測格子と空間群の特殊位置から構成 | Skinner [S]、[COD 9000107](https://www.crystallography.net/cod/9000107.html) |
| `Zincite.cif` | 単結晶X線構造から再構成 | Abrahams・Bernstein [Z]、298 K |
| `Fluorite.cif` | 文献集成から構成 | Wyckoff [W]、[COD 9009005](https://www.crystallography.net/cod/9009005.html) |
| `Rutile.cif` | 中性子粉末回折構造から再構成 | Howardほか [T]、[COD 9015662](https://www.crystallography.net/cod/9015662.html)、室温 |
| `Anatase.cif` | 中性子粉末回折構造から再構成 | Howardほか [T]、[COD 9015929](https://www.crystallography.net/cod/9015929.html)、室温 |
| `Perovskite.cif` | 単結晶X線の平均立方構造から再構成 | Abramovほか [P]、296 K |
| `Quartz.cif` | 実測構造から再構成 | Levienほか [Q]、[COD 9000775](https://www.crystallography.net/cod/9000775.html)、1 atm |
| `Pyrite.cif` | X線構造から再構成 | Brostigen・Kjekshus [Y]、[COD 5000115](https://www.crystallography.net/cod/5000115.html) |

NaClは、CODから取得した格子・原子位置・対称操作を[専用の生成器](https://github.com/ono-knct/symmetry-viewer/blob/v1.0.0/tools/reconstruct_cod_examples.py)で立方格子のCIFに再構成しています。その他15種は通常のモデル定義から生成しています。

### 結晶の文献

- [W] R. W. G. Wyckoff, *Crystal Structures*, 2nd ed., vol.1, Interscience Publishers, New York (1963)。
- [H] S. C. Abrahams, J. L. Bernstein, “Accuracy of an automatic diffractometer. Measurement of the sodium chloride structure factors”, *Acta Cryst.* **18**, 926–932 (1965). [DOI](https://doi.org/10.1107/S0365110X65002244)
- [C] M. E. Straumanis, L. S. Yu, “Lattice parameters, densities, expansion coefficients and perfection of structure of Cu and of Cu–In α phase”, *Acta Cryst.* **A25**, 676–682 (1969). [DOI](https://doi.org/10.1107/S0567739469001549)
- [M] M. E. Straumanis, “The precision determination of lattice constants by the powder and rotating crystal methods and applications”, *J. Appl. Phys.* **20**, 726–734 (1949). [DOI](https://doi.org/10.1063/1.1698520)
- [D] T. Hom, W. Kiszenik, B. Post, “Accurate lattice constants from multiple reflection measurements. II. Lattice constants of germanium, silicon and diamond”, *J. Appl. Cryst.* **8**, 457–458 (1975). [DOI](https://doi.org/10.1107/S0021889875010965)
- [G] P. Trucano, R. Chen, “Structure of graphite by neutron diffraction”, *Nature* **258**, 136–137 (1975). [DOI](https://doi.org/10.1038/258136a0)
- [S] B. J. Skinner, “Unit-cell edges of natural and synthetic sphalerites”, *Am. Mineral.* **46**, 1399–1411 (1961). [COD書誌](https://www.crystallography.net/cod/9000107.html)
- [Z] S. C. Abrahams, J. L. Bernstein, “Remeasurement of the structure of hexagonal ZnO”, *Acta Cryst.* **B25**, 1233–1236 (1969). [DOI](https://doi.org/10.1107/S0567740869003876)
- [T] C. J. Howard, T. M. Sabine, F. Dickson, “Structural and thermal parameters for rutile and anatase”, *Acta Cryst.* **B47**, 462–468 (1991). [DOI](https://doi.org/10.1107/S010876819100335X)
- [P] Yu. A. Abramov, V. G. Tsirelson, V. E. Zavodnik, S. A. Ivanov, I. D. Brown, “The chemical bond and atomic displacements in SrTiO3 from X-ray diffraction analysis”, *Acta Cryst.* **B51**, 942–951 (1995). [DOI](https://doi.org/10.1107/S0108768195003752)
- [Q] L. Levien, C. T. Prewitt, D. J. Weidner, “Structure and elastic properties of quartz at pressure”, *Am. Mineral.* **65**, 920–930 (1980). [COD書誌](https://www.crystallography.net/cod/9000775.html)
- [Y] G. Brostigen, A. Kjekshus, “Redetermined crystal structure of FeS2 (pyrite)”, *Acta Chem. Scand.* **23**, 2186–2188 (1969). [DOI](https://doi.org/10.3891/acta.chem.scand.23-2186)

## 分子

結合長・結合角を設定し、対称形と配座を固定した理想化モデルです。表の資料は、結合長・結合角などを照合するための参考資料です。

| ファイル | モデルの形・配座 | 照合用の参考資料 |
|---|---|---|
| `hydrogen_chloride.xyz` | 二原子分子 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=7647010)、[M-D] |
| `carbon_dioxide.xyz` | 直線形 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=124389)、[M-H] |
| `water.xyz` | 折れ線形 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=7732185)、[M-W] |
| `ammonia.xyz` | 三角錐 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=7664417)、[M-H] |
| `hydrogen_peroxide.xyz` | 非平面のねじれ配座 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=7722841)、[M-P] |
| `boron_trifluoride.xyz` | 平面三角形 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=7637072&charge=0)、[M-K] |
| `methane.xyz` | 正四面体 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=74828&charge=0)、[M-M] |
| `chlorofluoromethane.xyz` | 正四面体方向に置換基を配置 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=593704&charge=0)、[M-F] |
| `bromochlorofluoromethane.xyz` | 一方の鏡像を固定 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=593986&charge=0)、[M-B] |
| `xenon_tetrafluoride.xyz` | 平面正方形 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=13709610)、[M-X] |
| `ethene.xyz` | 平面形 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=74851)、[M-H] |
| `trans_dichloroethene.xyz` | 平面trans配座 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=156605)、[M-L] |
| `phosphorus_pentafluoride.xyz` | 三方両錐 | [CCCBDB](https://cccbdb.nist.gov/exp2x.asp?casno=7647190&charge=0)、[M-G]、[M-PF] |
| `bromine_pentafluoride.xyz` | 四角錐 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=7789302&charge=0)、[M-G] |
| `allene.xyz` | 末端のCH2面を90°に固定 | [CCCBDB](https://cccbdb.nist.gov/exp2x.asp?casno=463490&charge=0)、[M-H] |
| `sulfur_hexafluoride.xyz` | 正八面体 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=2551624&charge=0)、[M-K] |
| `ethane.xyz` | ねじれ形 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=74840&charge=0)、[M-H] |
| `anti_dibromodichloroethane.xyz` | 反転中心を持つanti配座 | [PubChem CID 79092](https://pubchem.ncbi.nlm.nih.gov/compound/79092)（物質情報） |
| `benzene.xyz` | 平面六角形 | [CCCBDB](https://cccbdb.nist.gov/expgeom2x.asp?casno=71432)、[M-H] |

座標には丸めを含み、点群判定は解析の許容誤差に依存します。生成した分子の結合長・結合角はモデル定義の `MOLECULES` 表、手作業で設定した分子の座標は各XYZを参照してください。

### 分子の参考文献

CCCBDB：R. D. Johnson III (ed.), *NIST Computational Chemistry Comparison and Benchmark Database*, NIST Standard Reference Database 101, Release 22 (May 2022)。[DOI](https://doi.org/10.18434/T47C7Z)。

- [M-H] G. Herzberg, *Molecular Spectra and Molecular Structure III: Electronic Spectra and Electronic Structure of Polyatomic Molecules*, Van Nostrand, New York (1966)。
- [M-K] K. Kuchitsu (ed.), *Structure of Free Polyatomic Molecules—Basic Data*, Springer (1998)。[DOI](https://doi.org/10.1007/978-3-642-45748-7)。
- [M-G] L. V. Gurvich, I. V. Veyts, C. B. Alcock, *Thermodynamic Properties of Individual Substances*, 4th ed., Hemisphere (1989)。
- [M-L] K. H. Hellwege & A. M. Hellwege (eds.), *Landolt-Börnstein*, Group II, vol.7, *Structure Data of Free Polyatomic Molecules*, Springer (1976)。
- [M-D] NIST Diatomic Spectral Database。[DOI](https://doi.org/10.18434/T4T59X)。
- [M-W] A. R. Hoy, P. R. Bunker, “A precise solution of the rotation bending Schrödinger equation for a triatomic molecule with application to the water molecule”, *J. Mol. Spectrosc.* **74**, 1–8 (1979)。[DOI](https://doi.org/10.1016/0022-2852(79)90019-5)。
- [M-M] E. Hirota, “Anharmonic Potential Function and Equilibrium Structure of Methane”, *J. Mol. Spectrosc.* **77**, 213–221 (1979)。[DOI](https://doi.org/10.1016/0022-2852(79)90103-6)。
- [M-P] R. L. Redington, W. B. Olson, P. C. Cross, “Studies of Hydrogen Peroxide: The Infrared Spectrum and the Internal Rotation Problem”, *J. Chem. Phys.* **36**, 1311–1326 (1962)。[DOI](https://doi.org/10.1063/1.1732733)。
- [M-F] S. Blanco, A. Lesarri, J. C. López, J. L. Alonso, A. Guarnieri, “The rotational spectrum of chlorofluoromethane”, *J. Mol. Spectrosc.* **174**, 397–416 (1995)。[DOI](https://doi.org/10.1006/jmsp.1995.0011)。
- [M-B] A. Bauder, A. Beil, D. Luckhaus, F. Müller, M. Quack, “Combined high resolution infrared and microwave study of bromochlorofluoromethane”, *J. Chem. Phys.* **106**, 7558–7570 (1997)。[DOI](https://doi.org/10.1063/1.473759)。
- [M-X] H. Bürger, S. Ma, J. Breidung, W. Thiel, “Ab initio calculations and high resolution infrared investigation on XeF4”, *J. Chem. Phys.* **104**, 4945–4953 (1996)。[DOI](https://doi.org/10.1063/1.471266)。
- [M-PF] K. W. Hansen, L. S. Bartell, “Electron Diffraction Study of the Structure of PF5”, *Inorg. Chem.* **4**, 1775–1776 (1965)。[DOI](https://doi.org/10.1021/ic50034a023)。

## データの配布条件

COD由来のデータは[CC0](https://www.crystallography.net/cod/documents/topic/privacy/COD-privacy-GDPR.pdf)で提供されています。出典は、各構造の原著とCODの登録情報を示しています。
同梱XYZは、本プロジェクトで組み立てた教材用座標で、MITライセンスで配布します。NIST CCCBDBの利用条件は、[NISTの公式説明](https://www.nist.gov/open/copyright-fair-use-and-licensing-statements-srd-data-software-and-technical-series-publications)を参照してください。
