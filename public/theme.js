(function () {
  var theme = "system";
  try {
    theme = localStorage.getItem("aliyun-panel:theme:v1") || "system";
  } catch (e) {}
  var dark =
    theme === "dark" ||
    (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", dark ? "#0a0a0b" : "#fafafa");
})();
