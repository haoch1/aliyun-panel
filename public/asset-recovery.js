(() => {
  function show() {
    const notice = document.getElementById("asset-recovery");
    if (!notice) {
      document.addEventListener("DOMContentLoaded", show, { once: true });
      return;
    }
    notice.hidden = false;
    notice.querySelector("button").onclick = () => location.reload();
  }
  window.addEventListener("vite:preloadError", show);
  window.addEventListener(
    "error",
    (event) => {
      const node = event.target;
      const url =
        node instanceof HTMLScriptElement
          ? node.src
          : node instanceof HTMLLinkElement && node.rel === "stylesheet"
            ? node.href
            : "";
      if (url && new URL(url).pathname.startsWith("/assets/")) show();
    },
    true,
  );
})();
