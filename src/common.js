/*
 * YTV — shared core: settings (with their defaults and checks), the TV constants and a few helpers.
 * Loaded by the content scripts, the toolbar menu, the settings page and the service worker.
 * Contains no network code. Settings live in chrome.storage.local on this device.
 */
(() => {
  "use strict";
  const SW = (globalThis.SW = globalThis.SW || {});

  SW.VERSION = "1.26.0";
  SW.ALLOWED_HOSTS = ["www.youtube.com", "m.youtube.com", "youtube.com"];

  SW.DEFAULT_CONFIG = Object.freeze({
    enabled: true,
    tv: {
      collections: [
        { id: "c1", name: "Nature", subjects: ["nature documentary", "wildlife 4k"], channels: [], blocked: [] },
        { id: "c2", name: "Science", subjects: ["science explained", "space documentary"], channels: [], blocked: [] },
      ],
    },
  });

  const clone = (v) => JSON.parse(JSON.stringify(v));
  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  const clampInt = (v, min, max, def) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
  };
  const strList = (v, maxItems, maxLen) =>
    (Array.isArray(v) ? v : [])
      .filter((s) => typeof s === "string")
      .map((s) => s.trim().slice(0, maxLen))
      .filter(Boolean)
      .slice(0, maxItems);

  /** YTV keyboard actions and their default keys. Escape (close / turn off) is always Escape. */
  SW.TV_ACTIONS = [
    ["chUp", "Next tab (with Shift: go there and play its first video)", "."], ["chDown", "Previous tab (with Shift: go there and play its first video)", ","], ["next", "Next video", "]"], ["prev", "Previous video", "["],
    ["list", "Open / close the list", "u"], ["info", "Info (description, stream details)", "i"], ["comments", "Comments (on a stream: its chat)", "o"], ["toggle", "Turn YTV on / off", "`"], ["explore", "Explore topic (on the Twitch tab: what’s live in a game; Shift: find streamers)", "e"], ["back", "Leave a topic, back to the channel", "b"], ["overview", "Channel overview", "g"], ["history", "History (everything you watched)", "h"], ["sorting", "Sorting on / off (off: the list stays exactly as it is)", "s"], ["autohide", "Switch when the list hides (always / full screen / never)", ""], ["fullscreen", "Full screen", "f"],
  ];
  /** Keys YouTube's player uses (left alone so they keep working); F is allowed because full screen is the same action. */
  // (, and . step frames in YouTube only while paused; YTV uses them for channels)
  SW.YT_KEYS = new Set(["k", "j", "l", "m", "c", "t", "i", " ", "<", ">", "/", "home", "end", "arrowup", "arrowdown", "arrowleft", "arrowright", "escape",
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "-", "=", "w"]);
  SW.TV_KEY_OK = /^([a-z0-9`\-=[\];',./\\]|PageUp|PageDown|Insert|Delete|F([1-9]|1[0-2]))$/;
  /** Thumbnail width in the Up next list (settings → Swiping & lists). */
  /** What a list row shows: [bit, line] in order; line 1 = the bold first line, 2 = the smaller second line, 0 = hidden. */
  SW.ROW_FIELDS = { title: "Title", creator: "Creator", age: "Posted", watched: "How far you got", len: "Length" };
  SW.ROW_FIELDS_DEFAULT = [["title", 1], ["creator", 2], ["age", 2], ["len", 2], ["watched", 0]];
  /** What the top bar over the video shows, the same way: [bit, line]. "channel" is the YTV channel's name, as a small label. */
  SW.TOP_FIELDS = { title: "Title", age: "Posted", channel: "Channel", creator: "Creator", len: "Length" };
  SW.MAX_CHANNELS = 99; // your own channels (each is one number in the guide)
  SW.TOP_FIELDS_DEFAULT = [["title", 1], ["channel", 0], ["creator", 2], ["len", 2], ["age", 2]];
  SW.TV_THUMBS = [["small", "Small", 96], ["medium", "Medium", 140], ["large", "Large", 200], ["xlarge", "Extra large", 260]];
  /** Built-in TV channels: your own Feed (always channel 0), Home, Watched, Subscriptions, Watch Later and Twitch Live. */
  SW.TV_BUILTIN_IDS = ["__feed", "__cont", "__home", "__subs", "__wl", "__twitch"];
  SW.TV_BUILTIN_NAMES = { __feed: "Feed", __cont: "Continue watching", __home: "Home", __subs: "Subscriptions", __wl: "Watch Later", __twitch: "Twitch Live" };
  /**
   * The ids of the switched-on channels (Feed not included) in the order you put them in.
   * Channels you haven't placed yet keep their old channel-number order and go after the ones you have.
   */
  SW.tvOrder = (tv) => {
    const all = [];
    if (tv.homeShuffle) all.push([Number.isInteger(tv.homeNum) ? tv.homeNum : 0, -3, "__home"]);
    if (tv.subs && tv.subs.enabled) all.push([0.5, -2, "__subs"]);
    if (tv.contTab !== false) all.push([-0.5, -2.9, "__cont"]); // (right after your Feed, until you move it)
    if (tv.watchLater && tv.watchLater.enabled) all.push([Number.isInteger(tv.watchLater.num) ? tv.watchLater.num : 9, -1, "__wl"]);
    if (tv.twitch && tv.twitch.enabled) all.push([0.7, -1.5, "__twitch"]);
    (tv.collections || []).forEach((c, i) => all.push([Number.isInteger(c.num) ? c.num : i + 1, i, c.id]));
    all.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const ids = all.map((x) => x[2]), have = new Set(ids);
    const placed = (Array.isArray(tv.order) ? tv.order : []).filter((id) => have.has(id));
    const done = new Set(placed);
    return [...placed, ...ids.filter((id) => !done.has(id))];
  };
  /** A channel's name: your own name for a built-in one, else its default; a collection's own name. */
  SW.tvName = (tv, id) => {
    if (SW.TV_BUILTIN_NAMES[id]) return (tv.names && tv.names[id]) || SW.TV_BUILTIN_NAMES[id];
    const c = (tv.collections || []).find((x) => x.id === id);
    return c ? c.name : "";
  };
  /** Whole looks: colours, top bar style and the panel / row styling in one go (Settings → Look & feel → Themes). Fonts, sizes and icons stay yours. */
  SW.TV_LOOKS = {
    YTV: { d: "Red on dark, rounded blocks over the video and a frosted, half see-through list.", accent: "#f22a2a", panel: "#1d1f26", topStyle: "card",
      look: { topRadius: 12, topPadY: 12, topPadX: 20, topAlpha: 60, topBlur: 20, panelAlpha: 70, panelBlur: 12, panelRadius: 0, panelGap: 0, rowRadius: 7, rowGap: 1, rowAlpha: 90 } },
    Classic: { d: "The first Hush TV: indigo on slate, rounded blocks and a solid list.", accent: "#6474ff", panel: "#20283a", topStyle: "card",
      look: { topRadius: 12, topPadY: 10, topPadX: 15, topAlpha: 80, topBlur: 6, panelAlpha: 96, panelBlur: 0, panelRadius: 0, panelGap: 0, rowRadius: 10, rowGap: 4, rowAlpha: 100 } },
    Glass: { d: "Light and airy: floating rounded blocks and a frosted list with space around it.", accent: "#4da3ff", panel: "#18202c", topStyle: "card",
      look: { topRadius: 16, topPadY: 12, topPadX: 18, topAlpha: 25, topBlur: 30, panelAlpha: 18, panelBlur: 28, panelRadius: 16, panelGap: 12, rowRadius: 12, rowGap: 4, rowAlpha: 55 } },
    Midnight: { d: "Near black and solid, sharp corners, nothing see-through.", accent: "#f22a2a", panel: "#0b0b0e", topStyle: "bar",
      look: { topRadius: 0, topPadY: 10, topPadX: 15, topAlpha: 92, topBlur: 0, panelAlpha: 94, panelBlur: 0, panelRadius: 0, panelGap: 0, rowRadius: 4, rowGap: 0, rowAlpha: 100 } },
    Ember: { d: "Warm orange on brown, a soft fade and a rounded, half see-through list.", accent: "#ff8a3d", panel: "#231a15", topStyle: "fade",
      look: { topRadius: 12, topPadY: 12, topPadX: 18, topAlpha: 55, topBlur: 16, panelAlpha: 50, panelBlur: 12, panelRadius: 14, panelGap: 10, rowRadius: 10, rowGap: 3, rowAlpha: 85 } },
  };
  /** Streamers added to Twitch Live the first time (none: add your own in settings → Twitch). */
  SW.TWITCH_FOLLOWS = [];
  /** One line of Twitch chat (IRC with tags) → { cmd, tags, user, text } for the commands YTV uses, else null. */
  SW.parseIrcLine = (line) => {
    const m = /^(?:@(\S+) )?:(?:(\w+)!\S+|\S+) (PRIVMSG|ROOMSTATE|CLEARMSG|CLEARCHAT|USERNOTICE|JOIN) #\w+(?: :(.*))?$/.exec(String(line));
    if (!m) return null;
    const tags = {};
    if (m[1]) for (const kv of m[1].split(";")) { const i = kv.indexOf("="); if (i > 0) tags[kv.slice(0, i)] = kv.slice(i + 1).replace(/\\(.)/g, (_, c) => (c === "s" ? " " : c === ":" ? ";" : c === "r" ? "\r" : c === "n" ? "" : c)); }
    return { cmd: m[3], tags, user: m[2] || "", text: m[4] || "" };
  };
  /** A chat message as YTV passes it on (everything checked and trimmed). */
  SW.chatMsg = (p) => {
    let text = p.text; const me = /^\u0001ACTION (.*)\u0001$/.exec(text); if (me) text = me[1];
    return { id: String(p.tags.id || "").slice(0, 40), user: p.user.slice(0, 25), name: String(p.tags["display-name"] || p.user).slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(p.tags.color || "") ? p.tags.color : "",
      emotes: String(p.tags.emotes || "").slice(0, 2000), text: text.slice(0, 500), me: !!me };
  };
  SW.TWITCH_CHAT_WS = "wss://irc-ws.chat.twitch.tv:443";
  SW.TV_THEMES = { ytv: ["#f22a2a", "#1d1f26"], blue: ["#6474ff", "#20283a"], teal: ["#2bb3a3", "#16302d"], amber: ["#f1a93c", "#2b2418"], mono: ["#e6e6e6", "#1c1c1c"] };

  /** "Only videos from" choices for YTV channels, and their limits in days. */
  SW.MAX_AGES = ["any", "year", "month", "week"];
  SW.MAX_AGE_DAYS = { any: Infinity, year: 366, month: 31, week: 7.5 };

  /**
   * Turn whatever someone types for a creator into one stable form:
   *  "@handle" (from @handle, a youtube.com/@handle/… link), "channel/UC…" (from a channel-id link),
   *  or the plain creator name (used as a search). Returns "" for junk.
   */
  SW.normalizeCreator = (raw) => {
    if (typeof raw !== "string") return "";
    const v = raw.trim();
    if (!v) return "";
    const handle = v.match(/^(?:https?:\/\/)?(?:(?:www|m)\.)?(?:youtube\.com\/)?(@[\p{L}\p{N}._-]{2,100})(?:[\/?#].*)?$/u);
    if (handle) return handle[1];
    const id = v.match(/(?:youtube\.com\/|^\/?)channel\/(UC[\w-]{20,24})/);
    if (id) return "channel/" + id[1];
    if (/^https?:|[\/<>"]/.test(v) || v.startsWith("@")) return ""; // a broken @handle or a non-YouTube link
    return v.slice(0, 60);
  };

  /** Turn any object (stored data, an imported file, or Hush's old TV settings) into safe, complete YTV settings. */
  SW.sanitizeTv = (raw) => {
    const tv = isObj(raw) ? raw : {};
    const cols = Array.isArray(tv.collections) ? tv.collections : clone(SW.DEFAULT_CONFIG.tv.collections);
    const out = {
      sidebarButton: typeof tv.sidebarButton === "boolean" ? tv.sidebarButton : true,
      headerButton: typeof tv.headerButton === "boolean" ? tv.headerButton : true,
      homeShuffle: typeof tv.homeShuffle === "boolean" ? tv.homeShuffle : true,
      homeBlocked: [...new Set(strList(tv.homeBlocked, 300, 120).map(SW.normalizeCreator).filter(Boolean))].slice(0, 300),
      homeSkipSeen: typeof tv.homeSkipSeen === "boolean" ? tv.homeSkipSeen : true,
      homeMaxAge: SW.MAX_AGES.includes(tv.homeMaxAge) ? tv.homeMaxAge : "any",
      homeNum: clampInt(tv.homeNum, 0, 999, 0),
      homeOrder: tv.homeOrder === "shuffle" ? "shuffle" : "youtube", // Home: in YouTube's own order (default) or shuffled
      // The list filter (the funnel above the list): one set for every YouTube tab except your Feed; never Twitch
      filter: (() => { const f = isObj(tv.filter) ? tv.filter : {}, tri = (v, a, b) => (v === a || v === b ? v : "any");
        return {
          under: f.under === true, underMin: clampInt(f.underMin, 1, 600, 10),
          over: f.over === true, overMin: clampInt(f.overMin, 1, 600, 8),
          age: tri(f.age, "within", "older"), ageN: clampInt(f.ageN, 1, 999, 2), ageUnit: ["days", "weeks", "months"].includes(f.ageUnit) ? f.ageUnit : "weeks",
          watched: tri(f.watched, "yes", "no"), watchedPct: clampInt(f.watchedPct, 1, 100, 80),
          subbed: tri(f.subbed, "yes", "no"),
        }; })(),
      skipMusic: typeof tv.skipMusic === "boolean" ? tv.skipMusic : true,
      keysOn: typeof tv.keysOn === "boolean" ? tv.keysOn : true,
      showBar: tv.showBar === true,
      thumbSize: SW.TV_THUMBS.some(([id]) => id === tv.thumbSize) ? tv.thumbSize : "medium",
      // swipeV 2 = rows swipe natively (Swipe Lab); settings saved before that start from the choices made there
      ...(tv.swipeV === 2 ? {
        swipeThreshold: clampInt(tv.swipeThreshold, 20, 400, 100),
        swipeStyle: tv.swipeStyle === "instant" ? "instant" : "release",
        swipeFlip: typeof tv.swipeFlip === "boolean" ? tv.swipeFlip : true,
        density: tv.density === "compact" ? "compact" : "comfortable",
      } : { swipeThreshold: 100, swipeStyle: "release", swipeFlip: true, density: "comfortable", thumbSize: "medium" }),
      swipeAxis: ["strict", "normal", "loose"].includes(tv.swipeAxis) ? tv.swipeAxis : "strict",
      swipeV: 2,
      swipeHoldMs: clampInt(tv.swipeHoldMs, 0, 3000, 280),
      swipeMove: true, // (a video on your Feed is in no other list, so adding always moves it there)
      swipeAddColor: typeof tv.swipeAddColor === "string" && /^#[0-9a-f]{6}$/i.test(tv.swipeAddColor) ? tv.swipeAddColor.toLowerCase() : "#17864a",
      swipeNextColor: typeof tv.swipeNextColor === "string" && /^#[0-9a-f]{6}$/i.test(tv.swipeNextColor) ? tv.swipeNextColor.toLowerCase() : "#3d7be0", // Shift + swipe: plays next
      fullPct: clampInt(tv.fullPct, 50, 100, 90), // a video counts as fully watched from here (%)
      keepOrder: tv.keepOrder === true,
      watchedFold: tv.watchedFold !== false, // watched videos fold away under a "Watched" bar (off: they stay in view, greyed out)
      histMax: clampInt(tv.histMax, 10, 2000, 200), // how many videos History keeps // sorting off (S): the list stays exactly as it is (no greying, no Watched bar, nothing moves)
      swipeRmColor: typeof tv.swipeRmColor === "string" && /^#[0-9a-f]{6}$/i.test(tv.swipeRmColor) ? tv.swipeRmColor.toLowerCase() : "#d93a3f",
      swipeIconPx: clampInt(tv.swipeIconPx, 8, 120, 24),
      swipeFadeMs: tv.prefsV >= 4 ? clampInt(tv.swipeFadeMs, 0, 5000, 300) : 300, // the whole remove animation: fade, then close up (Motion Lab pick)
      thumbPx: clampInt(tv.thumbPx, 24, 800, (SW.TV_THUMBS.find(([id]) => id === tv.thumbSize) || [0, 0, 150])[2]),
      rowPx: clampInt(tv.rowPx, 20, 600, 64),
      titleLines: clampInt(tv.titleLines, 1, 12, tv.density === "compact" ? 1 : 2),
      textPx: clampInt(tv.textPx, 6, 96, 15),
      metaPx: clampInt(tv.metaPx, 6, 96, 13),
      rowFields: (() => {
        const raw = Array.isArray(tv.rowFields) ? tv.rowFields : [], out = [], seen = new Set();
        for (const x of raw) if (Array.isArray(x) && SW.ROW_FIELDS[x[0]] && !seen.has(x[0])) { seen.add(x[0]); out.push([x[0], [0, 1, 2].includes(x[1]) ? x[1] : 2]); }
        if (!(tv.prefsV >= 6)) for (const x of out) { if (x[0] === "len") x[1] = 2; if (x[0] === "watched") x[1] = 0; } // back to the rows as they were (1.21 tried one short line)
        for (const d of SW.ROW_FIELDS_DEFAULT) if (!seen.has(d[0])) out.push([...d]);
        return out;
      })(),
      uiScale: clampInt(tv.uiScale, 25, 400, 110), // percent
      hbSize: clampInt(tv.hbSize, 8, 120, 20), // the explore / Watch Later buttons on a picture
      hbExplore: typeof tv.hbExplore === "boolean" ? tv.hbExplore : true,
      hbWl: typeof tv.hbWl === "boolean" ? tv.hbWl : true,
      // when the list hides along with YouTube's controls as the mouse rests: always, only in full screen, or never
      listHide: ["always", "fullscreen", "never"].includes(tv.listHide) ? tv.listHide : "never",
      // a strip along the right edge: point at it and the list comes out; it goes again a moment after you leave it
      edgeOpen: typeof tv.edgeOpen === "boolean" ? tv.edgeOpen : true, edgeWidth: clampInt(tv.edgeWidth, 1, 800, 100), edgeHideMs: clampInt(tv.edgeHideMs, 0, 600000, 300),
      // small icons before the creator, date and length: in the list and in the top bar, each on its own
      hideEverywhere: tv.hideEverywhere !== false, // a creator you hide is gone from every channel (off: only from the one you hid them on)
      chanMenu: tv.chanMenu === true, // the ▾ tab for looking at any channel (off: the + adds channels as tabs)
      tabMiddleClose: tv.tabMiddleClose !== false, // a middle click closes a tab
      tabCloseX: typeof tv.tabCloseX === "boolean" ? tv.tabCloseX : tv.tabMiddleClose === false, // an ✕ on each tab you can close (before: only without middle-click)
      appStart: tv.appStart !== false, // YouTube installed as an app: open straight into YTV
      rowIcons: tv.prefsV >= 6 && typeof tv.rowIcons === "boolean" ? tv.rowIcons : true,
      shortAge: tv.prefsV >= 6 && typeof tv.shortAge === "boolean" ? tv.shortAge : false, // "3w" instead of "3 weeks ago" in the list (off)
      contTab: tv.contTab !== false, // the Continue watching channel
      topIcons: typeof tv.topIcons === "boolean" ? tv.topIcons : typeof tv.textIcons === "boolean" ? tv.textIcons : true,
      guideLayout: ["posters", "cards", "guide", "wall"].includes(tv.guideLayout) ? tv.guideLayout : "cards", // the channel overview (G)
      tabIcons: typeof tv.tabIcons === "boolean" ? tv.tabIcons : true, // ready-made channels show as icons in the tab bar
      twitch: (() => { const t = isObj(tv.twitch) ? tv.twitch : {};
        const seed = t.seeded === true ? [] : SW.TWITCH_FOLLOWS; // once: the starter list (empty) joins the list
        const ch = isObj(t.chat) ? t.chat : {};
        // (v2: switched on again once, for anyone who turned it off before it worked)
        const chat = { v: 2, show: ch.v === 2 ? ch.show === true : false, where: ch.where === "panel" ? "panel" : "video", side: ch.side === "right" ? "right" : "left", life: clampInt(ch.life, 0, 86400, 30), size: clampInt(ch.size, 6, 120, 14), max: clampInt(ch.max, 1, 1000, 14),
          bttv: ch.bttv !== false, ffz: ch.ffz !== false, stv: ch.stv !== false,
          bg: clampInt(ch.bg, 0, 100, 55), // how dark the bars behind the messages are over the video
          panelSize: clampInt(ch.panelSize, 6, 120, 17), panelBg: clampInt(ch.panelBg, 0, 100, 70), // the chat in the list panel (O)
          recent: ch.recent !== false, // fill the chat with what was said just before you tuned in
          // where you dragged it to and how big you made it, as parts of the screen (none: the bottom left)
          box: (() => { const b = isObj(ch.box) ? ch.box : null; const f = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
            if (!b) return null; const o = { x: f(b.x, 0, 0.95), y: f(b.y, 0, 0.95), w: f(b.w, 0.08, 1), h: f(b.h, 0.08, 1) }; return Object.values(o).every((v) => v !== null) ? o : null; })(),
          // per streamer: where their chat goes, how big, its text size and bars (each stream looks different)
          boxes: (() => { const src = isObj(ch.boxes) ? ch.boxes : {}, out = {}; const f = (v, lo, hi) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
            for (const [k, b] of Object.entries(src).slice(0, 500)) {
              if (!/^[a-z0-9_]{2,25}$/.test(k) || !isObj(b)) continue;
              const o = { x: f(b.x, 0, 0.95), y: f(b.y, 0, 0.95), w: f(b.w, 0.08, 1), h: f(b.h, 0.08, 1) };
              const e = Object.values(o).every((v) => v !== null) ? o : {};
              if (Number.isInteger(b.size) && b.size >= 6 && b.size <= 120) e.size = b.size;
              if (Number.isInteger(b.bg) && b.bg >= 0 && b.bg <= 100) e.bg = b.bg;
              if (Object.keys(e).length) out[k] = e;
            }
            return out; })() }; // the chat over the video: read only, with BetterTTV / FrankerFaceZ / 7TV emotes
        const quality = ["chunked", "1080p60", "720p60", "720p30", "480p30", "360p30", "auto", "keep"].includes(t.quality) ? t.quality : "chunked";
        const logins0 = [...new Set([...strList(t.logins, 500, 25), ...seed].map((x) => x.toLowerCase().replace(/^@/, "")).filter((x) => /^[a-z0-9_]{2,25}$/.test(x)))].slice(0, 500);
        const alerts = [...new Set(strList(t.alerts, 500, 25).map((x) => x.toLowerCase()).filter((x) => logins0.includes(x)))]; // the streamers you want a note about when they go live
        return { seeded: true, chat, quality, alerts, enabled: t.enabled === true, sort: t.sort === "viewers" ? "viewers" : "yours", notify: t.notify !== false, offline: t.offline !== false, logins: logins0 }; })(),
      trail: tv.prefsV >= 6 ? clampInt(tv.trail, 0, 1000, 20) : 20, // what you watched on a channel, folded away under "Watched" above what's playing
      pins: (() => { const p = [...new Set(strList(tv.pins, 60, 24).filter((id) => /^[\w-]{1,24}$/.test(id)))].slice(0, 40);
        if (!(tv.prefsV >= 7) && tv.contTab !== false && !p.includes("__cont")) p.unshift("__cont"); // Continue watching is a channel now: it keeps its tab
        return p; })(),
      glass: typeof tv.glass === "boolean" && tv.prefsV >= 3 ? tv.glass : true, // see-through by default (once for older settings too)
      topStyle: ["card", "bar", "fade"].includes(tv.topStyle) ? tv.topStyle : "card",
      // the top bar's text: which bits, on which line, in what order (like a list row's)
      topFields: (() => {
        const raw = Array.isArray(tv.topFields) ? tv.topFields : [], out = [], seen = new Set();
        for (const x of raw) if (Array.isArray(x) && SW.TOP_FIELDS[x[0]] && !seen.has(x[0])) { seen.add(x[0]); out.push([x[0], [0, 1, 2].includes(x[1]) ? x[1] : 2]); }
        for (const d of SW.TOP_FIELDS_DEFAULT) if (!seen.has(d[0])) out.push(d[0] === "channel" && tv.topChannel === true ? ["channel", 2] : [...d]);
        return out;
      })(),
      // styling (Settings → Look & feel)
      look: (() => {
        const l = isObj(tv.look) ? tv.look : {}, glassOff = tv.glass === false && tv.prefsV >= 3, hex = (v, d) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
        return {
          topRadius: clampInt(l.topRadius, 0, 400, 12),
          // padding, up and down / at the sides (one number before 1.14)
          topPadY: clampInt(l.topPadY ?? l.topPad, 0, 400, 12), topPadX: clampInt(l.topPadX ?? (Number.isFinite(Number(l.topPad)) ? Math.round(Number(l.topPad) * 1.5) : undefined), 0, 400, 20),
          // the soft fade: how far below the bar it reaches, how far down the blur goes (part of the fade), how dark it starts
          topFade: clampInt(l.topFade, 0, 600, 40), topBlurReach: clampInt(l.topBlurReach, 0, 100, 100), topBg: hex(l.topBg, ""), topAlpha: clampInt(l.topAlpha, 0, 100, 60), topBlur: clampInt(l.topBlur, 0, 200, 20),
          topTitlePx: clampInt(l.topTitlePx, 6, 120, 20), topMetaPx: clampInt(l.topMetaPx, 6, 120, 13),
          panelAlpha: clampInt(l.panelAlpha, 0, 100, glassOff ? 100 : 70), panelBlur: clampInt(l.panelBlur, 0, 200, glassOff ? 0 : 12),
          panelRadius: clampInt(l.panelRadius, 0, 400, 0), panelGap: clampInt(l.panelGap, 0, 800, 0),
          rowRadius: clampInt(l.rowRadius, 0, 200, 7), rowGap: clampInt(l.rowGap, 0, 200, 1), rowAlpha: clampInt(l.rowAlpha, 0, 100, 90),
          edgeFade: typeof l.edgeFade === "boolean" ? l.edgeFade : true,
          tabHeight: clampInt(l.tabHeight, 12, 400, 50), tabPad: clampInt(l.tabPad, 0, 400, 12), tabWidth: clampInt(l.tabWidth, 30, 2000, 150), tabScale: clampInt(l.tabScale, 25, 400, 120),
        };
      })(),
      prefsV: 7,
      motion: typeof tv.motion === "boolean" ? tv.motion : true,
      motionSystem: tv.motionSystem === true, // also switch animations off when the computer asks for reduced motion
      subs: (() => { const sb = isObj(tv.subs) ? tv.subs : {}; return { enabled: typeof sb.enabled === "boolean" ? sb.enabled : true, skipSeen: sb.skipSeen === true }; })(),
      order: [...new Set(strList(tv.order, 200, 24).filter((id) => /^[\w-]{1,24}$/.test(id)))].slice(0, 150),
      names: (() => { const nm = isObj(tv.names) ? tv.names : {}, o = {};
        for (const id of SW.TV_BUILTIN_IDS) if (typeof nm[id] === "string" && nm[id].trim()) o[id] = nm[id].trim().slice(0, 40);
        return o; })(),
      keys: (() => { // custom keys: valid, not one of YouTube's player keys, no duplicates; otherwise the default
        const raw = isObj(tv.keys) ? { ...tv.keys } : {}, out2 = {}, used = new Set();
        if (raw.history === undefined && raw.autohide === "h") { raw.history = "h"; raw.autohide = ""; } // H used to switch when the list hides; now it opens History
        const OLD = { chUp: "PageUp", chDown: "PageDown", next: "n", prev: "p", toggle: "]" }; // the defaults before , . [ ]
        for (const [id, , def] of SW.TV_ACTIONS) {
          let k = typeof raw[id] === "string" ? raw[id] : def;
          if (!(tv.prefsV >= 3) && OLD[id] === k) k = def;
          if (k.length === 1) k = k.toLowerCase();
          const ok = (k === "" || (SW.TV_KEY_OK.test(k) && !(SW.YT_KEYS.has(k.toLowerCase()) && !(id === "fullscreen" && k === "f")))) && (k === "" || !used.has(k));
          if (!ok) k = used.has(def) ? "" : def;
          if (k) used.add(k);
          out2[id] = k; // "" = no key for this action
        }
        return out2;
      })(),
      theme: (() => { const t2 = isObj(tv.theme) ? tv.theme : {}; const hex = (v, d) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);
        const a = hex(t2.accent, "#f22a2a"); // the old pinkish red becomes the new, redder one
        return { accent: a === "#ff3355" ? "#f22a2a" : a, panel: hex(t2.panel, "#1d1f26") }; })(),
      watchLater: (() => { const w = isObj(tv.watchLater) ? tv.watchLater : {};
        return { enabled: typeof w.enabled === "boolean" ? w.enabled : true, num: clampInt(w.num, 0, 999, 9), skipSeen: w.skipSeen === true, order: w.order === "shuffle" ? "shuffle" : "playlist" }; })(),
      collections: cols.filter(isObj).slice(0, SW.MAX_CHANNELS).map((c, i) => ({
        id: typeof c.id === "string" && /^[\w-]{1,24}$/.test(c.id) ? c.id : "c" + (i + 1),
        name: (typeof c.name === "string" && c.name.trim() ? c.name.trim() : "Channel " + (i + 1)).slice(0, 40),
        // Older versions had a separate "topics" list; topics are now searches like the rest.
        subjects: [...new Set([...strList(c.subjects, 200, 80), ...strList(c.topics, 200, 80)])].slice(0, 200),
        channels: [...new Set(strList(c.channels, 300, 120).map(SW.normalizeCreator).filter(Boolean))].slice(0, 300),
        blocked: [...new Set(strList(c.blocked, 200, 120).map(SW.normalizeCreator).filter(Boolean))].slice(0, 200),
        home: c.home === true,
        skipSeen: typeof c.skipSeen === "boolean" ? c.skipSeen : true,
        maxAge: SW.MAX_AGES.includes(c.maxAge) ? c.maxAge : "any",
        num: Number.isInteger(c.num) && c.num >= 0 && c.num <= 999 ? c.num : i + 1,
      })),
    };
    const seen = new Set();
    for (const [i, c] of out.collections.entries()) { // keep every collection, make ids unique (deterministically)
      if (seen.has(c.id)) c.id = (c.id + "_" + i).slice(0, 24);
      seen.add(c.id);
    }

    return out;
  };
  SW.sanitizeConfig = (raw) => {
    const r = isObj(raw) ? raw : {};
    return { enabled: typeof r.enabled === "boolean" ? r.enabled : true, tv: SW.sanitizeTv(r.tv) };
  };

  /** JSON with object keys sorted, so equal settings compare equal regardless of key order. */
  SW.stableStringify = (v) => JSON.stringify(v, (_, x) =>
    x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);

  /**
   * Video ids from pasted links, one per line (also accepts spaces, commas, youtu.be, /shorts/, /live/, /embed/,
   * and bare 11-character ids). Returns { ids, skipped } — skipped = entries that weren't a video link.
   */
  SW.parseVideoLinks = (text) => {
    const ids = [], skipped = [], seen = new Set();
    for (const raw of String(text || "").split(/[\s,;]+/)) {
      const tok = raw.trim();
      if (!tok) continue;
      let id = "";
      if (/^[\w-]{11}$/.test(tok)) id = tok;
      else {
        try {
          const u = new URL(/^https?:\/\//i.test(tok) ? tok : "https://" + tok);
          const host = u.hostname.replace(/^(www|m|music)\./, "");
          if (host === "youtu.be") id = u.pathname.split("/")[1] || "";
          else if (host === "youtube.com" || host === "youtube-nocookie.com") {
            const m = u.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{11})/);
            id = m ? m[1] : u.pathname === "/watch" ? u.searchParams.get("v") || "" : "";
          }
        } catch {}
      }
      if (!/^[\w-]{11}$/.test(id)) { skipped.push(tok); continue; }
      if (!seen.has(id)) { seen.add(id); ids.push(id); }
    }
    return { ids, skipped };
  };

  if (typeof chrome !== "undefined" && chrome.storage) {
    SW.load = async () => {
      const raw = await chrome.storage.local.get("cfg");
      return { cfg: SW.sanitizeConfig(raw.cfg), fresh: !raw.cfg };
    };
    SW.saveCfg = (cfg) => chrome.storage.local.set({ cfg: SW.sanitizeConfig(cfg) });
  }
})();
