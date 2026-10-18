// Add the repository name beside the native footer GitHub icon.
(() => {
  window.__rootsetFooterCleanup?.();
  let frame;
  const observer = new window.MutationObserver(schedule);
  function schedule() {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      observer.disconnect();
      enhanceFooterRepository();
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href"],
      });
    });
  }
  function enhanceFooterRepository() {
    for (const link of document.querySelectorAll(
      '#footer a[href^="https://github.com/"]:has(> svg):has(> .sr-only)',
    )) {
      const repository = new URL(link.href).pathname.split("/").filter(Boolean);
      if (repository.length !== 2) continue;
      let label = link.querySelector("[data-oss-repository]");
      if (!label) {
        label = document.createElement("span");
        label.dataset.ossRepository = "";
        link.append(label);
      }
      const name = repository.join("/");
      if (label.textContent !== name) label.textContent = name;
    }
  }

  window.__rootsetFooterCleanup = () => {
    observer.disconnect();
    window.cancelAnimationFrame(frame);
  };
  schedule();
})();
