/**
 * HubLens static SPA — live from BendHub, aliases from ./aliases.json.
 * Badges computed client-side (ported from src/badges.ts).
 */
const HUB = "https://hub.bend-lang.com";
const STATUS_TEXT = "live from BendHub · waiting for bend kernel CI";
const OPEN_LAW_PACKAGE = "0x0f883c5f54a94db1185081a5171fcd7d";

const $ = (s) => document.querySelector(s);

/** @type {Map<string, object>} */
const packageCache = new Map();
/** @type {{ name: string, hash: string, note: string }[]} */
let aliasList = [];
/** @type {Record<string, { hash: string, note?: string }>} */
let aliasMap = {};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortHash(h) {
  return h.slice(0, 10) + "…" + h.slice(-4);
}

function normalizeId(h) {
  const x = String(h).trim().toLowerCase();
  return x.startsWith("0x") ? x : `0x${x}`;
}

function chipsHtml(chips = []) {
  return `<div class="chips">${chips
    .map((c) => `<span class="chip ${c.tone}">${escapeHtml(c.label)}</span>`)
    .join("")}</div>`;
}

async function hubText(path) {
  const r = await fetch(`${HUB}/${path}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.text();
}

async function hubJson(path) {
  return JSON.parse(await hubText(path));
}

function parseManifest(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n").filter((l) => l.trim());
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([0-9a-fA-F]{64})\s+(.+)$/);
    if (!m) throw new Error(`Bad manifest line: ${line}`);
    out.push({ sha256: m[1].toLowerCase(), path: m[2].trim() });
  }
  return out;
}

function fileKind(path) {
  const p = path.toLowerCase();
  if (p.endsWith(".bend")) return "bend";
  if (p.endsWith(".js")) return "js";
  if (p.endsWith(".c")) return "c";
  return "other";
}

/** Prefer lib.bend > main.bend > src/main.bend > hello.bend > first .bend */
function pickEntryPath(paths) {
  const prefs = ["lib.bend", "main.bend", "src/main.bend", "hello.bend"];
  for (const p of prefs) {
    if (paths.includes(p)) return p;
  }
  return paths.find((f) => f.endsWith(".bend")) ?? paths[0] ?? null;
}

function importAliasForEntry(entryPath) {
  if (!entryPath) return "Main";
  const base = entryPath.split("/").pop() || entryPath;
  if (base === "lib.bend") return "Lib";
  return "Main";
}

function bendImportLine(packageId, entryPath) {
  const id = normalizeId(packageId);
  const alias = importAliasForEntry(entryPath);
  return `import ${id}/${entryPath} as ${alias}`;
}

function parseImportLine(line) {
  const t = line.trim();
  if (!t.startsWith("import ")) return null;
  if (/^import\s+["']/.test(t)) return null;
  if (/^import\s+Base\s*$/.test(t)) {
    return { raw: t, kind: "base", target: "Base" };
  }
  const hashM = t.match(
    /^import\s+(0x[0-9a-fA-F]{32}\/[^\s]+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/,
  );
  if (hashM) {
    return { raw: t, kind: "hash", target: hashM[1], alias: hashM[2] };
  }
  const relM = t.match(
    /^import\s+(\.?\.?\/[^\s]+)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/,
  );
  if (relM) {
    return { raw: t, kind: "relative", target: relM[1], alias: relM[2] };
  }
  return null;
}

function scanPackageBadges(packageId, files) {
  const lawNames = new Set();
  const defNames = new Set();
  const symbols = [];
  const imports = [];
  let unsafe_count = 0;
  let todo_count = 0;
  const foreign_paths = [];

  for (const f of files) {
    const lower = f.path.toLowerCase();
    if (lower.endsWith(".js") || lower.endsWith(".c")) {
      foreign_paths.push(f.path);
    }
    if (!lower.endsWith(".bend")) continue;

    const lines = f.content.replace(/\r\n/g, "\n").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNo = i + 1;

      const lawM = line.match(/^\s*law\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/);
      if (lawM) {
        lawNames.add(lawM[1]);
        symbols.push({ kind: "law", name: lawM[1], path: f.path, line: lineNo });
      }

      if (/^\s*@unsafe\b/.test(line)) unsafe_count++;

      const defM = line.match(
        /^\s*(?:@unsafe\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\b/,
      );
      if (defM) {
        const full = defM[1];
        defNames.add(full);
        const bare = full.includes(".") ? full.split(".").pop() : full;
        defNames.add(bare);
        symbols.push({ kind: "def", name: full, path: f.path, line: lineNo });
      }

      const typeM = line.match(/^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
      if (typeM) {
        symbols.push({ kind: "type", name: typeM[1], path: f.path, line: lineNo });
      }

      if (/\?[A-Za-z_][A-Za-z0-9_]*/.test(line) && !/^\s*#/.test(line)) {
        todo_count++;
      } else if (/\bTODO\b/.test(line)) {
        todo_count++;
      }

      const imp = parseImportLine(line);
      if (imp) imports.push(imp);

      const foreignImp = line.match(
        /^\s*import\s+["']([^"']+\.(?:js|c))["']\s*$/,
      );
      if (foreignImp) {
        imports.push({
          raw: line.trim(),
          kind: "foreign",
          target: foreignImp[1],
        });
      }
    }
  }

  const filled_laws = [];
  const open_laws = [];
  for (const law of lawNames) {
    let filled = defNames.has(law);
    if (!filled) {
      for (const d of defNames) {
        if (d.endsWith(`.${law}`) || d === law) {
          filled = true;
          break;
        }
      }
    }
    if (!filled) {
      for (const f of files) {
        if (!f.path.endsWith(".bend")) continue;
        const re = new RegExp(
          `^\\s*def\\s+[A-Za-z_][A-Za-z0-9_]*\\.${law}\\b`,
          "m",
        );
        if (re.test(f.content)) {
          filled = true;
          break;
        }
      }
    }
    if (filled) filled_laws.push(law);
    else open_laws.push(law);
  }

  const has_open_laws = open_laws.length > 0;
  const warns_open_laws =
    has_open_laws && normalizeId(packageId) === OPEN_LAW_PACKAGE;

  return {
    laws_total: lawNames.size,
    laws_filled: filled_laws.length,
    open_laws,
    filled_laws,
    unsafe_count,
    todo_count,
    foreign_paths: [...new Set(foreign_paths)],
    imports,
    symbols,
    has_open_laws,
    warns_open_laws,
  };
}

function badgeChips(b) {
  const chips = [];
  if (b.laws_total > 0) {
    chips.push({
      key: "laws",
      label: `Laws: ${b.laws_filled}/${b.laws_total}`,
      tone: b.has_open_laws ? "warn" : "ok",
    });
    if (b.has_open_laws) {
      chips.push({
        key: "open_laws",
        label: `Open: ${b.open_laws.join(", ")}`,
        tone: "warn",
      });
    }
  } else {
    chips.push({ key: "laws", label: "Laws: 0", tone: "neutral" });
  }
  if (b.unsafe_count > 0) {
    chips.push({
      key: "unsafe",
      label: `@unsafe ×${b.unsafe_count}`,
      tone: "danger",
    });
  }
  if (b.todo_count > 0) {
    chips.push({
      key: "todo",
      label: `TODO ×${b.todo_count}`,
      tone: "danger",
    });
  }
  if (b.foreign_paths.length > 0) {
    chips.push({
      key: "foreign",
      label: `Foreign: ${b.foreign_paths.length}`,
      tone: "info",
    });
  }
  return chips;
}

function aliasesForHash(hash) {
  const id = normalizeId(hash);
  return aliasList.filter((a) => a.hash === id).map((a) => a.name);
}

async function loadPackage(hash, indexEntry) {
  const id = normalizeId(hash);
  if (packageCache.has(id)) return packageCache.get(id);

  const manifestText = await hubText(`${id}/manifest`);
  const manifest = parseManifest(manifestText);
  const paths = manifest.map((m) => m.path);
  const entry_path = pickEntryPath(paths);

  const fileMetas = manifest.map((m) => ({
    path: m.path,
    sha256: m.sha256,
    size: indexEntry?.files?.[m.path] ?? 0,
    kind: fileKind(m.path),
  }));

  // Fetch bend + foreign sources for badges / search / viewer cache
  const contents = await Promise.all(
    manifest.map(async (m) => {
      try {
        const content = await hubText(`${id}/${m.path}`);
        return { path: m.path, content };
      } catch {
        return { path: m.path, content: "" };
      }
    }),
  );

  // Fill sizes from content when index lacked them
  for (const meta of fileMetas) {
    if (!meta.size) {
      const c = contents.find((x) => x.path === meta.path);
      if (c) meta.size = new TextEncoder().encode(c.content).length;
    }
  }

  const badges = scanPackageBadges(id, contents);
  const chips = badgeChips(badges);
  const aliases = aliasesForHash(id);
  const import_line = entry_path ? bendImportLine(id, entry_path) : null;

  const pkg = {
    hash: id,
    bytes: indexEntry?.bytes ?? fileMetas.reduce((s, f) => s + f.size, 0),
    hub_ts: indexEntry?.ts ?? 0,
    desc: indexEntry?.desc ?? "",
    verified: true,
    entry_path,
    import_line,
    hub_url: `${HUB}/${id}/`,
    files: fileMetas,
    file_contents: Object.fromEntries(contents.map((c) => [c.path, c.content])),
    badges,
    badge_chips: chips,
    aliases,
  };
  packageCache.set(id, pkg);
  return pkg;
}

async function loadAliases() {
  const r = await fetch("./aliases.json");
  if (!r.ok) throw new Error(`aliases.json ${r.status}`);
  const raw = await r.json();
  aliasMap = raw;
  aliasList = Object.entries(raw)
    .map(([name, v]) => ({
      name,
      hash: normalizeId(typeof v === "string" ? v : v.hash),
      note: typeof v === "string" ? "" : v.note || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function renderPackageList(packages) {
  const el = $("#pkg-list");
  if (!packages.length) {
    el.innerHTML = "<p class='meta'>No packages on BendHub yet.</p>";
    return;
  }
  el.innerHTML = packages
    .map(
      (p) => `
    <div class="card" data-hash="${p.hash}">
      <h3 class="mono">${escapeHtml(p.hash)}</h3>
      <div class="meta">
        ${p.aliases?.length ? "aliases: " + p.aliases.join(", ") + " · " : ""}
        ${p.bytes} bytes · ${p.files.length} files
        ${p.entry_path ? " · entry " + escapeHtml(p.entry_path) : ""}
        ${p.desc ? " · " + escapeHtml(p.desc) : ""}
      </div>
      ${chipsHtml(p.badge_chips)}
    </div>`,
    )
    .join("");

  el.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => showPackage(card.dataset.hash));
  });
}

async function showPackage(hash) {
  const p = packageCache.get(normalizeId(hash));
  if (!p) return;
  const el = $("#pkg-detail");
  el.classList.remove("hidden");
  el.innerHTML = `
    <h2 class="mono">${escapeHtml(p.hash)}</h2>
    <div class="meta">
      <a href="${p.hub_url}" target="_blank" rel="noopener">Open on BendHub</a>
      ${p.aliases?.length ? " · aliases: " + p.aliases.map(escapeHtml).join(", ") : ""}
      · live fetch
      ${p.desc ? " · " + escapeHtml(p.desc) : ""}
    </div>
    ${chipsHtml(p.badge_chips)}
    ${
      p.badges?.has_open_laws
        ? `<p class="meta" style="color:var(--warn)">Open laws: ${escapeHtml(
            (p.badges.open_laws || []).join(", "),
          )}${
            p.badges.warns_open_laws
              ? " — known edge case on nested demo (0x0f88…)"
              : ""
          }</p>`
        : ""
    }
    ${
      p.import_line
        ? `<div class="import-box">
            <code id="import-line">${escapeHtml(p.import_line)}</code>
            <button class="copy-btn" type="button" data-copy="${escapeHtml(
              p.import_line,
            )}">Copy import</button>
          </div>`
        : ""
    }
    <h3>Files</h3>
    <ul class="file-list">
      ${p.files
        .map(
          (f) =>
            `<li><button class="link-btn file-link" data-path="${escapeHtml(
              f.path,
            )}" data-hash="${p.hash}">${escapeHtml(f.path)}</button>
             <span class="meta">${f.kind} · ${f.size} B</span></li>`,
        )
        .join("")}
    </ul>
    <div id="file-view"></div>
  `;

  el.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy import"), 1200);
    });
  });

  el.querySelectorAll(".file-link").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pkg = packageCache.get(normalizeId(btn.dataset.hash));
      let content = pkg?.file_contents?.[btn.dataset.path];
      if (content == null) {
        content = await hubText(`${btn.dataset.hash}/${btn.dataset.path}`);
      }
      $("#file-view").innerHTML = `
        <h4 class="mono">${escapeHtml(btn.dataset.path)}</h4>
        <pre class="source">${escapeHtml(content)}</pre>`;
    });
  });

  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function doSearch(q) {
  const el = $("#search-results");
  const needle = q.trim();
  if (!needle) {
    el.innerHTML = "<p class='meta'>Enter a query.</p>";
    return;
  }
  const qLower = needle.toLowerCase();
  const results = [];

  for (const a of aliasList) {
    if (a.name.toLowerCase().includes(qLower)) {
      results.push({
        hash: a.hash,
        match: `alias:${a.name}`,
        aliases: [a.name],
      });
    }
  }

  for (const p of packageCache.values()) {
    if (p.hash.includes(qLower)) {
      results.push({ hash: p.hash, match: "hash" });
    }
    for (const s of p.badges?.symbols || []) {
      if (s.name.toLowerCase().includes(qLower)) {
        results.push({
          hash: p.hash,
          path: s.path,
          match: `${s.kind}:${s.name}`,
        });
      }
    }
    for (const [path, content] of Object.entries(p.file_contents || {})) {
      if (
        path.toLowerCase().includes(qLower) ||
        content.toLowerCase().includes(qLower)
      ) {
        const i = content.toLowerCase().indexOf(qLower);
        let snippet = content.slice(0, 120);
        if (i >= 0) {
          const start = Math.max(0, i - 40);
          snippet = content.slice(start, start + 120).replace(/\n/g, " ");
        }
        results.push({
          hash: p.hash,
          path,
          match: path.toLowerCase().includes(qLower) ? "path" : "content",
          snippet,
        });
      }
    }
  }

  if (!results.length) {
    el.innerHTML = "<p class='meta'>No hits.</p>";
    return;
  }

  el.innerHTML = results
    .slice(0, 80)
    .map(
      (r) => `
    <div class="card" data-hash="${r.hash}">
      <h3 class="mono">${escapeHtml(shortHash(r.hash))}</h3>
      <div class="meta">${escapeHtml(r.match)}${
        r.path ? " · " + escapeHtml(r.path) : ""
      }</div>
      ${r.snippet ? `<pre class="source" style="max-height:80px">${escapeHtml(r.snippet)}</pre>` : ""}
    </div>`,
    )
    .join("");
  el.querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelector('[data-tab="packages"]').click();
      showPackage(card.dataset.hash);
    });
  });
}

function loadAliasesUI() {
  $("#alias-list").innerHTML = aliasList
    .map(
      (a) => `
    <div class="card" data-name="${escapeHtml(a.name)}">
      <h3>${escapeHtml(a.name)} → <span class="mono">${escapeHtml(
        a.hash,
      )}</span></h3>
      <div class="meta">${escapeHtml(a.note || "")}</div>
    </div>`,
    )
    .join("");
  $("#alias-list").querySelectorAll(".card").forEach((card) => {
    card.addEventListener("click", () => resolveAlias(card.dataset.name));
  });
}

function resolveAlias(name) {
  const key = name.trim().toLowerCase();
  const a = aliasList.find((x) => x.name === key);
  if (!a) {
    $("#alias-result").innerHTML = `<p class="meta">Alias not found.</p>`;
    return;
  }
  const pkg = packageCache.get(a.hash);
  $("#alias-result").innerHTML = `
    <h2>${escapeHtml(a.name)} → <span class="mono">${escapeHtml(
      a.hash,
    )}</span></h2>
    <div class="meta">${escapeHtml(a.note || "")}</div>
    ${
      pkg?.import_line
        ? `<div class="import-box">
            <code>${escapeHtml(pkg.import_line)}</code>
            <button class="copy-btn" data-copy="${escapeHtml(
              pkg.import_line,
            )}">Copy import</button>
          </div>`
        : ""
    }
    ${pkg ? chipsHtml(pkg.badge_chips) : ""}
    <p class="meta"><a href="${HUB}/${a.hash}/" target="_blank" rel="noopener">BendHub</a>
      · <button class="link-btn" type="button" id="alias-open-pkg">Open package</button></p>
  `;
  $("#alias-result").querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = "Copied";
      setTimeout(() => (btn.textContent = "Copy import"), 1200);
    });
  });
  const openBtn = $("#alias-open-pkg");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      document.querySelector('[data-tab="packages"]').click();
      showPackage(a.hash);
    });
  }
}

function setupTabs() {
  document.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach((b) =>
        b.classList.remove("active"),
      );
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      $(`#tab-${btn.dataset.tab}`).classList.add("active");
    });
  });
}

