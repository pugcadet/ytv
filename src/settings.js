/* YTV — settings page. Builds every control with DOM APIs (no innerHTML). */
(() => {
  "use strict";
  const SW = globalThis.SW;
  const $ = (id) => document.getElementById(id);
  let cfg;
  let current = "channels";
  let lastSaved = "";

  // ------------------------------------------------------------ helpers
  const h = (tag, props = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, "");
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  };
  // Save a cleaned copy, but keep editing the same in-memory object (editors hold references into it).
  const save = async () => {
    const clean = SW.sanitizeConfig(cfg);
    lastSaved = SW.stableStringify(clean);
    await chrome.storage.local.set({ cfg: clean });
    renderMaster();
    drawPreview();
    refreshMarks();
    if (demoRefresh && current === "lists" && document.querySelector(".sdemo")) demoRefresh();
  };
  const switchEl = (checked, onchange, label) => {
    const input = h("input", { type: "checkbox", "aria-label": label });
    input.checked = checked;
    input.addEventListener("change", () => onchange(input.checked));
    return h("span", { class: "switch" }, input, h("span"));
  };
  // ---- every setting has a path ("tv.look.topAlpha") and a default: a block can put itself back, and shows what you changed
  let DEF = null;
  const defaults = () => DEF || (DEF = SW.sanitizeConfig({ tv: { twitch: { seeded: true } } }));
  const getAt = (o, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
  const setAt = (o, path, v) => { const ks = path.split("."), last = ks.pop(); const t = ks.reduce((x, k) => x[k], o); t[last] = v; };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const P = (path) => ({ get: () => getAt(cfg, path), set: (v) => setAt(cfg, path, v) });
  const pathsOf = (el) => (el.dataset.paths || "").split(" ").filter(Boolean);
  const isChanged = (paths) => paths.some((p) => !same(getAt(cfg, p), getAt(defaults(), p)));
  // Each setting you changed gets a small ↺ next to its name: one click puts just that setting back to how YTV comes.
  const tagRow = (el, paths) => {
    if (!paths || !paths.length) return el;
    el.dataset.paths = paths.join(" "); el.classList.toggle("changed", isChanged(paths));
    const b = h("button", { type: "button", class: "rreset", text: "↺", title: "Back to default", "aria-label": "Put this setting back to its default", onclick: async (e) => {
      e.preventDefault(); e.stopPropagation(); // (inside a label: don't flip the switch as well)
      for (const p of paths) setAt(cfg, p, structuredClone(getAt(defaults(), p)));
      await save(); render();
    } });
    const name = el.querySelector(":scope > .label > span:first-child");
    (name || el).append(b);
    return el;
  };
  const allPaths = (el) => [...new Set([...(el.matches("[data-paths]") ? [el] : []), ...el.querySelectorAll("[data-paths]")].flatMap(pathsOf))];
  const refreshMarks = () => {
    for (const r of document.querySelectorAll("#main [data-paths]")) r.classList.toggle("changed", isChanged(pathsOf(r)));
    for (const c of document.querySelectorAll("#main .card")) { const b = c.querySelector(":scope > .card-head .reset"); if (b) b.disabled = !isChanged(allPaths(c)); }
  };
  const row = (label, control, hint, asLabel = false, paths = null) =>
    tagRow(h(asLabel ? "label" : "div", { class: "row" }, h("span", { class: "label" }, h("span", { text: label }), hint ? h("span", { class: "hint", text: hint }) : null), control), paths);
  // A block of settings. Its title can be { title, area, noReset }: area is the part of the preview it changes (lit up
  // while you point at the block); "Reset to default" puts every setting in it back to how YTV comes.
  const card = (title, intro, ...rows) => {
    const o = title && typeof title === "object" ? title : { title };
    const kids = rows.flat().filter((x) => x != null);
    const el = h("div", { class: "card" });
    if (o.area) el.dataset.area = o.area;
    const paths = o.noReset ? [] : [...new Set(kids.filter((k) => k && k.nodeType === 1).flatMap(allPaths))];
    const reset = paths.length ? h("button", { type: "button", class: "reset", text: "↺ Reset to default", title: "Put the settings in this block back to how YTV comes", disabled: !isChanged(paths), onclick: async () => {
      for (const p of paths) setAt(cfg, p, structuredClone(getAt(defaults(), p)));
      await save(); render();
    } }) : null;
    if (o.title || reset) el.append(h("div", { class: "card-head" }, o.title ? h("h2", { text: o.title }) : h("span"), reset));
    if (intro) el.append(h("p", { text: intro }));
    el.append(...kids);
    return el;
  };
  const page = (title, lead, ...content) => {
    const head = h("div", { class: "titlebar" }, h("div", {}, h("h1", { text: title }), lead ? h("p", { class: "lead", text: lead }) : null));
    if (pageTarget) { pageTarget.replaceChildren(head, ...content.flat().filter((x) => x != null)); return; } // building the search index
    $("main").replaceChildren(head, ...content.flat().filter((x) => x != null));
    if (current !== lastPage) { window.scrollTo(0, 0); lastPage = current; }
    drawPreview();
  };
  let lastPage = "", pageTarget = null;
  // a switch; give it a setting's path (and true to redraw the page), or a get / set pair
  const toggle = (label, hint, get, set, redraw = false) => {
    let paths = null;
    if (typeof get === "string") { paths = [get]; redraw = set === true; ({ get, set } = P(get)); }
    return row(label, switchEl(get(), async (v) => { set(v); await save(); if (redraw) render(); }, label), hint, true, paths);
  };
  // A slider with its value next to it: what it shows changes as you drag (and the preview with it), saved when you let go.
  const slider = (label, hint, { min, max, step, get, set, fmt, path }) => {
    if (path) ({ get, set } = P(path));
    const out = h("span", { class: "hint val", text: fmt(get()) });
    const inp = h("input", { type: "range", min, max, step, value: get(), "aria-label": label });
    let t = 0;
    inp.addEventListener("input", () => { out.textContent = fmt(Number(inp.value)); set(Number(inp.value)); cancelAnimationFrame(t); t = requestAnimationFrame(drawPreview); });
    inp.addEventListener("change", async () => { set(Number(inp.value)); await save(); });
    return row(label, h("span", { class: "inline slider" }, inp, out), hint, false, path ? [path] : null);
  };
  const pct = (n) => n + "%";
  const ms = (n) => (n ? n + " ms" : "Off");

  // ------------------------------------------------------------ swipe demo
  // A few rows that swipe exactly like YTV's, with your current settings, to try them out right here.
  let demoRefresh = null;
  const SVGNS = "http://www.w3.org/2000/svg";
  const sIcon = (d) => { const s = document.createElementNS(SVGNS, "svg"); s.setAttribute("viewBox", "0 0 24 24"); const p = document.createElementNS(SVGNS, "path"); p.setAttribute("d", d); s.append(p); return s; };
  const PLUS_D = "M12 5v14M5 12h14", TRASH_D = "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13";
  // a made-up video still: a sky, hills and a sun, with the length in the corner
  const thumbMock = (i, len, progress = 0) => {
    const hue = (i * 47 + 190) % 360;
    const th = h("div", { class: "mth", style: `--h:${hue}` }, h("span", { class: "mlen", text: len }));
    if (progress) th.append(h("span", { class: "mpg", style: `width:${progress}%` }));
    return th;
  };
  const swipeDemo = () => {
    const tv = cfg.tv;
    const box = h("div", { class: "sdemo" });
    const note = h("p", { class: "muted small", text: "" });
    const rowsData = PV_ROWS.slice(1, 6);
    const setVars = () => { for (const [k, v] of Object.entries({ "--addc": tv.swipeAddColor, "--rmc": tv.swipeRmColor, "--aico": tv.swipeIconPx + "px", "--acc": tv.theme.accent, "--pnl": tv.theme.panel,
      "--tw": tv.thumbPx + "px", "--rowh": Math.round(Math.max(tv.rowPx, tv.thumbPx * 9 / 16 + 10)) + "px", "--lines": tv.titleLines, "--fs": tv.textPx + "px", "--fs2": tv.metaPx + "px",
      "--rrad": tv.look.rowRadius + "px", "--rgap": tv.look.rowGap + "px" })) box.style.setProperty(k, String(v)); };
    const leave = (w, kind) => {
      const total = tv.swipeFadeMs, fade = Math.round(total * 0.55), h0 = w.offsetHeight;
      note.textContent = kind === "add" ? (tv.swipeMove ? "Added to your Feed — it leaves this list." : "Added to your Feed.") : "Removed.";
      if (kind === "add" && !tv.swipeMove) { w.scrollTo({ left: w._R, behavior: "smooth" }); w.querySelector(".item").animate([{ background: "var(--addc)" }, {}], { duration: 500, easing: "ease" }); setTimeout(() => { w._busy = false; }, 450); return; }
      w.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade, easing: "ease", fill: "forwards" }).onfinish = () =>
        w.animate([{ height: h0 + "px", marginBottom: getComputedStyle(w).marginBottom }, { height: "0px", marginBottom: "0px" }], { duration: total - fade, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }).onfinish = () => w.remove();
    };
    const row = ([title, meta], i) => {
      const R = Math.max(80, Math.min(tv.swipeThreshold * 2, 240));
      const leftAdd = !tv.swipeFlip;
      const w = h("div", { class: "dsw" }); w._R = R; w.style.setProperty("--R", R + "px");
      const L = h("div", { class: "act left " + (leftAdd ? "add" : "rm") }, sIcon(leftAdd ? PLUS_D : TRASH_D));
      const Rt = h("div", { class: "act right " + (leftAdd ? "rm" : "add") }, sIcon(leftAdd ? TRASH_D : PLUS_D));
      const [who, age, len] = meta.split(" · ");
      const bits = { title, creator: who, age, len }, line = (n) => tv.rowFields.filter(([, l]) => l === n).map(([f]) => bits[f]).filter(Boolean).join(" · ");
      const item = h("div", { class: "item" + (i === 0 ? " cur" : "") }, thumbMock(i, len, i === 1 ? 40 : 0), h("div", { class: "txt" }, h("div", { class: "it", text: line(1) }), h("div", { class: "ic", text: line(2) })));
      w.append(h("div", { class: "track" }, L, item, Rt));
      requestAnimationFrame(() => { w.scrollLeft = R; });
      let user = 0, side = 0;
      w.addEventListener("wheel", (e) => { if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) user = performance.now(); }, { passive: true });
      w.addEventListener("scroll", () => {
        if (w._busy || performance.now() - user > 1500) return;
        const d = R - w.scrollLeft;
        if (Math.abs(d) > 10 && !side) side = Math.sign(d);
        if (side && Math.sign(d) === -side && tv.swipeHoldMs > 0) { side = 0; w.scrollLeft = R; w.style.overflowX = "hidden"; setTimeout(() => { w.style.overflowX = ""; }, tv.swipeHoldMs); return; }
        w.style.setProperty("--p", String(Math.min(1, Math.abs(d) / (R / 2))));
        w.classList.toggle("armed", Math.abs(d) >= R / 2);
        const max = w.scrollWidth - w.clientWidth;
        if (i === 0) return; // what's playing can't be swiped away
        if (w.scrollLeft <= 1 || w.scrollLeft >= max - 1) { w._busy = true; leave(w, (w.scrollLeft <= 1) === leftAdd ? "add" : "rm"); }
      });
      w.addEventListener("scrollend", () => { side = 0; if (!w._busy && Math.abs(w.scrollLeft - R) > 2) w.scrollTo({ left: R, behavior: "smooth" }); w.classList.remove("armed"); w.style.setProperty("--p", "0"); });
      return w;
    };
    const fill = () => { setVars(); box.replaceChildren(...rowsData.map(row)); note.textContent = "Swipe a row sideways with two fingers. The first one is playing, so it stays."; };
    demoRefresh = fill;
    fill();
    return card("Try it", null, box, h("div", { class: "inline" }, h("button", { type: "button", text: "Reset the rows", onclick: fill }), note));
  };

  // ------------------------------------------------------------ preview
  // A YTV screen drawn from your current settings, beside the pages that change how it looks. Point at a block of
  // settings and the part of the screen it changes lights up; sliders update it while you drag.
  const PREVIEW_ON = new Set(["lists", "look", "topbar", "overview", "twitch"]);
  const PV_ROWS = [["A quiet walk through the Dutch dunes", "Natuur Kanaal · 3 days ago · 18:24"], ["How octopuses change colour", "Deep Blue · 1 week ago · 12:07"],
    ["The last wild horses of Mongolia, a full documentary about the steppe", "Wild Lens · 2 weeks ago · 44:51"], ["Kingfisher dives in slow motion", "Field Notes · 5 days ago · 6:33"],
    ["Storm chasing over the North Sea", "Slow Earth · 1 month ago · 21:10"], ["Inside a beaver lodge", "Natuur Kanaal · 2 months ago · 9:48"], ["Puffins on the Faroe Islands", "Wild Lens · 3 months ago · 15:02"]];
  const PV_CHAT = [["Kappa_King", "#ff7a7a", "that was so clean"], ["mod_ollie", "#6fd6ff", "GG"], ["lurker42", "#8ee88e", "how is he this lucky every single time"], ["Frogfan", "#ffe07a", "POG"],
    ["sasha_b", "#d69bff", "first time catching the stream live, hi all"], ["tavern_tom", "#ffb36b", "wait for the next turn"], ["Kappa_King", "#ff7a7a", "called it"], ["deckbuilder", "#9ea7ff", "that card is so underrated"],
    ["mod_ollie", "#6fd6ff", "remember to stay hydrated chat"], ["Zed", "#7ff0d0", "LUL"], ["lurker42", "#8ee88e", "unreal"], ["sasha_b", "#d69bff", "W streamer"]];
  const pvIcon = (d) => { const s = document.createElementNS("http://www.w3.org/2000/svg", "svg"); s.setAttribute("viewBox", "0 0 24 24"); const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p); return s; };
  const PV_ACTS = ["M11 4a7 7 0 1 1 0 14a7 7 0 1 1 0-14 M20 20l-4-4", "M9 8a4 4 0 1 0 0 .01M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6", "M3 3l18 18M10.6 5.1A10 10 0 0 1 22 12a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.7 9.7 0 0 0 4.4-1",
    "M12 8v.01M11 12h1v4h1M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18", "M4 4h16v12H8l-4 4z"];
  let hlArea = "";
  const applyHl = () => {
    const want = hlArea.split(" ").filter(Boolean);
    for (const n of document.querySelectorAll("#preview [data-area]")) n.classList.toggle("pv-hl", want.some((a) => n.dataset.area.split(" ").includes(a)));
  };
  const setHl = (a) => { if (a !== hlArea) { hlArea = a; applyHl(); } };
  $("main").addEventListener("mouseover", (e) => { const c = e.target.closest && e.target.closest("[data-area]"); setHl(c ? c.dataset.area : ""); });
  $("main").addEventListener("mouseleave", () => setHl(""));
  $("main").addEventListener("focusin", (e) => { const c = e.target.closest && e.target.closest("[data-area]"); if (c) setHl(c.dataset.area); });
  const screenVars = (tv) => ({ "--acc": tv.theme.accent, "--pnl": tv.theme.panel, "--tw": tv.thumbPx + "px", "--rowh": Math.round(Math.max(tv.rowPx, tv.thumbPx * 9 / 16 + 10)) + "px",
    "--lines": tv.titleLines, "--fs": tv.textPx + "px", "--fs2": tv.metaPx + "px",
    "--trad": tv.look.topRadius + "px", "--tpady": tv.look.topPadY + "px", "--tpadx": tv.look.topPadX + "px", "--tfade": tv.look.topFade + "px", "--treach": tv.look.topBlurReach / 100, "--tbg": tv.look.topBg || tv.theme.panel, "--talpha": tv.look.topAlpha + "%", "--tblur": tv.look.topBlur + "px",
    "--tfs": tv.look.topTitlePx + "px", "--tfs2": tv.look.topMetaPx + "px", "--palpha": tv.look.panelAlpha + "%", "--pblur": tv.look.panelBlur + "px", "--prad": tv.look.panelRadius + "px",
    "--pgap": tv.look.panelGap + "px", "--rrad": tv.look.rowRadius + "px", "--rgap": tv.look.rowGap + "px", "--ralpha": tv.look.rowAlpha + "%", "--hb": tv.hbSize + "px", "--ui": tv.uiScale / 100,
    "--tabh": tv.look.tabHeight + "px", "--tabp": tv.look.tabPad + "px", "--tabw": tv.look.tabWidth + "px", "--tabs": tv.look.tabScale / 100 });
  const pvTop = (tv, bits) => {
    const pLine = (n, cls) => { const parts = []; for (const [f] of tv.topFields.filter(([, l]) => l === n)) { if (!bits[f]) continue; if (parts.length && f !== "channel") parts.push(h("span", { class: "pv-sep", text: " · " })); parts.push(f === "channel" ? h("span", { class: "pv-chn", text: bits[f] }) : h("span", { class: f === "title" ? "" : "pv-dim", text: bits[f] })); } return parts.length ? h("div", { class: cls }, ...parts) : null; };
    return h("div", { class: "pv-top", "data-area": "top" }, h("div", { class: "pv-now" }, pLine(1, "pv-t"), pLine(2, "pv-c")), h("div", { class: "pv-acts" }, ...PV_ACTS.map((d) => h("span", { class: "pv-ab" }, pvIcon(d)))));
  };
  const pvTabs = (names) => h("div", { class: "pv-tabs", "data-area": "tabs" }, h("span", { class: "pv-tab" }, "Feed ", h("i", { text: "3" })), ...names.map((n, i) => h("span", { class: "pv-tab" + (i === 0 ? " sel" : "") }, i === 0 ? h("b", { class: "pv-live" }) : null, n)), h("span", { class: "pv-tab dim", text: "+" }));
  const pvChatLines = (n) => PV_CHAT.slice(-n).map(([u, col, t]) => h("div", { class: "pv-cm" }, h("b", { text: u, style: `color:${col}` }), h("span", { text: " " + t })));
  const listScreen = (tv) => {
    const screen = h("div", { class: `pv-screen top-${tv.topStyle}` });
    const [pWho, pAge, pLen] = PV_ROWS[0][1].split(" · ");
    const rows = PV_ROWS.map(([t, c], i) => h("div", { class: "pv-row" + (i === 0 ? " cur" : "") + (i === 2 ? " hover" : "") },
      h("div", { class: "pv-th mth", style: `--h:${(i * 47 + 190) % 360}` }, h("span", { class: "mlen", text: c.split(" · ")[2] }),
        ...(i === 2 ? [tv.hbExplore ? h("span", { class: "pv-hb l", "data-area": "buttons" }, pvIcon("M11 4a7 7 0 1 1 0 14a7 7 0 1 1 0-14 M20 20l-4-4")) : null, tv.hbWl ? h("span", { class: "pv-hb r", "data-area": "buttons" }, pvIcon("M12 7v5l3 2M12 3a9 9 0 1 1 0 18a9 9 0 1 1 0-18")) : null] : [])),
      (() => { const [who, age, len] = c.split(" · "), bits = { title: t, creator: who, age, len }, line = (n) => tv.rowFields.filter(([, l]) => l === n).map(([f]) => bits[f]).filter(Boolean).join(" · ");
        const l1 = line(1), l2 = line(2); return h("div", { class: "pv-tx" }, l1 ? h("div", { class: "pv-it", text: l1 }) : null, l2 ? h("div", { class: "pv-ic", text: l2 }) : null); })()));
    const panel = h("div", { class: "pv-panel", "data-area": "panel" }, pvTabs(["Nature", "Science"]), h("div", { class: "pv-list", "data-area": "rows" }, ...rows));
    screen.append(h("div", { class: "pv-video" }), h("div", { class: "pv-tv" }, pvTop(tv, { title: PV_ROWS[0][0], age: pAge, creator: pWho, len: pLen, channel: "Nature" }), panel));
    return screen;
  };
  // Twitch: a stream with the chat over the video and in the list panel, both as you set them
  const twitchScreen = (tv) => {
    const c = tv.twitch.chat, screen = h("div", { class: `pv-screen top-${tv.topStyle}` });
    const ov = h("div", { class: "pv-chatv" + (c.show ? "" : " off"), "data-area": "chatv" }, ...pvChatLines(Math.min(c.max, 9)), c.show ? null : h("span", { class: "pv-off", text: "Off — O or Shift+O shows it" }));
    ov.style.setProperty("--cfs", c.size + "px"); ov.style.setProperty("--cbg", (c.bg / 100).toFixed(2));
    if (c.box) Object.assign(ov.style, { left: c.box.x * 100 + "%", top: c.box.y * 100 + "%", width: c.box.w * 100 + "%", height: c.box.h * 100 + "%", bottom: "auto" });
    else ov.classList.add(c.side === "right" ? "right" : "left");
    const pc = h("div", { class: "pv-chatp", "data-area": "chatp" }, ...pvChatLines(12));
    pc.style.setProperty("--cfs", c.panelSize + "px"); pc.style.setProperty("--cbg", (c.panelBg / 100).toFixed(2));
    const panel = h("div", { class: "pv-panel see", "data-area": "panel" }, pvTabs(["Twitch", "Nature"]), pc);
    screen.append(h("div", { class: "pv-video tw", "data-area": "stream" }), h("div", { class: "pv-tv" }, pvTop(tv, { title: "Speedrun practice, chill games", age: "Just Chatting", creator: "SomeStreamer", len: "12K watching", channel: "Twitch" }), ov, panel));
    return screen;
  };
  // the channel overview (G), in the layout you picked
  const PV_CHANS = [["Feed", "Your own list"], ["Home", "Your home feed"], ["Nature", "3 topics"], ["Science", "2 topics · 4 creators"], ["Twitch", "Live now"], ["Racing", "1 topic"], ["Cooking", "5 creators"], ["Watch Later", "Your Watch Later list"]];
  const overviewScreen = (tv) => {
    const screen = h("div", { class: "pv-screen" });
    const cards = PV_CHANS.map(([name, src], i) => {
      const r = PV_ROWS[(i * 3) % PV_ROWS.length], next = [PV_ROWS[(i * 3 + 1) % PV_ROWS.length], PV_ROWS[(i * 3 + 2) % PV_ROWS.length]];
      return h("div", { class: "pg-card" + (i === 2 ? " on" : "") },
        h("div", { class: "pg-chd" }, h("span", { class: "pg-n", text: String(i) }), h("span", { class: "pg-nm", text: name })),
        h("div", { class: "pg-cb" }, h("div", { class: "mth", style: `--h:${(i * 61 + 200) % 360}` }),
          h("div", { class: "pg-ntx" }, h("div", { class: "pg-nt" }, h("span", { class: "pg-lbl", text: "Now " }), r[0]), h("div", { class: "pg-nw", text: r[1] }),
            h("div", { class: "pg-nxl" }, ...next.map((x) => h("div", { class: "pg-nx" }, h("span", { class: "pg-lbl", text: "Next " }), x[0])))),
          h("div", { class: "pg-strip" }, ...[1, 2, 3].map((k) => h("div", { class: "mth", style: `--h:${(i * 61 + k * 40 + 200) % 360}` }))),
          h("div", { class: "pg-nxv" }, ...[1, 2, 3].map((k) => h("div", { class: "pg-nv" }, h("div", { class: "mth", style: `--h:${(i * 61 + k * 40 + 200) % 360}` }), h("div", { class: "pg-nx" }, h("span", { class: "pg-lbl", text: "Next " }), PV_ROWS[(i * 3 + k) % PV_ROWS.length][0]))))),
        h("div", { class: "pg-cs", text: src }));
    });
    screen.append(h("div", { class: "pv-video" }), h("div", { class: `pv-guide gl-${tv.guideLayout}`, "data-area": "guide" }, h("div", { class: "pg-h", text: "Channels" }), h("div", { class: "pg-cards" }, ...cards)));
    return screen;
  };
  const PV_CAPTION = { lists: "Your list, close up, with your current settings.", look: "YTV on a 1280 × 720 screen with your current settings.", topbar: "The top bar over the video, with your current settings.",
    overview: "The channel overview (G) in the layout you picked.", twitch: "A stream with its chat over the video (left) and in the list panel (right)." };
  const drawPreview = () => {
    const box = $("preview");
    const show = PREVIEW_ON.has(current);
    box.classList.toggle("hidden", !show);
    document.body.classList.toggle("has-preview", show);
    if (!show || !cfg) return;
    const tv = cfg.tv, W = 1280, H = 720;
    const screen = current === "twitch" ? twitchScreen(tv) : current === "overview" ? overviewScreen(tv) : listScreen(tv);
    for (const [k, v] of Object.entries(screenVars(tv))) screen.style.setProperty(k, String(v));
    const frame = h("div", { class: "pv-frame" }, screen);
    box.replaceChildren(frame, h("div", { class: "preview-cap" }, h("span", { class: "preview-where", text: "Preview" }), h("span", { text: PV_CAPTION[current] + " It follows every change; point at a block of settings and the part it changes lights up." })));
    // on List & swiping: just the list, close up; elsewhere the whole screen (the top bar page: its top half)
    const crop = current === "lists" ? { x: W - 420 * (tv.uiScale / 100), y: 0, w: 420 * (tv.uiScale / 100), h: 560 } : current === "topbar" ? { x: 0, y: 0, w: W, h: 300 } : { x: 0, y: 0, w: W, h: H };
    const fit = () => { const s = frame.clientWidth / crop.w; screen.style.transform = `scale(${s}) translate(${-crop.x}px, ${-crop.y}px)`; frame.style.height = crop.h * s + "px"; };
    fit(); requestAnimationFrame(fit);
    applyHl();
  };
  window.addEventListener("resize", () => { if (!$("preview").classList.contains("hidden")) drawPreview(); });
  // A number you type, with its unit; out-of-range values snap back.
  // A number you type (or nudge with the arrows), with its unit. Out of range snaps to the nearest it can be.
  const number = (label, hint, { min, max, step = 1, get, set, unit = "", path }) => {
    if (path) ({ get, set } = P(path));
    const inp = h("input", { type: "number", min, max, step, value: get(), class: "num", "aria-label": label });
    inp.addEventListener("change", async () => {
      let n = Math.round(Number(inp.value));
      if (!Number.isFinite(n)) { inp.value = get(); return; }
      n = Math.min(max, Math.max(min, n));
      set(n); inp.value = n; await save();
    });
    return row(label, h("span", { class: "inline numwrap" }, inp, unit ? h("span", { class: "hint", text: unit }) : null), hint, false, path ? [path] : null);
  };

  let homeTopics = [];
  // A list of items you add one at a time: saved instantly, removable, no "click away to save".
  const chipEditor = ({ items, placeholder, normalize = (v) => v.trim(), onAdd, onRemove, empty, label, suggest }) => {
    const wrap = h("div", { class: "chips-edit" });
    const list = h("div", { class: "chip-list", role: "list", "aria-label": label });
    const draw = () => {
      list.replaceChildren(...(items().length ? items().map((v) => h("span", { class: "chip", role: "listitem" }, h("span", { text: v }),
        h("button", { type: "button", class: "chip-x", "aria-label": `Remove ${v}`, title: "Remove", text: "×", onclick: async () => { await onRemove(v); draw(); } })))
        : [h("span", { class: "muted small", text: empty })]));
    };
    const input = h("input", { type: "text", placeholder, "aria-label": label, maxlength: 120 });
    const err = h("span", { class: "error small hidden" });
    const add = async () => {
      const raw = input.value;
      if (!raw.trim()) return;
      const parts = raw.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
      const bad = [];
      for (const p of parts) {
        const v = normalize(p);
        if (!v) { bad.push(p); continue; }
        if (!items().includes(v)) await onAdd(v);
      }
      err.textContent = bad.length ? `Couldn’t use: ${bad.join(", ")}` : "";
      err.classList.toggle("hidden", !bad.length);
      input.value = "";
      draw();
      input.focus();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        // If YouTube suggestions for exactly this text are showing, Enter picks the top match; otherwise add what was typed.
        const top = sugg.querySelector("button.sugg");
        if (top && sugg.dataset.q === input.value.trim()) top.click(); else add();
      }
      if (e.key === "ArrowDown") { const b = sugg.querySelector("button"); if (b) { e.preventDefault(); b.focus(); } }
      if (e.key === "Escape") { sugg.replaceChildren(); }
    });
    // Search-as-you-type (creators): YouTube's matching channels, click to add.
    const sugg = h("div", { class: "suggest", role: "listbox", "aria-label": "Matching creators on YouTube" });
    let timer = 0, token = 0;
    if (suggest) input.addEventListener("input", () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2 || /^@|https?:|youtube\.com/.test(q)) { sugg.replaceChildren(); return; }
      timer = setTimeout(async () => {
        const my = ++token;
        sugg.replaceChildren(h("div", { class: "muted small sugg-note", text: "Searching YouTube…" }));
        const found = await suggest(q);
        if (my !== token) return;
        sugg.dataset.q = q;
        if (!found.length) return sugg.replaceChildren(h("div", { class: "muted small sugg-note", text: "No creators found — press Enter to add it as a name anyway." }));
        sugg.replaceChildren(...found.slice(0, 6).map((f) => {
          const img = h("img", { alt: "", width: 32, height: 32 });
          if (f.img) img.src = f.img; else img.style.visibility = "hidden";
          return h("button", { type: "button", class: "sugg", role: "option", onclick: async () => {
            if (!items().includes(f.value)) await onAdd(f.value);
            input.value = ""; sugg.replaceChildren(); draw(); input.focus();
          }, onkeydown: (e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); (e.currentTarget.nextElementSibling || e.currentTarget).focus(); }
            if (e.key === "ArrowUp") { e.preventDefault(); (e.currentTarget.previousElementSibling || input).focus(); }
          } }, img, h("span", { class: "sugg-txt" }, h("b", { text: f.label }), h("span", { text: [f.value.startsWith("@") ? f.value : "", f.sub].filter(Boolean).join(" · ") })),
            h("span", { class: "sugg-add", text: items().includes(f.value) ? "Added" : "+ Add" }));
        }));
      }, 350);
    });
    wrap.append(list, h("div", { class: "chip-add" }, input, h("button", { type: "button", text: "Add", onclick: add })), sugg, err);
    draw();
    wrap.redraw = draw;
    return wrap;
  };

  const AGE_LABELS = [["any", "Any time"], ["year", "Past year"], ["month", "Past month"], ["week", "Past week"]];
  const filterRows = (getSeen, setSeen, getAge, setAge) => {
    const ageSel = h("select", { "aria-label": "Only videos from" }, ...AGE_LABELS.map(([v, l]) => h("option", { value: v, text: l })));
    ageSel.value = getAge();
    ageSel.addEventListener("change", async () => { setAge(ageSel.value); await save(); });
    return [
      row("Skip videos I’ve already seen", switchEl(getSeen(), async (v) => { setSeen(v); await save(); }, "Skip seen videos"),
        "Leaves out videos YouTube shows as watched and anything YTV has played before.", true),
      row("Only videos from", ageSel, "For topics, YouTube’s own upload-date filter is used, so you still get a full lineup."),
    ];
  };

  const choose = (value, options, set, label, after = null) => {
    const sel = h("select", { "aria-label": label }, options.map(([v, l]) => h("option", { value: v, text: l })));
    sel.value = value;
    sel.addEventListener("change", async () => { set(sel.value); await save(); if (after) after(); });
    return sel;
  };
  // a drop-down for one setting (by its path)
  const pick = (label, path, options, hint = null, redraw = false) => { const p = P(path); return row(label, choose(p.get(), options, p.set, label, redraw ? render : null), hint, false, [path]); };
  // Creator search: type, press Search (or Enter), add results — and find similar creators.
  const askTab = (ytv, q) => new Promise((res) => { try { chrome.runtime.sendMessage({ ytv, q }, (r) => res(chrome.runtime.lastError ? { error: "failed" } : r || { error: "failed" })); } catch { res({ error: "failed" }); } });
  const findCreators = async (q, related = false) => {
    // Directly first; if YouTube sends no results (e.g. its consent page), ask an open YouTube tab to search.
    const direct = related ? await SW.yt.relatedChannels(q) : await SW.yt.searchChannels(q);
    if (direct && direct.length) return { results: direct };
    const viaTab = await askTab(related ? "relatedCreators" : "searchCreators", q);
    if (viaTab && Array.isArray(viaTab.results)) return { results: viaTab.results };
    return { results: direct || [], error: viaTab && viaTab.error };
  };
  const creatorFinder = (c, redraw) => {
    const input = h("input", { type: "search", placeholder: "Search YouTube for a creator", "aria-label": "Search YouTube for a creator", maxlength: 100 });
    const out = h("div", { class: "suggest", role: "list" });
    const show = (title, results, error) => {
      if (!results.length) {
        out.replaceChildren(h("div", { class: "muted small sugg-note", text: error === "no-tab" ? "YouTube didn’t answer from here. Open YouTube in a tab once, then search again." : "No creators found." }));
        return;
      }
      out.replaceChildren(h("div", { class: "muted small sugg-note", text: title }), ...results.slice(0, 8).map((f) => {
        const value = SW.normalizeCreator(f.creator) || f.creator;
        const img = h("img", { alt: "", width: 32, height: 32 });
        if (f.avatar) img.src = f.avatar; else img.style.visibility = "hidden";
        const has = () => c.channels.includes(value);
        const addB = h("button", { type: "button", class: "sugg-btn", text: has() ? "Added" : "+ Add", disabled: has(), onclick: async () => {
          if (has()) return; c.channels.push(value); c.blocked = c.blocked.filter((b) => b.toLowerCase() !== value.toLowerCase()); await save(); redraw(); addB.textContent = "Added"; addB.disabled = true; } });
        const simB = h("button", { type: "button", class: "sugg-btn", text: "Similar", title: `Creators related to ${f.name}`, onclick: async () => {
          out.replaceChildren(h("div", { class: "muted small sugg-note", text: `Finding creators like ${f.name}…` }));
          const r = await findCreators(value, true);
          show(`Creators ${f.name} features`, r.results, r.error);
        } });
        return h("div", { class: "sugg", role: "listitem" }, img, h("span", { class: "sugg-txt" }, h("b", { text: f.name }), h("span", { text: [value.startsWith("@") ? value : "", f.subs].filter(Boolean).join(" · ") })), addB, simB);
      }));
    };
    const go = async () => {
      const q = input.value.trim();
      if (q.length < 2) return input.focus();
      out.replaceChildren(h("div", { class: "muted small sugg-note", text: "Searching YouTube…" }));
      const r = await findCreators(q);
      show(`Creators matching “${q}”`, r.results, r.error);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    return h("div", { class: "finder" }, h("div", { class: "chip-add" }, input, h("button", { type: "button", class: "primary", text: "Search", onclick: go })), out);
  };

  const themeRow = () => {
    const t = cfg.tv.theme;
    const acc = h("input", { type: "color", value: t.accent, "aria-label": "Accent colour" });
    const pnl = h("input", { type: "color", value: t.panel, "aria-label": "Panel colour" });
    const set = async (a, p2) => { t.accent = a; t.panel = p2; acc.value = a; pnl.value = p2; await save(); };
    acc.addEventListener("change", () => set(acc.value, t.panel));
    pnl.addEventListener("change", () => set(t.accent, pnl.value));
    const presets = h("div", { class: "theme-presets" }, ...Object.entries(SW.TV_THEMES).map(([name, [a, p2]]) => {
      const b = h("button", { type: "button", class: "theme-chip", title: name, "aria-label": `${name} colours`, onclick: () => set(a, p2) }, h("span", { class: "sw" }), h("span", { text: name === "ytv" ? "YTV red" : name[0].toUpperCase() + name.slice(1) }));
      b.firstChild.style.background = `linear-gradient(135deg, ${a} 50%, ${p2} 50%)`;
      return b;
    }));
    return h("div", {}, presets, row("Accent colour", acc, "Buttons, highlights, the tab underline and what’s playing.", false, ["tv.theme.accent"]), row("Panel colour", pnl, "The background of the list, the top bar and the overview.", false, ["tv.theme.panel"]));
  };

  const keyLabel = (k) => (!k ? "—" : k.length === 1 ? k.toUpperCase() : k.replace("Page", "Page "));
  const keysCard = () => {
    const tv = cfg.tv;
    const rows = SW.TV_ACTIONS.map(([id, label]) => {
      const b = h("button", { type: "button", class: "keycap", text: keyLabel(tv.keys[id]), "aria-label": `Key for ${label}: ${keyLabel(tv.keys[id])}. Click to change.`, disabled: !tv.keysOn });
      const msg = h("span", { class: "hint" });
      b.addEventListener("click", () => {
        b.textContent = "Press a key…"; msg.textContent = "Esc cancels · Backspace clears";
        const onKey = async (e) => {
          e.preventDefault(); e.stopPropagation();
          window.removeEventListener("keydown", onKey, true);
          let k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
          if (k === "Escape") { b.textContent = keyLabel(tv.keys[id]); msg.textContent = ""; return; }
          if (k === "Backspace") k = "";
          if (k && SW.YT_KEYS.has(k.toLowerCase()) && !(id === "fullscreen" && k === "f")) { msg.textContent = `${keyLabel(k)} is one of YouTube’s player keys — pick another.`; b.textContent = keyLabel(tv.keys[id]); return; }
          if (k && !SW.TV_KEY_OK.test(k)) { msg.textContent = `${keyLabel(k)} can’t be used — try a letter, Page Up/Down or F1–F12.`; b.textContent = keyLabel(tv.keys[id]); return; }
          const clash = k && SW.TV_ACTIONS.find(([o]) => o !== id && tv.keys[o] === k);
          if (clash) { msg.textContent = `${keyLabel(k)} is already “${clash[1]}”.`; b.textContent = keyLabel(tv.keys[id]); return; }
          tv.keys[id] = k; await save(); b.textContent = keyLabel(k); msg.textContent = k ? "" : "No key for this action.";
        };
        window.addEventListener("keydown", onKey, true);
      });
      return h("div", { class: "row" }, h("span", { class: "label" }, h("span", { text: label }), msg), b);
    });
    return card("Keys", "Click a key to change it. YouTube’s own player keys (arrows, M, J/K/L, C, 0–9…) always keep working, and Esc always closes what’s open (it never turns YTV off: that’s YTV’s own key).",
      toggle("Use keyboard shortcuts", null, "tv.keysOn", true),
      tagRow(h("div", { class: "keyrows" }, ...rows), ["tv.keys"]));
  };

  // ------------------------------------------------------------ Channels
  const watch = (id) => chrome.tabs.create({ url: "https://www.youtube.com/#ytv=" + encodeURIComponent(id) });
  const renderChannels = async () => {
    const tv = cfg.tv;
    try { homeTopics = ((await chrome.storage.local.get("tvTopics")).tvTopics || []).filter((t) => typeof t === "string").slice(0, 40); } catch {}
    const order = () => SW.tvOrder(tv);
    const numOf = (id) => order().indexOf(id) + 1; // your Feed is channel 0
    const move = async (id, d) => {
      const ids = order(), i = ids.indexOf(id), j = i + d;
      if (i < 0 || j < 0 || j >= ids.length) return;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      tv.order = ids;
      await save(); render();
    };
    const colCard = (c, i) => {
      const name = h("input", { type: "text", value: c.name, maxlength: 40, "aria-label": "Channel name", class: "col-name" });
      name.addEventListener("change", async () => { c.name = name.value; await save(); });
      const topics = chipEditor({ label: "Topics and searches", items: () => c.subjects, placeholder: "Add a topic", empty: "No topics yet.",
        onAdd: async (v) => { c.subjects.push(v.slice(0, 80)); await save(); drawPresets(); }, onRemove: async (v) => { c.subjects = c.subjects.filter((x) => x !== v); await save(); drawPresets(); } });
      const presetBox = h("div", { class: "presets" });
      const drawPresets = () => {
        const have = new Set(c.subjects.map((x) => x.toLowerCase()));
        const mk = (t) => h("button", { type: "button", class: "preset-chip", text: "+ " + t, title: `Add “${t}”`, onclick: async () => { c.subjects.push(t); await save(); topics.redraw(); drawPresets(); } });
        const mine = homeTopics.filter((t) => !have.has(t.toLowerCase()));
        // suggestions come only from the signed-in user's own YouTube home page (nothing built in)
        presetBox.replaceChildren(...(mine.length ? [h("div", { class: "preset-row" }, h("span", { class: "preset-label", text: "From your YouTube home page" }), ...mine.slice(0, 16).map(mk))] : []));
      };
      drawPresets();
      const creators = chipEditor({ label: "Creators", items: () => c.channels, placeholder: "@handle or channel link (or search below)", empty: "No creators yet.",
        normalize: SW.normalizeCreator,
        onAdd: async (v) => { c.channels.push(v); c.blocked = c.blocked.filter((b) => b.toLowerCase() !== v.toLowerCase()); await save(); },
        onRemove: async (v) => { c.channels = c.channels.filter((x) => x !== v); await save(); } });
      const finder = creatorFinder(c, () => creators.redraw());
      const blocked = c.blocked.length ? h("div", { class: "list-editor" }, h("label", { text: "Hidden creators" }),
        h("p", { text: "Creators you hid while watching. Remove one to let them back on this channel." }),
        chipEditor({ label: "Hidden creators", items: () => c.blocked, placeholder: "Hide another creator", empty: "None.", normalize: SW.normalizeCreator,
          onAdd: async (v) => { c.blocked.push(v); await save(); }, onRemove: async (v) => { c.blocked = c.blocked.filter((x) => x !== v); await save(); } })) : null;
      const body = h("div", { class: "col-body" },
        h("div", { class: "list-editor" }, h("label", { text: "Topics & searches" }),
          h("p", { text: "Anything you’d type into YouTube’s search. Press Enter to add — it’s saved right away." }), topics, presetBox),
        h("div", { class: "list-editor" }, h("label", { text: "Creators" }),
          h("p", { text: "Their latest videos play on this channel. Search YouTube by name, or paste a channel link or @handle." }), creators, finder),
        blocked,
        toggle("Mix in my home feed", "Your YouTube recommendations.", () => c.home, (v) => (c.home = v)),
        ...filterRows(() => c.skipSeen, (v) => (c.skipSeen = v), () => c.maxAge, (v) => (c.maxAge = v)));
      const summary = h("span", { class: "col-sum", text: [c.subjects.length && `${c.subjects.length} topic${c.subjects.length > 1 ? "s" : ""}`, c.channels.length && `${c.channels.length} creator${c.channels.length > 1 ? "s" : ""}`, c.home && "home feed"].filter(Boolean).join(" · ") || "Empty — add topics or creators" });
      const open = openCols.has(c.id);
      const det = h("details", { class: "card tv-col", open },
        h("summary", { class: "col-head" },
          h("span", { class: "col-numin col-auto", text: String(numOf(c.id)), title: "Channel number (follows the order)" }),
          h("span", { class: "col-titles" }, name, summary),
          h("button", { type: "button", class: "primary", text: "▶ Watch", title: "Open this channel on YouTube", onclick: (e) => { e.preventDefault(); watch(c.id); } }),
          h("button", { type: "button", text: "↑", title: "Move up", "aria-label": "Move up", disabled: numOf(c.id) <= 1, onclick: (e) => { e.preventDefault(); move(c.id, -1); } }),
          h("button", { type: "button", text: "↓", title: "Move down", "aria-label": "Move down", disabled: numOf(c.id) >= order().length, onclick: (e) => { e.preventDefault(); move(c.id, +1); } }),
          h("button", { type: "button", class: "danger", text: "Delete", onclick: async (e) => { e.preventDefault(); if (!confirm(`Delete “${c.name}”?`)) return; tv.collections.splice(i, 1); await save(); render(); } })),
        body);
      name.addEventListener("click", (e) => e.preventDefault()); // typing in the name doesn't fold the card
      name.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") e.stopPropagation(); });
      det.addEventListener("toggle", () => { if (det.open) openCols.add(c.id); else openCols.delete(c.id); });
      return det;
    };
    page("Your channels", "Each channel mixes topics, creators and (if you like) your home feed. Pick one and videos keep playing.",
      card("Hidden creators", "The eye button in YTV’s top bar hides the creator of what’s playing. Each channel keeps its own list, shown when you open the channel below.",
        toggle("Hide them on every channel", "On: someone you hid on one channel is gone from all of them (not from your Feed or Watch Later). Off: only from the channel you hid them on.", "tv.hideEverywhere")),
      ...SW.tvOrder(tv).map((id) => tv.collections.findIndex((c) => c.id === id)).filter((i) => i >= 0).map((i) => colCard(tv.collections[i], i)),
      h("div", { class: "inline" }, h("button", { type: "button", class: "primary", text: "+ New channel", disabled: tv.collections.length >= SW.MAX_CHANNELS, onclick: async () => {
        let n = tv.collections.length + 1, id;
        do { id = "c" + n++; } while (tv.collections.some((c) => c.id === id));
        tv.collections.push({ id, name: "New channel", subjects: [], channels: [], blocked: [], home: false, skipSeen: true, maxAge: "any", num: 999 });
        tv.order = SW.tvOrder(tv);
        openCols.add(id);
        await save(); render();
        const inputs = document.querySelectorAll(".col-name"); const last = inputs[inputs.length - 1];
        if (last) { last.scrollIntoView({ block: "center" }); last.select(); }
      } })));
  };
  const openCols = new Set();

  // ------------------------------------------------------------ Twitch
  // which streamers you get a note about when they go live (a notification from your computer, also while YouTube is closed)
  const alertPicker = () => {
    const tw = cfg.tv.twitch, note = h("p", { class: "muted small", text: "" });
    const bells = tw.logins.map((l) => {
      const on = () => tw.alerts.includes(l);
      const b = h("button", { type: "button", class: "bell" + (on() ? " on" : ""), "aria-pressed": String(on()), title: on() ? `You get a note when ${l} goes live` : `Get a note when ${l} goes live`, text: (on() ? "🔔 " : "🔕 ") + l, onclick: async () => {
        if (!on()) {
          let ok = false; try { ok = await chrome.permissions.request({ permissions: ["notifications", "alarms"] }); } catch {}
          if (!ok) { note.textContent = "Notes need the browser’s OK to show notifications. Nothing was changed."; return; }
          tw.alerts.push(l);
        } else tw.alerts = tw.alerts.filter((x) => x !== l);
        await save(); b.classList.toggle("on", on()); b.setAttribute("aria-pressed", String(on())); b.textContent = (on() ? "🔔 " : "🔕 ") + l;
      } });
      return b;
    });
    return h("div", { class: "list-editor" }, h("p", { text: "Click a streamer to get a notification when they go live (🔔 on, 🔕 off). YTV looks every 2 minutes, also while YouTube is closed. Click the notification to watch." }),
      h("div", { class: "bells" }, ...bells), note);
  };
  let twLast = { q: "", r: null };
  const twitchFinder = () => {
    const tw = cfg.tv.twitch;
    const q = h("input", { type: "search", placeholder: "Search Twitch by name", "aria-label": "Search Twitch streamers", autocomplete: "off", spellcheck: "false" });
    const out = h("div", { class: "twfound" });
    let t = 0, tok = 0;
    const draw = (r) => {
      if (!r) { out.replaceChildren(h("p", { class: "muted small", text: "No answer. Reload the extension once, then try again." })); return; }
      if (!r.found.length) { out.replaceChildren(h("p", { class: "muted small", text: r.error ? `Twitch didn’t answer as expected (${r.error}).` : "Nobody by that name." })); return; }
      out.replaceChildren(...r.found.map((u) => {
        const have = () => tw.logins.includes(u.login);
        const b = h("button", { type: "button", class: "twadd" + (have() ? " on" : ""), text: have() ? "✓ Added" : "+ Add", onclick: async () => {
          if (have()) tw.logins = tw.logins.filter((x) => x !== u.login); else tw.logins.push(u.login);
          await save(); twLast = { q: q.value, r }; render(); // the list below shows them too
          const q2 = document.querySelector("input[aria-label='Search Twitch streamers']"); if (q2) q2.focus({ preventScroll: true });
        } });
        const meta = [u.login !== u.name.toLowerCase() ? u.login : "", u.live ? `● live, ${u.viewers.toLocaleString()} watching` : "", u.followers ? `${Intl.NumberFormat(undefined, { notation: "compact" }).format(u.followers)} followers` : ""].filter(Boolean).join(" · ");
        return h("div", { class: "twhit" + (u.live ? " live" : "") }, h("span", { class: "twn" }, h("b", { text: u.name || u.login }), h("span", { class: "muted small", text: meta })), b);
      }));
    };
    q.addEventListener("input", () => {
      clearTimeout(t);
      const v = q.value.trim(); if (v.length < 2) { out.replaceChildren(); return; }
      t = setTimeout(async () => {
        const my = ++tok; out.replaceChildren(h("p", { class: "muted small", text: "Searching…" }));
        let r = null; try { r = await chrome.runtime.sendMessage({ ytv: "twitchSearch", q: v }); } catch {}
        if (my === tok) { twLast = { q: v, r }; draw(r); }
      }, 300);
    });
    if (twLast.q) { q.value = twLast.q; draw(twLast.r); }
    return h("div", { class: "list-editor" }, h("label", { text: "Find streamers" }), q, out);
  };
  const renderTwitch = () => {
    const tw = cfg.tv.twitch, c = tw.chat, note = h("p", { class: "muted small", text: "" });
    const sw = switchEl(tw.enabled, async (v) => {
      if (v) {
        let granted = false;
        try { granted = await chrome.permissions.request({ origins: ["https://gql.twitch.tv/*"] }); } catch {}
        if (!granted) { sw.querySelector("input").checked = false; note.textContent = "Twitch Live needs the browser’s OK to ask Twitch who’s live. Nothing was changed."; return; }
      }
      tw.enabled = v; await save(); render();
    }, "Twitch Live");
    const streamers = chipEditor({ label: "Streamers", items: () => tw.logins, placeholder: "Twitch name (or a twitch.tv link)", empty: "No streamers yet.",
      normalize: (x) => { const m = String(x).trim().toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, "").replace(/^@/, "").replace(/[/?#].*$/, ""); return /^[a-z0-9_]{2,25}$/.test(m) ? m : ""; },
      onAdd: async (x) => { tw.logins.push(x); await save(); }, onRemove: async (x) => { tw.logins = tw.logins.filter((y) => y !== x); await save(); } });
    const test = h("button", { type: "button", text: "Who’s live now?", onclick: async () => {
      note.textContent = "Asking Twitch…";
      let r = null; try { r = await chrome.runtime.sendMessage({ ytv: "twitchLive", logins: tw.logins }); } catch {}
      if (!r) { note.textContent = "No answer. Reload the extension once, then try again."; return; }
      if (r.error && !(r.live || []).length) { note.textContent = r.error === "no-access" ? "YTV doesn’t have the browser’s OK for Twitch yet: switch Twitch Live off and on again." : `Twitch didn’t answer as expected (${r.error}). Run the health check and send the report.`; return; }
      note.textContent = r.live.length ? `Live now: ${r.live.map((x) => `${x.name || x.login} (${x.viewers} watching)`).join(", ")}` : "None of them are live right now.";
    } });
    const placed = Object.keys(c.boxes).length;
    const forget = tagRow(row("Each streamer’s own chat", h("button", { type: "button", text: "Forget them", disabled: !placed && !c.box, onclick: async () => { c.boxes = {}; c.box = null; await save(); render(); } }),
      placed ? `${placed} streamer${placed > 1 ? "s have" : " has"} their own place, size, text or bars (set with the chat’s handle). Forget them and every chat starts from the values above.` : "When you drag a chat or use A−, A+ or ◐ on it, that streamer keeps it. Nobody has their own yet."), ["tv.twitch.chat.boxes", "tv.twitch.chat.box"]);
    page("Twitch", "Your Twitch streamers as a channel in YTV, in Twitch’s own player, with their chat on top.",
      card({ title: "Twitch Live", noReset: true }, "Switching it on asks your browser to let YTV ask Twitch who’s live. YTV never asks Twitch anything about you.",
        row("Twitch Live", sw, tw.enabled ? "On: the Twitch channel sits with your other channels." : "Off by default.", true),
        tw.enabled ? h("div", { class: "inline" }, test) : null, note),
      ...(tw.enabled ? [
        card({ title: "Streamers", noReset: true }, "Who’s in your Twitch channel. In YTV, drag a stream in the list to change the order.",
          twitchFinder(), h("div", { class: "list-editor" }, h("label", { text: "Your streamers" }), h("p", { text: "Their Twitch name (the end of twitch.tv/…), or paste the link." }), streamers)),
        card({ title: "Watching streams", area: "stream" }, "Space pauses and plays a stream; a click on the picture never pauses it. M mutes. Streams always play at full volume.",
          pick("Order in the list", "tv.twitch.sort", [["yours", "My order"], ["viewers", "Most viewers first"]]),
          pick("Quality", "tv.twitch.quality", [["chunked", "Source (best)"], ["1080p60", "1080p60"], ["720p60", "720p60"], ["720p30", "720p"], ["480p30", "480p"], ["360p30", "360p"], ["auto", "Auto"], ["keep", "Whatever I picked last in the player"]],
            "Each stream starts in this; the gear in YTV’s top bar changes it while you watch. Twitch only gives the top qualities to people logged in to twitch.tv."),
          toggle("Show who’s offline", "Greyed out under the live ones. Click one for their past broadcasts.", "tv.twitch.offline")),
        card({ title: "Chat", area: "chatv chatp" }, "Read only. It only connects while you can see it, so a hidden chat costs nothing.",
          pick("O shows the chat", "tv.twitch.chat.where", [["video", "Over the video"], ["panel", "In the list panel"]], "Shift+O moves it to the other place.", true),
          toggle("Start with the last messages", "What was said just before you tuned in, so it isn’t empty (from recent-messages.robotty.de, a public service the Chatterino app uses too).", "tv.twitch.chat.recent"),
          toggle("BetterTTV emotes", null, "tv.twitch.chat.bttv"), toggle("FrankerFaceZ emotes", null, "tv.twitch.chat.ffz"), toggle("7TV emotes", null, "tv.twitch.chat.stv")),
        card({ title: "Chat over the video", area: "chatv" }, "Point at it for its handle: drag it anywhere, pull its corner to resize. These are the starting values; A−, A+ and ◐ on the handle change them for that streamer only.",
          toggle("Show it", c.where === "video" ? "O shows and hides it too." : "Shift+O shows it (and makes O show and hide it).", "tv.twitch.chat.show"),
          pick("Corner", "tv.twitch.chat.side", [["left", "Bottom left"], ["right", "Bottom right"]], "Where it sits until you drag it somewhere."),
          number("Text size", null, { min: 6, max: 120, path: "tv.twitch.chat.size", unit: "px" }),
          slider("Dark bars behind the text", "How dark the strip behind each message is. 0 is just the text, with a soft shadow.", { min: 0, max: 100, step: 5, path: "tv.twitch.chat.bg", fmt: pct }),
          number("Messages in the corner", "Moved somewhere of its own, it keeps as many as fit.", { min: 1, max: 1000, path: "tv.twitch.chat.max" }),
          number("Messages fade after", "In the corner. 0 keeps them until newer ones push them out.", { min: 0, max: 86400, path: "tv.twitch.chat.life", unit: "s" }),
          forget),
        card({ title: "Chat in the list panel", area: "chatp" }, "The list goes see-through so the stream shows; each message keeps its own dark strip. A−, A+ and ◐ in its corner change these too.",
          number("Text size", null, { min: 6, max: 120, path: "tv.twitch.chat.panelSize", unit: "px" }),
          slider("Dark bars behind the text", "0 is just the text.", { min: 0, max: 100, step: 5, path: "tv.twitch.chat.panelBg", fmt: pct })),
        card({ title: "Go-live notifications", noReset: true }, null, alertPicker()),
      ] : []));
  };
  const renderBuiltin = () => {
    const tv = cfg.tv;
    const hidden = (label, list, set) => list().length ? h("div", { class: "list-editor" }, h("label", { text: label }),
      chipEditor({ label, items: list, placeholder: "Hide another creator", empty: "None.", normalize: SW.normalizeCreator,
        onAdd: async (v) => { list().push(v); await save(); }, onRemove: async (v) => { set(list().filter((x) => x !== v)); await save(); } })) : null;
    page("Ready-made channels", "Channels YTV makes from your own YouTube account. Your Feed is always channel 0: everything you add lands there, and is then left out of every other list.",
      card("Home", "Your YouTube home recommendations, the same videos YouTube shows you there.",
        toggle("Show Home", null, "tv.homeShuffle", true),
        ...(tv.homeShuffle ? [pick("Order", "tv.homeOrder", [["youtube", "As on YouTube"], ["shuffle", "Shuffled"]])] : []),
        ...(tv.homeShuffle ? filterRows(() => tv.homeSkipSeen, (v) => (tv.homeSkipSeen = v), () => tv.homeMaxAge, (v) => (tv.homeMaxAge = v)) : []),
        tv.homeShuffle ? hidden("Hidden on Home", () => tv.homeBlocked, (v) => (tv.homeBlocked = v)) : null),
      card("Continue watching", "YouTube videos you started and didn’t finish (also ones you half watched on YouTube itself), newest first, each from where you were. Not Twitch.",
        toggle("Show Continue watching", null, "tv.contTab", true)),
      card("Subscriptions", "The newest videos from the channels you subscribe to, newest first.",
        toggle("Show Subscriptions", null, "tv.subs.enabled", true),
        ...(tv.subs.enabled ? [toggle("Skip videos I’ve already seen", "Leaves out videos YouTube shows as watched.", "tv.subs.skipSeen")] : [])),
      card("Watch Later", "Your whole YouTube Watch Later list and nothing else: it ends where your list ends. While it plays you can take the playing video, or all watched ones, off the list.",
        toggle("Show Watch Later", null, "tv.watchLater.enabled", true),
        ...(tv.watchLater.enabled ? [
          pick("Order", "tv.watchLater.order", [["playlist", "Playlist order"], ["shuffle", "Shuffled"]]),
          toggle("Skip videos I’ve already watched", "Off by default, so you can still see and clear them out.", "tv.watchLater.skipSeen"),
        ] : [])),
      card({ title: "Twitch Live", noReset: true }, "Your Twitch streamers, their chat and go-live notifications have a page of their own.",
        h("div", { class: "inline" }, h("button", { type: "button", class: "primary", text: "Twitch settings →", onclick: () => { current = "twitch"; history.replaceState(null, "", "#twitch"); render(); } }))));
  };

  // ------------------------------------------------------------ Watching
  const renderSwiping = () => {
    const tv = cfg.tv;
    const side = row("Direction", choose(tv.swipeFlip ? "left" : "right", [["right", "Swipe right to add, left to remove"], ["left", "Swipe left to add, right to remove"]], (v) => { tv.swipeFlip = v === "left"; }, "Direction", render), null, false, ["tv.swipeFlip"]);
    page("Swiping", "Swipe a video in the list sideways with two fingers: one way adds it to your Feed, the other removes it. Hold Shift to make it play next instead of adding it to your Feed.",
      swipeDemo(),
      card({ title: "Swiping", area: "rows" }, null,
        side,
        number("How far to swipe", "The width of the plus and bin. Let go past half of it and the swipe goes through.", { min: 20, max: 400, path: "tv.swipeThreshold", unit: "px" }),
        slider("Pause in the middle", "Coming back past the middle stops the row for a moment, so you don’t go from remove straight through to add.", { min: 0, max: 3000, step: 20, path: "tv.swipeHoldMs", fmt: ms }),
        pick("What counts as sideways", "tv.swipeAxis", [["strict", "Strict: only clearly sideways"], ["normal", "Normal"], ["loose", "Loose: any sideways movement"]],
          "If scrolling up or down sometimes slides a video, make it stricter. If swipes don’t start, make it looser.")),
      card({ title: "Look", area: "rows" }, null,
        row("Add colour", (() => { const i = h("input", { type: "color", value: tv.swipeAddColor, "aria-label": "Add colour" }); i.addEventListener("change", async () => { tv.swipeAddColor = i.value; await save(); }); return i; })(), null, false, ["tv.swipeAddColor"]),
        row("Remove colour", (() => { const i = h("input", { type: "color", value: tv.swipeRmColor, "aria-label": "Remove colour" }); i.addEventListener("change", async () => { tv.swipeRmColor = i.value; await save(); }); return i; })(), null, false, ["tv.swipeRmColor"]),
        row("Play next colour", (() => { const i = h("input", { type: "color", value: tv.swipeNextColor, "aria-label": "Play next colour" }); i.addEventListener("change", async () => { tv.swipeNextColor = i.value; await save(); }); return i; })(), "Holding Shift while you swipe to the plus: the video plays next.", false, ["tv.swipeNextColor"]),
        number("Plus and bin size", null, { min: 8, max: 120, path: "tv.swipeIconPx", unit: "px" }),
        slider("Remove animation", "How long a removed video takes to fade out and the rows below to move up.", { min: 0, max: 5000, step: 20, path: "tv.swipeFadeMs", fmt: ms })),
      card({ title: "With the keyboard", noReset: true }, "Point at a video in the list, then press:",
        h("ul", { class: "keylist" },
          h("li", {}, h("kbd", { text: "A" }), h("span", { text: " adds it to your Feed (like swiping to the plus)" })),
          h("li", {}, h("kbd", { text: "Shift+A" }), h("span", { text: " makes it play next (if it’s further down the list it moves up, never twice)" })),
          h("li", {}, h("kbd", { text: "D" }), h("span", { text: " or " }), h("kbd", { text: "Delete" }), h("span", { text: " removes it" })))));
  };
  const renderLists = () => {
    const tv = cfg.tv, lkp = (k) => ({ path: "tv.look." + k });
    page("List", "The list of what’s playing and what’s next, with a tab per channel (U opens and closes it).",
      card({ title: "Showing and hiding", area: "panel" }, null,
        pick("Hide the list when the mouse rests", "tv.listHide", [["always", "Always"], ["fullscreen", "Only in full screen"], ["never", "Never"]],
          "It fades out with YouTube’s player controls and comes back when you move the mouse (never while you point at it). You can give this a key under Keyboard."),
        toggle("Open it from the right edge", "Point at the screen’s right edge and the list slides out.", "tv.edgeOpen", true),
        ...(tv.edgeOpen ? [number("Edge width", "How wide the strip along the right edge is.", { min: 1, max: 800, path: "tv.edgeWidth", unit: "px" }),
          number("Close it again after", "Once the mouse has left the list. 0 keeps it open.", { min: 0, max: 600000, step: 100, path: "tv.edgeHideMs", unit: "ms" })] : [])),
      card({ title: "Tabs", area: "tabs" }, null,
        toggle("Middle-click closes a tab", null, "tv.tabMiddleClose"),
        toggle("Show an ✕ on tabs", tv.tabMiddleClose ? "Off: tabs stay compact; close them with a middle click." : "With middle-click off, this is the only way to close a tab.", "tv.tabCloseX"),
        toggle("Show the ▾ tab", "A tab for looking at any channel without playing it. Without it, + adds channels as tabs.", "tv.chanMenu"),
        toggle("Icons for ready-made channels", "Feed, Continue watching, Home, Subscriptions, Watch Later and Twitch Live show as an icon, to save room.", "tv.tabIcons"),
        number("Height", null, { min: 12, max: 400, ...lkp("tabHeight"), unit: "px" }),
        number("Padding", "Space at the sides of each tab.", { min: 0, max: 400, ...lkp("tabPad"), unit: "px" }),
        number("Widest", "How wide a tab with a long name may get.", { min: 30, max: 2000, ...lkp("tabWidth"), unit: "px" }),
        number("Text and icon size", null, { min: 25, max: 400, step: 5, ...lkp("tabScale"), unit: "%" })),
      card({ title: "Rows", area: "rows" }, null,
        toggle("Sorting (S)", "On: what you watched greys out, folds away under “Watched” and leaves up next, and a video you pick moves up. Off: the list stays exactly as it is, however much you switch, and where you scrolled it. Turning it back on clears fully watched videos from the tab you’re on (Cmd+Z brings them back), and what’s playing moves to the top with the rest in its order after it.", () => !cfg.tv.keepOrder, (v) => (cfg.tv.keepOrder = !v)),
        slider("Fully watched from", "A video counts as fully watched from here: it leaves when sorting goes back on, drops off Continue watching, and “skip videos I’ve seen” skips it.", { min: 50, max: 100, step: 5, path: "tv.fullPct", fmt: pct }),
        number("Watched videos kept per channel", "Right above what’s playing. 0 keeps none: they leave the list (History, H, has everything anyway).", { min: 0, max: 1000, path: "tv.trail" }),
        toggle("Fold them under a “Watched” bar", "On: click the bar to show them. Off: they stay in view above what’s playing, greyed out.", "tv.watchedFold"),
        number("History keeps", "The last this many videos you watched (History, H). Older ones drop off.", { min: 10, max: 2000, step: 10, path: "tv.histMax", unit: "videos" }),
        number("Picture width", null, { min: 24, max: 800, path: "tv.thumbPx", unit: "px" }),
        number("Row height", "Never less than the picture needs.", { min: 20, max: 600, path: "tv.rowPx", unit: "px" }),
        number("Corner rounding", null, { min: 0, max: 200, ...lkp("rowRadius"), unit: "px" }),
        number("Space between rows", null, { min: 0, max: 200, ...lkp("rowGap"), unit: "px" }),
        slider("Row background opacity", null, { min: 0, max: 100, step: 5, ...lkp("rowAlpha"), fmt: pct }),
        toggle("Soft fades at the list’s edges", "A little depth where there’s more to scroll.", "tv.look.edgeFade")),
      rowTextCard(),
      card({ title: "Buttons on a picture", area: "buttons" }, "They show when you point at a video’s picture.",
        toggle("Explore (magnifier)", "Find more videos on the same topic.", "tv.hbExplore"),
        toggle("Watch Later (clock)", "Saves it to Watch Later, or takes it off if it’s there.", "tv.hbWl"),
        number("Size", null, { min: 8, max: 120, path: "tv.hbSize", unit: "px" })));
  };
  // whole looks in one click; everything stays adjustable below
  const themesCard = () => {
    const tv = cfg.tv;
    const isOn = (t) => tv.theme.accent === t.accent && tv.theme.panel === t.panel && tv.topStyle === t.topStyle && Object.entries(t.look).every(([k, v]) => tv.look[k] === v);
    const tiles = Object.entries(SW.TV_LOOKS).map(([name, t]) => {
      const mini = h("span", { class: "lk-mini" }, h("span", { class: "lk-top" }), h("span", { class: "lk-pnl" }, h("span", { class: "lk-row cur" }), h("span", { class: "lk-row" }), h("span", { class: "lk-row" })));
      mini.style.setProperty("--a", t.accent); mini.style.setProperty("--p", t.panel);
      mini.style.setProperty("--pa", t.look.panelAlpha + "%"); mini.style.setProperty("--pr", Math.round(t.look.panelRadius / 2) + "px"); mini.style.setProperty("--pg", Math.round(t.look.panelGap / 2) + "px");
      mini.style.setProperty("--rr", Math.round(t.look.rowRadius / 2) + "px"); mini.style.setProperty("--ta", t.look.topAlpha + "%"); mini.classList.add("lk-" + t.topStyle);
      return h("button", { type: "button", class: "lk-tile" + (isOn(t) ? " on" : ""), "aria-pressed": String(isOn(t)), "aria-label": `${name} theme`, title: t.d, onclick: async () => {
        tv.theme.accent = t.accent; tv.theme.panel = t.panel; tv.topStyle = t.topStyle; Object.assign(tv.look, t.look, { topBg: "" });
        await save(); render();
      } }, mini, h("b", { text: name }), h("span", { class: "muted small", text: t.d }));
    });
    return card({ title: "Themes", area: "top panel rows tabs", noReset: true }, "A whole look in one click: colours, the top bar and the list. Text sizes and icons stay as they are; fine-tune anything below.", h("div", { class: "lk-tiles" }, ...tiles));
  };
  const lk = (k) => ({ path: "tv.look." + k });
  const renderTopBar = () => {
    const tv = cfg.tv, L = tv.look;
    const inp = h("input", { type: "color", value: L.topBg || tv.theme.panel, "aria-label": "Background colour" });
    inp.addEventListener("change", async () => { L.topBg = inp.value; await save(); });
    page("Top bar", "The title and buttons over the top of the video.",
      card({ title: "Style", area: "top" }, null,
        pick("Style", "tv.topStyle", [["fade", "Soft fade into the video"], ["card", "Rounded blocks"], ["bar", "One solid bar"]]),
        number("Corner rounding", "For rounded blocks, and the solid bar’s lower corners.", { min: 0, max: 400, ...lk("topRadius"), unit: "px" }),
        number("Padding above and below", null, { min: 0, max: 400, ...lk("topPadY"), unit: "px" }),
        number("Padding at the sides", null, { min: 0, max: 400, ...lk("topPadX"), unit: "px" }),
        row("Background colour", h("span", { class: "inline" }, inp, h("button", { type: "button", text: "Same as the panel", onclick: async () => { L.topBg = ""; inp.value = tv.theme.panel; await save(); } })), null, false, ["tv.look.topBg"]),
        slider("Background opacity", "How solid the background is (with the soft fade: how dark it is at the very top).", { min: 0, max: 100, step: 5, ...lk("topAlpha"), fmt: pct }),
        slider("Background blur", "Blurs the video behind it.", { min: 0, max: 200, step: 2, ...lk("topBlur"), fmt: (n) => (n ? n + " px" : "Off") })),
      card({ title: "Soft fade", area: "top" }, "For the “soft fade into the video” style: the dark gradient and the blur behind the title, easing out into the picture.",
        number("How far down it reaches", "Below the title and buttons. 0 stops right under them.", { min: 0, max: 600, ...lk("topFade"), unit: "px" }),
        slider("How far down the blur goes", "Part of the fade that’s blurred. Lower keeps the blur close to the title and lets the rest be just a gradient.", { min: 0, max: 100, step: 5, ...lk("topBlurReach"), fmt: pct })),
      card({ title: "Text", area: "top" }, "What the top bar says, on which line and in what order. Bits on the same line are joined with ·; the channel shows as a small label.",
        fieldEditor("topFields", SW.TOP_FIELDS),
        number("Title size", null, { min: 6, max: 120, ...lk("topTitlePx"), unit: "px" }),
        number("Size of the rest", "Date, creator, length and channel.", { min: 6, max: 120, ...lk("topMetaPx"), unit: "px" }),
        toggle("Small icons", "A person before the creator, a calendar before the date, a clock before the length.", "tv.topIcons")));
  };
  const renderLook = () => {
    page("Colours & style", "Themes, colours, the list panel, overall size and animations.",
      themesCard(),
      card({ title: "Colours", area: "top panel rows tabs" }, null, themeRow()),
      card({ title: "List panel", area: "panel" }, null,
        slider("Background opacity", "Lower lets the video show through.", { min: 0, max: 100, step: 5, ...lk("panelAlpha"), fmt: pct }),
        slider("Background blur", null, { min: 0, max: 200, step: 2, ...lk("panelBlur"), fmt: (n) => (n ? n + " px" : "Off") }),
        number("Corner rounding", null, { min: 0, max: 400, ...lk("panelRadius"), unit: "px" }),
        number("Space around it", "Floats the panel off the screen’s edges.", { min: 0, max: 800, ...lk("panelGap"), unit: "px" })),
      card({ title: "Size", area: "top panel rows tabs" }, null,
        number("Everything’s size", "Scales all YTV draws: the top bar, the list, the overview.", { min: 25, max: 400, step: 5, path: "tv.uiScale", unit: "%" })),
      card("Effects", null,
        toggle("Animations", "Rows glide, panels slide, swipes fade.", "tv.motion"),
        toggle("Follow my computer’s Reduce motion", "When your computer asks for less motion, YTV turns its animations off too.", "tv.motionSystem")));
  };
  // The channel overview (G): which layout
  const GUIDE_LAYOUTS = [["posters", "Poster wall", "Small cards: a picture of what’s on and a strip of what’s next."], ["cards", "Classic cards", "Bigger cards with a picture of what’s on now and its title, like the first Hush TV."],
    ["guide", "TV guide", "One line per channel: what’s on now, then the next three side by side."], ["wall", "Big pictures", "Large pictures with the title on top. Fewer channels at a time, more to look at."]];
  const renderOverview = () => {
    const tv = cfg.tv;
    const tiles = GUIDE_LAYOUTS.map(([id, name, d]) => h("button", { type: "button", class: "lk-tile gl-tile" + (tv.guideLayout === id ? " on" : ""), "aria-pressed": String(tv.guideLayout === id), onclick: async () => { tv.guideLayout = id; await save(); render(); } },
      h("span", { class: "gl-mini gl-" + id }, ...[0, 1, 2, 3, 4, 5].map(() => h("span", { class: "gm" }, h("i"), h("b"), h("s")))), h("b", { text: name }), h("span", { class: "muted small", text: d })));
    page("Channel overview", "All your channels at a glance: press G in YTV. Click one to watch it, drag to reorder, double-click a name to rename it.",
      card({ title: "Layout", area: "guide" }, null, tagRow(h("div", { class: "lk-tiles gl-tiles" }, ...tiles), ["tv.guideLayout"])));
  };
  // Row text: which bits a row shows, on which line, in what order, and how big.
  // A list of bits (title, creator…) you put on line 1, line 2 or hide, and move up and down.
  const fieldEditor = (key, names) => {
    const tv = cfg.tv;
    const list = h("div", { class: "fields" });
    const draw = () => list.replaceChildren(...tv[key].map(([f, line], i) => {
      const sel = h("select", { "aria-label": `${names[f]}: where` }, h("option", { value: "1", text: "First line" }), h("option", { value: "2", text: "Second line" }), h("option", { value: "0", text: "Hidden" }));
      sel.value = String(line);
      sel.addEventListener("change", async () => { tv[key][i][1] = Number(sel.value); await save(); draw(); });
      const mv = (d) => async () => { const j = i + d; if (j < 0 || j >= tv[key].length) return; [tv[key][i], tv[key][j]] = [tv[key][j], tv[key][i]]; await save(); draw(); };
      return h("div", { class: "field" + (line === 0 ? " off" : "") }, h("span", { class: "fname", text: names[f] }), sel,
        h("button", { type: "button", text: "↑", title: "Earlier", "aria-label": `Move ${names[f]} earlier`, disabled: i === 0, onclick: mv(-1) }),
        h("button", { type: "button", text: "↓", title: "Later", "aria-label": `Move ${names[f]} later`, disabled: i === tv[key].length - 1, onclick: mv(1) }));
    }));
    draw();
    return tagRow(list, ["tv." + key]);
  };
  const rowTextCard = () => card({ title: "Row text", area: "rows" }, "What each video in the list says, on which line and in what order. Bits on the same line are joined with ·.",
    fieldEditor("rowFields", SW.ROW_FIELDS),
    number("Title size", null, { min: 6, max: 96, path: "tv.textPx", unit: "px" }),
    number("Size of the rest", "Creator, date and length.", { min: 6, max: 96, path: "tv.metaPx", unit: "px" }),
    number("Lines for the first line", "How far it may wrap before it’s cut off with …", { min: 1, max: 12, path: "tv.titleLines" }),
    toggle("Short dates", "“3w” instead of “3 weeks ago”, “2d” instead of “2 days ago”.", "tv.shortAge"),
    toggle("Small icons", "A person before the creator, a calendar before the date, a clock before the length.", "tv.rowIcons"));
  const renderPlayback = () => {
    page("Playing", "What plays, and the controls while it does. To filter the list itself (length, upload date, watched, subscribed), use the funnel at the top of the list.",
      card("What plays", null,
        toggle("Skip music videos", "Leaves out official music videos, lyric videos, “– Topic” and VEVO channels, and anything YouTube labels as Music. Never on Home, Watched or Watch Later: those show what YouTube shows.", "tv.skipMusic")),
      card("Picture", null,
        pick("Video quality", "tv.videoQuality", [["premium", "1080p Premium"], ["hd1080", "1080p"], ["hd720", "720p"], ["auto", "Auto"]],
          "1080p Premium is YouTube’s higher-bitrate 1080p (with YouTube Premium); where a video doesn’t have it, it plays in 1080p. A video without 1080p plays in the best it has.")),
      card("Controls", null,
        toggle("Buttons above the player bar", "Prev, Next, list, info and comments. They always show when keyboard shortcuts are off.", "tv.showBar")));
  };
  const fixedKey = (k, what) => h("li", {}, h("kbd", { text: k }), h("span", { text: " " + what }));
  const renderKeys = () => page("Keyboard", "Keys while YTV is on.", keysCard(),
    card({ title: "Always the same", noReset: true }, "These can’t be changed.",
      h("ul", { class: "keylist" },
        fixedKey("A", "adds the video under the pointer to your Feed"), fixedKey("Shift+A", "makes the video under the pointer play next"),
        fixedKey("D / Delete", "removes the video under the pointer"), fixedKey("Shift+N / Shift+P", "next / previous video"),
        fixedKey("Shift + the tab keys", "go to that tab and play its first video"), fixedKey("Shift+E", "searches YouTube"),
        fixedKey("Shift+[ / Shift+]", "back and forth through everything you watched"), fixedKey("Shift+O", "moves a stream’s chat between the video and the list"),
        fixedKey("Cmd/Ctrl+Z", "undoes the last change in the list"), fixedKey("Esc", "closes what’s open (it never turns YTV off)"))));

  // ------------------------------------------------------------ App
  const renderYouTube = () => {
    const tv = cfg.tv;
    page("On YouTube", "Where you can start YTV.",
      card(null, null,
        toggle("Button in YouTube’s top bar", "Next to your channel icon — opens a menu with your channels.", () => tv.headerButton, (v) => (tv.headerButton = v)),
        toggle("Button in YouTube’s sidebar", "You can also start YTV from its toolbar menu.", () => tv.sidebarButton, (v) => (tv.sidebarButton = v))),
      card("YTV as an app", "Give YTV its own window and an icon in your Dock: install YouTube as an app, and YTV starts by itself whenever you open it.",
        toggle("Start YTV when YouTube opens as an app", null, () => tv.appStart, (v) => (tv.appStart = v)),
        h("div", { class: "inline" },
          h("button", { type: "button", text: "Set up the app", title: "Opens YouTube with YTV's app link and shows how to install it", onclick: () => chrome.tabs.create({ url: "https://www.youtube.com/?ytvapp=setup" }) })),
        h("ol", { class: "steps" },
          h("li", { text: "Click “Set up the app”: YouTube opens with YTV’s app link (it ends in ?ytvapp) and a note on what to click." }),
          h("li", { text: "Chrome: menu ⋮ → Cast, save and share → Install page as app… Brave: menu ☰ → Save and share → Install page as app…, or More tools → Create shortcut… with “Open as window” ticked." }),
          h("li", { text: "It now sits in your Applications folder and Launchpad; drag it to the Dock. YTV starts by itself every time, with all your settings. (Already made one that doesn’t start YTV, e.g. in Brave? Remove it and make it again this way.)" }),
          h("li", { text: "The link https://www.youtube.com/?ytvapp also works as a bookmark: it always opens straight into YTV." }))));
  };
  // ------------------------------------------------------------ Health check
  // Tries every way YTV reads YouTube, from an open YouTube tab, and writes a report you can send for a fix.
  let lastReport = null;
  const reportText = (r) => {
    const tv = cfg.tv;
    const lines = [`YTV health report`, `YTV ${SW.VERSION} · ${new Date().toISOString()}`, `Browser: ${r.ua || navigator.userAgent}`, `YouTube page: ${r.page || "?"} · language: ${r.lang || "?"} · took ${r.ms || 0} ms`, ""];
    for (const x of r.results || []) lines.push(`${x.ok ? "OK  " : "FAIL"}  ${x.name} — ${x.detail} (${x.ms} ms)`);
    lines.push("", `Recent problems (${(r.errors || []).length}):`);
    for (const e of (r.errors || []).slice(-15)) lines.push(`- ${e.at} [${e.where}] ${e.msg}`);
    const { collections, homeBlocked, names, ...rest } = tv; // your channels and hidden creators stay out of the report
    lines.push("", `Channels: ${collections.length} (${collections.map((c) => `${c.subjects.length} topics/${c.channels.length} creators`).join(", ")})`, "Settings:", JSON.stringify(rest));
    void homeBlocked; void names;
    return lines.join("\n");
  };
  const renderHealth = () => {
    const out = h("div", { class: "health" });
    const status = h("p", { class: "muted", text: "Takes a few seconds. Uses an open YouTube tab, the way YTV itself reads YouTube. Nothing on your account changes." });
    const actions = h("div", { class: "inline hidden" });
    const show = (r) => {
      lastReport = r;
      const bad = (r.results || []).filter((x) => !x.ok).length;
      status.textContent = bad ? `${bad} of ${r.results.length} checks failed. Copy the report and send it, and it can be fixed.` : `All ${r.results.length} checks passed.`;
      status.className = bad ? "error" : "ok";
      out.replaceChildren(...(r.results || []).map((x) => h("div", { class: "hrow" + (x.ok ? " good" : " bad") }, h("span", { class: "hmark", text: x.ok ? "✓" : "✗" }),
        h("span", { class: "hname", text: x.name }), h("span", { class: "hdet", text: x.detail }), h("span", { class: "hms", text: x.ms + " ms" }))),
        (r.errors || []).length ? h("p", { class: "muted small", text: `${r.errors.length} recent problem${r.errors.length > 1 ? "s" : ""} logged by YTV are included in the report.` }) : null);
      actions.classList.remove("hidden");
    };
    const go = h("button", { type: "button", class: "primary", text: "Run health check", onclick: async () => {
      go.disabled = true; status.className = "muted"; status.textContent = "Checking…"; out.replaceChildren();
      const r = await askTab("health", "");
      go.disabled = false;
      if (!r || r.error || !Array.isArray(r.results)) {
        status.className = "error";
        status.textContent = r && r.error === "no-tab" ? "Open YouTube in a tab (and reload it once after updating YTV), then run the check again." : "The YouTube tab didn’t answer. Reload it once, then run the check again.";
        return;
      }
      show(r);
    } });
    const copy = h("button", { type: "button", text: "Copy report", onclick: async (e) => { if (!lastReport) return; try { await navigator.clipboard.writeText(reportText(lastReport)); e.target.textContent = "Copied"; } catch { e.target.textContent = "Couldn’t copy — use Save"; } setTimeout(() => (e.target.textContent = "Copy report"), 1800); } });
    const saveB = h("button", { type: "button", text: "Save report", onclick: () => {
      if (!lastReport) return;
      const a = h("a", { href: URL.createObjectURL(new Blob([reportText(lastReport)], { type: "text/plain" })), download: `ytv-health-${new Date().toISOString().slice(0, 10)}.txt` });
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } });
    actions.append(copy, saveB);
    page("Health check", "When something in YTV stops working, YouTube has usually changed its pages. This finds out what, and makes a report to send so it can be patched.",
      card(null, null, h("div", { class: "inline" }, go), status, out, actions,
        h("p", { class: "muted small", text: "The report has YTV’s version, your browser, each check’s result and recent problems YTV ran into, plus your settings — but not your channels’ topics or creators." })));
    if (lastReport) show(lastReport);
  };
  const renderBackup = () => {
    const status = h("p", { class: "hidden" });
    const file = h("input", { type: "file", accept: "application/json,.json", class: "hidden" });
    file.addEventListener("change", async () => {
      const f = file.files[0];
      if (!f) return;
      try {
        if (f.size > 2_000_000) throw new Error("too large");
        const data = JSON.parse(await f.text());
        const c = data.cfg || data;
        cfg = SW.sanitizeConfig(c.tv ? c : { enabled: true, tv: c }); // also takes a Hush settings file (its TV part)
        await save();
        status.textContent = "Settings imported."; status.className = "ok";
        render();
      } catch {
        status.textContent = "That file couldn’t be read as YTV settings."; status.className = "error";
      }
      file.value = "";
    });
    page("Backup", "YTV keeps everything in this browser. Carry your channels and settings to another computer in a small file.",
      card("Export and import", null,
        h("div", { class: "inline" },
          h("button", { type: "button", class: "primary", text: "Export settings", onclick: () => {
            const blob = new Blob([JSON.stringify({ app: "ytv", version: SW.VERSION, cfg }, null, 2)], { type: "application/json" });
            const a = h("a", { href: URL.createObjectURL(blob), download: `ytv-settings-${new Date().toISOString().slice(0, 10)}.json` });
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 1000);
          } }),
          h("button", { type: "button", text: "Import settings…", onclick: () => file.click() }), file),
        status),
      card("Reset", "Turns every setting back to its default and removes your channels.",
        h("div", { class: "inline" }, h("button", { type: "button", class: "danger", text: "Reset everything", onclick: async () => {
          if (!confirm("Reset all YTV settings and channels?")) return;
          cfg = SW.sanitizeConfig({}); await save(); render();
        } }))));
  };
  const renderAbout = () =>
    page("About & privacy", null,
      h("div", { class: "card prose" },
        h("h2", { text: `YTV ${SW.VERSION}` }),
        h("p", { text: "Watch YouTube like TV: channels that keep playing, no scrolling and no choosing." }),
        h("ul", {},
          h("li", { text: "It only talks to youtube.com, to read the same pages and lists you’d see there yourself." }),
          h("li", { text: "No accounts, analytics, ads or tracking." }),
          h("li", { text: "Channels and settings are stored only in this browser." })),
        h("p", { class: "muted", text: "Made to go with Hush for YouTube, which tidies YouTube itself. Each works on its own." })));

  // ------------------------------------------------------------ navigation
  const SECTIONS = [
    { group: "Channels" },
    { id: "channels", label: "Your channels", fn: renderChannels },
    { id: "builtin", label: "Ready-made channels", fn: renderBuiltin },
    { id: "twitch", label: "Twitch", fn: renderTwitch },
    { group: "Watching" },
    { id: "lists", label: "List", fn: renderLists },
    { id: "swiping", label: "Swiping", fn: renderSwiping },
    { id: "topbar", label: "Top bar", fn: renderTopBar },
    { id: "look", label: "Colours & style", fn: renderLook },
    { id: "overview", label: "Channel overview", fn: renderOverview },
    { id: "playback", label: "Playing", fn: renderPlayback },
    { id: "keys", label: "Keyboard", fn: renderKeys },
    { group: "YTV" },
    { id: "youtube", label: "On YouTube", fn: renderYouTube },
    { id: "health", label: "Health check", fn: renderHealth },
    { id: "backup", label: "Backup", fn: renderBackup },
    { id: "about", label: "About & privacy", fn: renderAbout },
  ];
  const renderNav = () => {
    $("nav-list").replaceChildren(...SECTIONS.map((s) => s.group
      ? h("div", { class: "nav-group", text: s.group })
      : h("a", { "aria-current": s.id === current ? "page" : false, href: "#" + s.id, onclick: (e) => { e.preventDefault(); current = s.id; history.replaceState(null, "", "#" + s.id); render(); } },
          h("span", { text: s.label }), s.id === "channels" ? h("span", { class: "count", text: String(cfg.tv.collections.length) }) : null)));
  };
  const renderMaster = () => {
    $("master").checked = cfg.enabled;
    $("master-text").textContent = cfg.enabled ? "YTV is on" : "YTV is off";
  };
  $("master").addEventListener("change", async () => { cfg.enabled = $("master").checked; await save(); });
  // ---- search: every section is drawn off-screen once per search, and its settings are matched by name, hint and card
  const searchIndex = async () => {
    const idx = [], keepCur = current;
    for (const s of SECTIONS) {
      if (!s.fn) continue;
      const box = h("div");
      pageTarget = box; current = s.id;
      try { await s.fn(); } catch { /* a section that can't draw off-screen just isn't searchable */ }
      pageTarget = null;
      for (const c of box.querySelectorAll(".card")) {
        const ct = (c.querySelector("h2") || {}).textContent || "";
        const rows = [...c.querySelectorAll(".row")];
        if (ct) idx.push({ sec: s, card: ct, label: ct, hint: (c.querySelector(":scope > p") || {}).textContent || "", isCard: true });
        for (const r of rows) {
          const label = (r.querySelector(".label > span") || {}).textContent || "";
          if (label) idx.push({ sec: s, card: ct, label, hint: (r.querySelector(".label .hint") || {}).textContent || "" });
        }
      }
    }
    current = keepCur;
    return idx;
  };
  const norm = (x) => String(x).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const goTo = (hit) => {
    $("search").value = ""; current = hit.sec.id; history.replaceState(null, "", "#" + hit.sec.id); render();
    const all = [...$("main").querySelectorAll(hit.isCard ? ".card h2" : ".row .label > span")];
    const t = all.find((n) => n.textContent === hit.label);
    const box = t && (t.closest(".row") || t.closest(".card"));
    if (!box) return;
    box.scrollIntoView({ block: "center", behavior: "smooth" });
    box.classList.add("hit"); setTimeout(() => box.classList.remove("hit"), 1800);
    const ctl = box.querySelector("input, select, button"); if (ctl && !hit.isCard) ctl.focus({ preventScroll: true });
  };
  let searchT = 0;
  let searching = Promise.resolve(), searchTok = 0;
  const renderSearch = async () => {
    const tok = ++searchTok;
    await searching; // sections draw one search at a time
    if (tok !== searchTok) return;
    const q = norm($("search").value.trim());
    if (!q) { render(); return; }
    const words = q.split(/\s+/);
    let done; searching = new Promise((r) => (done = r));
    let idx = []; try { idx = await searchIndex(); } finally { done(); }
    if (tok !== searchTok) return;
    const hits = idx.filter((x) => { const hay = norm(`${x.label} ${x.hint} ${x.card} ${x.sec.label}`); return words.every((w) => hay.includes(w)); })
      .sort((a, b) => (norm(b.label).includes(q) ? 1 : 0) - (norm(a.label).includes(q) ? 1 : 0));
    const list = h("div", { class: "card results" }, ...(hits.length ? hits.slice(0, 60).map((x) => h("button", { type: "button", class: "result", onclick: () => goTo(x) },
      h("span", { class: "r-where", text: x.isCard ? x.sec.label : `${x.sec.label} › ${x.card}` }), h("b", { text: x.label }), x.hint ? h("span", { class: "hint", text: x.hint }) : null))
      : [h("p", { text: "Nothing found. Try another word, like “blur”, “keys” or “Twitch”." })]));
    lastPage = "search";
    page("Search", hits.length ? `${hits.length} setting${hits.length > 1 ? "s" : ""} for “${$("search").value.trim()}”. Click one to go there.` : null, list);
    for (const a of $("nav-list").querySelectorAll("a")) a.removeAttribute("aria-current");
    $("preview").classList.add("hidden");
  };
  $("search").addEventListener("input", () => { clearTimeout(searchT); searchT = setTimeout(renderSearch, 120); });
  $("search").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { $("search").value = ""; render(); }
    if (e.key === "Enter") { const b = $("main").querySelector(".result"); if (b) b.click(); }
  });
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f" && !e.shiftKey) { e.preventDefault(); $("search").focus(); $("search").select(); } });
  const render = () => {
    renderNav();
    renderMaster();
    (SECTIONS.find((s) => s.id === current) || SECTIONS[1]).fn();
  };
  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (!SECTIONS.some((s) => s.id === id)) return;
    current = id; render();
  });
  const boot = async () => {
    ({ cfg } = await SW.load());
    lastSaved = SW.stableStringify(cfg);
    const fromHash = location.hash.slice(1);
    if (SECTIONS.some((s) => s.id === fromHash)) current = fromHash;
    render();
  };
  // Re-render if settings change elsewhere (toolbar menu, YTV itself), but not for our own writes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.cfg) return;
    if (SW.stableStringify(SW.sanitizeConfig(changes.cfg.newValue)) === lastSaved) return;
    boot();
  });
  boot();
})();
