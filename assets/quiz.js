/*
 * Quiz widget, shared by every lesson.
 * Usage: <script type="application/json" class="quiz-data">[{"q": "...", "options": ["..", ".."], "answer": 0, "why": "..."}]</script>
 * The quiz renders right after the script tag. Feedback is immediate; "Reset" allows a spaced re-try.
 */
(function () {
  function render(script, host) {
    var data = JSON.parse(script.textContent);
    host.innerHTML = "";
    var score = 0, answered = 0;
    var bar = document.createElement("div");
    bar.className = "quiz-bar";
    var tally = document.createElement("span");
    tally.className = "quiz-tally";
    tally.textContent = "0 / " + data.length + " answered";
    var reset = document.createElement("button");
    reset.type = "button";
    reset.className = "reset";
    reset.textContent = "Reset quiz";
    reset.addEventListener("click", function () { render(script, host); });

    data.forEach(function (item, i) {
      var box = document.createElement("fieldset");
      box.className = "q";
      var legend = document.createElement("legend");
      legend.textContent = (i + 1) + ". " + item.q;
      box.appendChild(legend);
      var fb = document.createElement("p");
      fb.className = "feedback";
      fb.hidden = true;
      fb.setAttribute("aria-live", "polite");

      item.options.forEach(function (opt, oi) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "opt";
        b.textContent = String.fromCharCode(65 + oi) + ") " + opt;
        b.addEventListener("click", function () {
          if (box.dataset.done) return;
          box.dataset.done = "1";
          answered++;
          var ok = oi === item.answer;
          if (ok) score++;
          box.querySelectorAll("button.opt").forEach(function (x, xi) {
            x.disabled = true;
            if (xi === item.answer) x.classList.add("right");
          });
          if (!ok) b.classList.add("wrong");
          fb.hidden = false;
          fb.innerHTML = (ok ? "<strong>Correct.</strong> " : "<strong>Not quite.</strong> ") + item.why;
          tally.textContent = score + " / " + answered + " correct" +
            (answered === data.length ? " (all answered)" : "");
        });
        box.appendChild(b);
      });
      box.appendChild(fb);
      host.appendChild(box);
    });
    bar.appendChild(tally);
    bar.appendChild(reset);
    host.appendChild(bar);
  }

  document.querySelectorAll("script.quiz-data").forEach(function (s) {
    var host = document.createElement("div");
    host.className = "quiz";
    s.parentNode.insertBefore(host, s.nextSibling);
    try { render(s, host); } catch (e) { host.textContent = "Quiz failed to load: " + e.message; }
  });
})();
