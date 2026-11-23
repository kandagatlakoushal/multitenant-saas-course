/*
 * Shard calculator: reproduces Java's String.hashCode() and compares
 * Math.floorMod(h, N) with Math.abs(h) % N, and N with N+1.
 * Usage: <div class="tool shard-calc" data-tenants="acme,globex" data-n="4"></div>
 */
(function () {
  function javaHash(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; // UTF-16 units, like Java
    return h;
  }
  function floorMod(h, n) { return ((h % n) + n) % n; }
  function absMod(h, n) {                       // Java: Math.abs(MIN_VALUE) == MIN_VALUE; % truncates
    var a = h === -2147483648 ? h : Math.abs(h);
    return a % n;
  }
  function el(tag, text) { var e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; }

  document.querySelectorAll(".shard-calc").forEach(function (host) {
    host.innerHTML = "";
    host.appendChild(el("strong", "Shard calculator (Java String.hashCode)"));
    var l1 = el("label", "Tenant IDs, comma-separated"); var tIn = el("input"); tIn.value = host.dataset.tenants || "acme,globex";
    var l2 = el("label", "Shard count N"); var nIn = el("input"); nIn.type = "number"; nIn.min = "1"; nIn.value = host.dataset.n || "4";
    var go = el("button", "Compute"); go.type = "button"; go.style.marginTop = ".6rem";
    var out = el("div");
    [l1, tIn, l2, nIn, go, out].forEach(function (x) { host.appendChild(x); });

    function run() {
      var n = parseInt(nIn.value, 10);
      out.innerHTML = "";
      if (!(n >= 1)) { out.textContent = "N must be 1 or more."; return; }
      var t = el("table"); var head = el("tr");
      ["tenantId", "hashCode()", "floorMod(h," + n + ")", "abs(h)%" + n, "floorMod(h," + (n + 1) + ")", "moves?"]
        .forEach(function (c) { head.appendChild(el("th", c)); });
      t.appendChild(head);
      var moved = 0, total = 0;
      tIn.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean).forEach(function (id) {
        var h = javaHash(id), a = floorMod(h, n), b = absMod(h, n), c = floorMod(h, n + 1);
        total++; if (a !== c) moved++;
        var tr = el("tr");
        tr.appendChild(el("td", id)); tr.appendChild(el("td", String(h))); tr.appendChild(el("td", String(a)));
        var bd = el("td", String(b)); if (b !== a) { bd.className = "flag"; bd.title = "disagrees with floorMod"; } tr.appendChild(bd);
        tr.appendChild(el("td", String(c))); tr.appendChild(el("td", a !== c ? "yes" : "no"));
        t.appendChild(tr);
      });
      out.appendChild(t);
      out.appendChild(el("p", moved + " of " + total + " tenants move when N goes from " + n + " to " + (n + 1) +
        ". Red cells: abs(h)%N disagrees with floorMod (or is negative)."));
    }
    go.addEventListener("click", run);
    run();
  });
})();
