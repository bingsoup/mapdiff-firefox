(function () {
  "use strict";

  const MAP_SELECT_ID = "filter-map-select";
  const TABLE_SELECTOR = "blz-data-table.herostats-data-table";
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  // Runtime settings (loaded from storage, falling back to defaults)
  const D = window.MapDiffDefaults;
  let HERO_TAGS = { ...D.HERO_TAGS };
  let TRAIT_LABELS = D.TRAIT_LABELS;
  let featureToggles = {};

  function getDefaultToggles() {
    const toggles = {};
    for (const [key, cfg] of Object.entries(D.FEATURE_TOGGLES)) {
      toggles[key] = cfg.default;
    }
    return toggles;
  }

  async function loadSettings() {
    try {
      const result = await window.browserStorage.sync.get(["featureToggles", "heroTagOverrides"]);
      featureToggles = { ...getDefaultToggles(), ...(result.featureToggles || {}) };
      const overrides = result.heroTagOverrides || {};
      HERO_TAGS = { ...D.HERO_TAGS };
      for (const [heroId, tags] of Object.entries(overrides)) {
        HERO_TAGS[heroId] = tags;
      }
    } catch {
      featureToggles = getDefaultToggles();
      HERO_TAGS = { ...D.HERO_TAGS };
    }
  }

  function buildURL(mapValue) {
    const url = new URL(window.location.href);
    url.searchParams.set("map", mapValue);
    return url.toString();
  }

  function getFilterKey() {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.searchParams);
    params.delete("map");
    return params.toString();
  }

  function parseTableData(table) {
    const raw = table.getAttribute("allrows");
    if (!raw) return null;
    try {
      const rows = JSON.parse(raw);
      const data = {};
      for (const row of rows) {
        data[row.id] = {
          name: row.cells.name,
          winrate: row.cells.winrate,
          pickrate: row.cells.pickrate,
        };
      }
      return data;
    } catch {
      return null;
    }
  }

  async function fetchMapData(mapValue) {
    try {
      const url = buildURL(mapValue);
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`[MapDiff] fetch failed for map "${mapValue}": ${resp.status}`);
        return null;
      }
      const html = await resp.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const table = doc.querySelector(TABLE_SELECTOR);
      if (!table) return null;
      return parseTableData(table);
    } catch (err) {
      console.warn(`[MapDiff] fetch error for map "${mapValue}":`, err);
      return null;
    }
  }

  const cache = {};

  function isCacheValid(entry) {
    return entry && (Date.now() - entry.ts) < CACHE_TTL_MS;
  }

  async function fetchMapDataCached(mapValue) {
    const key = getFilterKey();
    if (!cache[key]) cache[key] = {};
    const entry = cache[key][mapValue];
    if (entry && isCacheValid(entry)) return entry.data;
    const data = await fetchMapData(mapValue);
    if (data) cache[key][mapValue] = { data, ts: Date.now() };
    return data;
  }

  function getMapSlugs() {
    const select = document.getElementById(MAP_SELECT_ID);
    if (!select) return [];
    const seen = new Set();
    return [...select.options]
      .map((o) => ({ value: o.value, text: o.text }))
      .filter((o) => o.value !== "all-maps" && !seen.has(o.value) && seen.add(o.value));
  }

  function getMapName(slug) {
    const select = document.getElementById(MAP_SELECT_ID);
    if (!select) return slug;
    const opt = [...select.options].find((o) => o.value === slug);
    return opt ? opt.text : slug;
  }

  function formatDiff(diff) {
    const sign = diff >= 0 ? "+" : "";
    return sign + diff.toFixed(1);
  }

  // Select a map via the dropdown (triggers the page's own change handler)
  function selectMap(slug) {
    const select = document.getElementById(MAP_SELECT_ID);
    if (!select) return;
    select.value = slug;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Normalize hero ID to a key for HERO_TAGS lookup
  function normalizeHeroId(heroId) {
    return heroId.replace(/[^a-z0-9]/gi, "").toLowerCase();
  }

  // Store per-hero diffs for sort functionality
  let heroDiffs = {};
  let heroPickDiffs = {};

  // ── Cleanup ──

  function cleanup() {
    document
      .querySelectorAll(
        ".mapdiff-badge, .mapdiff-maps, " +
        ".mapdiff-loading, .mapdiff-avg-marker, " +
        ".mapdiff-outlier-bar, .mapdiff-error"
      )
      .forEach((el) => el.remove());
    // Also clean up sort UI from shadow DOM
    const table = document.querySelector(TABLE_SELECTOR);
    if (table?.shadowRoot) {
      table.shadowRoot.querySelectorAll(".mapdiff-sort-btn, .mapdiff-shadow-styles").forEach((el) => el.remove());
    }
    heroDiffs = {};
    heroPickDiffs = {};
    sortKey = null;
    sortDir = "desc";
  }

  // ── Badge: plain text after a percentage ──


  function injectBadge(heroId, type, diff, allMapsValue, pickrate) {
    const valEl = document.getElementById(`${heroId}-${type}-value`);
    if (!valEl) return;
    const parent = valEl.parentElement;
    if (!parent) return;
    const existing = parent.querySelector(`.mapdiff-badge[data-type="${type}"]`);
    if (existing) existing.remove();

    const badge = document.createElement("span");
    badge.className = "mapdiff-badge";
    badge.dataset.type = type;
    if (diff > 0.05) badge.classList.add("positive");
    else if (diff < -0.05) badge.classList.add("negative");
    else badge.classList.add("neutral");
    badge.textContent = formatDiff(diff);

    // Tooltip with context
    const currentVal = (allMapsValue + diff).toFixed(1);
    const avgVal = allMapsValue.toFixed(1);
    const label = type === "winrate" ? "win rate" : "pick rate";
    badge.title = `${currentVal}% ${label} on this map vs ${avgVal}% average (all maps)`;

    valEl.after(badge);
  }

  // ── Map Outlier Bar ──

  function injectOutlierBar(currentData, allMapsData, currentMap) {
    const existing = document.querySelector(".mapdiff-outlier-bar");
    if (existing) existing.remove();

    const table = document.querySelector(TABLE_SELECTOR);
    if (!table) return;

    // Compute diffs with visual data
    const diffs = [];
    for (const [heroId, cur] of Object.entries(currentData)) {
      const avg = allMapsData[heroId];
      if (cur?.winrate == null || avg?.winrate == null) continue;
      const diff = cur.winrate - avg.winrate;
      const pickrate = cur.pickrate ?? 0;
      const visuals = getHeroVisuals(heroId);
      diffs.push({
        heroId, name: cur.name, diff, pickrate,
        role: visuals?.role || "damage",
        portrait: visuals?.portrait || "",
        color: visuals?.color || "#888",
        roleIcon: visuals?.roleIcon || "",
      });
    }

    if (diffs.length === 0) return;

    // Group by role
    const byRole = { tank: [], damage: [], support: [] };
    for (const d of diffs) {
      if (byRole[d.role]) byRole[d.role].push(d);
    }

    // Sort each role by diff
    for (const role of Object.keys(byRole)) {
      byRole[role].sort((a, b) => b.diff - a.diff);
    }

    // Trait analysis
    const traits = analyzeMapTraits(diffs);

    // Ban list: top heroes by diff, minimum 3 shown, max 2 per role
    const allSorted = [...diffs].sort((a, b) => b.diff - a.diff);
    const banCandidates = [];
    const banRoleCounts = { tank: 0, damage: 0, support: 0 };
    for (const d of allSorted) {
      if (banCandidates.length >= 3 && d.diff <= 1) break;
      if (banRoleCounts[d.role] >= 2) continue;
      banRoleCounts[d.role]++;
      banCandidates.push(d);
      if (banCandidates.length >= 6) break;
    }

    const mapName = getMapName(currentMap);

    // Role display config
    const ROLE_CONFIG = {
      tank: { label: "TANK" },
      damage: { label: "DAMAGE" },
      support: { label: "SUPPORT" },
    };

    // Build DOM
    const bar = document.createElement("div");
    bar.className = "mapdiff-outlier-bar";

    // -- Header
    const header = document.createElement("div");
    header.className = "mapdiff-ob-header";

    const title = document.createElement("div");
    title.className = "mapdiff-ob-title";
    title.textContent = `Map Diff \u2014 ${mapName}`;
    header.appendChild(title);

    if (traits.favors.length > 0 || traits.punishes.length > 0) {
      const traitsEl = document.createElement("div");
      traitsEl.className = "mapdiff-ob-traits";
      if (traits.favors.length > 0) {
        const fSpan = document.createElement("span");
        fSpan.className = "mapdiff-ob-traits-group";
        fSpan.innerHTML = `<span class="mapdiff-ob-traits-label">Favors:</span> ` +
          traits.favors.map((t) =>
            `<span class="mapdiff-ob-trait">${t.label} <span class="mapdiff-ob-trait-val best">${formatDiff(t.avg)}</span></span>`
          ).join(`<span class="mapdiff-ob-trait-sep">,</span> `);
        traitsEl.appendChild(fSpan);
      }
      if (traits.favors.length > 0 && traits.punishes.length > 0) {
        const sep = document.createElement("span");
        sep.className = "mapdiff-ob-traits-divider";
        sep.textContent = "\u00b7";
        traitsEl.appendChild(sep);
      }
      if (traits.punishes.length > 0) {
        const pSpan = document.createElement("span");
        pSpan.className = "mapdiff-ob-traits-group";
        pSpan.innerHTML = `<span class="mapdiff-ob-traits-label">Punishes:</span> ` +
          traits.punishes.map((t) =>
            `<span class="mapdiff-ob-trait">${t.label} <span class="mapdiff-ob-trait-val worst">${formatDiff(t.avg)}</span></span>`
          ).join(`<span class="mapdiff-ob-trait-sep">,</span> `);
        traitsEl.appendChild(pSpan);
      }
      header.appendChild(traitsEl);
    }
    bar.appendChild(header);

    // -- Role columns
    const rolesContainer = document.createElement("div");
    rolesContainer.className = "mapdiff-ob-roles";

    for (const [role, config] of Object.entries(ROLE_CONFIG)) {
      const heroes = byRole[role] || [];
      if (heroes.length === 0) continue;

      const col = document.createElement("div");
      col.className = "mapdiff-ob-role-col";

      // Role header with icon
      const roleHeader = document.createElement("div");
      roleHeader.className = "mapdiff-ob-role-header";
      const sampleIcon = heroes[0]?.roleIcon;
      if (sampleIcon) {
        const icon = document.createElement("img");
        icon.className = "mapdiff-ob-role-icon";
        icon.src = sampleIcon;
        icon.alt = config.label;
        roleHeader.appendChild(icon);
      }
      const roleLabel = document.createElement("span");
      roleLabel.textContent = config.label;
      roleHeader.appendChild(roleLabel);
      col.appendChild(roleHeader);

      // Winners (top 3)
      const winners = heroes.slice(0, 3);
      const winnersLabel = document.createElement("div");
      winnersLabel.className = "mapdiff-ob-section-label best";
      winnersLabel.textContent = "Winners";
      col.appendChild(winnersLabel);
      const winnersRow = document.createElement("div");
      winnersRow.className = "mapdiff-ob-winners";
      for (const w of winners) {
        winnersRow.appendChild(makeHeroChip(w, "best"));
      }
      col.appendChild(winnersRow);

      // Losers (bottom 3)
      const losers = heroes.slice(-3).reverse();
      const losersLabel = document.createElement("div");
      losersLabel.className = "mapdiff-ob-section-label worst";
      losersLabel.textContent = "Losers";
      col.appendChild(losersLabel);
      const losersRow = document.createElement("div");
      losersRow.className = "mapdiff-ob-losers";
      for (const l of losers) {
        losersRow.appendChild(makeHeroChip(l, "worst"));
      }
      col.appendChild(losersRow);

      rolesContainer.appendChild(col);
    }
    bar.appendChild(rolesContainer);

    // -- Ban row
    if (banCandidates.length > 0) {
      const banRow = document.createElement("div");
      banRow.className = "mapdiff-ob-ban";

      const banLabel = document.createElement("span");
      banLabel.className = "mapdiff-ob-ban-label";
      banLabel.textContent = "Consider banning";
      banRow.appendChild(banLabel);

      const banHeroes = document.createElement("div");
      banHeroes.className = "mapdiff-ob-ban-heroes";
      for (const b of banCandidates) {
        banHeroes.appendChild(makeHeroChip(b, "best"));
      }
      banRow.appendChild(banHeroes);

      bar.appendChild(banRow);
    }

    table.parentElement.insertBefore(bar, table);
  }

  function makeHeroChip(hero, type) {
    const chip = document.createElement("div");
    chip.className = `mapdiff-ob-chip ${type}`;

    if (hero.portrait) {
      const img = document.createElement("img");
      img.className = "mapdiff-ob-portrait";
      img.src = hero.portrait;
      img.alt = hero.name;
      img.style.borderColor = hero.color;
      chip.appendChild(img);
    }

    const name = document.createElement("span");
    name.className = "mapdiff-ob-chip-name";
    name.textContent = hero.name;
    chip.appendChild(name);

    const diff = document.createElement("span");
    diff.className = `mapdiff-ob-chip-diff ${type}`;
    diff.textContent = formatDiff(hero.diff);
    chip.appendChild(diff);

    return chip;
  }

  // ── Map Archetype Analysis ──

  function analyzeMapTraits(diffs) {
    // For each trait, compute the average win rate diff of heroes with that trait
    const traitSums = {};
    const traitCounts = {};

    for (const d of diffs) {
      const key = normalizeHeroId(d.heroId);
      const tags = HERO_TAGS[key];
      if (!tags) continue;
      for (const tag of tags) {
        if (!traitSums[tag]) { traitSums[tag] = 0; traitCounts[tag] = 0; }
        traitSums[tag] += d.diff;
        traitCounts[tag]++;
      }
    }

    const traitAvgs = [];
    for (const [tag, sum] of Object.entries(traitSums)) {
      const count = traitCounts[tag];
      if (count < 3) continue;
      traitAvgs.push({ tag, avg: sum / count, count });
    }

    traitAvgs.sort((a, b) => Math.abs(b.avg) - Math.abs(a.avg));

    const favors = traitAvgs.filter((t) => t.avg > 0.3).slice(0, 2)
      .map((t) => ({ label: TRAIT_LABELS[t.tag] || t.tag, avg: t.avg, type: "favors" }));
    const punishes = traitAvgs.filter((t) => t.avg < -0.3).slice(0, 2)
      .map((t) => ({ label: TRAIT_LABELS[t.tag] || t.tag, avg: t.avg, type: "punishes" }));

    return { favors, punishes };
  }

  // ── Top/Bottom maps: two clean rows ──

  function makeMapRow(label, cssClass, maps, currentMapSlug) {
    const row = document.createElement("div");
    row.className = "mapdiff-maps-row";

    const lbl = document.createElement("span");
    lbl.className = `mapdiff-maps-label ${cssClass}`;
    lbl.textContent = cssClass === "best" ? "▲" : "▼";
    row.appendChild(lbl);

    const entries = document.createElement("span");
    entries.className = "mapdiff-maps-entries";

    for (const m of maps) {
      const entry = document.createElement("span");
      entry.className = "mapdiff-map-entry";
      entry.title = `${m.name}: ${formatDiff(m.diff)}% vs average`;

      const name = document.createElement("a");
      name.className = "mapdiff-map-name";
      if (m.slug === currentMapSlug) name.classList.add("mapdiff-current-map");
      name.textContent = m.name;
      name.href = "#";
      name.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectMap(m.slug);
      });

      const diff = document.createElement("span");
      diff.className = `mapdiff-map-diff ${cssClass}`;
      diff.textContent = formatDiff(m.diff);

      entry.appendChild(name);
      entry.appendChild(diff);
      entries.appendChild(entry);
    }

    row.appendChild(entries);
    return row;
  }

  function injectMapList(heroId, mapDiffs, currentMapSlug, slotType) {
    const rateCell = document.querySelector(
      `[slot="cell-${heroId}-${slotType}"]`
    );
    if (!rateCell) return;
    const existing = rateCell.querySelector(".mapdiff-maps");
    if (existing) existing.remove();

    const sorted = [...mapDiffs]
      .filter((m) => m.diff !== null && !isNaN(m.diff))
      .sort((a, b) => b.diff - a.diff);
    if (sorted.length === 0) return;

    const best = sorted.slice(0, 3);
    const worst = sorted.slice(-3).reverse();

    const container = document.createElement("div");
    container.className = "mapdiff-maps";

    // Collapsed view: top 3 / bottom 3
    const collapsed = document.createElement("div");
    collapsed.className = "mapdiff-maps-collapsed";
    collapsed.appendChild(makeMapRow("best", "best", best, currentMapSlug));
    collapsed.appendChild(makeMapRow("worst", "worst", worst, currentMapSlug));
    container.appendChild(collapsed);

    // Expanded view: all maps ranked
    const expanded = document.createElement("div");
    expanded.className = "mapdiff-maps-expanded";
    for (const m of sorted) {
      const cssClass = m.diff > 0.05 ? "best" : m.diff < -0.05 ? "worst" : "neutral";
      const row = document.createElement("div");
      row.className = "mapdiff-maps-row";

      const name = document.createElement("a");
      name.className = "mapdiff-map-name";
      if (m.slug === currentMapSlug) name.classList.add("mapdiff-current-map");
      name.textContent = m.name;
      name.href = "#";
      name.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        selectMap(m.slug);
      });

      const diff = document.createElement("span");
      diff.className = `mapdiff-map-diff ${cssClass}`;
      diff.textContent = formatDiff(m.diff);

      row.appendChild(name);
      row.appendChild(diff);
      expanded.appendChild(row);
    }
    container.appendChild(expanded);

    // Toggle
    collapsed.style.cursor = "pointer";
    collapsed.title = "Click to show all maps";
    collapsed.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // don't toggle on map link clicks
      container.classList.toggle("mapdiff-maps-open");
    });
    expanded.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      container.classList.toggle("mapdiff-maps-open");
    });

    rateCell.appendChild(container);
  }

  // ── Error state ──

  function showError() {
    const existing = document.querySelector(".mapdiff-error");
    if (existing) existing.remove();

    const table = document.querySelector(TABLE_SELECTOR);
    if (!table?.parentElement) return;

    const el = document.createElement("div");
    el.className = "mapdiff-error";
    el.textContent = "Unable to load map data. Check your connection and refresh.";
    table.parentElement.insertBefore(el, table);
  }

  function removeError() {
    const el = document.querySelector(".mapdiff-error");
    if (el) el.remove();
  }

  // ── Loading state ──

  function showLoading(heroId) {
    const heroCell = document.querySelector(
      `div.hero-cell[slot="cell-${heroId}-name"]`
    );
    if (!heroCell || heroCell.querySelector(".mapdiff-loading")) return;
    const el = document.createElement("div");
    el.className = "mapdiff-loading";
    el.innerHTML = '<span class="mapdiff-skeleton"></span>';
    heroCell.appendChild(el);
  }

  function removeLoading(heroId) {
    const heroCell = document.querySelector(
      `div.hero-cell[slot="cell-${heroId}-name"]`
    );
    if (!heroCell) return;
    heroCell.querySelectorAll(".mapdiff-loading").forEach((el) => el.remove());
  }

  // ── Sorting (diff columns only — built-in sort left untouched) ──

  let sortKey = null;   // null | "pickdiff" | "windiff"
  let sortDir = "desc";

  function injectSortUI() {
    const table = document.querySelector(TABLE_SELECTOR);
    if (!table?.shadowRoot) return;
    const shadow = table.shadowRoot;
    if (shadow.querySelector(".mapdiff-shadow-styles")) return;

    // Inject styles into shadow DOM
    const style = document.createElement("style");
    style.className = "mapdiff-shadow-styles";
    style.textContent = `
      .mapdiff-sort-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-left: 6px;
        padding: 3px 8px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 4px;
        background: transparent;
        color: rgba(255, 255, 255, 0.55);
        font-family: Config, sans-serif;
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        cursor: pointer;
        transition: background 0.15s, color 0.15s, border-color 0.15s;
        vertical-align: middle;
        white-space: nowrap;
      }
      .mapdiff-sort-btn:hover {
        background: rgba(255, 255, 255, 0.08);
        color: rgba(255, 255, 255, 0.8);
        border-color: rgba(255, 255, 255, 0.25);
      }
      .mapdiff-sort-btn.active {
        background: rgba(255, 255, 255, 0.12);
        color: #ffffff;
        border-color: rgba(255, 255, 255, 0.3);
      }
      .mapdiff-sort-arrow {
        font-size: 10px;
        opacity: 0.7;
      }
    `;
    shadow.appendChild(style);

    // Add diff sort buttons to pick rate and win rate header cells
    const headerCells = shadow.querySelectorAll(".data-table-header-cell");
    const addBtn = (cellIndex, key, label) => {
      const cell = headerCells[cellIndex];
      if (!cell) return;
      const span = cell.querySelector("span");
      if (!span) return;
      const btn = document.createElement("button");
      btn.className = "mapdiff-sort-btn";
      btn.dataset.sortKey = key;
      btn.innerHTML = `<span class="mapdiff-sort-arrow">▼</span> ${label}`;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        activateDiffSort(key);
      });
      span.appendChild(btn);
    };
    addBtn(1, "pickdiff", "Diff");
    addBtn(2, "windiff", "Diff");

    // Detect built-in sort: when a native header cell is clicked,
    // reset our diff sort state so the two don't conflict.
    headerCells.forEach((cell) => {
      cell.addEventListener("click", (e) => {
        // Ignore clicks on our own diff buttons
        if (e.target.closest(".mapdiff-sort-btn")) return;
        if (sortKey) {
          sortKey = null;
          sortDir = "desc";
          updateDiffSortUI();
        }
      });
    });
  }

  function activateDiffSort(key) {
    if (sortKey === key) {
      sortDir = sortDir === "desc" ? "asc" : "desc";
    } else {
      sortKey = key;
      sortDir = "desc";
    }
    applyDiffSort();
    updateDiffSortUI();
  }

  function applyDiffSort() {
    const table = document.querySelector(TABLE_SELECTOR);
    if (!table) return;

    table.removeAttribute("sortby");

    const rowsAttr = table.getAttribute("rows");
    if (!rowsAttr) return;
    try {
      const rows = JSON.parse(rowsAttr);
      rows.sort((a, b) => {
        const source = sortKey === "pickdiff" ? heroPickDiffs : heroDiffs;
        const da = source[a.id] ?? 0;
        const db = source[b.id] ?? 0;
        return sortDir === "desc" ? db - da : da - db;
      });
      table.setAttribute("rows", JSON.stringify(rows));
      // Clear the component's internal sort state and trigger re-render
      // via main-world script (content scripts can't set JS properties)
      document.dispatchEvent(new CustomEvent("mapdiff-clear-sort"));
    } catch {
      // ignore
    }
  }

  function updateDiffSortUI() {
    const table = document.querySelector(TABLE_SELECTOR);
    if (!table?.shadowRoot) return;
    for (const btn of table.shadowRoot.querySelectorAll(".mapdiff-sort-btn")) {
      const key = btn.dataset.sortKey;
      btn.classList.toggle("active", sortKey === key);
      const arrow = sortKey === key && sortDir === "asc" ? "▲" : "▼";
      btn.innerHTML = `<span class="mapdiff-sort-arrow">${arrow}</span> Diff`;
    }
  }

  function getHeroVisuals(heroId) {
    const heroCell = document.querySelector(
      `div.hero-cell[slot="cell-${heroId}-name"]`
    );
    if (!heroCell) return null;
    const blzImg = heroCell.querySelector("blz-image");
    const portrait = blzImg?.getAttribute("src") || "";
    const style = blzImg?.getAttribute("style") || "";
    const colorMatch = style.match(/--hero-color:\s*(#[0-9a-f]+)/i);
    const color = colorMatch ? colorMatch[1] : "#888";
    const roleEl = heroCell.querySelector(
      "blz-icon.hero-role-icon, img.role-icon, img[class*='role']"
    );
    const roleSrc = roleEl?.getAttribute("src") || "";
    let role = "damage";
    let roleIcon = "";
    if (roleSrc.includes("tank")) { role = "tank"; roleIcon = roleSrc; }
    else if (roleSrc.includes("damage")) { role = "damage"; roleIcon = roleSrc; }
    else if (roleSrc.includes("support")) { role = "support"; roleIcon = roleSrc; }
    else { roleIcon = roleSrc; }
    return { portrait, color, role, roleIcon };
  }

  // ── Pick rate top/bottom maps ──


  // ── Progress bar average marker ──

  function injectProgressMarker(heroId, type, allMapsValue) {
    const valEl = document.getElementById(`${heroId}-${type}-value`);
    if (!valEl) return;
    const cell = valEl.closest("[slot]") || valEl.parentElement?.parentElement;
    if (!cell) return;
    const progressBar = cell.querySelector(".progress-bar, [class*='progress']");
    if (!progressBar) return;

    const existing = progressBar.querySelector(".mapdiff-avg-marker");
    if (existing) existing.remove();

    const pct = Math.max(0, Math.min(100, allMapsValue));

    const marker = document.createElement("div");
    marker.className = "mapdiff-avg-marker";
    marker.style.left = `${pct}%`;
    marker.title = `All-maps average: ${allMapsValue.toFixed(1)}%`;

    const pos = getComputedStyle(progressBar).position;
    if (pos === "static") progressBar.style.position = "relative";
    progressBar.appendChild(marker);
  }

  // ── Main logic ──

  async function run() {
    const table = document.querySelector(TABLE_SELECTOR);
    if (!table) return;

    const currentData = parseTableData(table);
    if (!currentData) return;

    const mapSelect = document.getElementById(MAP_SELECT_ID);
    if (!mapSelect) return;
    const currentMap = mapSelect.value;

    cleanup();

    // Reset sort state on data change
    sortKey = null;
    sortDir = "desc";

    const heroIds = Object.keys(currentData);

    // Phase 1: Diff badges (current map vs all-maps)
    if (currentMap !== "all-maps") {
      const allMapsData = await fetchMapDataCached("all-maps");
      if (!allMapsData) {
        showError();
      } else {
        for (const heroId of heroIds) {
          const cur = currentData[heroId];
          const avg = allMapsData[heroId];
          if (cur?.winrate != null && avg?.winrate != null) {
            // Always compute diffs for sort functionality
            heroDiffs[heroId] = cur.winrate - avg.winrate;
            if (featureToggles.diffBadges !== false) {
              injectBadge(heroId, "winrate", cur.winrate - avg.winrate, avg.winrate, cur.pickrate);
            }
            if (featureToggles.progressMarkers !== false) {
              injectProgressMarker(heroId, "winrate", avg.winrate);
            }
          }
          if (cur?.pickrate != null && avg?.pickrate != null) {
            heroPickDiffs[heroId] = cur.pickrate - avg.pickrate;
            if (featureToggles.diffBadges !== false) {
              injectBadge(heroId, "pickrate", cur.pickrate - avg.pickrate, avg.pickrate, cur.pickrate);
            }
            if (featureToggles.progressMarkers !== false) {
              injectProgressMarker(heroId, "pickrate", avg.pickrate);
            }
          }
        }
        if (featureToggles.outlierBar !== false) {
          injectOutlierBar(currentData, allMapsData, currentMap);
        }
      }
      if (featureToggles.sortButtons !== false) {
        injectSortUI();
      }
    }

    // Phase 2: Fetch all maps, show top/bottom 3
    for (const heroId of heroIds) showLoading(heroId);

    const maps = getMapSlugs();
    const allMapsBaseline = await fetchMapDataCached("all-maps");
    if (!allMapsBaseline) {
      for (const heroId of heroIds) removeLoading(heroId);
      showError();
      return;
    }

    const BATCH_SIZE = 5;
    const allMapData = {};
    for (let i = 0; i < maps.length; i += BATCH_SIZE) {
      const batch = maps.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map((m) => fetchMapDataCached(m.value))
      );
      for (let j = 0; j < batch.length; j++) {
        const result = results[j];
        if (result.status === "fulfilled" && result.value) {
          allMapData[batch[j].value] = result.value;
        }
      }
    }

    for (const heroId of heroIds) {
      const baseline = allMapsBaseline[heroId]?.winrate;
      const baselinePick = allMapsBaseline[heroId]?.pickrate;
      if (baseline == null) {
        removeLoading(heroId);
        continue;
      }

      const mapDiffs = [];
      const pickDiffs = [];
      for (const map of maps) {
        const mapData = allMapData[map.value];
        if (!mapData || !mapData[heroId]) continue;
        const mapWin = mapData[heroId].winrate;
        const mapPick = mapData[heroId].pickrate;
        if (mapWin != null) {
          mapDiffs.push({
            slug: map.value,
            name: map.text,
            diff: mapWin - baseline,
          });
        }
        if (mapPick != null && baselinePick != null) {
          pickDiffs.push({
            slug: map.value,
            name: map.text,
            diff: mapPick - baselinePick,
          });
        }
      }

      removeLoading(heroId);

      if (featureToggles.topBottomMaps !== false) {
        injectMapList(heroId, mapDiffs, currentMap, "winrate");
      }
      if (featureToggles.pickRateMaps !== false) {
        injectMapList(heroId, pickDiffs, currentMap, "pickrate");
      }
    }
  }

  // ── Observers ──

  let activeObserver = null;

  function observe() {
    if (activeObserver) {
      activeObserver.disconnect();
      activeObserver = null;
    }

    const table = document.querySelector(TABLE_SELECTOR);
    if (table) {
      activeObserver = new MutationObserver(() => {
        clearTimeout(observe._timer);
        observe._timer = setTimeout(run, 500);
      });
      activeObserver.observe(table, {
        attributes: true,
        attributeFilter: ["allrows"],
      });
    }
  }

  function waitForTable() {
    const table = document.querySelector(TABLE_SELECTOR);
    if (table) {
      run();
      observe();
      return;
    }
    const bodyObserver = new MutationObserver(() => {
      const table = document.querySelector(TABLE_SELECTOR);
      if (table) {
        bodyObserver.disconnect();
        run();
        observe();
      }
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }

  // URL change detection
  let lastURL = window.location.href;

  function onURLChange() {
    if (window.location.href !== lastURL) {
      lastURL = window.location.href;
      cleanup();
      setTimeout(run, 1000);
    }
  }

  window.addEventListener("popstate", onURLChange);

  if (typeof navigation !== "undefined") {
    navigation.addEventListener("navigatesuccess", onURLChange);
  } else {
    const urlPollId = setInterval(onURLChange, 500);
    window.addEventListener("pagehide", () => clearInterval(urlPollId), { once: true });
  }

  // Listen for live settings changes from popup
  window.browserStorage.onChanged.addListener((changes, area) => {
    if (area !== "sync" && area !== "local") return;
    if (changes.featureToggles || changes.heroTagOverrides) {
      loadSettings().then(() => {
        cleanup();
        run();
      });
    }
  });

  // Load settings before starting
  loadSettings().then(() => waitForTable());
})();
