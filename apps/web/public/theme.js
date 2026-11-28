// Applies the saved colour theme before the page paints, so a light theme never flashes dark.
// The app takes over once it loads (apps/web/src/theme.ts); keep the two in step.
/* global document, localStorage, window */
(function () {
  var choice = "dark";
  try {
    choice = localStorage.getItem("pedirr.theme") || "dark";
  } catch {
    // Storage may be blocked; the default applies.
  }
  var light =
    choice === "light" ||
    (choice === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
  var theme = light ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute("content", light ? "#f6f4ef" : "#101014");
  }
})();