async function boot() {
  setupTabs();
  $("#status").textContent = STATUS_TEXT;

  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    doSearch($("#search-q").value.trim());
  });
  $("#alias-lookup").addEventListener("submit", (e) => {
    e.preventDefault();
    resolveAlias($("#alias-name").value.trim());
  });

  try {
    await loadAliases();
    loadAliasesUI();
  } catch (e) {
    $("#alias-list").innerHTML = `<p class="meta">Failed to load aliases: ${escapeHtml(e.message)}</p>`;
  }

  $("#pkg-list").innerHTML = "<p class='meta'>Fetching BendHub index…</p>";
  try {
    const index = await hubJson("index.json");
    // newest first
    index.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    $("#pkg-list").innerHTML = `<p class='meta'>Loading ${index.length} packages from hub…</p>`;

    const packages = [];
    for (const entry of index) {
      try {
        const pkg = await loadPackage(entry.hash, entry);
        packages.push(pkg);
        renderPackageList(packages);
      } catch (err) {
        console.warn("package load failed", entry.hash, err);
      }
    }
    if (!packages.length) {
      $("#pkg-list").innerHTML = "<p class='meta'>No packages loaded.</p>";
    }
  } catch (e) {
    $("#pkg-list").innerHTML = `<p class='meta'>Hub unreachable: ${escapeHtml(e.message)}</p>`;
    $("#status").textContent = "hub offline · " + STATUS_TEXT;
  }
}

boot();
