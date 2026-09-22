/*
 * Copyright 2026 Astro Survey Atlas contributors.
 * Licensed under the Apache License, Version 2.0.
 */

(function () {
  "use strict";

  const sections = Array.from(document.querySelectorAll("main .doc-section, main .subsection[id]"));
  const links = Array.from(document.querySelectorAll(".sidebar-list a[href^='#']"));

  function setActive(id) {
    links.forEach((link) => {
      const item = link.closest(".sidebar-item");
      if (!item) return;
      item.classList.toggle("active", link.getAttribute("href") === `#${id}`);
    });
  }

  function currentSection() {
    let current = sections[0]?.id;
    const offset = 120;
    for (const section of sections) {
      if (section.getBoundingClientRect().top - offset <= 0) {
        current = section.id;
      }
    }
    return current;
  }

  if (sections.length && links.length) {
    setActive(currentSection());
    window.addEventListener("scroll", () => setActive(currentSection()), { passive: true });
  }
})();
