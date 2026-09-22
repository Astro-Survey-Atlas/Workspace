/*
 * Copyright 2026 Astro Survey Atlas contributors.
 * Licensed under the Apache License, Version 2.0.
 */

(function () {
  "use strict";

  const STORAGE_KEY = "workspace-docs-theme";

  function readTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
    } catch (error) {
      return "light";
    }
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
      // Visual preference still applies when storage is unavailable.
    }
  }

  function updateAsset(element, dark) {
    const attribute = element.tagName === "LINK" ? "href" : "src";
    element.setAttribute(attribute, dark ? "assets/asa-mark-dark.svg" : "assets/asa-mark.svg");
  }

  function applyTheme(theme, persist) {
    const value = theme === "dark" ? "dark" : "light";
    const dark = value === "dark";
    document.documentElement.dataset.theme = value;
    if (persist !== false) {
      saveTheme(value);
    }
    document.querySelectorAll("[data-theme-label]").forEach((label) => {
      label.textContent = dark ? "Light mode" : "Dark mode";
    });
    const button = document.getElementById("theme-toggle");
    if (button) {
      button.hidden = false;
      button.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    }
    document.querySelectorAll(".brand-logo, link[rel='icon']").forEach((element) => updateAsset(element, dark));
  }

  applyTheme(readTheme(), false);
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
})();
