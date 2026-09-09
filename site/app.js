const $app = document.getElementById("app");
const lightbox = document.getElementById("lightbox");
const lbMedia = document.getElementById("lb-media");
const lbCaption = document.getElementById("lb-caption");

const state = { manifest: null, statsLoaded: false };
const lbContext = { items: [], index: -1 };

const BATCH_SIZE = 48;
const BATCH_ROOT_MARGIN = "800px 0px";
const COLUMN_GAP = 14;

async function ensureManifest() {
  if (!state.manifest) {
    const res = await fetch("./manifest.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`manifest.json HTTP ${res.status}`);
    state.manifest = await res.json();
  }
  return state.manifest;
}

async function ensureStats() {
  if (state.statsLoaded || !state.manifest) return;
  state.statsLoaded = true;
  try {
    const res = await fetch("./stats.json");
    if (!res.ok) return;
    const stats = await res.json();
    for (const category of state.manifest.categories)
      for (const file of category.files)
        if (file.views == null) file.views = stats[file.path] ?? null;
  } catch {
    void 0;
  }
}

function allFiles() {
  return state.manifest.categories.flatMap((category) => category.files);
}

function hasViews() {
  return state.manifest.categories.some((category) =>
    category.files.some((file) => file.views != null)
  );
}

function fileURL(file) {
  return encodeURI(`${state.manifest.base_url}/${file.path}`);
}

function thumbURL(file) {
  if (!state.manifest.thumbs_base) return null;
  return encodeURI(`${state.manifest.thumbs_base}/${file.path}.webp`);
}

function categoryURL(name) {
  return `#/c/${encodeURIComponent(name)}`;
}

function categoryOf(file) {
  return file.path.split("/")[0];
}

function fileNameOf(file) {
  return file.path.split("/").pop();
}

const STATS_PREFIX = "/walls";

function countPageview(path, title) {
  const gc = window.goatcounter;
  if (typeof gc?.count !== "function") return;
  try {
    gc.count({ path, title, event: false });
  } catch {
    void 0;
  }
}

function routePath(route) {
  if (route.name === "category") return `${STATS_PREFIX}/c/${route.category}`;
  if (route.name === "random") return `${STATS_PREFIX}/random`;
  if (route.name === "popular") return `${STATS_PREFIX}/popular`;
  return `${STATS_PREFIX}/`;
}

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(items, seed) {
  const out = items.slice();
  const rand = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function dailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

function mediaNode(file, lazy = true, deferPoster = false) {
  const url = fileURL(file);
  const thumb = thumbURL(file);
  if (file.kind === "video") {
    const ratio = file.width && file.height ? `aspect-ratio: ${file.width} / ${file.height}` : null;
    return el("video", {
      src: url,
      muted: "",
      loop: "",
      playsinline: "",
      preload: "none",
      poster: deferPoster ? null : thumb,
      "data-poster": deferPoster ? thumb : null,
      style: ratio,
    });
  }
  const image = el("img", {
    src: thumb ?? url,
    alt: file.stem,
    width: file.width ?? null,
    height: file.height ?? null,
    loading: lazy ? "lazy" : "eager",
    decoding: "async",
    onerror: () => {
      image.onerror = null;
      image.src = url;
    },
  });
  return image;
}

function disposeGrids(root) {
  root.querySelectorAll(".grid").forEach((node) => node.cleanupGrid?.());
}

function grid(files, showViews = false) {
  const host = el("div", { class: "grid" });
  const row = el("div", { class: "grid-cols" });
  const sentinel = el("div", { class: "grid-sentinel" });
  host.append(row);
  let columns = [];
  const placed = [];
  let index = 0;
  let frame = 0;

  const card = (file, position) =>
    el(
      "button",
      {
        class: "card",
        type: "button",
        "aria-label": file.stem,
        title: showViews && file.views != null ? `${file.views} ${file.views === 1 ? "view" : "views"}` : null,
        onclick: () => openLightbox(files, position),
      },
      mediaNode(file, true, true)
    );

  const columnCount = (width) =>
    width <= 640
      ? Math.max(1, Math.min(2, Math.floor((width + COLUMN_GAP) / (140 + COLUMN_GAP))))
      : Math.max(1, Math.min(4, Math.floor((width + COLUMN_GAP) / (240 + COLUMN_GAP))));

  const buildColumns = () => {
    const count = columnCount(host.clientWidth || 1);
    row.replaceChildren(...Array.from({ length: count }, () => el("div", { class: "col" })));
    columns = [...row.children].map((node) => ({ node, height: 0 }));
  };

  const measureColumns = () => {
    for (const column of columns) {
      let height = 0;
      for (const node of column.node.children) height += node.offsetHeight + COLUMN_GAP;
      column.height = height;
    }
  };

  const shortestColumn = () => columns.reduce((a, b) => (b.height < a.height ? b : a));

  const estimatedHeight = (file) => {
    const width = columns[0].node.clientWidth || 200;
    const ratio = file.width && file.height ? file.width / file.height : 16 / 9;
    return (width - 2) / ratio + 2;
  };

  const loadMore = () => {
    const end = Math.min(index + BATCH_SIZE, files.length);
    for (; index < end; index++) {
      const node = card(files[index], index);
      placed.push(node);
      const target = shortestColumn();
      target.node.append(node);
      target.height += estimatedHeight(files[index]) + COLUMN_GAP;
    }
    measureColumns();
    for (const video of host.querySelectorAll("video[data-poster]")) observer.observe(video);
    return index >= files.length;
  };

  const rebuild = () => {
    buildColumns();
    for (const node of placed) {
      const target = shortestColumn();
      target.node.append(node);
      target.height += node.offsetHeight + COLUMN_GAP;
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target;
        observer.unobserve(target);
        if (target === sentinel) {
          if (loadMore()) {
            sentinel.remove();
            observer.disconnect();
          } else {
            observer.observe(sentinel);
          }
        } else if (target.dataset.poster) {
          target.setAttribute("poster", target.dataset.poster);
          target.removeAttribute("data-poster");
        }
      }
    },
    { rootMargin: BATCH_ROOT_MARGIN }
  );

  const onResize = () => {
    if (host.isConnected && columns.length && columnCount(host.clientWidth) !== columns.length) rebuild();
  };

  frame = requestAnimationFrame(() => {
    frame = 0;
    if (!host.isConnected) return;
    buildColumns();
    if (!loadMore()) {
      host.append(sentinel);
      observer.observe(sentinel);
    }
  });

  window.addEventListener("resize", onResize);
  host.cleanupGrid = () => {
    if (frame) cancelAnimationFrame(frame);
    window.removeEventListener("resize", onResize);
    observer.disconnect();
  };
  return host;
}

function openLightbox(items, index) {
  lbContext.items = items;
  lbContext.index = index;
  lightbox.hidden = false;
  document.body.classList.add("no-scroll");
  showLightbox();
}

function closeLightbox() {
  lightbox.hidden = true;
  document.body.classList.remove("no-scroll");
  lbMedia.replaceChildren();
}

function stepLightbox(delta) {
  const total = lbContext.items.length;
  if (!total) return;
  lbContext.index = (lbContext.index + delta + total) % total;
  showLightbox();
}

history.scrollRestoration = "manual";

const scrollMemory = new Map();
let currentUid = null;
let traversing = false;
let restoreToken = 0;
let lastTraversalAt = -Infinity;
const RESTORE_DEADLINE = 2000;

function entryUid() {
  const uid = history.state?.uid;
  if (uid) return uid;
  const fresh = `s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  history.replaceState({ ...(history.state ?? {}), uid: fresh }, "");
  return fresh;
}

function saveScroll() {
  if (currentUid) scrollMemory.set(currentUid, window.scrollY);
}

function invalidateRestore() {
  restoreToken++;
}

function restoreScroll() {
  const token = ++restoreToken;
  const target = Math.max(0, scrollMemory.get(currentUid) ?? 0);
  const deadline = performance.now() + RESTORE_DEADLINE;
  const detach = () => {
    window.removeEventListener("wheel", cancel);
    window.removeEventListener("touchmove", cancel);
    window.removeEventListener("keydown", cancel);
  };
  const cancel = () => {
    restoreToken = Math.max(restoreToken, token + 1);
    detach();
  };
  let lastSet = null;
  const nudge = () => {
    if (token !== restoreToken) return detach();
    if (lastSet != null && Math.abs(window.scrollY - lastSet) > 2) return cancel();
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const y = Math.min(target, Math.max(0, max));
    if (window.scrollY < y) {
      window.scrollTo(0, y);
      lastSet = y;
    }
    if (window.scrollY >= target || performance.now() > deadline) return cancel();
    requestAnimationFrame(nudge);
  };
  window.addEventListener("wheel", cancel, { passive: true });
  window.addEventListener("touchmove", cancel, { passive: true });
  window.addEventListener("keydown", cancel);
  requestAnimationFrame(nudge);
}

function onHashChange() {
  if (performance.now() - lastTraversalAt < 100) return;
  saveScroll();
  traversing = false;
  currentUid = entryUid();
  render();
}

function onPopState() {
  lastTraversalAt = performance.now();
  saveScroll();
  traversing = true;
  currentUid = entryUid();
  render();
}

function showLightbox() {
  const file = lbContext.items[lbContext.index];
  if (!file) return closeLightbox();
  const url = fileURL(file);
  lbMedia.replaceChildren(
    file.kind === "video"
      ? el("video", { src: url, controls: "", autoplay: "", loop: "", playsinline: "" })
      : el("img", { src: url, alt: file.stem, decoding: "async" })
  );
  lbCaption.replaceChildren(
    el("span", { class: "lb-title" }, file.stem),
    el("a", { class: "chip", href: categoryURL(categoryOf(file)) }, categoryOf(file)),
    el("button", { class: "btn", type: "button", onclick: () => downloadFile(file) }, "Download")
  );
  countPageview(`${STATS_PREFIX}/w/${file.path}`, file.stem);
}

async function downloadFile(file) {
  const url = fileURL(file);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const blob = await res.blob();
    const a = el("a", { href: URL.createObjectURL(blob), download: fileNameOf(file) });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

lightbox.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "close") closeLightbox();
  else if (action === "prev") stepLightbox(-1);
  else if (action === "next") stepLightbox(1);
});

document.addEventListener("keydown", (e) => {
  if (lightbox.hidden) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") stepLightbox(-1);
  else if (e.key === "ArrowRight") stepLightbox(1);
});

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return { name: "home", params };
  if (parts[0] === "c" && parts[1]) return { name: "category", category: decodeURIComponent(parts[1]), params };
  if (parts[0] === "random") return { name: "random", params };
  if (parts[0] === "popular") return { name: "popular", params };
  return { name: "home", params };
}

function setActiveNav(name) {
  document.querySelectorAll(".nav [data-nav]").forEach((a) => {
    a.classList.toggle("active", a.dataset.nav === name);
  });
}

function emptyState() {
  return el(
    "section",
    { class: "panel placeholder" },
    el("p", null, "The manifest is empty."),
    el("p", { class: "muted" }, "Add categories with wallpapers, then regenerate the manifest.")
  );
}

function viewHome() {
  const files = allFiles();
  if (!files.length) return emptyState();
  const picks = shuffled(files, dailySeed()).slice(0, 6);
  const categories = state.manifest.categories.map((category) => {
    const preview = shuffled(category.files, fnv(category.name))[0];
    return el(
      "a",
      { class: "cat-card", href: categoryURL(category.name) },
      el("div", { class: "cat-thumb" }, preview ? mediaNode(preview) : null),
      el(
        "div",
        { class: "cat-meta" },
        el("span", { class: "cat-name" }, category.name),
        el("span", { class: "cat-count" }, `${category.files.length} items`)
      )
    );
  });
  return el(
    "div",
    null,
    el(
      "section",
      { class: "hero" },
      el("h1", null, "Walls"),
      el("p", { class: "muted" }, "Browse the wallpaper collection by category, or roll the dice."),
      el(
        "div",
        { class: "hero-actions" },
        el("a", { class: "btn primary", href: "#/random" }, "Surprise me"),
        el(
          "button",
          { class: "btn", type: "button", onclick: () => document.getElementById("categories").scrollIntoView({ behavior: "smooth" }) },
          "Browse categories"
        )
      )
    ),
    el("section", null, el("h2", null, "Today's picks"), grid(picks)),
    el("section", { id: "categories" }, el("h2", null, "Categories"), el("div", { class: "cat-grid" }, categories))
  );
}

function viewCategory(name) {
  const category = state.manifest.categories.find((c) => c.name === name);
  if (!category) {
    return el(
      "section",
      { class: "panel placeholder" },
      el("p", null, `Category "${name}" not found.`),
      el("p", null, el("a", { href: "#/" }, "Back to home"))
    );
  }
  let filterText = "";
  let sortBy = "name";
  let randomSeed = fnv(name);
  const gridHost = el("div");

  const apply = () => {
    let files = category.files.filter((f) => f.stem.toLowerCase().includes(filterText));
    if (sortBy === "views")
      files = files.slice().sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || a.stem.localeCompare(b.stem));
    else if (sortBy === "random") files = shuffled(files, randomSeed);
    else files = files.slice().sort((a, b) => a.stem.localeCompare(b.stem));
    return files;
  };
  const rerender = () => {
    disposeGrids(gridHost);
    gridHost.replaceChildren(grid(apply()));
  };

  const search = el("input", {
    class: "input",
    type: "search",
    placeholder: `Filter ${category.files.length} items by name`,
    oninput: (e) => {
      filterText = e.target.value.trim().toLowerCase();
      rerender();
    },
  });
  const reroll = el("button", {
    class: "btn",
    type: "button",
    hidden: "hidden",
    onclick: () => {
      randomSeed = (Math.random() * 2 ** 31) | 0;
      rerender();
    },
  }, "Shuffle");
  const sortSelect = el(
    "select",
    {
      class: "input",
      onchange: (e) => {
        sortBy = e.target.value;
        reroll.hidden = sortBy !== "random";
        if (sortBy === "random") randomSeed = (Math.random() * 2 ** 31) | 0;
        rerender();
      },
    },
    el("option", { value: "name" }, "Name"),
    el("option", { value: "views" }, "Views"),
    el("option", { value: "random" }, "Random")
  );

  rerender();
  return el(
    "section",
    null,
    el(
      "div",
      { class: "page-head" },
      el("a", { class: "btn ghost", href: "#/" }, "\u2190 All categories"),
      el("h2", { class: "page-title" }, name),
      el("span", { class: "muted" }, `${category.files.length} items`)
    ),
    el("div", { class: "toolbar" }, search, sortSelect, reroll),
    gridHost
  );
}

function viewRandom(params) {
  const files = allFiles();
  if (!files.length) return emptyState();
  const n = Math.min(Math.max(parseInt(params.get("n") || "6", 10) || 6, 1), 24);
  const host = el("div");
  const draw = () => {
    disposeGrids(host);
    host.replaceChildren(grid(shuffled(files, (Math.random() * 2 ** 31) | 0).slice(0, n)));
  };
  draw();
  return el(
    "section",
    null,
    el(
      "div",
      { class: "page-head" },
      el("h2", { class: "page-title" }, "Random"),
      el("span", { class: "muted" }, `${n} items`),
      el("button", { class: "btn primary", type: "button", onclick: draw }, "Reroll")
    ),
    host
  );
}

function viewPopular() {
  if (!hasViews()) {
    return el(
      "section",
      null,
      el("div", { class: "page-head" }, el("h2", { class: "page-title" }, "Popular")),
      el(
        "div",
        { class: "panel placeholder" },
        el("p", null, "No view data yet."),
        el("p", { class: "muted" }, "Popularity tracking is not wired up yet. Once a stats source is connected, the most viewed wallpapers will be ranked here.")
      )
    );
  }
  const ranked = allFiles()
    .filter((file) => file.views != null)
    .sort((a, b) => b.views - a.views)
    .slice(0, 60);
  return el(
    "section",
    null,
    el(
      "div",
      { class: "page-head" },
      el("h2", { class: "page-title" }, "Popular"),
      el("span", { class: "muted" }, "top 60")
    ),
    grid(ranked, true)
  );
}

async function render() {
  invalidateRestore();
  const route = parseRoute();
  setActiveNav(route.name);
  try {
    await ensureManifest();
    await ensureStats();
  } catch (err) {
    $app.replaceChildren(el("section", { class: "panel error" }, `Failed to load manifest: ${err.message}`));
    return;
  }
  const view =
    route.name === "category"
      ? viewCategory(route.category)
      : route.name === "random"
        ? viewRandom(route.params)
        : route.name === "popular"
          ? viewPopular()
          : viewHome();
  disposeGrids($app);
  $app.replaceChildren(view);
  countPageview(routePath(route), document.title);
  if (traversing) restoreScroll();
  else window.scrollTo(0, 0);
}

currentUid = entryUid();
window.addEventListener("hashchange", onHashChange);
window.addEventListener("popstate", onPopState);
render();
