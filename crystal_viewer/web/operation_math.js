/* Affine operation powers retain translations; crystal matching alone is modulo Z³. */
(function (root) {
  const EPS = 1e-6;
  const identity = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const close = (a, b) => Math.abs(a - b) < EPS;
  function number(value) {
    if (Math.abs(value) < EPS) return "0";
    if (close(value, Math.round(value))) return String(Math.round(value));
    for (const d of [2, 3, 4, 6, 8, 12, 24]) {
      if (close(value * d, Math.round(value * d))) return `${Math.round(value * d)}/${d}`;
    }
    return value.toFixed(4).replace(/\.?0+$/, "");
  }
  function affine(op, crystal) {
    return {W: crystal ? op.matrix_frac : op.matrix_cart,
      t: (crystal ? op.translation_frac : op.translation_cart) || [0, 0, 0]};
  }
  function compose(a, b) {
    return {
      W: a.W.map(row => b.W[0].map((_, j) => row.reduce((v, x, k) => v + x * b.W[k][j], 0))),
      t: a.W.map((row, i) => row.reduce((v, x, k) => v + x * b.t[k], a.t[i])),
    };
  }
  function coordinateExpressions(transform, compact = false) {
    if (!transform.W) return [];
    return transform.W.map((row, i) => {
      const terms = [];
      row.forEach((value, j) => {
        if (Math.abs(value) < EPS) return;
        const magnitude = Math.abs(value);
        terms.push([value < 0, (close(magnitude, 1) ? "" : number(magnitude) + "·") + "xyz"[j]]);
      });
      const shift = transform.t[i];
      if (Math.abs(shift) >= EPS) terms.push([shift < 0, number(Math.abs(shift))]);
      return terms.map(([negative, term], j) => (j
        ? (compact ? (negative ? "−" : "+") : (negative ? " − " : " + "))
        : (negative ? "−" : "")) + term).join("") || "0";
    });
  }
  function formula(transform, compact = false) {
    if (!transform.W) return "";
    return "(x, y, z) → (" + coordinateExpressions(transform, compact).join(", ") + ")";
  }
  function powers(op, operations, crystal, limit = 120) {
    const base = affine(op, crystal);
    if (!base.W) return {steps: [], complete: false};
    const I = identity();
    // Molecular matrices are fitted to finite-precision coordinates. Small
    // errors accumulate under powers (e.g. ethane S6); crystal matrices are exact.
    const equivalent = (a, b) => Math.abs(a - b) < (crystal ? 1e-7 : 1e-5);
    const sameMatrix = (a, b) => a.every((row, i) => row.every((x, j) => equivalent(x, b[i][j])));
    let current = {W: I, t: [0, 0, 0]};
    const steps = [];
    for (let n = 1; n <= limit; n++) {
      current = compose(base, current);
      let match = null, latticeShift = null;
      for (const candidate of operations) {
        const other = affine(candidate, crystal);
        if (!other.W || !sameMatrix(current.W, other.W)) continue;
        const delta = current.t.map((x, i) => x - other.t[i]);
        if (!delta.every(x => equivalent(x, crystal ? Math.round(x) : 0))) continue;
        match = candidate;
        latticeShift = delta.map(x => Math.round(x));
        break;
      }
      const exactIdentity = sameMatrix(current.W, I) && current.t.every(x => equivalent(x, 0));
      const latticeIdentity = crystal && sameMatrix(current.W, I) && current.t.every(x => equivalent(x, Math.round(x)));
      steps.push({n, W: current.W, t: current.t, match, latticeShift, exactIdentity, latticeIdentity});
      if (exactIdentity || latticeIdentity) return {steps, complete: true};
    }
    return {steps, complete: false};
  }
  // Symmetry matrices are similar to real orthogonal matrices, also in a
  // non-orthogonal fractional basis. Their spectrum is ±1 and conjugate pairs.
  function eigenpairs(W) {
    const determinant = W[0][0]*(W[1][1]*W[2][2]-W[1][2]*W[2][1])
      - W[0][1]*(W[1][0]*W[2][2]-W[1][2]*W[2][0])
      + W[0][2]*(W[1][0]*W[2][1]-W[1][1]*W[2][0]);
    const axial = determinant < 0 ? -1 : 1;
    let cosine = Math.max(-1, Math.min(1, (W[0][0]+W[1][1]+W[2][2]-axial)/2));
    if (1-Math.abs(cosine)<1e-5) cosine=Math.sign(cosine);
    const sine = Math.sqrt(Math.max(0, 1-cosine*cosine));
    const roots = sine < 1e-4 ? [[axial,0],[Math.sign(cosine),0],[Math.sign(cosine),0]]
      : [[axial,0],[cosine,sine],[cosine,-sine]];
    const mul = (a,b) => [a[0]*b[0]-a[1]*b[1],a[0]*b[1]+a[1]*b[0]];
    const sub = (a,b) => [a[0]-b[0],a[1]-b[1]];
    const div = (a,b) => mul(a,[b[0]/(b[0]*b[0]+b[1]*b[1]),-b[1]/(b[0]*b[0]+b[1]*b[1])]);
    const magnitude = a => Math.hypot(...a);
    const result = [];
    for (const value of [...new Map(roots.map(r=>[r.join(','),r])).values()]) {
      const rows = W.map((row,i)=>row.map((x,j)=>[x-(i===j?value[0]:0),i===j?-value[1]:0]));
      const pivots = [];
      for (let col=0; col<3; col++) {
        const rank=pivots.length;
        let best=rank;
        for (let i=rank+1;i<3;i++) if(magnitude(rows[i][col])>magnitude(rows[best][col])) best=i;
        if (!rows[best] || magnitude(rows[best][col])<1e-4) continue;
        [rows[rank],rows[best]]=[rows[best],rows[rank]];
        const pivot=rows[rank][col];
        rows[rank]=rows[rank].map(x=>div(x,pivot));
        for(let i=0;i<3;i++) if(i!==rank) {
          const factor=rows[i][col];
          rows[i]=rows[i].map((x,j)=>sub(x,mul(factor,rows[rank][j])));
        }
        pivots.push(col);
      }
      const dimension=3-pivots.length;
      for(let col=0;col<3;col++) if(!pivots.includes(col)) {
        let vector=Array.from({length:3},()=>[0,0]);
        vector[col]=[1,0];
        pivots.forEach((pivot,i)=>{vector[pivot]=rows[i][col].map(x=>-x);});
        const anchor=vector.reduce((a,x,i)=>magnitude(x)>magnitude(vector[a])+1e-6?i:a,0);
        vector=vector.map(x=>div(x,vector[anchor]));
        let description;
        if (value[1]) description='回転面内の複素方向';
        else if(dimension===3) description=value[0]>0?'任意方向（基底）':'全方向が反転（基底）';
        else if(axial>0) description=value[0]>0?'回転軸方向':'軸に垂直（基底）';
        else if(dimension===2) description='鏡映面に平行（基底）';
        else description=sine<1e-4?'鏡映面の法線方向':'回転軸方向（反転）';
        result.push({value,vector,description});
      }
    }
    return result;
  }
  function complexNumber([real, imaginary]) {
    if(Math.abs(imaginary)<EPS) return number(real);
    const imaginaryText=(close(Math.abs(imaginary),1)?'':number(Math.abs(imaginary)))+'i';
    return (Math.abs(real)<EPS?'':number(real))+(imaginary<0?'−':Math.abs(real)<EPS?'':'+')+imaginaryText;
  }
  // An exact route for finite-order integral crystallographic matrices.
  // No decimal-to-radical matching: arithmetic stays in Q(sqrt(-d)), d=1 or 3.
  function exactEigenpairs(W) {
    if (!W || !W.every(row => row.every(x => Number.isSafeInteger(x) && Math.abs(x) <= 1000))) return null;
    const A = W.map(row => row.map(BigInt));
    const I = [[1n,0n,0n],[0n,1n,0n],[0n,0n,1n]];
    let power = I, finite = false;
    for (let n=1; n<=12; n++) {
      power = power.map(row => A[0].map((_,j) => row.reduce((s,x,k) => s+x*A[k][j],0n)));
      if (power.every((row,i) => row.every((x,j) => x===I[i][j]))) { finite=true; break; }
    }
    if (!finite) return null;
    const determinant=A[0][0]*(A[1][1]*A[2][2]-A[1][2]*A[2][1])
      - A[0][1]*(A[1][0]*A[2][2]-A[1][2]*A[2][0])
      + A[0][2]*(A[1][0]*A[2][1]-A[1][1]*A[2][0]);
    if (determinant!==1n && determinant!==-1n) return null;
    const tracePair=A[0][0]+A[1][1]+A[2][2]-determinant;
    if (tracePair < -2n || tracePair > 2n) return null;
    const d=tracePair===1n || tracePair===-1n ? 3n : 1n;
    const gcd=(a,b) => b ? gcd(b,a%b) : a<0n?-a:a;
    function q(n,den=1n) {
      if (den<0n) { n=-n; den=-den; }
      const g=gcd(n,den);
      return [n/g,den/g];
    }
    const plus=(a,b)=>q(a[0]*b[1]+b[0]*a[1],a[1]*b[1]);
    const neg=a=>[-a[0],a[1]];
    const times=(a,b)=>q(a[0]*b[0],a[1]*b[1]);
    const over=(a,b)=>q(a[0]*b[1],a[1]*b[0]);
    const z=(real,imaginary=q(0n))=>[real,imaginary];
    const sub=(a,b)=>[plus(a[0],neg(b[0])),plus(a[1],neg(b[1]))];
    const mul=(a,b)=>[plus(times(a[0],b[0]),neg(times(q(d),times(a[1],b[1])))),plus(times(a[0],b[1]),times(a[1],b[0]))];
    function div(a,b) {
      const norm=plus(times(b[0],b[0]),times(q(d),times(b[1],b[1])));
      return mul(a,[b[0],neg(b[1])]).map(x=>over(x,norm));
    }
    const zero=a=>a[0][0]===0n && a[1][0]===0n;
    const numeric=a=>[Number(a[0][0])/Number(a[0][1]),Number(a[1][0])/Number(a[1][1])*Math.sqrt(Number(d))];
    const rationalText=a=>a[1]===1n?String(a[0]):`${a[0]}/${a[1]}`;
    function text(a) {
      const real=a[0][0]===0n?'':rationalText(a[0]);
      if (a[1][0]===0n) return real || '0';
      const coefficient=q(a[1][0]<0n?-a[1][0]:a[1][0],a[1][1]);
      const numerator=(coefficient[0]===1n?'':String(coefficient[0]))+(d===1n?'':'√3');
      const imaginary=numerator+'i'+(coefficient[1]===1n?'':`/${coefficient[1]}`);
      return real+(a[1][0]<0n?'−':real?'+':'')+imaginary;
    }
    function polar(a) {
      if (a[1][0]===0n) return null;
      const realSquare=times(a[0],a[0]);
      const imaginarySquare=times(q(d),times(a[1],a[1]));
      const norm=plus(realSquare,imaginarySquare);
      let radicand=norm[0]*norm[1], outside=1n;
      // Extract square factors exactly; a remaining large radicand is still
      // an exact radical, even if it is not fully simplified.
      for(let factor=2n;factor<=1000n && factor*factor<=radicand;factor++) {
        while(radicand%(factor*factor)===0n) {
          radicand/=factor*factor;outside*=factor;
        }
      }
      const coefficient=q(outside,norm[1]);
      const radius=radicand===1n?rationalText(coefficient)
        :(coefficient[0]===1n?'':String(coefficient[0]))+`√${radicand}`+(coefficient[1]===1n?'':`/${coefficient[1]}`);
      const equal=(x,y)=>x[0]===y[0] && x[1]===y[1];
      let denominator=null;
      if(a[0][0]===0n) denominator=2n;
      else if(equal(realSquare,imaginarySquare)) denominator=4n;
      else if(equal(times(realSquare,q(3n)),imaginarySquare)) denominator=3n;
      else if(equal(realSquare,times(imaginarySquare,q(3n)))) denominator=6n;
      let exponent;
      if(denominator!==null) {
        const angle=q(a[0][0]<0n?denominator-1n:1n,denominator);
        exponent=(a[1][0]<0n?'−':'')+(angle[0]===1n?'':String(angle[0]))+'iπ'+(angle[1]===1n?'':`/${angle[1]}`);
      } else {
        const [real,imaginary]=numeric(a);
        exponent=Math.atan2(imaginary,real).toFixed(4).replace(/\.?0+$/,'')+'i';
      }
      return {radius,exponent};
    }
    const roots=[z(q(determinant))];
    if (tracePair===2n || tracePair===-2n) roots.push(z(q(tracePair/2n)));
    else {
      const coefficient=tracePair===0n?q(1n):q(1n,2n);
      roots.push(z(q(tracePair,2n),coefficient),z(q(tracePair,2n),neg(coefficient)));
    }
    const unique=[...new Map(roots.map(root=>[text(root),root])).values()];
    const result=[];
    for (const root of unique) {
      const rows=A.map((row,i)=>row.map((x,j)=>sub(z(q(x)),i===j?root:z(q(0n)))));
      const pivots=[];
      for(let col=0;col<3;col++) {
        const rank=pivots.length;
        const best=rows.findIndex((row,i)=>i>=rank && !zero(row[col]));
        if(best<0) continue;
        [rows[rank],rows[best]]=[rows[best],rows[rank]];
        const pivot=rows[rank][col];
        rows[rank]=rows[rank].map(x=>div(x,pivot));
        for(let i=0;i<3;i++) if(i!==rank) {
          const factor=rows[i][col];
          rows[i]=rows[i].map((x,j)=>sub(x,mul(factor,rows[rank][j])));
        }
        pivots.push(col);
      }
      for(let col=0;col<3;col++) if(!pivots.includes(col)) {
        let vector=Array.from({length:3},()=>z(q(0n)));
        vector[col]=z(q(1n));
        pivots.forEach((pivot,i)=>{vector[pivot]=rows[i][col].map(neg);});
        const anchor=vector.reduce((best,x,i)=>Math.hypot(...numeric(x))>Math.hypot(...numeric(vector[best]))+1e-6?i:best,0);
        vector=vector.map(x=>div(x,vector[anchor]));
        result.push({value:numeric(root),vector:vector.map(numeric),valueText:text(root),vectorText:vector.map(text),vectorPolar:vector.map(polar)});
      }
    }
    return result.length===3?result:null;
  }
  function eigenvalueExponent(value, exactText) {
    if (Math.abs(value[1]) < EPS) return null;
    const exact = {
      i: 'iπ/2', '−i': '−iπ/2',
      '1/2+√3i/2': 'iπ/3', '1/2−√3i/2': '−iπ/3',
      '-1/2+√3i/2': '2iπ/3', '-1/2−√3i/2': '−2iπ/3',
    };
    if (Object.hasOwn(exact, exactText)) return exact[exactText];
    // Do not infer an exact multiple of pi from a fitted decimal matrix.
    return Math.atan2(value[1], value[0]).toFixed(4).replace(/\.?0+$/, '') + 'i';
  }
  function complexPolar(value, exactPolar) {
    if (Math.abs(value[1])<EPS) return null;
    return exactPolar || {
      radius: Math.hypot(...value).toFixed(4).replace(/\.?0+$/,''),
      exponent: eigenvalueExponent(value, undefined),
    };
  }
  const api = {number, affine, compose, formula, coordinateExpressions, powers, eigenpairs, complexNumber, exactEigenpairs, eigenvalueExponent, complexPolar};
  root.SymmetryOperationMath = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);

/* MathML markup shared by the analysis panel and the quiz "行列で見る" details
   (the "Symmetry Math" face comes from browser_ui.css). Browser only. */
(function (root) {
  if (typeof document === "undefined") return;
  function mathNode(tag, ...children) {
    const node = document.createElementNS("http://www.w3.org/1998/Math/MathML", tag);
    for (const child of children) node.append(typeof child === "string" ? document.createTextNode(child) : child);
    return node;
  }

  // Parse only the numeric/linear expressions produced by our existing formatter.
  // The displayed values are unchanged; MathML supplies fraction and operator layout.
  function mathExpression(text, inlineFractions = false) {
    const tokens = String(text).match(/\d+(?:\.\d+)?(?:e[+−-]?\d+)?|[^\s]/gi) || [];
    let index = 0;
    function atom() {
      const token = tokens[index++];
      if (token === "-" || token === "−" || token === "+") {
        const sign = mathNode("mo", token === "-" ? "−" : token);
        if (token !== "+") sign.setAttribute("class", "mathml-unary-minus");
        return mathNode("mrow", sign, atom());
      }
      if (token === "√") return mathNode("msqrt", atom());
      if (token === "(") {
        const value = sum();
        if (tokens[index] === ")") index++;
        return mathNode("mrow", mathNode("mo", "("), value, mathNode("mo", ")"));
      }
      if (token === undefined) return mathNode("mrow");
      if (/^\d/.test(token)) return mathNode("mn", token);
      if (/^[a-zλπ]$/i.test(token)) {
        const variable = mathNode("mi", token);
        if (tokens[index] === "′") {
          index++;
          // The prime glyph already sits above the baseline; do not shrink or raise it again.
          const prime = mathNode("mo", "′");
          prime.setAttribute("class", "operation-math-prime");
          prime.setAttribute("lspace", "0");
          prime.setAttribute("rspace", "0");
          prime.setAttribute("stretchy", "false");
          return mathNode("mrow", variable, prime);
        }
        return variable;
      }
      return mathNode("mo", token);
    }
    function product() {
      let value = atom();
      while (index < tokens.length && !["+", "-", "−", ")", ","].includes(tokens[index])) {
        const token = tokens[index];
        if (token === "/") {
          index++;
          const denominator = atom();
          if (inlineFractions) {
            const slash = mathNode("mo", "/");
            slash.setAttribute("lspace", "0");
            slash.setAttribute("rspace", "0");
            slash.setAttribute("stretchy", "false");
            value = mathNode("mrow", value, slash, denominator);
          } else value = mathNode("mfrac", value, denominator);
        }
        else if (token === "·" || token === "*") { index++; value = mathNode("mrow", value, mathNode("mo", "·"), atom()); }
        else value = mathNode("mrow", value, mathNode("mo", "⁢"), atom());
      }
      return value;
    }
    function sum() {
      const row = mathNode("mrow", product());
      while (index < tokens.length && ["+", "-", "−"].includes(tokens[index])) {
        const sign = tokens[index++];
        row.append(mathNode("mo", sign === "-" ? "−" : sign), product());
      }
      return row;
    }
    return sum();
  }

  function mathMatrix(values, formatter = String, label = "", inlineFractions = false) {
    const table = mathNode("mtable");
    table.setAttribute("columnalign", "center");
    table.setAttribute("columnspacing", "0.7em");
    table.setAttribute("rowspacing", "0.35em");
    for (const valuesRow of values) {
      const row = mathNode("mtr");
      row.setAttribute("class", "mathml-matrix-row");
      for (const value of valuesRow) {
        const content = formatter(value);
        const padding = mathNode("mpadded", typeof content === "string" ? mathExpression(content, inlineFractions) : content);
        padding.setAttribute("height", "1.2em");
        padding.setAttribute("depth", "0.3em");
        const cell = mathNode("mtd", padding);
        if (typeof content === "string") cell.setAttribute("data-value", content);
        row.append(cell);
      }
      table.append(row);
    }
    const matrix = mathNode("mrow", mathNode("mo", "("), table, mathNode("mo", ")"));
    matrix.setAttribute("class", "mathml-matrix-block");
    matrix.setAttribute("data-label", label);
    return matrix;
  }

  // --- 「行列の読み方」 window, shared by the quiz (行列で見る) and analysis (行列表示) ---
  const tm = {
    mi: text => mathNode("mi", text),
    mo: text => mathNode("mo", text),
    expr: text => mathExpression(text, true),
    mat: rows => mathMatrix(rows, value => value, "", true),
    row: (...nodes) => mathNode("mrow", ...nodes),
  };
  const mathHtml = node => mathNode("math", node).outerHTML;

  // Vectors x, x′, t in bold italic (Latin Modern Math has the math-alphanumeric glyphs);
  // symbols inside sentences and labels use the same math font as the formulas.
  function vectorSymbol(letter, prime = false) {
    const node = tm.mi({x: "\u{1D499}", t: "\u{1D495}"}[letter]);
    if (!prime) return node;
    const mark = tm.mo("′");
    mark.setAttribute("lspace", "0");
    mark.setAttribute("rspace", "0");
    return tm.row(node, mark);
  }

  function inlineMath(node) {
    const element = mathNode("math", node);
    element.setAttribute("class", "puzzle-inline-math");
    return element.outerHTML;
  }

  function matrixHelpDialog() {
    let dialog = document.getElementById("puzzle-matrix-dialog");
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.id = "puzzle-matrix-dialog";
    dialog.className = "puzzle-matrix-dialog";
    dialog.setAttribute("aria-labelledby", "puzzle-matrix-dialog-title");
    // General form, then 4₁ along c on (1/2, 1/2, 1/2), then the augmented 4×4 form and
    // 4₁·4₁ = 2₁. The augmented-matrix wording follows International Tables Vol. A, ch. 1.2.
    const numbers = rows => tm.mat(rows.map(row => row.map(tm.expr)));
    const column = values => tm.mat(values.map(value => [tm.expr(value)]));
    const W = [["0", "-1", "0"], ["1", "0", "0"], ["0", "0", "1"]];
    const screw = [[...W[0], "0"], [...W[1], "0"], [...W[2], "1/4"], ["0", "0", "0", "1"]];
    const twofold = [["-1", "0", "0", "0"], ["0", "-1", "0", "0"], ["0", "0", "1", "1/2"], ["0", "0", "0", "1"]];
    const vector = vectorSymbol;
    const sym = {x: inlineMath(vector("x")), xp: inlineMath(vector("x", true)), t: inlineMath(vector("t")), W: inlineMath(tm.mi("W"))};
    // (W t; 0 1); the bold 0 is the zero row (0 0 0).
    const block = tm.mat([[tm.mi("W"), vector("t")], [mathNode("mn", "\u{1D7CE}"), tm.expr("1")]]);
    const math = node => `<div class="puzzle-matrix-dialog-math">${mathHtml(node)}</div>`;
    const piece = (label, node) => `<span class="puzzle-equation-label">${label}</span>`
      + `<span class="puzzle-equation-math">${mathHtml(node)}</span>`;
    const general = node => `<div class="puzzle-matrix-dialog-math puzzle-matrix-dialog-general">${mathHtml(node)}</div>`;
    dialog.innerHTML = `<div class="structure-dialog-header"><h2 id="puzzle-matrix-dialog-title">行列の読み方</h2>`
      + `<button type="button" class="secondary" aria-label="閉じる" autofocus>×</button></div>`
      + `<p>対称操作によって、位置ベクトル ${sym.x} の点は ${sym.xp} に移ります。このとき ${sym.xp} は次のように表されます。ここで ${sym.W} は回転や鏡映を表す3行3列の行列、${sym.t} は並進ベクトルです。</p>`
      + general(tm.row(vector("x", true), tm.mo("="), tm.mi("W"), vector("x"), tm.mo("+"), vector("t")))
      + `<p>例：c軸に平行な4回らせん軸（4<sub>1</sub>）では、${sym.W} は c軸まわりの90°回転、${sym.t} = (0, 0, 1/4) です。点 (1/2, 1/2, 1/2) は次の点に移ります。</p>`
      // Labels above each term, as in the quiz's 行列で見る; ※ on 並進 opens the note.
      + `<div class="puzzle-equation puzzle-matrix-dialog-equation">`
      + piece(`操作後 ${sym.xp}`, column(["x′", "y′", "z′"])) + piece("", tm.mo("="))
      + piece(`4回回転 ${sym.W}`, numbers(W)) + piece(`操作前 ${sym.x}`, column(["1/2", "1/2", "1/2"]))
      + piece("", tm.mo("+"))
      + piece(`<span class="puzzle-note-mark" tabindex="0" aria-describedby="puzzle-matrix-dialog-note">並進 ${sym.t}<span aria-hidden="true">※</span></span>`,
        column(["0", "0", "1/4"]))
      + piece("", tm.mo("=")) + piece("", column(["-1/2", "1/2", "3/4"])) + `</div>`
      + `<p>${sym.W} と ${sym.t} は、1つの4行4列の行列（拡大行列）にまとめられます。このとき、位置ベクトルにも4番目の成分として1を加えます。</p>`
      + `<div class="puzzle-matrix-dialog-math puzzle-matrix-dialog-block">${mathHtml(tm.row(tm.mat([[vector("x", true)], [tm.expr("1")]]), tm.mo("="), block, tm.mat([[vector("x")], [tm.expr("1")]])))}</div>`
      + `<p>拡大行列を使うと、2つの操作を続けて行う操作は、それぞれの拡大行列の積で表されます。たとえば 4<sub>1</sub> を2回続けると、c軸に平行な2回らせん軸（2<sub>1</sub>）の操作になります。</p>`
      + math(tm.row(numbers(screw), numbers(screw), tm.mo("="), numbers(twofold)))
      + `<div id="puzzle-matrix-dialog-note" class="puzzle-note-tip" role="tooltip" hidden>`
      + `${sym.t} は、次の2つを足したものです。<ul>`
      + `<li>らせん・映進で、軸や面に沿って進む量（問題文や答えの「並進」）</li>`
      + `<li>軸や面が原点を通らないときに出る、位置のずれ</li></ul>`
      + `そのため、回転や鏡映でも、軸や面が原点を通らなければ ${sym.t} は0になりません。</div>`;
    // The note sits inside the dialog (top layer) and is placed next to the ※ mark.
    const note = dialog.querySelector("#puzzle-matrix-dialog-note");
    const showNote = event => {
      const mark = event.target.closest?.(".puzzle-note-mark");
      if (!mark) return;
      note.hidden = false;
      const rect = mark.getBoundingClientRect();
      note.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - note.offsetWidth - 12))}px`;
      note.style.top = `${rect.top - note.offsetHeight - 6 >= 12 ? rect.top - note.offsetHeight - 6 : rect.bottom + 6}px`;
    };
    const hideNote = event => {
      if (event?.relatedTarget && event.target.closest?.(".puzzle-note-mark")?.contains(event.relatedTarget)) return;
      note.hidden = true;
    };
    dialog.addEventListener("mouseover", showNote);
    dialog.addEventListener("focusin", showNote);
    dialog.addEventListener("mouseout", hideNote);
    dialog.addEventListener("focusout", () => hideNote());
    dialog.addEventListener("scroll", () => hideNote(), true);
    dialog.addEventListener("close", () => hideNote());
    dialog.querySelector("button").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    document.body.append(dialog);
    return dialog;
  }

    function openMatrixHelp() {
      matrixHelpDialog().showModal();
    }
  root.SymmetryMathMarkup = {mathNode, mathExpression, mathMatrix, vectorSymbol, inlineMath, openMatrixHelp};
})(globalThis);
