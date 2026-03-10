(function () {
  "use strict";

  const D = window.MapDiffDefaults;

  // --- State ---
  let featureToggles = {};
  let heroTagOverrides = {};

  function getDefaultToggles() {
    const toggles = {};
    for (const [key, cfg] of Object.entries(D.FEATURE_TOGGLES)) {
      toggles[key] = cfg.default;
    }
    return toggles;
  }

  function getEffectiveTags(heroId) {
    return heroTagOverrides[heroId] || D.HERO_TAGS[heroId] || [];
  }

  // --- Storage ---

  async function loadSettings() {
    const result = await window.browserStorage.sync.get(["featureToggles", "heroTagOverrides"]);
    featureToggles = { ...getDefaultToggles(), ...(result.featureToggles || {}) };
    heroTagOverrides = result.heroTagOverrides || {};
  }

  function saveToggles() {
    window.browserStorage.sync.set({ featureToggles });
  }

  function saveTagOverrides() {
    window.browserStorage.sync.set({ heroTagOverrides });
  }

  // --- Render: Features tab ---

  function renderFeatures() {
    const panel = document.getElementById("panel-features");
    panel.innerHTML = "";

    for (const [key, cfg] of Object.entries(D.FEATURE_TOGGLES)) {
      const row = document.createElement("div");
      row.className = "toggle-row";

      const label = document.createElement("span");
      label.className = "toggle-label";
      label.textContent = cfg.label;
      row.appendChild(label);

      const sw = document.createElement("label");
      sw.className = "toggle-switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = featureToggles[key] !== false;
      input.addEventListener("change", () => {
        featureToggles[key] = input.checked;
        saveToggles();
      });
      const slider = document.createElement("span");
      slider.className = "toggle-slider";
      sw.appendChild(input);
      sw.appendChild(slider);
      row.appendChild(sw);

      panel.appendChild(row);
    }
  }

  // --- Render: Hero Tags tab ---

  function renderTagLegend() {
    const legend = document.getElementById("tag-legend");
    legend.innerHTML = "";
    for (const [tag, label] of Object.entries(D.TRAIT_LABELS)) {
      const chip = document.createElement("span");
      chip.className = "tag-legend-chip";
      chip.textContent = label;
      chip.dataset.tag = tag;
      legend.appendChild(chip);
    }
  }

  function renderHeroGrid() {
    const grid = document.getElementById("hero-grid");
    grid.innerHTML = "";

    const traitKeys = Object.keys(D.TRAIT_LABELS);

    for (const [role, heroes] of Object.entries(D.HERO_ROLES)) {
      const section = document.createElement("div");
      section.className = "role-section";

      const header = document.createElement("div");
      header.className = "role-header";
      header.textContent = role;
      section.appendChild(header);

      for (const heroId of heroes) {
        const row = document.createElement("div");
        row.className = "hero-row";

        const name = document.createElement("span");
        name.className = "hero-name";
        name.textContent = D.HERO_NAMES[heroId] || heroId;
        row.appendChild(name);

        const chips = document.createElement("div");
        chips.className = "hero-chips";

        const activeTags = getEffectiveTags(heroId);

        for (const tag of traitKeys) {
          const chip = document.createElement("button");
          chip.className = "tag-chip";
          chip.textContent = D.TRAIT_LABELS[tag];
          if (activeTags.includes(tag)) chip.classList.add("active");

          chip.addEventListener("click", () => {
            const current = getEffectiveTags(heroId);
            let updated;
            if (current.includes(tag)) {
              updated = current.filter((t) => t !== tag);
            } else {
              updated = [...current, tag];
            }

            // Check if updated matches defaults — if so, remove override
            const defaults = D.HERO_TAGS[heroId] || [];
            const same = updated.length === defaults.length &&
              updated.every((t) => defaults.includes(t)) &&
              defaults.every((t) => updated.includes(t));

            if (same) {
              delete heroTagOverrides[heroId];
            } else {
              heroTagOverrides[heroId] = updated;
            }

            chip.classList.toggle("active");
            saveTagOverrides();
          });

          chips.appendChild(chip);
        }

        row.appendChild(chips);
        section.appendChild(row);
      }

      grid.appendChild(section);
    }
  }

  // --- Tabs ---

  function initTabs() {
    const tabs = document.querySelectorAll(".tab");
    const panels = document.querySelectorAll(".panel");

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        tabs.forEach((t) => t.classList.remove("active"));
        panels.forEach((p) => p.classList.add("hidden"));
        tab.classList.add("active");
        document.getElementById("panel-" + tab.dataset.tab).classList.remove("hidden");
      });
    });
  }

  // --- Reset ---

  function initReset() {
    document.getElementById("reset-tags").addEventListener("click", () => {
      heroTagOverrides = {};
      window.browserStorage.sync.remove("heroTagOverrides");
      renderHeroGrid();
    });
  }

  // --- Init ---

  async function init() {
    await loadSettings();
    initTabs();
    renderFeatures();
    renderTagLegend();
    renderHeroGrid();
    initReset();
  }

  init();
})();
