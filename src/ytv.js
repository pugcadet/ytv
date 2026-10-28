/*
 * YTV — watch YouTube like TV.
 *
 * Collections are "channels": each mixes searches (topics, subjects), creators and optionally
 * your home feed. Picking one plays its videos one after another, full screen.
 *
 * How it works:
 *  - Lineups: YTV asks YouTube for the same pages you would open (a search, a creator's Videos
 *    tab, your home page) and reads the video list from the data YouTube puts in those pages.
 *    These requests only ever go to youtube.com itself (enforced in ytFetch and by verify.py),
 *    from the YouTube tab, exactly like browsing there. Nothing is sent anywhere else.
 *  - Playback: YouTube's normal player on the watch page (YouTube refuses embedded players on
 *    youtube.com — error 152-4). YTV makes that player fill the screen, draws its controls on
 *    top, and loads videos into the same player via main-world.js, so nothing reloads.
 */
(() => {
  "use strict";
  if (window.__ytvLoaded) return;
  window.__ytvLoaded = true;
  if (window !== window.top || location.origin !== "https://www.youtube.com" || location.pathname.startsWith("/embed/")) return;

  const SW = globalThis.SW;
  const ID_RE = /^[\w-]{11}$/;
  const TW_RE = /^tw:[a-z0-9_]{2,25}$/; // a Twitch stream in a YTV list ("tw:" + the streamer's name)
  const isItem = (id) => ID_RE.test(id) || TW_RE.test(id);

  // =====================================================================================
  // YouTube data
  // =====================================================================================
  // Reading YouTube's data lives in yt-data.js (one request function, locked to youtube.com).
  const { fetchPage: ytFetch, embeddedJson, extractVideos } = SW.yt;

  // YouTube's own search filters: videos only, optionally uploaded this year / month / week.
  const SEARCH_SP = { any: "EgIQAQ%253D%253D", year: "EgQIBRAB", month: "EgQIBBAB", week: "EgQIAxAB" };
  const spFor = (col) => SEARCH_SP[(col && col.maxAge) || "any"] || SEARCH_SP.any;
  const sourcesOf = (col) => [
    ...col.subjects.map((q) => ({ label: q, path: `/results?search_query=${encodeURIComponent(q)}&sp=${spFor(col)}` })),
    ...col.channels.map((c) => c.startsWith("@") || c.startsWith("channel/")
      ? { label: c, path: `/${c}/videos`, creator: c }
      : { label: c, path: `/results?search_query=${encodeURIComponent(c)}&sp=${spFor(col)}` }),
    ...(col.home ? [{ label: "Home feed", path: "/" }] : []),
  ];

  const readSource = async (src) => {
    if (src.creator) { // a creator's Videos tab: YouTube leaves the name off each video, so add it
      const pg = await SW.yt.pageVideos(src.path);
      return pg.videos.map((v) => ({ ...v, channel: (v.channel && !SW.yt.isStat(v.channel) ? v.channel : "") || pg.title || (src.creator.startsWith("@") ? src.creator : ""), creator: v.creator || src.creator }));
    }
    return SW.yt.videosAt(src.path);
  };

  // =====================================================================================
  // Lineups (cached for a few hours), with creator blocking and "never again" skipping
  // =====================================================================================
  let cfg = null;
  const CACHE_MS = 4 * 3600 * 1000;
  const lsGet = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || "null") ?? d; } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  // Problems YTV runs into are kept (the last 30) for the health check's report, so they can be fixed.
  const logErr = (where, err) => {
    try {
      const list = lsGet("ytv:errors", []).slice(-29);
      list.push({ at: new Date().toISOString(), where: String(where).slice(0, 60), msg: String((err && (err.stack || err.message)) || err).slice(0, 600) });
      lsSet("ytv:errors", list);
    } catch {}
  };
  window.addEventListener("error", (e) => { if (/ytv\.js|yt-data\.js|common\.js/.test(e.filename || "")) logErr("uncaught", e.error || e.message); });
  window.addEventListener("unhandledrejection", (e) => { const r = e.reason; if (r && /ytv\.js|yt-data\.js/.test(String(r.stack || ""))) logErr("promise", r); });
  const skipped = new Set(lsGet("hush:tv:skip", []).filter((x) => ID_RE.test(x)));
  // Creators found to post music (YouTube's category says so once a video plays) stay out of the lineups.
  const musicBy = new Set(lsGet("hush:tv:musicby", []).filter((x) => typeof x === "string" && x));
  const musicLike = (v) => !!v && (SW.yt.isMusic(v) || (!!creatorKey(v.creator) && musicBy.has(creatorKey(v.creator))) || (!!creatorKey(v.channel) && musicBy.has(creatorKey(v.channel))));
  const played = new Set(JSON.parse(sessionStorage.getItem("hush:tv:played") || "[]").filter((x) => ID_RE.test(x)));
  const remember = (id) => { played.add(id); try { sessionStorage.setItem("hush:tv:played", JSON.stringify([...played].slice(-300))); } catch {} };

  const creatorKey = (s) => String(s || "").toLowerCase().replace(/^@/, "").trim();
  // Hidden creators. YouTube names a creator in several ways (an @handle, a channel id, a display name), and a list
  // often only carries one of them: every pair YTV sees together is remembered, so hiding one name hides them all.
  const creatorAlias = new Map(Object.entries(lsGet("ytv:alias", {})).filter(([k, v]) => typeof k === "string" && Array.isArray(v)).map(([k, v]) => [k, new Set(v.filter((x) => typeof x === "string").slice(0, 8))]));
  let aliasT = 0;
  const learnAlias = (v) => {
    const a = creatorKey(v.creator), b = v.channel && !SW.yt.isStat(v.channel) ? creatorKey(v.channel) : "";
    if (!a || !b || a === b || (creatorAlias.has(a) && creatorAlias.get(a).has(b))) return;
    for (const [x, y] of [[a, b], [b, a]]) { const s = creatorAlias.get(x) || new Set(); s.add(y); if (s.size > 8) s.delete(s.values().next().value); creatorAlias.set(x, s); }
    if (creatorAlias.size > 4000) for (const k of [...creatorAlias.keys()].slice(0, creatorAlias.size - 4000)) creatorAlias.delete(k);
    clearTimeout(aliasT); aliasT = setTimeout(() => lsSet("ytv:alias", Object.fromEntries([...creatorAlias].map(([k, s]) => [k, [...s]]))), 3000);
  };
  // Settings → Your channels: hide a creator on every channel (default), or only on the one you hid them on
  let blockMemo = { cfg: null, all: null, per: new WeakMap() };
  const blockedSet = (col) => {
    if (blockMemo.cfg !== cfg) blockMemo = { cfg, all: null, per: new WeakMap() };
    if (cfg && cfg.tv.hideEverywhere && !col.feed && !col.watchLater) return blockMemo.all || (blockMemo.all = new Set([...(cfg.tv.homeBlocked || []), ...cfg.tv.collections.flatMap((c) => c.blocked)].map(creatorKey).filter(Boolean)));
    const list = Array.isArray(col.blocked) ? col.blocked : [];
    let s = blockMemo.per.get(list); if (!s) { s = new Set(list.map(creatorKey).filter(Boolean)); blockMemo.per.set(list, s); }
    return s;
  };
  const isBlocked = (col, v) => {
    if (!v || v.tw || !col || col.twitch) return false;
    learnAlias(v);
    const keys = blockedSet(col);
    if (!keys.size) return false;
    for (const k of [creatorKey(v.creator), creatorKey(v.channel)]) {
      if (!k) continue;
      if (keys.has(k)) return true;
      const al = creatorAlias.get(k); if (al) for (const x of al) if (keys.has(x)) return true;
    }
    return false;
  };
  // Videos YTV has played before (kept across sessions, for "skip videos I've seen").
  const seen = new Set(lsGet("hush:tv:seen", []).filter((x) => ID_RE.test(x)));
  // A video only counts as watched (greyed in the list, left out of later lineups) once you've really watched some of it.
  const WATCHED_SECONDS = 25, WATCHED_FRACTION = 0.3;
  // Sorting (S): on, watched videos grey out, fold away under "Watched" and leave up next. Off, the list is just a list:
  // nothing greys, folds, moves or goes. Switching it never rearranges what's there; it counts from that moment on.
  const sortOff = () => !!(cfg && cfg.tv.keepOrder);
  const fullPct = () => (cfg ? cfg.tv.fullPct : 90); // from how far a video counts as fully watched (Settings → List → Rows)
  const dumbPlayed = new Set(); // watched while sorting was off
  const countWatched = (id) => { if (ID_RE.test(id)) { remember(id); markSeen(id); if (sortOff()) dumbPlayed.add(id); } };
  const markSeen = (id) => { if (seen.has(id)) return; seen.add(id); lsSet("hush:tv:seen", [...seen].slice(-5000)); };
  // how old a video is, in days: its exact publish date once it has played here, else what the list said ("3 weeks ago")
  const ageOf = (v) => { if (v && v.pub) { const t = Date.parse(v.pub); if (Number.isFinite(t)) return Math.max(0, (Date.now() - t) / 86400000); } return SW.yt.ageDays(v && v.age); };
  const tooOld = (col, v) => { const max = SW.MAX_AGE_DAYS[col.maxAge] || Infinity; if (max === Infinity) return false; const d = ageOf(v); return d !== null && d > max; };
  // YTV's own record of how far you got in a video (for the progress bar in Up next).
  const progress = lsGet("hush:tv:progress", {});
  const progressOf = (v) => Math.max(Number(v.progress) || 0, Number(progress[v.id]) || 0);
  const saveProgress = (id, pct) => {
    if (!ID_RE.test(id) || !(pct > 0)) return;
    const r = Math.min(100, Math.round(pct));
    if (progress[id] === r) return; // nothing new: no write
    progress[id] = r;
    if (Date.now() - progressT < 5000) return; // at most every few seconds (and when you leave the page)
    flushProgress();
  };
  let progressT = 0;
  const flushProgress = () => {
    progressT = Date.now();
    const keys = Object.keys(progress);
    if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete progress[k];
    lsSet("hush:tv:progress", progress);
  };
  window.addEventListener("pagehide", flushProgress);
  // Where you left each video, so going back to one carries on from there (kept for the last 300).
  const resumeAt = lsGet("ytv:resume", {});
  let resumeT = 0;
  const saveResume = (id, t, d) => {
    if (!ID_RE.test(id) || !Number.isFinite(t)) return;
    const done = t < 5 || (d > 0 && (d - t < 20 || t / d > 0.95)); // barely started or as good as finished: start over next time
    if (done) { if (!(id in resumeAt)) return; delete resumeAt[id]; } else resumeAt[id] = Math.floor(t);
    if (Date.now() - resumeT < 4000 && !done) return; // at most every few seconds
    resumeT = Date.now();
    const keys = Object.keys(resumeAt);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete resumeAt[k];
    lsSet("ytv:resume", resumeAt);
  };
  const resumeOf = (id) => Number(resumeAt[id]) || 0;
  // leaving or reloading the page: the last few seconds are written too (they're otherwise saved every few seconds)
  const flushResume = () => { if (Object.keys(resumeAt).length) lsSet("ytv:resume", resumeAt); };
  window.addEventListener("pagehide", flushResume);
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushResume(); });
  const removed = new Set(); // taken out of the queue by hand this session
  const usable = (col, v) => v && isItem(v.id) && ((col.feed && v.f) || (!skipped.has(v.id) && !isBlocked(col, v) &&
    !(col.skipSeen && (v.watched || seen.has(v.id) || progressOf(v) >= fullPct())) && !tooOld(col, v) &&
    !(cfg && cfg.tv.skipMusic && !col.watchLater && !col.homeFeed && !col.watchedChip && !col.cont && musicLike(v)) && !removed.has(v.id) && // (Home shows what YouTube shows)
    (col.feed || !inFeed(v.id)))); // what's on your Feed plays there, not again on another channel
  const cacheKey = (col) => "tvcache:" + col.id + ":" + col.maxAge + ":" + SW.stableStringify([col.subjects, col.channels, col.home]).length;

  /** Build a channel's lineup. Calls onFirst as soon as the first source has videos. */
  const buildLineup = async (col, onProgress, onFirst, force = false) => {
    const key = cacheKey(col);
    if (col.feed) { // your own Feed: exactly what you put in it, in your order
      const items = feedStore.slice();
      if (items.length) onFirst(items);
      return items;
    }
    if (col.subs) { // newest uploads from the channels you subscribe to (kept for a few minutes)
      const hit = subsCache;
      let items = !force && hit && Date.now() - hit.at < 5 * 60 * 1000 ? hit.items : null;
      if (!items) { items = await readSource({ path: "/feed/subscriptions" }); if (items.length) subsCache = { at: Date.now(), items }; }
      items = items.filter((v) => usable(col, v));
      if (items.length) onFirst(items);
      return items;
    }
    if (col.watchLater) { // your Watch Later list, in playlist order or shuffled
      const wl = await SW.yt.watchLater();
      state.wlCtx = wl.ctx;
      let items = wl.videos.filter((v) => usable(col, v));
      if (cfg.tv.watchLater.order === "shuffle") items = items.sort(() => Math.random() - 0.5);
      if (items.length) onFirst(items);
      return items;
    }
    if (col.cont) { // Continue watching: what you started and didn't finish, newest first, each from where you were
      const items = contItems().filter((v) => usable(col, v));
      for (const v of items) if (!resumeOf(v.id) && v.progress > 0) { const d = lenSecs(v.len); if (d) resumeAt[v.id] = Math.floor(d * v.progress / 100); }
      if (items.length) onFirst(items);
      return items;
    }
    if (col.watchedChip) { // the "Watched" chip on your home page, in YouTube's order
      const pg = await SW.yt.homeChip(WATCHED_CHIP);
      const items = pg.videos.filter((v) => usable(col, v));
      if (items.length) onFirst(items);
      return items;
    }
    if (col.twitch) { // who of your streamers is live right now, most watched first
      const items = await twitchLive();
      if (items.length) onFirst(items);
      return items;
    }
    if (col.homeFeed) { // always fresh: in YouTube's own order, or fully random (Settings → Home → Order)
      let items = (await readSource({ path: "/" })).filter((v) => usable(col, v));
      if (col.shuffle) items = items.sort(() => Math.random() - 0.5);
      if (items.length) onFirst(items);
      return items;
    }
    if (!force) try {
      const c = (await chrome.storage.local.get(key))[key];
      if (c && Date.now() - c.at < CACHE_MS && Array.isArray(c.items) && c.items.length) {
        const items = c.items.filter((v) => usable(col, v));
        if (items.length) { onFirst(items); return items; }
      }
    } catch {}
    const srcs = sourcesOf(col);
    if (!srcs.length) return [];
    onProgress(srcs.map((s) => s.label).join(" · "));
    let first = true;
    const lists = await Promise.all(srcs.map(async (s) => {
      const items = (await readSource(s)).filter((v) => usable(col, v));
      if (first && items.length) { first = false; onFirst([...items].sort(() => Math.random() - 0.5)); }
      return items;
    }));
    const mixed = [], ids = new Set();
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && !ids.has(l[i].id)) { ids.add(l[i].id); mixed.push(l[i]); }
    for (let i = 0; i < mixed.length; i += 5) { // light shuffle in small blocks
      const block = mixed.slice(i, i + 5).sort(() => Math.random() - 0.5);
      mixed.splice(i, block.length, ...block);
    }
    const items = mixed.slice(0, 120);
    try { if (items.length) await chrome.storage.local.set({ [key]: { at: Date.now(), items } }); } catch {}
    return items;
  };

  // ---- Twitch Live: asks YTV's background (the only part allowed to reach Twitch, and only once you switched it on)
  // which of your streamers are live. Kept for a minute.
  let twitchCache = { at: 0, items: [], offline: [], err: "" };
  const twitchLive = async (force = false) => {
    if (!cfg || !cfg.tv.twitch.enabled || !cfg.tv.twitch.logins.length) return [];
    const order = (items) => { // your order, or most watched first; always as set right now
      const L = cfg.tv.twitch.logins;
      return cfg.tv.twitch.sort === "yours" ? items.slice().sort((a, b) => L.indexOf(a.login) - L.indexOf(b.login)) : items.slice().sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
    };
    // who's offline goes below, greyed, in your order (Settings: Twitch Live → show who's offline)
    const withOffline = (live) => (cfg.tv.twitch.offline ? [...live, ...order(twitchCache.offline || []).filter((v) => cfg.tv.twitch.logins.includes(v.login))] : live);
    if (!force && Date.now() - twitchCache.at < 60 * 1000) return withOffline(order(twitchCache.items.filter((v) => cfg.tv.twitch.logins.includes(v.login))));
    let r = null;
    try { r = await chrome.runtime.sendMessage({ ytv: "twitchLive", logins: cfg.tv.twitch.logins }); } catch {}
    const ok = (s) => typeof s === "string" ? s : "";
    const pic = (u) => (/^https:\/\/static-cdn\.jtvnw\.net\//.test(u || "") ? u : "");
    const offline = (r && Array.isArray(r.offline) ? r.offline : []).filter((x) => x && /^[a-z0-9_]{2,25}$/.test(x.login)).map((x) => ({
      id: "tw:" + x.login, tw: true, off: true, login: x.login, title: ok(x.name).slice(0, 60) || x.login, channel: ok(x.name).slice(0, 60) || x.login, creator: "", len: "", age: "Offline", thumb: pic(x.avatar), progress: 0, watched: false }));
    const items = (r && Array.isArray(r.live) ? r.live : []).filter((x) => x && /^[a-z0-9_]{2,25}$/.test(x.login)).map((x) => ({
      id: "tw:" + x.login, tw: true, login: x.login, title: ok(x.title).slice(0, 200) || `${ok(x.name) || x.login} is live`, channel: ok(x.name).slice(0, 60) || x.login, creator: "",
      len: x.viewers ? `${Intl.NumberFormat(undefined, { notation: "compact" }).format(x.viewers)} watching` : "live", age: ok(x.game).slice(0, 60),
      viewers: Number(x.viewers) || 0, since: Date.parse(ok(x.since)) || 0, game: ok(x.game).slice(0, 60), avatar: pic(x.avatar),
      thumb: /^https:\/\/static-cdn\.jtvnw\.net\//.test(x.thumb || "") ? x.thumb : "", progress: 0, watched: false }));
    twitchCache = { at: Date.now(), items, offline, err: (r && r.error) || "" };
    return withOffline(order(items));
  };

  // ---- endless: every source of a channel keeps its place in YouTube's list, so "more" always means the next page.
  // When a source truly runs out (a small creator), videos related to ones on the channel keep it going.
  const pagers = new Map(); // channel id → { srcs: [{ src, more, title, done }], at }
  // The home page chip for videos you've watched, in the languages YouTube shows it in
  const WATCHED_CHIP = /^(watched|bekeken|angesehen|déjà regardées?|vues|vistos|visto|assistidos|guardati|obejrzane|просмотренные|visionnées|gesehen)$/i;
  const pagedSources = (col) => col.twitch || col.cont ? [] : col.watchedChip ? [{ label: "Watched", chip: WATCHED_CHIP }] : col.homeFeed ? [{ label: "Home", path: "/" }] : col.subs ? [{ label: "Subscriptions", path: "/feed/subscriptions" }] : col.feed || col.watchLater ? [] : sourcesOf(col);
  // (`have`: what's in the list already — the first page of a source is usually exactly that, so it never counts as "more")
  const moreLineup = async (col, want = 12, have = new Set()) => {
    let p = pagers.get(col.id);
    if (!p || Date.now() - p.at > 2 * 3600 * 1000) { p = { srcs: pagedSources(col).map((src) => ({ src, more: null, title: "", started: false })), at: Date.now() }; pagers.set(col.id, p); }
    const named = (s, list) => s.src.creator ? list.map((v) => ({ ...v, channel: (v.channel && !SW.yt.isStat(v.channel) ? v.channel : "") || s.title || (s.src.creator.startsWith("@") ? s.src.creator : ""), creator: v.creator || s.src.creator })) : list;
    const out = [], seen = new Set();
    const take = (list) => { for (const v of list) if (!seen.has(v.id) && !have.has(v.id) && usable(col, v) && !played.has(v.id)) { seen.add(v.id); out.push(v); } };
    for (let round = 0; round < 4 && out.length < want; round++) {
      const live = p.srcs.filter((s) => !s.started || s.more);
      if (!live.length) break;
      const pages = await Promise.all(live.map(async (s) => {
        const pg = s.started ? await SW.yt.moreVideos(s.more) : s.src.chip ? await SW.yt.homeChip(s.src.chip) : await SW.yt.videosPage(s.src.path);
        s.started = true; s.more = pg.more; if (pg.title) s.title = pg.title;
        return named(s, pg.videos);
      }));
      const mixed = []; for (let i = 0; pages.some((l) => i < l.length); i++) for (const l of pages) if (i < l.length) mixed.push(l[i]);
      take(col.shuffle ? mixed.sort(() => Math.random() - 0.5) : mixed);
    }
    if (col.twitch) return (await twitchLive()).filter((v) => !seen.has(v.id)); // live streams: just look again
    if (out.length < want && !col.feed && !col.watchLater && !col.watchedChip && !col.cont) { // every source is at its end: related videos keep it going
      const pool = [...(browse.get(col.id) || { items: [] }).items, ...state.queue].filter((v) => v && ID_RE.test(v.id));
      for (let i = 0; i < 3 && out.length < want && pool.length; i++) {
        const v = pool[Math.floor(Math.random() * pool.length)];
        try { take(await similarTo(v.id)); } catch {}
      }
    }
    return out;
  };

  // One request per watch page, shared by "similar", tags, description, subscribers and comments. A watch page is
  // over a megabyte, so only the last few are kept, and each is read (parsed) once, not once per use.
  const lru = (map, key, make, max) => {
    if (map.has(key)) { const v = map.get(key); map.delete(key); map.set(key, v); return v; }
    const v = make(); map.set(key, v);
    while (map.size > max) map.delete(map.keys().next().value);
    return v;
  };
  const watchCache = new Map(), watchParsed = new Map();
  const watchPage = (id) => lru(watchCache, id, () => ytFetch(`/watch?v=${id}`).catch(() => ""), 6);
  const watchData = (id) => lru(watchParsed, id, () => watchPage(id).then((html) => ({ data: embeddedJson(html, "ytInitialData") || {}, pr: embeddedJson(html, "ytInitialPlayerResponse") || {} })).catch(() => ({ data: {}, pr: {} })), 8);
  /** Similar videos for "More like this": the related list from that video's page. */
  const similarTo = async (id) => {
    try { return extractVideos((await watchData(id)).data.contents?.twoColumnWatchNextResults?.secondaryResults || {}); }
    catch { return []; }
  };
  // Words that never make a topic on their own (English + Dutch).
  const STOP = new Set(("the a an and or of to in on at for with from by is are was were be this that these those it its my your our their you me we they i " +
    "new best top vs video videos official full hd 4k 1080p live part episode ep season how what why when who which " +
    "de het een en of van in op met voor naar door is zijn was dit dat deze die mijn je jouw ons hun ik wij nieuw beste nieuwe " +
    "ago day days week weeks month months year years hour hours minute minutes today yesterday geleden dag dagen weken maand maanden jaar jaren uur vandaag gisteren").split(" "));
  const words = (t) => String(t || "").toLowerCase().replace(/#/g, " ").replace(/[^\p{L}\p{N}\s'-]/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  /** Suggested topics for a video: its tags that also appear in the title first, then other tags, then title words. */
  // What a video is "about" beyond its tags: the game / show / film YouTube lists on its page, its category and tags.
  const findAll = (node, key, out = [], depth = 0) => {
    if (!node || typeof node !== "object" || depth > 16 || out.length > 12) return out;
    if (Array.isArray(node)) { for (const n of node) findAll(n, key, out, depth + 1); return out; }
    for (const [k, val] of Object.entries(node)) { if (k === key) out.push(val); else findAll(val, key, out, depth + 1); }
    return out;
  };
  const plain = (t) => (t ? t.simpleText || (Array.isArray(t.runs) ? t.runs.map((r) => r.text).join("") : "") : "");
  const themeCache = new Map();
  const themeOf = async (id) => {
    if (themeCache.has(id)) return themeCache.get(id);
    const out = { game: "", category: "", keywords: [], tags: [] };
    try {
      const { data, pr } = await watchData(id);
      const rm = findAll(data, "richMetadataRenderer").map((r) => plain(r && r.title).trim()).find((t) => t && t.length <= 60);
      out.game = rm || "";
      const mf = pr.microformat && pr.microformat.playerMicroformatRenderer;
      out.category = (mf && mf.category) || "";
      const k = pr.videoDetails && pr.videoDetails.keywords;
      out.keywords = Array.isArray(k) ? k.filter((x) => typeof x === "string").slice(0, 30) : [];
      // #hashtags in the description say what a video is about (#cooking, #travel)
      const desc = (pr.videoDetails && pr.videoDetails.shortDescription) || "";
      const GENERIC = new Set(["shorts", "short", "youtube", "subscribe", "like", "follow", "fyp", "viral", "trending", "video", "videos", "new", "live"]);
      out.tags = [...new Set([...desc.matchAll(/(?:^|\s)#([\p{L}\d_]{3,30})/gu)].map((m) => m[1].replace(/_/g, " ").replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/(\p{L})(\d)/gu, "$1 $2").trim().toLowerCase()).filter((t) => t && !GENERIC.has(t)))].slice(0, 4);
    } catch {}
    themeCache.set(id, out);
    if (themeCache.size > 60) themeCache.delete(themeCache.keys().next().value);
    return out;
  };
  const topicIdeas = (v, keywords, theme = {}) => {
    const lead = [theme.game, ...(theme.tags || []).slice(0, 2)].map((x) => String(x || "").trim()).filter((x) => x && x.length <= 40);
    const rest = topicIdeasFrom(v, keywords);
    const seen = new Set(), out = [];
    for (const t of [...lead, ...rest]) { const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(t); } }
    return out.slice(0, 12);
  };
  const topicIdeasFrom = (v, keywords) => {
    const title = String(v.title || "").toLowerCase();
    const tw = new Set(words(v.title));
    const kws = [...new Set((keywords || []).map((k) => k.trim().toLowerCase()).filter((k) => k && k.length <= 40 && k.split(/\s+/).length <= 3 && !STOP.has(k)))];
    const score = (k) => (title.includes(k) ? 3 : 0) + k.split(/\s+/).filter((w) => tw.has(w)).length;
    const ranked = kws.sort((a, b) => score(b) - score(a));
    // names in the title ("Rocket League", "Formula One"): runs of capitalised words, skipping shouting titles
    const caps = [];
    const toks = String(v.title || "").split(/\s+/);
    let run = [], start = 0;
    const flush = () => {
      while (run.length && /^(of|the|and|de|van|&)$/i.test(run[run.length - 1])) run.pop();
      if (run.length > 1 && /(?:ed|ing)$/i.test(run[0]) && (start === 0 || /^i$/i.test(toks[start - 1] || ""))) run.shift(); // "I Played X" -> X
      const t = run.join(" ");
      if (t.length >= 4 && t.length <= 32 && !/^[A-Z\d\s'’&-]+$/.test(t) && !STOP.has(t.toLowerCase()) && !(start === 0 && run.length === 1)) caps.push(t.toLowerCase());
      run = [];
    };
    toks.forEach((w, idx) => {
      const clean = w.replace(/^[^\p{L}\d]+|[^\p{L}\d'’&-]+$/gu, "");
      if (/^[A-Z]/.test(clean) && clean.length > 1 && !STOP.has(clean.toLowerCase())) { if (!run.length) start = idx; run.push(clean); }
      else if (run.length && /^(of|the|and|de|van|&)$/i.test(clean)) run.push(clean);
      else flush();
    });
    flush();
    const fromTitle = [...tw].slice(0, 6);
    return [...new Set([...ranked.slice(0, 5), ...caps, ...ranked.slice(5), ...fromTitle])].slice(0, 10);
  };
  // (several topics explored together are joined with " + ": a video about any of them counts)
  const matchesTopic = (v, query, strict = false) => {
    if (String(query).includes(" + ")) return String(query).split(" + ").some((q1) => matchesTopic(v, q1, strict));
    const q = words(query); const t = (String(v.title || "") + " " + String(v.channel || "")).toLowerCase();
    if (!q.length) return true;
    // written together or apart both count: "warfare3" finds "Warfare 3", "modern warfare" finds "#ModernWarfare"
    const tc = t.replace(/[^\p{L}\d]+/gu, "");
    if (tc.includes(q.join(""))) return true;
    const hits = q.filter((w) => t.includes(w) || tc.includes(w)).length;
    return strict ? hits >= Math.max(1, Math.ceil(q.length * 0.67)) : hits > 0;
  };

  /** Description fallback when the player doesn't provide it. */
  /** The channel's subscriber count and the video's views, from its watch page (as YouTube writes them). */
  const ownerOf = async (id) => {
    try {
      const { data } = await watchData(id);
      const own = SW.yt.findKey(data, "videoOwnerRenderer") || {};
      let subs = SW.yt.text(own.subscriberCountText);
      if (!subs) { const a11y = SW.yt.findKey(own, "accessibilityData"); subs = a11y && typeof a11y.label === "string" && /\d/.test(a11y.label) ? a11y.label : ""; }
      const vc = SW.yt.findKey(data, "videoViewCountRenderer") || {};
      const views = SW.yt.text(vc.shortViewCount) || SW.yt.text(vc.viewCount) || "";
      return { subs: String(subs).slice(0, 60), views: String(views).slice(0, 60) };
    } catch { return null; }
  };
  const descriptionOf = async (id) => {
    try { const { pr } = await watchData(id); return (pr && pr.videoDetails && pr.videoDetails.shortDescription) || ""; }
    catch { return ""; }
  };

  // Remember the topic chips on your home page, offered as one-click presets in settings.
  const GENERIC = new Set(["all", "alles", "new to you", "nieuw voor jou", "recently uploaded", "recent geüpload", "onlangs geüpload", "watched", "bekeken", "live", "mixes", "mixen", "music", "muziek", "gaming"]);
  const saveHomeTopics = async () => {
    if (location.pathname !== "/") return;
    const labels = [...document.querySelectorAll("yt-chip-cloud-chip-renderer, ytd-feed-filter-chip-bar-renderer chip-shape, #chips chip-shape")]
      .map((c) => c.textContent.trim()).filter((t) => t && t.length <= 40 && !GENERIC.has(t.toLowerCase()));
    if (!labels.length) return;
    try {
      const { tvTopics = [] } = await chrome.storage.local.get("tvTopics");
      const merged = [...new Set([...labels, ...tvTopics.filter((t) => typeof t === "string")])].slice(0, 40);
      if (merged.join("|") !== tvTopics.join("|")) await chrome.storage.local.set({ tvTopics: merged });
    } catch {}
  };

  // =====================================================================================
  // Session (TV continues on the watch page it opens)
  // =====================================================================================
  const SESSION = "ytv:session";
  const readSession = () => { try { const v = JSON.parse(sessionStorage.getItem(SESSION) || "null"); return v && Array.isArray(v.queue) ? v : null; } catch { return null; } };
  const writeSession = (v) => { try { v ? sessionStorage.setItem(SESSION, JSON.stringify(v)) : sessionStorage.removeItem(SESSION); } catch {} };
  const videoParam = () => new URLSearchParams(location.search).get("v") || "";

  // Typing in one of YTV's own boxes (explore, search, a new channel…): the letters and the space stay in that box.
  // YouTube never sees them (a space would pause the video, K / J / L would play or skip). This listener is added
  // before YouTube's own, so it runs first; the text still lands in the box (only the key's travel is stopped).
  const typingInYtv = (e) => { const t = e.composedPath()[0]; return !!t && t !== document.body && !!t.getRootNode && t.getRootNode().host && t.getRootNode().host.id === "ytv-host" && (/^(INPUT|TEXTAREA)$/.test(t.tagName || "") || t.isContentEditable); };
  for (const type of ["keydown", "keypress", "keyup"]) window.addEventListener(type, (e) => { if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && typingInYtv(e)) e.stopImmediatePropagation(); }, true);
  // YTV as an app: YouTube in its own window opens straight into YTV. Browsers differ in how an app window says
  // so (Brave's "Create shortcut" windows don't always report it), so YTV looks for several signs: the window's
  // display mode, YouTube's own app address (?feature=ytca) and YTV's app link (?ytvapp, also fine as a bookmark).
  // "?ytvapp=setup" (from settings) is the tab you make the app from: it explains how, and doesn't start YTV.
  const APP_Q = new URLSearchParams(location.search);
  if (APP_Q.get("ytvapp") === "setup") { try { sessionStorage.setItem("ytv:appsetup", "1"); } catch {} history.replaceState(history.state, "", location.pathname + "?ytvapp"); }
  const APP_LINK = APP_Q.has("ytvapp") || APP_Q.get("feature") === "ytca";
  const APP_MQ = "(display-mode: standalone), (display-mode: minimal-ui), (display-mode: window-controls-overlay)";
  const inAppWindow = () => matchMedia(APP_MQ).matches;
  const appSetupTab = () => { try { return sessionStorage.getItem("ytv:appsetup") === "1"; } catch { return false; } };
  const endAppSetup = () => { try { sessionStorage.removeItem("ytv:appsetup"); } catch {} const b = document.getElementById("ytv-appsetup"); if (b) b.remove(); };
  const resumed = location.pathname === "/watch" && readSession();
  // a stream was on over another YouTube page (Twitch needs no video page): a reload brings it back too
  const resumedTw = !resumed && (() => { const ss = readSession(); const v = ss && ss.queue[Math.max(0, ss.pos | 0)]; return v && v.tw ? ss : null; })();
  if (resumed) {
    SW.tvActive = true;
    document.documentElement.classList.add("ytv");
    document.documentElement.classList.remove("hush-wide");
    document.documentElement.setAttribute("data-ytv", "1");
  }
  const cmd = (c) => document.dispatchEvent(new CustomEvent("ytv-cmd", { detail: JSON.stringify(c) }));

  // =====================================================================================
  // Page styling in TV mode: the player fills the screen, the rest of YouTube is hidden
  // =====================================================================================
  const PAGE_CSS = `
    html.ytv, html.ytv body { overflow: hidden !important; background: #000 !important; margin: 0 !important; scrollbar-width: none !important; }
    html.ytv::-webkit-scrollbar, html.ytv body::-webkit-scrollbar { display: none !important; }
    html.ytv #masthead-container, html.ytv tp-yt-app-drawer#guide, html.ytv ytd-mini-guide-renderer,
    html.ytv ytd-watch-flexy #below, html.ytv ytd-watch-flexy #secondary, html.ytv ytd-watch-flexy #chat,
    html.ytv ytd-watch-flexy #panels, html.ytv ytd-popup-container, html.ytv .ytp-endscreen-content,
    html.ytv .html5-endscreen, html.ytv .ytp-ce-element, html.ytv .ytp-pause-overlay,
    html.ytv .ytp-autonav-endscreen-countdown-overlay, html.ytv .ytp-upnext,
    html.ytv .ytp-chrome-top, html.ytv .ytp-gradient-top, html.ytv .ytp-title,
    html.ytv .ytp-fullerscreen-edu-button, html.ytv .ytp-overlays-container .ytp-title-channel,
    html.ytv #movie_player .ytp-overlay-top-left, html.ytv #movie_player .ytp-overlay-top-right,
    html.ytv #movie_player .ytp-title-fullerscreen-link, html.ytv #movie_player .ytp-fullscreen-metadata,
    html.ytv #movie_player .ytp-player-content.ytp-overlay-top, html.ytv #movie_player .ytp-overlay-top,
    html.ytv #movie_player [class*="OverlayVideoDetails"], html.ytv #movie_player [class*="overlay-video-details"],
    html.ytv #movie_player .ytp-fullscreen-quick-actions, html.ytv #movie_player .ytp-paid-content-overlay,
    html.ytv #movie_player .ytp-chrome-top-buttons { display: none !important; } /* YouTube's own title (also its full-screen one) sits under YTV's */
    html.ytv ytd-app { --ytd-masthead-height: 0px !important; }
    /* full screen, nobody touched anything, yet YouTube put its controls up by itself: they stay away */
    html.ytv.ytv-still .ytp-chrome-bottom, html.ytv.ytv-still .ytp-gradient-bottom { opacity: 0 !important; pointer-events: none !important; }
    html.ytv.ytv-still #movie_player, html.ytv.ytv-still #movie_player * { cursor: none !important; }
    html.ytv ytd-page-manager { margin: 0 !important; padding: 0 !important; }
    html.ytv ytd-watch-flexy, html.ytv ytd-watch-flexy #columns, html.ytv ytd-watch-flexy #primary,
    html.ytv ytd-watch-flexy #primary-inner { display: block !important; container-type: normal !important; margin: 0 !important;
      padding: 0 !important; max-width: none !important; width: 100vw !important; }
    html.ytv ytd-watch-flexy #player, html.ytv #player-container-outer { width: 100vw !important; max-width: none !important; min-width: 0 !important; margin: 0 !important; }
    html.ytv #player-container-inner { padding-top: 0 !important; height: 100vh !important; }
    html.ytv #full-bleed-container { height: 100vh !important; max-height: none !important; min-height: 0 !important; }
    /* YouTube moves the player between these two containers (normal view vs. full screen / theater).
       Only the one that holds the player may take up the screen, or an empty block pushes it out of view. */
    html.ytv ytd-watch-flexy #full-bleed-container:not(:has(#movie_player, .html5-video-player)),
    html.ytv ytd-watch-flexy #player:not(:has(#movie_player, .html5-video-player)) { display: none !important; }
  `;
  const pageStyle = () => {
    if (document.getElementById("ytv-page")) return;
    const st = document.createElement("style"); st.id = "ytv-page"; st.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(st);
  };
  if (resumed) pageStyle();

  // =====================================================================================
  // Overlay
  // =====================================================================================
  // Colours come from your TV theme (settings): --acc (accent) and --pnl (panel).
  const CSS = `
    :host{all:initial}
    .tv{--acc:#f22a2a;--pnl:#1d1f26;--pbg:color-mix(in srgb,var(--pnl) var(--palpha,80%),transparent);--rowbg:color-mix(in srgb,color-mix(in srgb,var(--pnl) 92%,#000) var(--ralpha,90%),transparent);--pw:min(420px,92vw);--tw:140px;--rowh:90px;--gap:4px;position:fixed;inset:0;z-index:2147483646;color:#e0ebf6;font:15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none;pointer-events:none}
    .tv > *{pointer-events:auto}
    .tv{zoom:var(--ui,1);width:calc(100vw / var(--ui,1));height:calc(100vh / var(--ui,1));inset:0 auto auto 0}
    button{font:inherit;color:#fff;background:color-mix(in srgb,var(--pnl) 70%,#5a6680);border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);border-radius:10px;min-height:38px;padding:0 12px;cursor:pointer}
    button:hover{background:color-mix(in srgb,var(--pnl) 55%,#7a86a0)} button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
    button:disabled{opacity:.45;cursor:default}
    button.acc{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:700}
    .curtain{position:absolute;inset:0;z-index:1;background:#000;display:grid;place-items:center}
    .noise{position:absolute;inset:0;opacity:.16;background:repeating-linear-gradient(0deg,#fff 0 1px,transparent 1px 3px);animation:roll .35s steps(6) infinite}
    @keyframes roll{to{background-position:0 9px}}
    @media (prefers-reduced-motion:reduce){.noise{animation:none}}
    .tv:not(.motion) *{animation:none !important}
    .tuning{position:relative;text-align:center;max-width:70vw}
    .tuning b{display:block;font-size:30px;font-weight:800;color:#fff}
    .tuning span{color:#aab3c4}
    /* slim bar over the top of the picture: a soft dark, blurred fade keeps the text readable on any video */
    .top{position:absolute;top:0;left:0;right:0;z-index:4;display:flex;align-items:flex-start;gap:14px;padding:var(--tpady,14px) var(--tpadx,22px) var(--tfade,40px);transition:right .3s cubic-bezier(.4,0,.2,1);pointer-events:none;isolation:isolate}
    /* the fade: blur and colour are two layers, both easing out along the same smooth curve (no visible edge where the blur stops) */
    .top::before,.top-fade .top::after{content:"";position:absolute;inset:0 0 -24px;z-index:-1;pointer-events:none;
      --ease:#000 0%,rgba(0,0,0,.74) 19%,rgba(0,0,0,.54) 34%,rgba(0,0,0,.38) 47%,rgba(0,0,0,.28) 56.5%,rgba(0,0,0,.19) 65%,rgba(0,0,0,.13) 73%,rgba(0,0,0,.075) 80.2%,rgba(0,0,0,.042) 86.1%,rgba(0,0,0,.021) 91%,rgba(0,0,0,.008) 95.2%,rgba(0,0,0,.002) 98.2%,transparent 100%;
      -webkit-mask:linear-gradient(180deg,var(--ease));mask:linear-gradient(180deg,var(--ease))}
    .top::before{backdrop-filter:blur(calc(var(--tblur,14px) * var(--bk,1))) saturate(1.1)}
    .top-fade .top::before{bottom:auto;height:calc((100% + 24px) * var(--treach,1))} /* how far down the blur reaches (Settings → Top bar) */
    .top-fade .top::after{background:color-mix(in srgb,var(--tbg,#06070a) calc(var(--talpha,60%) * 1.6),transparent);background:color-mix(in srgb,color-mix(in srgb,var(--tbg,#06070a) 45%,#000) min(100%,calc(var(--talpha,60%) * 1.6)),transparent)}
    .top > *{pointer-events:auto}
    .now{flex:1;min-width:0}
    .now .t{font-size:var(--tfs,17px);font-weight:700;color:#fff;overflow-wrap:anywhere;text-wrap:pretty;text-shadow:0 1px 3px rgba(0,0,0,.55)}
    .now .age{font-weight:400;color:rgba(255,255,255,.72)}
    .now .c{display:flex;align-items:center;gap:8px;margin-top:2px;font-size:var(--tfs2,13px);color:rgba(255,255,255,.8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 2px rgba(0,0,0,.5)}
    .now .chn{flex:none;padding:1px 7px;border-radius:5px;background:var(--acc);color:#fff;font-size:11px;font-weight:800;letter-spacing:.02em;text-shadow:none}
    .motion .now .t{animation:fadein .35s ease}
    @keyframes fadein{from{opacity:0;transform:translateY(-3px)}}
    .stay{flex:none;display:flex;align-items:center;gap:7px;max-width:32%;height:32px;padding:0 4px 0 11px;border-radius:999px;background:color-mix(in srgb,var(--acc) 82%,#000);font-size:12.5px;font-weight:700;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.3)}
    .stay[hidden]{display:none}
    .stay svg{width:14px;height:14px;flex:none;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
    .stay span{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .stay button{min-height:0;height:24px;padding:0 10px;border:0;border-radius:999px;background:rgba(0,0,0,.32);font-size:12px;font-weight:700}
    .stay button:hover{background:rgba(0,0,0,.5)}
    .acts{flex:none;display:flex;align-items:center;gap:2px}
    .acts .ab{position:relative;width:36px;height:36px;min-height:0;padding:0;border:0;border-radius:10px;background:transparent;color:rgba(255,255,255,.92);display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s,transform .15s}
    .acts .ab:hover{background:rgba(255,255,255,.16);color:#fff}
    .acts .ab:active{transform:scale(.92)}
    .acts .ab[hidden]{display:none}
    .acts .ab svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,.55))}
    .acts .ab[aria-pressed="true"]{background:var(--acc);color:#fff}
    .acts .ab.on::after{content:"";position:absolute;right:6px;top:6px;width:7px;height:7px;border-radius:50%;background:#17864a;box-shadow:0 0 0 2px rgba(0,0,0,.45)}
    .asep{width:1px;height:20px;margin:0 5px;background:rgba(255,255,255,.22)}
    .now .c .sep,.now .t .sep{opacity:.6;font-weight:400}
    .now [hidden]{display:none}
    /* top bar looks (Settings → Look & feel): rounded blocks (default), one solid bar, or a soft fade */
    .top-card .top,.top-bar .top{padding-bottom:14px}
    .top-card .top{padding:14px 22px}
    .top-card .top::before,.top-bar .top::before{display:none}
    .top-card .now,.top-card .acts,.top-card .stay{background:color-mix(in srgb,var(--tbg,var(--pnl)) var(--talpha,84%),transparent);backdrop-filter:blur(calc(var(--tblur,10px) * var(--bk,1))) saturate(1.1);border-radius:var(--trad,12px);box-shadow:0 6px 20px rgba(0,0,0,.28)}
    .top-card .now{flex:0 1 auto;min-width:0;max-width:100%;padding:var(--tpady,10px) var(--tpadx,14px)}
    .top-card .top{gap:10px}
    .top-card .top::after{content:"";flex:1;order:1}
    .top-card .stay{order:2;height:auto;padding:6px 6px 6px 12px;align-self:stretch;background:color-mix(in srgb,var(--acc) 75%,#000)}
    .top-card .acts{order:3;padding:calc(var(--tpady,10px) * .4);align-self:stretch}
    .top-bar .top{padding:var(--tpady,10px) var(--tpadx,22px)}
    .top-bar .top::after{content:"";position:absolute;inset:0;z-index:-1;background:color-mix(in srgb,var(--tbg,var(--pnl)) var(--talpha,84%),transparent);backdrop-filter:blur(calc(var(--tblur,10px) * var(--bk,1))) saturate(1.1);border-radius:0 0 var(--trad,0) var(--trad,0);border-bottom:1px solid rgba(255,255,255,.06)}
    .top-bar .now,.top-card .now{text-shadow:none}
    .top-bar .now .t,.top-card .now .t,.top-bar .now .c,.top-card .now .c,.top-bar .acts .ab svg,.top-card .acts .ab svg{text-shadow:none;filter:none}
    /* sits above YouTube's own player controls */
    .bar{position:absolute;left:50%;bottom:104px;transform:translateX(-50%);z-index:4;display:flex;gap:6px;padding:8px;border-radius:14px;background:color-mix(in srgb,var(--pnl) 88%,transparent);backdrop-filter:blur(6px);transition:opacity .25s}
    /* hiding fades the content and eases the blur out with it (fading a whole blurred block makes the blur pop) */
    .top > *,.top::before,.top::after{transition:opacity .3s ease,backdrop-filter .3s ease}
    .fade{--bk:0}
    .fade .top > *,.fade .top::before,.fade .top::after,.fade .bar,.fade .panel{opacity:0}
    .fade .top,.fade .bar,.fade .panel{pointer-events:none}
    .panel{transition:opacity .3s ease,backdrop-filter .3s ease}
    .fade .top > *,.fade .bar{pointer-events:none}
    .panel{position:absolute;top:0;right:0;bottom:0;width:var(--pw);z-index:5;display:none;flex-direction:column;background:var(--pbg);border-left:1px solid color-mix(in srgb,var(--pnl) 60%,#8a96ad)}
    .panel{backdrop-filter:blur(calc(var(--pblur,16px) * var(--bk,1))) saturate(1.15);top:var(--pgap,0px);right:var(--pgap,0px);bottom:var(--pgap,0px);border-radius:var(--prad,0px);overflow:hidden}
    .grip{border-radius:var(--prad,0px) 0 0 var(--prad,0px)}
    .show-panel .panel{display:flex}
    .motion.show-panel .panel{animation:pin .3s cubic-bezier(.4,0,.2,1)}
    .motion .panel.closing{display:flex;animation:pout .2s ease forwards;pointer-events:none}
    @keyframes pout{to{transform:translateX(28px);opacity:0}}
    @keyframes pin{from{transform:translateX(24px);opacity:0;backdrop-filter:blur(0px)}}
    .show-panel .top{right:calc(var(--pw) + var(--pgap,0px))}
    .show-panel .bar,.show-panel .toast{left:calc((100% - var(--pw)) / 2)}
    .bar[hidden]{display:none}
    .grip{position:absolute;left:-5px;top:0;bottom:0;width:11px;z-index:6;cursor:ew-resize;touch-action:none}
    .grip:hover,.grip.on{background:linear-gradient(90deg,transparent 4px,var(--acc) 4px,var(--acc) 6px,transparent 6px)}
    /* header: underline tabs (Feed · channel ▾ · topic) and the panel's buttons */
    .phead{background:color-mix(in srgb,color-mix(in srgb,var(--pnl) 80%,#000) min(100%,calc(var(--palpha,80%) + 25%)),transparent);padding:6px 8px 0;border-bottom:1px solid color-mix(in srgb,var(--pnl) 70%,#8a96ad)}
    .prow{display:flex;align-items:flex-end;gap:4px;min-width:0}
    .ptabs{position:relative;display:flex;gap:0;flex:1;min-width:0;overflow-x:auto;scrollbar-width:none;-webkit-mask:linear-gradient(90deg,#000 calc(100% - 18px),transparent);mask:linear-gradient(90deg,#000 calc(100% - 18px),transparent)}
    .ptabs::-webkit-scrollbar{display:none}
    .tab{position:relative;flex:none;min-height:32px;max-width:150px;padding:0 8px;border:0;border-radius:8px 8px 0 0;background:none;color:#aab3c4;font-size:12.5px;font-weight:700;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;overflow:hidden;transition:color .18s,background .18s}
    .tab:hover{background:color-mix(in srgb,var(--pnl) 75%,#5a6680);color:#fff}
    .tab[aria-selected="true"]{color:#fff;background:none}
    .tab .tl{overflow:hidden;text-overflow:ellipsis}
    .tab .cnt{min-width:16px;padding:0 5px;border-radius:999px;font-size:11px;font-weight:800;background:rgba(255,255,255,.12);color:#fff;text-align:center;font-variant-numeric:tabular-nums}
    .tab[aria-selected="true"] .cnt{background:var(--acc)}
    .tab .cnt.bump{animation:bump .4s cubic-bezier(.4,0,.2,1)}
    @keyframes bump{40%{transform:scale(1.4)}}
    .tab .car{display:inline-flex;width:18px;height:18px;margin-right:-4px;border-radius:5px;align-items:center;justify-content:center;transition:background .15s,transform .2s}
    .tab .car:hover{background:rgba(255,255,255,.14)}
    .tab .car svg,.tab .si,.tab .tx svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;flex:none}
    .tab.add{width:36px;padding:0 4px;margin-left:4px;justify-content:center;color:#8d97ab}
    .tab.add svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round}
    .tab .tx{display:inline-flex;width:18px;height:18px;margin-right:-4px;border-radius:6px;align-items:center;justify-content:center;opacity:.7}
    .tab .tx:hover{opacity:1;background:rgba(255,255,255,.14)}
    .live{width:6px;height:6px;flex:none;border-radius:50%;background:#ff2d2d;box-shadow:0 0 0 3px rgba(255,45,45,.2)}
    /* (the live dot stays still: a never-ending animation over the blurred list cost every frame of the page) */
    .tind{position:absolute;left:0;bottom:0;height:2.5px;width:0;border-radius:2px 2px 0 0;background:var(--acc);pointer-events:none;opacity:0;transition:transform .3s cubic-bezier(.4,0,.2,1),width .3s cubic-bezier(.4,0,.2,1),opacity .2s}
    .phead .pb{flex:none;align-self:center;width:30px;min-height:30px;margin:0;padding:0;border:0;background:none;color:#aab3c4;font-size:13px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:9px;transition:color .15s,background .15s}
    .phead .pb:hover{color:#fff;background:color-mix(in srgb,var(--pnl) 70%,#5a6680)}
    .phead .pb svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
    .phead .pb[hidden]{display:none}
    .prow{margin-right:-4px} /* history (always there) sits flush in the top-right corner, on every tab */
    /* the list filter: a funnel (with how many filters are on), chips under the tabs, and its panel */
    .phead .filtb{position:relative}
    .phead .filtb.on{color:#fff}
    .phead .filtb.open{color:#fff;background:color-mix(in srgb,var(--pnl) 70%,#5a6680)}
    .fdot{position:absolute;top:0;right:-2px;min-width:14px;height:14px;padding:0 3px;border-radius:7px;background:var(--acc);color:#fff;font-size:9.5px;font-weight:800;line-height:14px;text-align:center;pointer-events:none}
    .sdot{position:absolute;right:3px;bottom:3px;width:7px;height:7px;border-radius:50%;background:#ffb020;box-shadow:0 0 0 2px color-mix(in srgb,var(--pnl) 80%,#000);pointer-events:none}
    .sdot[hidden],.fdot[hidden],.fstrip[hidden],.fpop[hidden]{display:none}
    .fpill{display:inline-flex;align-items:center;gap:2px;height:22px;padding:0 4px 0 2px;border-radius:999px;background:rgba(255,255,255,.1)}
    .fpill .fpw{min-height:0;height:22px;padding:0 4px 0 8px;border:0;background:none;color:#dfe3ec;font-size:11.5px;font-weight:600}
    .fpill .fdotsep{color:#8d97ab}
    .fpill .fclear{margin:0;height:22px}
    /* the ⋯ menu */
    .pop .mi{min-height:36px;gap:10px;padding:0 10px;border-radius:9px}
    .pop .mic{display:inline-flex;width:18px;height:18px;opacity:.85}
    .pop .mic svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .pop .ml{flex:1}
    .pop .mk{color:#7d8699;font-size:11.5px;font-weight:600}
    .acts .moreb[aria-pressed="true"]{background:rgba(255,255,255,.18)}
    .phead .histb{position:relative}
    .phead .twsb.open,.phead .histb[aria-pressed="true"]{color:#fff;background:color-mix(in srgb,var(--pnl) 70%,#5a6680)}
    /* History */
    .hpage{padding:6px 6px 12px}
    .histhead{display:flex;align-items:baseline;gap:8px;padding:4px 6px 10px;color:#aab3c4;font-size:12px}
    .histhead b{color:#fff;font-size:14px}
    .hseg{display:flex;gap:2px;padding:2px;border-radius:9px;background:rgba(0,0,0,.3)}
    .hseg button{min-height:0;height:26px;padding:0 11px;border:0;border-radius:7px;background:none;color:#aab3c4;font-size:12px;font-weight:600}
    .hseg button.on{background:var(--acc);color:#fff}
    .hseg button:not(.on):hover{color:#fff;background:rgba(255,255,255,.08)}
    .histhead .hclear{margin-left:auto;min-height:0;height:24px;padding:0 10px;border:0;border-radius:7px;background:rgba(255,255,255,.08);color:#cfd4de;font-size:12px}
    .histhead .hclear:hover{background:rgba(255,255,255,.16);color:#fff}
    .hlist{display:flex;flex-direction:column;gap:var(--gap,2px)}
    .hrow{display:flex;align-items:center;gap:10px;width:100%;min-height:0;padding:6px;border:0;border-radius:var(--rrad,7px);background:var(--rowbg,rgba(255,255,255,.04));color:#e8ebf2;text-align:left;font:inherit}
    .hrow:hover{background:color-mix(in srgb,var(--pnl) 60%,#5a6680)}
    .hrow.hnow{box-shadow:inset 3px 0 0 var(--acc);background:color-mix(in srgb,var(--acc) 22%,var(--pnl))}
    .hrow .thumb{width:calc(var(--tw,140px) * .72);flex:none;position:relative}
    .hpbar{position:absolute;left:0;bottom:0;height:3px;background:var(--acc);border-radius:0 2px 0 0}
    .htx{display:flex;flex-direction:column;gap:3px;min-width:0}
    .htx b{font-size:var(--fs1,13px);font-weight:600;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .htx span{font-size:var(--fs2,12px);color:#aab3c4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    /* Find Twitch streamers */
    .twpop .twq{width:100%;min-height:0;height:32px;margin:2px 0 8px;padding:0 10px;border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);border-radius:8px;background:#0e121b;color:#fff;font:inherit;font-size:13px}
    .twres{display:flex;flex-direction:column;gap:2px}
    .twhit{display:flex;align-items:center;gap:9px;padding:5px 4px;border-radius:8px}
    .twhit:hover{background:rgba(255,255,255,.06)}
    .twav{width:30px;height:30px;flex:none;border-radius:50%;overflow:hidden;background:rgba(255,255,255,.08)}
    .twav img{width:100%;height:100%;object-fit:cover}
    .twhit:not(.tson) .twav{filter:grayscale(1);opacity:.7}
    .twtx{display:flex;flex-direction:column;min-width:0;flex:1}
    .twtx b{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .twtx span{font-size:11.5px;color:#8d97ab}
    .twhit.tson .twtx span{color:#ff8a8a}
    .twcat{display:flex;align-items:center;gap:10px;width:100%;min-height:0;padding:5px 4px;border:0;border-radius:8px;background:none;color:#e8ebf2;text-align:left;font:inherit}
    .twcat:hover{background:rgba(255,255,255,.06)}
    .twart{width:30px;height:40px;flex:none;border-radius:4px;overflow:hidden;background:rgba(255,255,255,.08)}
    .twart img{width:100%;height:100%;object-fit:cover}
    .twback2{display:flex;align-items:center;gap:8px;width:100%;min-height:0;height:30px;margin:0 0 4px;padding:0 6px;border:0;border-radius:8px;background:rgba(255,255,255,.06);color:#fff;font:inherit;font-size:12.5px;font-weight:700}
    .twback2 svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
    .twback2 i{margin-left:auto;font-style:normal;font-weight:600;color:#ff8a8a;font-size:11.5px}
    .twstream{cursor:pointer}
    .twstream .twtx span{color:#aab3c4 !important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .twadd{width:28px;height:28px;min-height:0;flex:none;padding:0;border:0;border-radius:50%;background:rgba(255,255,255,.1);color:#fff;font-size:17px;font-weight:700;line-height:28px;text-align:center}
    .twadd:hover{background:var(--acc)}
    .twadd.on{background:color-mix(in srgb,#17864a 70%,var(--pnl));font-size:14px}
    /* Settings over TV */
    .setwrap{position:absolute;inset:0;z-index:30;display:grid;place-items:center;background:rgba(0,0,0,.55);backdrop-filter:blur(calc(6px * var(--bk,1)))}
    .setwrap[hidden]{display:none}
    .setbox{width:min(1240px,94%);height:92%;display:flex;flex-direction:column;border-radius:14px;overflow:hidden;background:#14161b;border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);box-shadow:0 24px 70px rgba(0,0,0,.6)}
    .motion .setbox{animation:fpin .2s ease}
    .setbar{display:flex;align-items:center;gap:10px;padding:8px 10px 8px 16px;border-bottom:1px solid color-mix(in srgb,var(--pnl) 60%,#8a96ad);color:#8d97ab;font-size:12px}
    .setbar b{color:#fff;font-size:13.5px}
    .setbar .setx{margin-left:auto;width:32px;min-height:0;height:32px;padding:0;border:0;border-radius:8px;background:rgba(255,255,255,.08);font-size:15px}
    .setbar .setx:hover{background:var(--acc)}
    .setf{flex:1;width:100%;border:0;background:#14161b}
    .fstrip{display:flex;flex-wrap:wrap;align-items:center;gap:5px;padding:4px 0 7px}
    .fchip{display:inline-flex;align-items:center;gap:2px;min-height:0;height:22px;padding:0 3px 0 9px;border:0;border-radius:999px;background:rgba(255,255,255,.1);color:#dfe3ec;font-size:11.5px;font-weight:600}
    .fchip i{font-style:normal;width:16px;text-align:center;opacity:.55}
    .fchip:hover{background:rgba(255,255,255,.16)} .fchip:hover i{opacity:1}
    .fclear{min-height:0;height:22px;margin-left:auto;padding:0 4px;border:0;background:none;color:#8d97ab;font-size:11.5px;text-decoration:underline}
    .fclear:hover{color:#fff;background:none}
    .fpop{position:absolute;z-index:9;top:44px;right:8px;width:min(300px,calc(100% - 16px));max-height:calc(100% - 56px);overflow:auto;padding:12px 12px 10px;border-radius:12px;background:var(--pnl);border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);box-shadow:0 16px 40px rgba(0,0,0,.55);color:#e8ebf2;font-size:12.5px;line-height:1.35}
    .motion .fpop{animation:fpin .16s ease}
    @keyframes fpin{from{opacity:0;transform:translateY(-4px)}}
    .fpop h4{margin:0 0 8px;font-size:13px;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
    .fpop .fcount{color:#8d97ab;font-weight:600;font-size:11.5px;font-variant-numeric:tabular-nums}
    .fsec{padding:9px 0;border-top:1px solid color-mix(in srgb,var(--pnl) 60%,#8a96ad)}
    .flbl{font-size:11.5px;font-weight:700;color:#aab3c4;margin-bottom:6px}
    .fseg{display:flex;gap:2px;padding:2px;border-radius:8px;background:rgba(0,0,0,.3)}
    .fseg button{flex:1;min-height:0;height:26px;padding:0 4px;border:0;border-radius:6px;background:none;color:#aab3c4;font-size:12px;font-weight:600;white-space:nowrap}
    .fseg button.on{background:var(--acc);color:#fff}
    .fseg button:not(.on):hover{color:#fff;background:rgba(255,255,255,.08)}
    .fline{display:flex;align-items:center;gap:6px;margin-top:6px;min-height:26px;color:#cfd4de}
    .fline.off{opacity:.45}
    .ftx{cursor:pointer;user-select:none}
    .fck{width:16px;height:16px;min-height:0;flex:none;padding:0;border:1.5px solid #6b7488;border-radius:4px;background:none;display:inline-flex;align-items:center;justify-content:center}
    .fck.on{background:var(--acc);border-color:var(--acc)}
    .fck.on::after{content:"";width:8px;height:4px;margin-top:-2px;border:2px solid #fff;border-top:0;border-right:0;transform:rotate(-45deg)}
    .fpop .fnum{width:54px;min-height:0;height:26px;padding:0 6px;border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);border-radius:6px;background:#0e121b;color:#fff;font:inherit;font-size:12.5px;text-align:right}
    .fsel{height:26px;padding:0 4px;border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);border-radius:6px;background:#0e121b;color:#fff;font:inherit;font-size:12.5px}
    .fnote{margin-top:5px;font-size:11px;color:#8d97ab}
    .fnote:empty{display:none}
    .ffoot{display:flex;justify-content:space-between;align-items:center;gap:8px;padding-top:10px;border-top:1px solid color-mix(in srgb,var(--pnl) 60%,#8a96ad);font-size:11.5px;color:#8d97ab}
    .ffoot button{min-height:0;height:28px;padding:0 12px;border:0;border-radius:7px;background:rgba(255,255,255,.1);color:#fff;font-size:12px;font-weight:600}
    @keyframes spin{to{transform:rotate(360deg)}}
    /* the ▾ channel list */
    .chmenu{position:absolute;z-index:8;width:min(250px,80%);max-height:60%;overflow:auto;padding:6px;border-radius:12px;background:var(--pnl);border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);box-shadow:0 14px 36px rgba(0,0,0,.5);opacity:0;transform:translateY(-6px) scale(.97);transform-origin:top left;transition:opacity .16s ease,transform .18s cubic-bezier(.4,0,.2,1)}
    .chmenu.on{opacity:1;transform:none}
    .chmenu .cm{display:flex;align-items:center;gap:10px;width:100%;min-height:36px;padding:0 10px;border:0;background:none;text-align:left;font-size:13.5px}
    .chmenu .cm:hover,.chmenu .cm:focus-visible{background:color-mix(in srgb,var(--acc) 28%,var(--pnl));outline:none}
    .chmenu .cm.sel{background:color-mix(in srgb,var(--acc) 18%,var(--pnl))}
    .chmenu .n{min-width:18px;font-weight:800;color:color-mix(in srgb,var(--acc) 60%,#fff);font-variant-numeric:tabular-nums}
    .chmenu .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .chmenu .sep{height:1px;margin:5px 6px;background:color-mix(in srgb,var(--pnl) 55%,#8a96ad)}
    .chmenu .more .nm{color:#aab3c4}
    .pwrap{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
    .pbody{position:relative;flex:1;min-height:0;overflow:auto;padding:4px 6px;overscroll-behavior:contain}
    /* the shelf under a list: pull it into view to load more */
    /* the end of a list: load more */
    .endline{margin:10px 0 16px;text-align:center;font-size:12px;color:#8d97ab}
    .endline[hidden]{display:none}
    .more{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:44px;margin:8px 0 14px;border:1.5px dashed color-mix(in srgb,var(--pnl) 45%,#8a96ad);border-radius:var(--rrad,7px);background:transparent;color:#aab3c4;font-size:13px;font-weight:600;transition:color .2s ease,border-color .2s ease,background .2s ease}
    .more:hover{color:#fff;border-color:var(--acc);background:color-mix(in srgb,var(--acc) 12%,transparent)}
    .more[hidden]{display:none}
    .more svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
    /* the slim bar slides in from under the tabs, never over them */
    .pwrap{overflow:hidden}
    /* depth: the list softly fades out at an edge where there is more to scroll */
    .edgefade .pbody.ft{-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 22px);mask-image:linear-gradient(180deg,transparent 0,#000 22px)}
    .edgefade .pbody.fb{-webkit-mask-image:linear-gradient(0deg,transparent 0,#000 28px);mask-image:linear-gradient(0deg,transparent 0,#000 28px)}
    .edgefade .pbody.ft.fb{-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 22px,#000 calc(100% - 28px),transparent 100%);mask-image:linear-gradient(180deg,transparent 0,#000 22px,#000 calc(100% - 28px),transparent 100%)}
    /* back to the top, once you're far down */
    .totop{position:absolute;right:12px;bottom:12px;z-index:3;width:34px;height:34px;min-height:0;padding:0;border:0;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--pnl) 70%,#000);box-shadow:0 6px 16px rgba(0,0,0,.45);color:#fff;opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .25s ease,transform .25s cubic-bezier(.4,0,.2,1),background .15s ease}
    .totop.on{opacity:1;transform:none;pointer-events:auto}
    .totop:hover{background:var(--acc)}
    .totop svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;transform:rotate(180deg)}

    .ptitle{margin:4px 8px 8px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#aab3c4}
    .hintline{margin:6px 8px 8px;font-size:12px;color:#aab3c4}
    .empty{margin:28px 16px;text-align:center;color:#aab3c4;font-size:13.5px;line-height:1.5}
    .empty b{display:block;margin-bottom:4px;color:#fff;font-size:15px}
    .empty:has(.skel){margin:0;text-align:left}
    /* loading: placeholder rows that shimmer */
    .skel{display:flex;flex-direction:column;gap:var(--gap)}
    .srow{display:flex;gap:10px;align-items:center;padding:6px}
    .srow .sth{flex:none;width:min(var(--tw),45%);aspect-ratio:16/9;border-radius:7px}
    .srow .stx{flex:1;height:12px;border-radius:6px;margin-right:30%}
    .srow .sth,.srow .stx{background:linear-gradient(90deg,rgba(255,255,255,.05) 25%,rgba(255,255,255,.12) 50%,rgba(255,255,255,.05) 75%) 0 0/300% 100%}
    .motion .srow .sth,.motion .srow .stx{animation:shim 1.3s ease-in-out infinite}
    @keyframes shim{from{background-position:100% 0}to{background-position:0 0}}
    /* rows: each is a sideways scroller [left action | video | right action] resting on the video */
    .lbox{display:flex;flex-direction:column}
    .lbox .mid{flex:1}
    .sw{position:relative;margin:0 0 var(--gap);border-radius:var(--rrad,7px);overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none;overscroll-behavior-x:contain;container-type:inline-size}
    .sw::-webkit-scrollbar{display:none}
    .sw.gone{pointer-events:none;overflow:hidden}
    /* the playing row stays at the top while you scroll down past it (never at the bottom) */
    /* what's playing, as a slim bar over the top of the list once its row scrolls away (scroll-linked, no layout changes) */
    .nowbar{position:absolute;left:6px;right:6px;top:0;z-index:3;display:flex;align-items:center;gap:9px;min-height:0;height:calc(var(--rowh) * .56);padding:3px 10px 3px 4px;border:0;border-radius:0 0 9px 9px;background:color-mix(in srgb,var(--acc) 34%,var(--pnl));box-shadow:inset 4px 0 0 var(--acc),0 8px 18px -6px rgba(0,0,0,.6);text-align:left;opacity:0;transform:translateY(-105%);pointer-events:none;will-change:transform,opacity}
    .nowbar.on{pointer-events:auto}
    .nowbar:hover{background:color-mix(in srgb,var(--acc) 44%,var(--pnl))}
    .nowbar .nth{flex:none;height:100%;aspect-ratio:16/9;border-radius:5px;background:#111 center/cover no-repeat}
    .nowbar .nt{flex:1;min-width:0;font-size:var(--fs,13px);font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sw.moved .item{background:color-mix(in srgb,#17864a 30%,var(--pnl))}
    .sw.dragslot{opacity:.25}
    .dragghost{position:absolute;z-index:9;margin:0;pointer-events:none;box-shadow:0 14px 34px rgba(0,0,0,.55);border-radius:10px;will-change:transform;opacity:.96}
    .track{display:grid;grid-template-columns:var(--R,200px) 100cqw var(--R,200px)}
    .act{display:flex;align-items:center;color:#fff;scroll-snap-align:start}
    .act.left{justify-content:flex-start}
    .act.right{scroll-snap-align:end;justify-content:flex-end}
    /* the icons stay put at the list's edge while the video slides off them, as if uncovered from behind */
    .act.left svg{position:sticky;left:22px;margin-left:22px} .act.right svg{position:sticky;right:22px;margin-right:22px}
    .act.rm{background:color-mix(in srgb,var(--rmc,#d93a3f) calc(40% + var(--p,0) * 45%),var(--pnl))}
    .act.add{background:color-mix(in srgb,var(--addc,#17864a) calc(40% + var(--p,0) * 45%),var(--pnl))}
    .sw.armed .act.rm{background:var(--rmc,#d93a3f)} .sw.armed .act.add{background:var(--addc,#17864a)}
    .sw.nextup .act.add{background:color-mix(in srgb,var(--nxc,#3d7be0) calc(40% + var(--p,0) * 45%),var(--pnl))} .sw.nextup.armed .act.add{background:var(--nxc,#3d7be0)}
    .sw.no .act{background:color-mix(in srgb,#6b7385 30%,var(--pnl))}
    .act svg{width:var(--aico,24px);height:var(--aico,24px);fill:none;stroke:currentColor;stroke-width:2.3;stroke-linecap:round;stroke-linejoin:round;transform:scale(calc(.65 + var(--p,0) * .35));transition:transform .16s cubic-bezier(.4,0,.2,1)}
    .sw.armed .act svg{transform:scale(1.18)}
    .sw.no .act svg{opacity:.35}
    .item{position:relative;display:flex;gap:10px;align-items:center;min-width:0;min-height:var(--rowh);padding:5px;border:1px solid transparent;border-radius:var(--rrad,7px);background:var(--rowbg);text-align:left;cursor:pointer;scroll-snap-align:start;scroll-initial-target:nearest;transition:background .15s}
    .item:hover{background:color-mix(in srgb,var(--pnl) 70%,#5a6680)}
    .item.cur{background:color-mix(in srgb,var(--acc) 34%,var(--pnl));border-color:var(--acc)}
    .item.done{opacity:.5}
    .item.flash{animation:flash .55s ease}
    @keyframes flash{25%{background:color-mix(in srgb,#17864a 38%,var(--pnl))}}
    .sw.enter{animation:enter .32s cubic-bezier(.4,0,.2,1) both}
    @keyframes enter{from{opacity:0;transform:translateY(8px)}}
    .thumb{position:relative;flex:none;width:min(var(--tw),55%);aspect-ratio:16/9;border-radius:7px;overflow:hidden;background:#111}
    .thumb img{width:100%;height:100%;object-fit:cover;display:block;opacity:0;transition:opacity .3s ease}
    .thumb img.ok{opacity:1}
    .thumb .pg{position:absolute;left:0;bottom:0;height:3px;background:#f03}
    .thumb .pgt{position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.35)}
    /* explore and Watch Later: only while the pointer is on the picture */
    .thumb .hb{position:absolute;top:4px;width:var(--hb,22px);height:var(--hb,22px);min-height:0;padding:0;border-radius:calc(var(--hb,22px) * .28);border:0;background:rgba(0,0,0,.72);color:#fff;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .14s,background .14s}
    .thumb .hb.exb{left:4px} .thumb .hb.wlb{right:4px}
    .thumb .hb svg{width:calc(var(--hb,22px) * .6);height:calc(var(--hb,22px) * .6);fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
    .thumb:hover .hb,.thumb .hb:focus-visible,.thumb .hb.on{opacity:1;transform:none}
    .item:not(:hover) .thumb .hb.exb{opacity:0}
    .thumb .hb:hover{background:var(--acc)}
    .thumb .hb.on{background:#17864a}
    .thumb .hb.bad{animation:shake .35s}
    @keyframes shake{25%{transform:translateX(-3px)}75%{transform:translateX(3px)}}
    .item .txt{flex:1;min-width:0}
    .item .it{font-size:var(--fs,13px);font-weight:600;color:#fff;display:-webkit-box;-webkit-line-clamp:var(--lines,2);-webkit-box-orient:vertical;overflow:hidden}
    .item .ic{font-size:var(--fs2,12px);color:#aab3c4;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    /* compact rows: small pictures, one-line titles, a thin gap, an accent bar on what's playing */
    .dense{--gap:1px}
    .dense .item{gap:9px;padding:4px}
    .dense .item .it{-webkit-line-clamp:var(--lines,1)}
    .dense .item.cur{border-color:color-mix(in srgb,var(--acc) 75%,transparent);box-shadow:inset 4px 0 0 var(--acc);background:color-mix(in srgb,var(--acc) 32%,var(--pbg))}
    .item.cur .it{color:#fff}
    .dense .thumb{border-radius:5px}
    .item.drop-before{box-shadow:inset 0 3px 0 var(--acc)} .item.drop-after{box-shadow:inset 0 -3px 0 var(--acc)}
    .withicon{display:inline-flex;align-items:center;gap:6px}
    .withicon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
    .explore .sub{margin:14px 0 6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#aab3c4}
    .desc{white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.55;color:#e0ebf6;padding:6px 8px 4px;user-select:text}
    .desc h3{margin:0 0 4px;font-size:17px;color:#fff;white-space:normal}
    .desc .by{color:#aab3c4;margin-bottom:12px;white-space:normal}
    .desc .subs{margin:-8px 0 12px;color:#aab3c4;font-size:12.5px;white-space:normal}
    .desc .subs[hidden]{display:none}
    .desc .fact{white-space:nowrap}
    .desc .ico{display:inline-block}
    .sect{margin:16px 8px 4px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#aab3c4}
    .coms{padding:0 6px 20px;user-select:text}
    .coms .muted{color:#aab3c4}
    .com{padding:10px 6px;border-bottom:1px solid color-mix(in srgb,var(--pnl) 70%,#8a96ad)}
    .com .ch{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;font-size:13px}
    .com .ch b{color:#fff}
    .com .ch span{color:#8d97ab;font-size:12px}
    .com .ct{margin-top:4px;font-size:14px;line-height:1.5;color:#e0ebf6;white-space:pre-wrap;word-break:break-word}
    .com .cr{margin-top:4px;font-size:12px;color:color-mix(in srgb,var(--acc) 60%,#fff)}
    .coms > button{margin-top:12px;width:100%}
    .start{position:absolute;inset:0;z-index:6;display:none;place-items:center;background:rgba(0,0,0,.55)}
    .start button{font:700 20px system-ui,sans-serif;background:var(--acc);border:0;border-radius:14px;padding:16px 28px;min-height:0}
    .show-start .start{display:grid}
    .guide{position:absolute;inset:0;z-index:7;display:none;overflow:auto;padding:56px 7vw;background:color-mix(in srgb,var(--pnl) 97%,#000)}
    .show-guide .guide{display:block}
    .guide h2{margin:0 0 6px;font-size:30px;color:#fff}
    .guide p{margin:0 0 24px;color:#aab3c4}
    .guide .gtop{position:absolute;top:20px;right:24px;display:flex;gap:8px}
    .guide .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,196px));gap:10px}
    .guide .card{display:flex;flex-direction:column;align-items:stretch;gap:8px;min-height:0;padding:12px;text-align:left;border-radius:14px}
    .guide .card.on{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc) inset}
    .guide .chd{display:flex;align-items:center;gap:10px}
    .guide .chd .n{font-size:16px;font-weight:800;color:color-mix(in srgb,var(--acc) 60%,#fff);min-width:22px}
    .guide .chd .nm{flex:1;min-width:0;font-size:13.5px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .guide .chd .live{font-size:0}
    .guide .cb{display:flex;flex-direction:column;gap:4px;min-height:60px}
    .guide .cb img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:7px;background:#111}
    .guide .nt{font-size:14px;font-weight:600;color:#fff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .guide .nw{font-size:12px;color:#aab3c4}
    .guide .nx{font-size:12px;color:#cfd6e4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .guide .lbl{color:color-mix(in srgb,var(--acc) 60%,#fff);font-weight:700}
    .guide .cs{font-size:11px;color:#8d97ab;margin-top:auto}
    .guide .strip{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;margin-top:2px}
    .guide .strip img{width:100%;aspect-ratio:16/9;object-fit:cover;border-radius:4px;background:#111;opacity:.85;transition:opacity .15s}
    .guide .card:hover .strip img{opacity:1}
    .guide .card{position:relative;cursor:pointer;padding:8px;gap:6px;border-radius:12px;background:transparent;border:1.5px solid color-mix(in srgb,var(--pnl) 45%,#8a96ad);transition:transform .2s cubic-bezier(.4,0,.2,1),border-color .15s,box-shadow .2s,opacity .15s}
    .guide .card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--acc) 60%,#8a96ad);box-shadow:0 8px 22px rgba(0,0,0,.35);background:transparent}
    .motion .guide .card{animation:enter .35s cubic-bezier(.4,0,.2,1) both}
    .guide .card .nt{font-size:12px}
    .guide .card .nx,.guide .card .nw{font-size:11px}
    .guide .card.on{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc) inset}
    .guide .card[draggable="true"]{cursor:grab}
    .guide .card.dragging{opacity:.35}
    .guide .card.drop-before{box-shadow:-4px 0 0 var(--acc)} .guide .card.drop-after{box-shadow:4px 0 0 var(--acc)}
    .guide .chd .nm[contenteditable="true"]{outline:2px solid var(--acc);outline-offset:2px;border-radius:4px;cursor:text;user-select:text}
    .guide .ren{flex:none;width:28px;height:28px;min-height:0;padding:0;border-radius:8px;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .12s}
    .guide .ren svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
    .guide .card:hover .ren,.guide .ren:focus-visible{opacity:1}
    .guide .newc{display:flex;flex-direction:column;gap:8px;padding:12px;border-radius:14px;border:1.5px dashed color-mix(in srgb,var(--pnl) 40%,#8a96ad);background:none}
    .guide .newc b{color:#fff;font-size:15px}
    .guide .newc input{min-height:36px;padding:0 10px;border-radius:9px;border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);background:#0e121b;color:#fff;font:inherit;font-size:13px}
    .guide .newc .hint{font-size:11.5px;color:#8d97ab}
    .guide .newc .row{display:flex;gap:6px}
    .keys{margin-top:28px;color:#aab3c4;font-size:13px}
    .msg{position:absolute;inset:0;z-index:3;display:none;place-items:center;text-align:center;padding:24px;background:#000}
    .show-msg .msg{display:grid}
    .toast{position:absolute;left:50%;bottom:170px;transform:translateX(-50%);z-index:8;padding:10px 16px;border-radius:12px;background:var(--acc);color:#fff;font-weight:600;opacity:0;transition:opacity .3s;pointer-events:none}
    .toast.on{opacity:1}
    .toast.act{pointer-events:auto}
    .tundo{margin-left:8px;padding:3px 10px;border-radius:8px;border:1px solid rgba(255,255,255,.7);background:rgba(0,0,0,.25);color:#fff;font:inherit;font-weight:700;cursor:pointer}
    .pop{position:absolute;z-index:8;width:min(320px,90vw);max-height:60vh;overflow:auto;padding:8px;border-radius:14px;background:var(--pnl);border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);box-shadow:0 12px 32px rgba(0,0,0,.5)}
    .pop[hidden]{display:none}
    .pop .ph{padding:6px 8px 8px;font-size:12px;color:#aab3c4}
    .pop button{display:flex;align-items:center;gap:10px;width:100%;min-height:40px;margin:2px 0;text-align:left;border-color:transparent;background:none}
    .pop button:hover{background:color-mix(in srgb,var(--acc) 30%,var(--pnl))}
    .pop .ck{width:18px;color:var(--acc);font-weight:800}
    .pop .row{display:flex;gap:6px;margin-top:6px}
    .pop input,.explore input{flex:1;min-height:38px;padding:0 10px;border-radius:10px;border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);background:#0e121b;color:#fff;font:inherit}
    .scrim{position:absolute;inset:0;z-index:7;display:none;background:transparent}
    .tv:has(.explore:not([hidden])) .scrim,.tv:has(.pop:not([hidden])) .scrim{display:block}
    .tv:has(.explore:not([hidden])) .scrim{background:rgba(0,0,0,.22);backdrop-filter:blur(calc(8px * var(--bk,1)));animation:scrimin .2s ease both} /* the video softly blurred behind explore and search */
    @keyframes scrimin{from{opacity:0}}
    .explore .ideas button.picked{background:var(--acc);border-color:var(--acc);color:#fff}
    .explore{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:8;width:min(520px,92vw);padding:20px;border-radius:16px;background:var(--pnl);border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);box-shadow:0 16px 40px rgba(0,0,0,.5)}
    .explore[hidden]{display:none}
    .explore h3{margin:0 0 4px;font-size:19px;color:#fff}
    .explore p{margin:0 0 12px;color:#aab3c4;font-size:13px}
    .explore .row{display:flex;gap:8px}
    .explore input{font-size:16px;min-height:42px}
    .explore textarea{width:100%;box-sizing:border-box;padding:10px;border-radius:10px;border:1px solid color-mix(in srgb,var(--pnl) 55%,#8a96ad);background:#0e121b;color:#fff;font:inherit;font-size:14px;resize:vertical;min-height:120px}
    .explore .bulknote{margin:8px 0 10px;min-height:18px}
    .explore .ideas{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
    .explore .ideas button{min-height:30px;padding:0 12px;border-radius:999px;font-size:13px}
    /* picking several videos */
    .sw.picked .item{box-shadow:inset 0 0 0 2px var(--acc);background:color-mix(in srgb,var(--acc) 18%,var(--pnl))}
    .sw.picked .thumb::after{content:"✓";position:absolute;inset:auto 5px 5px auto;width:20px;height:20px;border-radius:50%;display:grid;place-items:center;background:var(--acc);color:#fff;font-size:12px;font-weight:800}
    .pickbar{position:absolute;left:8px;right:8px;bottom:8px;z-index:4;display:flex;align-items:center;gap:6px;padding:6px 6px 6px 12px;border-radius:12px;background:color-mix(in srgb,var(--pnl) 92%,#000);border:1px solid color-mix(in srgb,var(--acc) 50%,transparent);box-shadow:0 10px 28px rgba(0,0,0,.5);opacity:0;transform:translateY(12px);pointer-events:none;transition:opacity .22s ease,transform .22s cubic-bezier(.4,0,.2,1)}
    .pickbar.on{opacity:1;transform:none;pointer-events:auto}
    .pickbar .pn{flex:1;min-width:0;font-size:13px;font-weight:700;color:#fff;white-space:nowrap}
    .pickbar button{min-height:30px;padding:0 10px;font-size:12.5px;font-weight:600}
    .pickbar .pclose{width:30px;padding:0;display:grid;place-items:center;background:none;border:0}
    .pickbar .pclose svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round}
    /* the title has its own size; the other bits on its line follow the smaller size */
    .now .t .age,.now .t .sep,.now .t .bit{font-size:var(--tfs2,13px);font-weight:400}
    .item .it .bit{font-size:var(--fs2,12px);font-weight:400;color:#c3c9d6}
    /* small icons before the creator, date and length (Settings → Look & feel) */
    .ico{display:none;width:1.05em;height:1.05em;margin-right:.25em;vertical-align:-.15em;opacity:.8}
    .ricons .item .ico,.topicons .now .ico{display:inline-block}
    .ico svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
    /* ready-made channels as icons in the tab bar */
    .tab .tico{display:inline-grid;place-items:center;width:17px;height:17px}
    .tab .tico svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2.1;stroke-linecap:round;stroke-linejoin:round}
    .chmenu .cm .cmi{display:inline-grid;place-items:center;width:16px;height:16px;color:#aab3c4}
    .chmenu .cm .cmi svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.1;stroke-linecap:round;stroke-linejoin:round}
    /* the right edge that brings the list out */
    .edge{position:absolute;top:0;right:0;bottom:0;width:var(--edgew,12px);z-index:6;display:none;transition:background .25s ease}
    .edgeon:not(.show-panel) .edge{display:block}
    .edgeglow{position:absolute;top:0;right:0;bottom:0;width:var(--edgew,12px);z-index:6;display:none;pointer-events:none;opacity:0;transition:opacity .25s ease;background:linear-gradient(270deg,color-mix(in srgb,var(--acc) 30%,transparent),transparent)}
    .edgeon:not(.show-panel) .edgeglow{display:block}
    .tv:has(> .edge:hover) > .edgeglow{opacity:1}
    /* the channel overview takes the panel's look: see-through and blurred */
    /* the overview: your panel colour, darker and more blurred than the list so the cards stand out */
    .guide{background:color-mix(in srgb,color-mix(in srgb,var(--pnl) 70%,#000) min(100%,calc(var(--palpha,80%) + 45%)),transparent);backdrop-filter:blur(calc(max(28px,var(--pblur,16px) * 2.5) * var(--bk,1))) saturate(1.1);scrollbar-width:none}
    .motion.show-guide .guide{animation:gin .26s cubic-bezier(.22,1,.36,1) both}
    .guide-out .guide{display:block;pointer-events:none;animation:gout .2s cubic-bezier(.4,0,1,1) both}
    @keyframes gin{from{opacity:0;transform:scale(.985);backdrop-filter:blur(0) saturate(1)}}
    @keyframes gout{to{opacity:0;transform:scale(.99);backdrop-filter:blur(0) saturate(1)}}
    /* no browser scrollbars anywhere in YTV (they show up white on some setups) */
    *{scrollbar-width:none}
    *::-webkit-scrollbar{display:none;width:0;height:0}
    /* a soft shadow lifts the list off the video */
    .panel{box-shadow:-10px 0 34px rgba(0,0,0,.28),0 0 1px rgba(0,0,0,.4)}
    .guide .pinb{flex:none;width:26px;height:26px;min-height:0;padding:0;border-radius:50%;display:grid;place-items:center;background:rgba(0,0,0,.35);border:0;color:#fff;transition:background .2s ease}
    .guide .pinb:hover{background:var(--acc)}
    .guide .pinb.on{background:var(--acc)}
    .guide .pinb svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
    .tab .tl.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
    /* Twitch: its player over YouTube's */
    .twframe{position:absolute;inset:0;width:100%;height:100%;border:0;z-index:1;background:#000}
    /* Twitch in YTV's own look: a red LIVE pill with a breathing dot, the viewer count like a video's length */
    .thumb .twlive{position:absolute;left:5px;top:5px;display:inline-flex;align-items:center;gap:4px;height:16px;padding:0 6px 0 5px;border-radius:999px;background:var(--acc);color:#fff;font-size:9.5px;font-weight:800;letter-spacing:.06em;box-shadow:0 2px 6px rgba(0,0,0,.35);z-index:1}
    .thumb .twlive i,.twpill i{width:5px;height:5px;border-radius:50%;background:#fff}
    @keyframes livedot{50%{opacity:.35}}
    .thumb .twv{position:absolute;right:5px;bottom:5px;display:inline-flex;align-items:center;gap:3px;padding:1px 5px;border-radius:4px;background:rgba(0,0,0,.72);color:#fff;font-size:10.5px;font-weight:700;font-variant-numeric:tabular-nums;z-index:1}
    .thumb .twv svg{width:11px;height:11px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
    .sw.twoff .item{min-height:0;padding-top:4px;padding-bottom:4px;opacity:.55;transition:opacity .15s}
    .sw.twoff .item:hover{opacity:.85}
    .sw.twoff .thumb{width:44px;height:44px;aspect-ratio:auto;flex:none;margin-left:calc((var(--tw) - 44px) / 2);margin-right:calc((var(--tw) - 44px) / 2);border-radius:50%;overflow:hidden;filter:grayscale(1)}
    .sw.twoff .thumb img{width:100%;height:100%;object-fit:cover;border-radius:50%}
    .sw.twoff .it{font-weight:600}
    .twinfo h3{margin:4px 0 10px}
    .twfacts{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;color:#cfd6e4;font-size:13px}
    .twpill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px 0 7px;border-radius:999px;background:var(--acc);color:#fff;font-size:10.5px;font-weight:800;letter-spacing:.06em}
    /* loading: a small ring that spins smoothly (an arc that grows and shrinks as it turns) */
    .phead .pb.spin svg,.more.go svg{display:none}
    .phead .pb.spin::after,.more.go::before{content:"";width:15px;height:15px;flex:none;border-radius:50%;box-sizing:border-box;
      border:2px solid color-mix(in srgb,currentColor 18%,transparent);border-top-color:var(--acc);border-right-color:var(--acc);
      animation:ring .75s cubic-bezier(.5,.15,.5,.85) infinite}
    @keyframes ring{to{transform:rotate(360deg)}}
    /* middle click closes tabs: no ✕ needed */
    .nox .tab .tx{display:none}
    /* tabs you drag to reorder */
    .ptabs .tab.tdrag{z-index:3;opacity:.9;transition:none;cursor:grabbing;background:color-mix(in srgb,var(--pnl) 70%,#5a6680);border-radius:8px 8px 0 0}
    .ptabs .tab.tshift{transition:transform .18s cubic-bezier(.4,0,.2,1)}
    /* Twitch: a plain list to pick from (no swiping), a see-through layer over the player that keeps the mouse and keys with YTV */
    .sw.still{overflow:hidden;scroll-snap-type:none}
    .sw.still .act{visibility:hidden}
    .acts .tw-only{display:none}
    .on-twitch .acts .tw-only{display:flex}
    .on-twitch .acts .yt-only{display:none}
    .twbio{margin:10px 0;white-space:pre-wrap;color:#cfd6e4;font-size:13px}
    .twopen{display:inline-block;margin-top:8px;color:color-mix(in srgb,var(--acc) 60%,#fff);font-weight:700;text-decoration:none}
    .twopen:hover{text-decoration:underline}
    /* Twitch chat over the video: just the messages on soft dark bars, appearing and fading away */
    .twchatov{position:absolute;left:22px;bottom:96px;z-index:3;width:min(360px,34vw);max-height:46vh;display:flex;flex-direction:column;pointer-events:auto;font-size:var(--cfs,14px);line-height:1.38}
    .twchatov[hidden]{display:none}
    .twchatov.right{left:auto;right:22px}
    .twchatov .lines{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:flex-end;gap:3px;overflow:hidden;-webkit-mask:linear-gradient(180deg,transparent 0,#000 40px);mask:linear-gradient(180deg,transparent 0,#000 40px)}
    .twchatov.right .lines{align-items:flex-end}
    .twchatov .cm,.twchatp .cm{align-self:flex-start;max-width:100%;padding:3px 9px 4px;border-radius:9px;background:rgba(10,11,14,var(--cbg,.55));color:#eef1f6;overflow-wrap:anywhere;text-shadow:0 1px 2px rgba(0,0,0,.6);animation:cmin .22s cubic-bezier(.22,1,.36,1) both}
    .twchatov.right .cm{align-self:flex-end}
    .twchatov .cm[style*="--life"]{animation:cmin .22s cubic-bezier(.22,1,.36,1) both,cmout .6s ease var(--life) forwards}
    .twchatov .cm b,.twchatp .cm b{font-weight:700;margin-right:6px}
    .twchatov .cm.me .ct,.twchatp .cm.me .ct{font-style:italic;opacity:.85}
    .twchatov .emo,.twchatp .emo{height:1.75em;width:auto;vertical-align:-.5em;margin:0 1px}
    .twchatov .emoalt,.twchatp .emoalt{font-weight:600}
    /* its handle (while YTV's UI is up): drag to move, the corner to resize */
    .twchatov .chdl{display:flex;align-items:center;gap:2px;height:26px;margin-bottom:4px;padding:0 4px 0 10px;border-radius:9px;background:rgba(10,11,14,.6);color:#cfd6e4;font-size:12px;font-weight:700;cursor:grab;pointer-events:auto;opacity:0;transition:opacity .2s}
    .twchatov:hover .chdl,.twchatov.dragging .chdl{opacity:1} /* the handle only while you point at the chat */
    .twchatov .chdt{flex:1}
    .twchatov .chb{width:22px;height:22px;min-height:0;padding:0;border:0;border-radius:6px;background:none;color:#cfd6e4;display:flex;align-items:center;justify-content:center}
    .twchatov .chb:hover{background:rgba(255,255,255,.14);color:#fff}
    .twchatov .chb svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
    .twchatov .chgrip{position:absolute;right:-4px;bottom:-4px;width:16px;height:16px;cursor:nwse-resize;pointer-events:auto;background:linear-gradient(135deg,transparent 50%,rgba(255,255,255,.5) 50%,rgba(255,255,255,.5) 60%,transparent 60%,transparent 72%,rgba(255,255,255,.5) 72%,rgba(255,255,255,.5) 82%,transparent 82%);opacity:0;transition:opacity .2s}
    .twchatov:hover .chgrip,.twchatov.dragging .chgrip{opacity:1}
    .twchatov:not(.placed) .chgrip{display:none}
    .twchatov.dragging{transition:none}
    .twchatov.dragging .chdl{cursor:grabbing}
    .twchatov.placed{max-height:none}
    @keyframes cmin{from{opacity:0;transform:translateY(6px)}}
    @keyframes cmout{to{opacity:0}}
    .twchatov .emoalt{font-weight:600}
    /* the stream's chat in the list panel: the same bars as over the video */
    .twchatp{display:flex;flex-direction:column;gap:3px;padding:6px 6px 10px;font-size:var(--cfs,14px);line-height:1.42}
    .twchatp .cstat{align-self:center;margin:8px 0;padding:4px 10px;border-radius:999px;background:color-mix(in srgb,var(--pnl) 70%,#000);color:#aab3c4;font-size:12px;font-style:italic}
    .twchatp .cstat[hidden]{display:none}
    .twframe{pointer-events:auto} /* the mouse goes to Twitch's player: its own volume, quality and hover pop-ups */
    .twwarm{position:absolute;left:-10000px;top:0;width:640px;height:360px;border:0;opacity:0;pointer-events:none} /* loading ahead, out of sight */
    /* Twitch: past broadcasts under the stream's details */
    .twvh{margin:18px 0 8px;font-size:12px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#8d97ab}
    .twvods{display:flex;flex-direction:column;gap:4px}
    .twvod{display:flex;gap:10px;align-items:center;width:100%;min-height:0;padding:5px;border:1px solid transparent;border-radius:var(--rrad,7px);background:transparent;text-align:left;cursor:pointer}
    .twvod:hover{background:color-mix(in srgb,var(--pnl) 70%,#5a6680)}
    .twvod.on{border-color:var(--acc);background:color-mix(in srgb,var(--acc) 18%,var(--pnl))}
    .twvod .vth{position:relative;flex:none;width:min(var(--tw),45%);aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:#111}
    .twvod .vth img{width:100%;height:100%;object-fit:cover;display:block}
    .twvod .vlen{position:absolute;right:4px;bottom:4px;padding:0 4px;border-radius:3px;background:rgba(0,0,0,.75);color:#fff;font-size:10.5px;font-weight:700}
    .twvod .vtx{display:flex;flex-direction:column;gap:2px;min-width:0}
    .twvod .vtx b{font-size:13px;color:#fff;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .twvod .vtx span{font-size:11.5px;color:#aab3c4}
    .twback{margin-top:10px}
    .twmine{display:inline-flex;align-items:center;gap:8px;min-height:0;height:30px;margin:10px 0 2px;padding:0 12px;border:0;border-radius:8px;background:rgba(255,255,255,.08);color:#dfe3ec;font-size:12.5px;font-weight:600}
    .twmine svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
    .twmine:hover{background:rgba(255,255,255,.14);color:#fff}
    .twmine.on:hover{background:color-mix(in srgb,var(--rmc,#d93a3f) 70%,var(--pnl))}
    .twchatov .cstat{align-self:flex-start;padding:3px 9px;border-radius:999px;background:rgba(10,11,14,.6);color:#aab3c4;font-size:12px;font-style:italic}
    /* info and comments read as solidly as the list's rows (the video behind shouldn't wash them out) */
    .desc{margin:4px 2px;padding:12px 12px 10px;border-radius:var(--rrad,7px);background:var(--rowbg)}
    .coms{margin:4px 2px;padding:4px 10px 20px;border-radius:var(--rrad,7px);background:var(--rowbg)}
    .twinfo{white-space:normal}
    .dragshield{position:absolute;inset:0;z-index:20;pointer-events:auto;background:transparent}
    .item.twrow .ic > span:first-child{color:#fff;font-weight:600} /* on Twitch, who's streaming matters: in white */
    /* tab size (Settings → Look & feel → Tabs): height, padding, widest, and text / icons scaling together */
    .tab{min-height:var(--tabh,32px);max-width:var(--tabw,150px);padding:0 var(--tabpad,8px);font-size:calc(12.5px * var(--tabs,1))}
    .tab .tico{width:calc(17px * var(--tabs,1));height:calc(17px * var(--tabs,1))}
    .tab .tico svg{width:calc(16px * var(--tabs,1));height:calc(16px * var(--tabs,1))}
    .tab .car svg,.tab .si,.tab .tx svg{width:calc(14px * var(--tabs,1));height:calc(14px * var(--tabs,1))}
    .tab .cnt{font-size:calc(11px * var(--tabs,1))}
    .tab.add{width:calc(36px * var(--tabs,1))}
    .tab.add svg{width:calc(15px * var(--tabs,1));height:calc(15px * var(--tabs,1))}
    .twchatov .cm.still,.twchatp .cm.still{animation:none}
    .twchatov .cm.still[style*="--life"]{animation:cmout .6s ease var(--life) forwards}
    .twchatov .chbt{width:auto;padding:0 5px;font-size:11.5px;font-weight:800}
    /* the chat in the list panel: the panel itself see-through, the messages on their bars; small controls at the top */
    .tv.panchat .panel{background:transparent;backdrop-filter:none;box-shadow:none;border-left-color:transparent}
    .tv.panchat .phead{background:color-mix(in srgb,var(--pnl) 70%,transparent);border-radius:0 0 10px 10px}
    .twchatp .chctl{position:sticky;top:0;align-self:flex-end;display:flex;gap:2px;padding:2px;border-radius:8px;background:rgba(10,11,14,.55);opacity:.35;transition:opacity .2s;z-index:1}
    .twchatp:hover .chctl{opacity:1}
    .twchatp .chb{width:auto;min-height:0;height:22px;padding:0 6px;border:0;border-radius:6px;background:none;color:#cfd6e4;font-size:11.5px;font-weight:800}
    .twchatp .chb:hover{background:rgba(255,255,255,.14);color:#fff}
    /* overview layouts (settings → Look → Channel overview) */
    .guide .ntx{display:flex;flex-direction:column;gap:3px;min-width:0}
    .guide .nxl{display:none;flex-direction:column;gap:2px}
    .guide.gl-cards .cards{grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px}
    .guide.gl-cards .card{padding:12px;gap:8px;background:color-mix(in srgb,var(--pnl) 60%,transparent)}
    .guide.gl-cards .card .nt{font-size:13.5px}
    .guide.gl-cards .card .nw,.guide.gl-cards .card .nx{font-size:12px}
    .guide.gl-cards .strip{display:none}
    .guide.gl-guide .cards{grid-template-columns:1fr;gap:6px;max-width:1100px}
    .guide.gl-guide .card{flex-direction:row;align-items:center;gap:14px;padding:8px 12px}
    .guide.gl-guide .card:hover{transform:none}
    .guide.gl-guide .chd{width:190px;flex:none}
    .guide.gl-guide .cb{flex:1;flex-direction:row;align-items:center;gap:14px;min-height:0}
    .guide.gl-guide .cb img{width:128px;flex:none}
    .guide.gl-guide .ntx{flex:0 1 300px;min-width:160px}
    .guide.gl-guide .strip{display:none}
    .guide.gl-guide .cs{display:none}
    .guide.gl-guide .newc{max-width:1400px;flex-direction:row;flex-wrap:wrap;align-items:center}
    .guide.gl-wall .cards{grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
    .guide.gl-wall .card{padding:0;overflow:hidden;border-width:0;background:#000}
    .guide.gl-wall .chd{position:absolute;top:8px;left:10px;right:10px;z-index:1;text-shadow:0 1px 4px #000}
    .guide.gl-wall .cb{position:relative;gap:0}
    .guide.gl-wall .cb img{border-radius:0;filter:brightness(.8)}
    .guide.gl-wall .ntx{position:absolute;left:0;right:0;bottom:0;padding:26px 12px 10px;background:linear-gradient(transparent,rgba(0,0,0,.85))}
    .guide.gl-wall .card .nt{font-size:15px}
    .guide.gl-wall .strip,.guide.gl-wall .cs{display:none}
    .guide.gl-wall .card.on{box-shadow:0 0 0 3px var(--acc) inset}
    .guide.gl-wall .cb:not(:has(img)){aspect-ratio:16/9;justify-content:flex-end;padding:12px;background:color-mix(in srgb,var(--pnl) 70%,#000)}
    .guide.gl-wall .cb:not(:has(img)) .nx{white-space:normal}
    /* Twitch: who's offline, folded away under one line */
    .tv:not(.twoff-open) .pbody .list > .sw.twoff{display:none}
    .twoffbar{display:flex;align-items:center;gap:8px;width:100%;min-height:34px;margin:6px 0 2px;padding:0 10px;border:0;border-radius:9px;background:rgba(255,255,255,.06);color:#aab3c4;font:inherit;font-size:12.5px;font-weight:700;cursor:pointer;text-align:left}
    .twoffbar:hover{background:rgba(255,255,255,.12);color:#fff}
    .twoffbar svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;transform:rotate(0deg);transition:transform .18s cubic-bezier(.4,0,.2,1)}
    .twoffbar.open svg{transform:rotate(180deg)}
    .wbar{display:flex;align-items:center;gap:8px;width:100%;min-height:30px;margin:2px 0 4px;padding:0 10px;border:0;border-radius:9px;background:rgba(255,255,255,.05);color:#8d97ab;font:inherit;font-size:12px}
    .wbar:hover{background:rgba(255,255,255,.11);color:#fff}
    .wbar svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round;transform:rotate(180deg);transition:transform .18s cubic-bezier(.4,0,.2,1)}
    .wbar.open svg{transform:rotate(0deg)}
    .tv:not(.wopen) .sw.wfold{display:none}
    .motion.wopen .sw.wfold,.motion.twoff-open .pbody .list > .sw.twoff{animation:foldin .16s ease-out}
    @keyframes foldin{from{opacity:0;transform:translateY(-4px)}}
    .twoffbar i{margin-left:auto;font-style:normal;padding:0 7px;border-radius:999px;background:rgba(255,255,255,.12);color:#fff;font-size:11px}
    /* the arrow on the list's left edge that closes it */
    .phide{position:absolute;right:calc(var(--pw) + var(--pgap,0px));top:50%;z-index:7;width:20px;height:52px;min-height:0;padding:0;margin-top:-26px;border:0;border-radius:9px 0 0 9px;display:none;place-items:center;background:color-mix(in srgb,var(--pnl) 82%,transparent);color:#fff;opacity:.7;cursor:pointer;pointer-events:auto;box-shadow:-4px 0 12px rgba(0,0,0,.25);transition:opacity .3s ease,background .15s}
    .show-panel .phide{display:grid}
    .fade .phide{opacity:0;pointer-events:none}
    .phide:hover,.phide:focus-visible{opacity:1;background:var(--acc)}
    .phide svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round;transform:rotate(-90deg)}
    .guide .nxv{display:none}
    .guide.gl-guide .nxv{flex:1;min-width:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
    .guide .nv{display:flex;align-items:center;gap:8px;min-width:0}
    .guide .nvp{width:72px;flex:none;aspect-ratio:16/9;object-fit:cover;border-radius:4px;background:#111;opacity:.85}
    .guide .nvt{min-width:0;font-size:11.5px;color:#cfd6e4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .guide.gl-guide .cards{max-width:1400px}
    .guide.gl-guide .cb .nvp{width:84px;border-radius:4px}
    .guide.gl-guide .cb > img{width:128px}
    /* back / forward through what you watched: small and quiet */
    .acts .hist{display:flex;gap:0}
    .acts .hist .ab{width:26px;opacity:.55}
    .acts .hist .ab:hover{opacity:1}
    .acts .hist .ab svg{width:16px;height:16px}
  `;

  let ui = null;
  const state = { colId: "", queue: [], pos: 0, history: [], hideTimer: 0, startTimer: 0, toastTimer: 0, lastEvt: "", tuneToken: 0, panel: "", desc: {}, stay: null, xtabs: [], base: null, mem: {}, t: 0 };
  /** Creator name to show: the name, else the @handle (never a raw channel id). */
  const goodName = (n) => (n && !SW.yt.isStat(n) ? n : "");
  const whoOf = (v) => (v && (goodName(v.channel) || (v.creator && v.creator.startsWith("@") ? v.creator : ""))) || "";
  const metaOf = (v) => [whoOf(v), v && v.age, v && v.len].filter(Boolean).join(" · ");
  // A row's two lines, as you set them up (Settings → Swiping & lists → Row text): which bits, on which line, in what order.
  // "3 weeks ago" → "3w" (rows only; English, Dutch, German, French, Spanish)
  const SHORT_UNIT = [[/^(sec|second|seconde|sekunde|segundo)/i, "s"], [/^(min|minute|minuut|minuto)/i, "m"], [/^(hour|uur|stunde|heure|hora)/i, "h"], [/^(day|dag|tag|jour|día|dia)/i, "d"],
    [/^(week|woche|semaine|semana)/i, "w"], [/^(month|maand|monat|mois|mes)/i, "mo"], [/^(year|jaar|jahr|an|año)/i, "y"]];
  const shortAge = (t) => { const m = String(t || "").match(/(\d+)\s*([\p{L}]+)/u); if (!m) return t; for (const [re, u] of SHORT_UNIT) if (re.test(m[2])) return m[1] + u; return t; };
  const FIELDS = { title: (v) => v.title || "Video", creator: (v) => whoOf(v), age: (v) => (!v.tw && cfg && cfg.tv.shortAge ? shortAge(v.age) : v.age), len: (v) => (liveTw(v) ? liveFor(v.since) : v.len), // (a live stream: how long they've been live; how many watch is on its picture)
    watched: (v) => { if (v.tw) return ""; const p = progressOf(v); return p >= 3 && p < 95 ? `${Math.round(p)}% watched` : ""; } };
  // a row's line as nodes: the title as plain text, the other bits smaller, each with its little icon
  const liveTw = (v) => !!(v && v.tw && !v.off && !v.vod && v.since);
  const BIT_ICON = { creator: "user", age: "cal", len: "clock" }, TW_ICON = { creator: "user", age: "game", len: "eye", up: "clock" }; // on Twitch: time live, the game and how many are watching
  const bitNode = (f, t, cls, tw) => { const sp = el("span", cls), k = tw === "off" ? "" : (tw ? TW_ICON : BIT_ICON)[f]; if (k) { const ic = el("span", "ico"); ic.append(icon(k)); sp.append(ic); } sp.append(document.createTextNode(t)); return sp; };
  const fillLine = (node, v, n) => {
    const parts = (cfg ? cfg.tv.rowFields : SW.ROW_FIELDS_DEFAULT).filter(([, l]) => l === n).map(([f]) => [f === "len" && liveTw(v) ? "up" : f, FIELDS[f] && FIELDS[f](v)]).filter(([, t]) => t);
    const sig = parts.map((p) => p.join("\u0001")).join("\u0002");
    node.hidden = !parts.length;
    if (node._sig === sig) return;
    node._sig = sig;
    const kids = [];
    parts.forEach(([f, t], k) => { if (k) kids.push(document.createTextNode(" · ")); kids.push(f === "title" ? document.createTextNode(t) : bitNode(f, t, n === 1 ? "bit" : null, v.off ? "off" : v.tw)); });
    node.replaceChildren(...kids);
  };
  // ready-made channels have icons for the tab bar
  const CHAN_ICON = { __feed: "feed", __cont: "play-half", __home: "home", __watched: "history", __subs: "subs", __wl: "clock", __twitch: "live" };
  const chanIcon = (id, cls) => { if (!CHAN_ICON[id]) return null; const s = el("span", cls); s.append(icon(CHAN_ICON[id])); return s; };
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const btn = (label, title, fn, cls) => { const b = el("button", cls || null, label); b.type = "button"; b.title = title; b.setAttribute("aria-label", title); b.addEventListener("click", (e) => { fn(e); if (e.detail > 0 && !(e.target && e.target.closest && e.target.closest(".pop"))) b.blur(); }); return b; };
  // small line icons (no emoji): search, plus, check
  const icon = (kind) => {
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    const add = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [k, val] of Object.entries(attrs)) n.setAttribute(k, val); svg.append(n); };
    if (kind === "search") { add("circle", { cx: 11, cy: 11, r: 7 }); add("path", { d: "M21 21l-4.3-4.3" }); }
    else if (kind === "plus") add("path", { d: "M12 5v14M5 12h14" });
    else if (kind === "trash-2") { add("path", { d: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5" }); }
    else if (kind === "refresh-cw") { add("path", { d: "M20 7v5h-5M4 17v-5h5" }); add("path", { d: "M5.6 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.4-3" }); }
    else if (kind === "check") add("path", { d: "M5 13l4 4L19 7" });
    else if (kind === "x") add("path", { d: "M6 6l12 12M18 6L6 18" });
    else if (kind === "info") { add("circle", { cx: 12, cy: 12, r: 9 }); add("path", { d: "M12 11v5M12 8h.01" }); }
    else if (kind === "comment") add("path", { d: "M21 12a8 8 0 0 1-8 8H6l-3 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" });
    else if (kind === "chevron") add("path", { d: "M6 9l6 6 6-6" });
    else if (kind === "back") add("path", { d: "M15 5l-7 7 7 7" });
    else if (kind === "more") { add("circle", { cx: 5, cy: 12, r: 1.4 }); add("circle", { cx: 12, cy: 12, r: 1.4 }); add("circle", { cx: 19, cy: 12, r: 1.4 }); }
    else if (kind === "up") add("path", { d: "M12 19V6M6 11l6-6 6 6" });
    else if (kind === "play-half") { add("circle", { cx: 12, cy: 12, r: 9 }); add("path", { d: "M10 8.5v7l5.5-3.5z" }); add("path", { d: "M12 3a9 9 0 0 1 0 18", "stroke-dasharray": "2 3" }); }
    else if (kind === "fwd") add("path", { d: "M9 5l7 7-7 7" });
    else if (kind === "user-plus") { add("circle", { cx: 9, cy: 8, r: 4 }); add("path", { d: "M2 21a7 7 0 0 1 14 0M19 8v6M16 11h6" }); }
    else if (kind === "eye-off") { add("path", { d: "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.2 3.9M6.6 6.6A17 17 0 0 0 2 12s4 7 10 7a9.7 9.7 0 0 0 4.4-1" }); add("path", { d: "M9.9 9.9a3 3 0 0 0 4.2 4.2" }); }
    else if (kind === "eye") { add("path", { d: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" }); add("circle", { cx: 12, cy: 12, r: 3 }); }
    else if (kind === "fs") add("path", { d: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" });
    else if (kind === "feed") add("path", { d: "M4 6h16M4 12h16M4 18h10" });
    else if (kind === "home") add("path", { d: "M4 11l8-7 8 7v9h-5v-6H9v6H4z" });
    else if (kind === "subs") { add("path", { d: "M3 6h18v12H3z" }); add("path", { d: "M10 9l5 3-5 3z" }); }
    else if (kind === "live") { add("path", { d: "M8 8a6 6 0 0 0 0 8M16 8a6 6 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" }); add("circle", { cx: 12, cy: 12, r: 1.5 }); }
    else if (kind === "user") add("path", { d: "M12 12a4 4 0 1 0 0-8a4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0" });
    else if (kind === "game") { add("path", { d: "M7 6h10a5 5 0 0 1 4.9 6l-.8 4a2.6 2.6 0 0 1-4.5 1.2L15 15H9l-1.6 2.2A2.6 2.6 0 0 1 2.9 16l-.8-4A5 5 0 0 1 7 6z" }); add("path", { d: "M8 9.5v3M6.5 11h3M15.5 10.5h.01M17.5 12h.01" }); }
    else if (kind === "hand") add("path", { d: "M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11.5v-2a1.5 1.5 0 0 1 3 0V12M14 10.5a1.5 1.5 0 0 1 3 0V12M17 11.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-2a6 6 0 0 1-5-2.7L4.3 14a1.5 1.5 0 0 1 2.4-1.8L8 14" });
    else if (kind === "gear") { add("circle", { cx: 12, cy: 12, r: 3 }); add("path", { d: "M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" }); }
    else if (kind === "ext") add("path", { d: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" });
    else if (kind === "cal") add("path", { d: "M4 6h16v14H4zM4 10h16M9 3v4M15 3v4" });
    else if (kind === "grid") add("path", { d: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" });
    else if (kind === "clock-x") { add("path", { d: "M20.9 13A9 9 0 1 1 11 3.1" }); add("path", { d: "M12 7v5l3 2M16 3l5 5M21 3l-5 5" }); }
    else if (kind === "sweep") add("path", { d: "M4 6h11M4 12h8M4 18h6M15 14l2 2 4-4" });
    else if (kind === "clock") { add("circle", { cx: 12, cy: 12, r: 9 }); add("path", { d: "M12 7v5l3 2" }); }
    else if (kind === "history") { add("path", { d: "M3 12a9 9 0 1 0 2.6-6.4L3 8" }); add("path", { d: "M3 3v5h5" }); add("path", { d: "M12 7v5l3 2" }); }
    else if (kind === "filter") add("path", { d: "M3 5h18l-7 8v5l-4 2v-7z" });
    else if (kind === "pencil") add("path", { d: "M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" });
    else if (kind === "refresh") { add("path", { d: "M20 11a8 8 0 0 0-14.3-4.9L4 8" }); add("path", { d: "M4 3v5h5" }); add("path", { d: "M4 13a8 8 0 0 0 14.3 4.9L20 16" }); add("path", { d: "M20 21v-5h-5" }); }
    return svg;
  };
  const iconBtn = (kind, title, fn, cls = "") => {
    const b = el("button", "ib " + cls); b.type = "button"; b.title = title; b.setAttribute("aria-label", title);
    b.append(icon(kind));
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(e); if (e.detail > 0) b.blur(); });
    return b;
  };
  // something is loading: a soft light sweeps under the tabs
  let busyN = 0;
  const busy = (d) => { busyN = Math.max(0, busyN + d); if (ui) ui.root.classList.toggle("busy", busyN > 0); };
  const liveFor = (t) => { const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`; };
  const collections = () => (cfg && cfg.tv.collections) || [];
  // Built-in channels. Feed is your own list (always channel 0); Home plays your home recommendations (as on YouTube, or shuffled);
  // Watched is the "Watched" chip on your home page.
  const CONT_ID = "__cont", FEED_ID = "__feed", HOME_ID = "__home", WL_ID = "__wl", SUBS_ID = "__subs", TWITCH_ID = "__twitch", WATCHED_ID = "__watched";
  const nameOf = (id) => (cfg ? SW.tvName(cfg.tv, id) : SW.TV_BUILTIN_NAMES[id] || "");
  const feedChannel = () => ({ id: FEED_ID, name: nameOf(FEED_ID), subjects: [], channels: [], blocked: [], home: false, feed: true, skipSeen: false, maxAge: "any" });
  const homeChannel = () => ({ id: HOME_ID, name: nameOf(HOME_ID), subjects: [], channels: [], blocked: (cfg && cfg.tv.homeBlocked) || [], home: true, homeFeed: true, shuffle: !!(cfg && cfg.tv.homeOrder === "shuffle"),
    skipSeen: cfg ? cfg.tv.homeSkipSeen : true, maxAge: cfg ? cfg.tv.homeMaxAge : "any" });
  const watchedChannel = () => ({ id: WATCHED_ID, name: nameOf(WATCHED_ID), subjects: [], channels: [], blocked: [], home: false, watchedChip: true, skipSeen: false, maxAge: "any" });
  const contChannel = () => ({ id: CONT_ID, name: nameOf(CONT_ID), subjects: [], channels: [], blocked: [], home: false, cont: true, skipSeen: false, maxAge: "any" });
  const wlChannel = () => ({ id: WL_ID, name: nameOf(WL_ID), subjects: [], channels: [], blocked: [], home: false, watchLater: true,
    skipSeen: cfg ? cfg.tv.watchLater.skipSeen : false, maxAge: "any" });
  const subsChannel = () => ({ id: SUBS_ID, name: nameOf(SUBS_ID), subjects: [], channels: [], blocked: [], home: false, subs: true,
    skipSeen: cfg ? cfg.tv.subs.skipSeen : false, maxAge: "any" });
  const twitchChannel = () => ({ id: TWITCH_ID, name: nameOf(TWITCH_ID), subjects: [], channels: [], blocked: [], home: false, twitch: true, skipSeen: false, maxAge: "any" });
  // Every channel, numbered by position: Feed is 0, the rest follow the order you set in the channel overview.
  // Rebuilt only when the settings change (cfg is replaced on every change).
  let chansFor = null, chansList = [];
  const chans = () => {
    if (!cfg) return [];
    if (chansFor === cfg) return chansList;
    const byId = new Map(collections().map((c) => [c.id, c]));
    if (cfg.tv.homeShuffle) byId.set(HOME_ID, homeChannel());
    if (cfg.tv.subs.enabled) byId.set(SUBS_ID, subsChannel());
    if (cfg.tv.contTab) byId.set(CONT_ID, contChannel());
    if (cfg.tv.watchLater.enabled) byId.set(WL_ID, wlChannel());
    if (cfg.tv.twitch.enabled) byId.set(TWITCH_ID, twitchChannel());
    const list = [feedChannel(), ...SW.tvOrder(cfg.tv).map((id) => byId.get(id)).filter(Boolean)];
    chansList = list.map((c, i) => ({ ...c, num: i }));
    chansFor = cfg;
    return chansList;
  };
  const dropChans = () => { chansFor = null; };
  const currentCol = () => chans().find((c) => c.id === state.colId);
  const chanById = (id) => chans().find((c) => c.id === id);
  const labelOf = (i) => { const c = chans()[i]; return c ? String(c.num) : ""; };
  const onFeed = () => state.colId === FEED_ID;

  // ---- your Feed: a list you fill yourself (swipe a video right in any tab). Kept on this computer.
  const FEED_KEY = "hush:tv:feed";
  const slim = (v) => ({ id: v.id, title: String(v.title || "").slice(0, 200), channel: v.channel || "", creator: v.creator || "", len: v.len || "", age: v.age || "", f: 1,
    ...(v.src && typeof v.src === "object" && /^[\w-]{1,24}$/.test(v.src.c) ? { src: { c: v.src.c, i: Number(v.src.i) | 0 } } : {}) }); // where it came from
  let feedStore = (Array.isArray(lsGet(FEED_KEY, [])) ? lsGet(FEED_KEY, []) : []).filter((v) => v && ID_RE.test(v.id)).slice(0, 400).map(slim);
  let subsCache = null;
  let feedSaveTimer = 0;
  const writeFeed = () => { clearTimeout(feedSaveTimer); feedSaveTimer = setTimeout(() => lsSet(FEED_KEY, feedStore.slice(0, 400).map(slim)), 120); };
  // While the Feed plays, it is what's playing now plus everything after it (watched videos leave it);
  // while exploring from the Feed, it's the video you left plus what was still to come.
  const syncFeed = () => {
    if (!onFeed()) return;
    if (state.stay) feedStore = [...(state.from && state.from.item && state.from.item.f ? [state.from.item] : []), ...(state.base || []).filter((v) => v.f)];
    else feedStore = state.queue.slice(state.pos).filter((v) => v.f);
    writeFeed();
  };
  const current = () => state.queue[state.pos];
  const onWatchTv = () => location.pathname === "/watch" && document.documentElement.classList.contains("ytv");

  const wake = () => { if (ui && state.syncControls) state.syncControls(); };
  const poke = () => {
    if (!ui) return;
    state.wakeUntil = performance.now() + 3000;
    const mp = document.getElementById("movie_player"); // YouTube's own controls come back in step
    if (mp) { const r = mp.getBoundingClientRect(); mp.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); }
    wake(); setTimeout(wake, 3050);
  };
  const toast = (msg, action = null) => {
    if (!ui) return;
    ui.toast.replaceChildren(document.createTextNode(msg));
    ui.toast.classList.toggle("act", !!action);
    if (action) {
      const b = document.createElement("button"); b.type = "button"; b.className = "tundo"; b.textContent = action.label;
      b.addEventListener("click", (e) => { e.stopPropagation(); action.fn(); ui.toast.classList.remove("on"); });
      ui.toast.append(" ", b);
    }
    ui.toast.classList.add("on");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => ui && ui.toast.classList.remove("on"), action ? 6000 : 2600);
  };

  const buildUi = () => {
    if (!state.origTitle) state.origTitle = document.title;
    document.documentElement.style.overscrollBehaviorX = "none"; // a two-finger swipe sideways must not go back a page
    if (document.body) document.body.style.overscrollBehaviorX = "none";
    const host = document.createElement("div");
    host.id = "ytv-host";
    const shadow = host.attachShadow({ mode: "open" });
    // (and every other key typed in a YTV box ends there too: Enter, Escape and the arrows don't reach YouTube)
    for (const type of ["keydown", "keypress", "keyup"]) host.addEventListener(type, (e) => { const t = e.composedPath()[0]; if (t && (/^(INPUT|TEXTAREA)$/.test(t.tagName || "") || t.isContentEditable)) e.stopPropagation(); });
    const style = el("style"); style.textContent = CSS;
    const root = el("div", "tv");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "YTV");
    // tuning curtain
    const curtain = el("div", "curtain");
    const tuning = el("div", "tuning");
    const tTitle = el("b", null, "YTV"); const tSub = el("span", null, "");
    tuning.append(tTitle, tSub);
    curtain.append(el("div", "noise"), tuning);
    // top: one slim bar over the picture: what's playing on the left, its actions as icons on the right
    const top = el("div", "top");
    const now = el("div", "now"); const nT = el("div", "t"); const nC = el("div", "c");
    now.append(nT, nC);
    const stay = el("div", "stay"); stay.hidden = true; // while exploring: the topic, and the way back
    const stayTxt = el("span", null, "");
    const stayBtn = btn("Back", "Back to the channel", () => backToMix());
    stay.append(icon("search"), stayTxt, stayBtn);
    const acts = el("div", "acts");
    const addB = iconBtn("user-plus", "Add this creator to a channel", (e) => openCreatorMenu(e.currentTarget), "ab yt-only");
    const wlRemove = iconBtn("clock-x", "Remove this video from your Watch Later list", () => wlRemoveCurrent(), "ab");
    const wlClear = iconBtn("sweep", "Remove watched videos from your Watch Later list", () => wlRemoveWatched(), "ab");
    const infoB = iconBtn("info", "Info (description)", () => togglePanel("info"), "ab");
    const comB = iconBtn("comment", "Comments", () => commentsOrChat(), "ab");
    // back and forward through everything you watched (Shift+[ and Shift+]): small, at the start
    // three buttons stay; everything else is in the ⋯ menu (addB, wlRemove, wlClear only keep their state for it)
    const moreB = iconBtn("more", "More: forward, explore, creator, Watch Later…", (e) => openMoreMenu(e.currentTarget), "ab moreb");
    acts.append(iconBtn("back", "Back to what you watched before (Shift+[)", () => historyStep(-1), "ab"), el("span", "asep"), infoB, comB, moreB); // (the channel overview is G)
    top.append(now, stay, acts);
    // controls (above YouTube's own player bar)
    const bar = el("div", "bar");
    const prevB = btn("◀ Prev", "Previous video", () => prevVideo());
    bar.append(prevB,
      btn("Next ▶", "Next video", () => nextVideo()),
      btn("☰ List", "What's playing and your channels", () => toggleList()),
      btn("ⓘ Info", "Description", () => togglePanel("info")),
      btn("💬 Comments", "Comments", () => togglePanel("comments")));
    // side panel: Up next / Info (description + comments)
    const panel = el("div", "panel");
    const phead = el("div", "phead");
    const prow = el("div", "prow");
    const ptabs = el("div", "ptabs"); ptabs.setAttribute("role", "tablist");
    const pbtn = (kind, label, title, fn) => { const b = btn("", title, fn, "pb"); b.append(icon(kind)); if (label) b.append(document.createTextNode(label)); return b; };
    const clearB = pbtn("trash-2", "", "Clear your Feed (Cmd+Z brings it back)", () => clearFeed());
    const refB = pbtn("refresh", "", "Refresh this tab", async () => {
      if (refB.classList.contains("spin")) return;
      refB.classList.add("spin"); busy(+1);
      try { await refreshTab(); } catch {}
      busy(-1);
      if (ui) { refB.classList.remove("spin"); schedulePanel(); }
    });
    const tabInd = el("span", "tind"); // the underline that slides to the selected tab
    // how the list hides: with YouTube's controls always, only in full screen, or never (also the H key)
    const hideB = pbtn("eye", "", "", () => cycleHide()); hideB.classList.add("hideb");
    const filtB = pbtn("filter", "", "Filter the list", () => toggleFilter()); filtB.classList.add("filtb");
    const fdot = el("span", "fdot"); fdot.hidden = true; filtB.append(fdot);
    const histPB = pbtn("history", "", "History: everything you watched (H)", () => togglePanel("history")); histPB.classList.add("histb");
    const sdot = el("span", "sdot"); sdot.hidden = true; histPB.append(sdot); // sorting is off (it's on every page, the funnel isn't)
    const twsB = pbtn("search", "", "Find Twitch streamers to add", () => toggleTwSearch()); twsB.classList.add("twsb"); twsB.hidden = true;
    prow.append(ptabs, clearB, twsB, filtB, refB, histPB); // history last: it shows on every tab, so it (and the sorting-off dot) never moves. // (no ✕: the list goes with U, or by itself; how it hides is set in settings, or with H)
    const fstrip = el("div", "fstrip"); fstrip.hidden = true; // the filters that are on, as chips (× turns one off)
    phead.append(prow, fstrip);
    const fpop = el("div", "fpop"); fpop.hidden = true; fpop.setAttribute("role", "dialog"); fpop.setAttribute("aria-label", "Filter the list");
    const twpop = el("div", "fpop twpop"); twpop.hidden = true; twpop.setAttribute("role", "dialog"); twpop.setAttribute("aria-label", "Find Twitch streamers");
    const setFrame = el("div", "setwrap"); setFrame.hidden = true; // settings, right here over TV (also in full screen)
    const chmenu = el("div", "chmenu"); chmenu.hidden = true; chmenu.setAttribute("role", "menu");
    const pbody = el("div", "pbody");
    pbodyW = 0; try { new ResizeObserver((es) => { const w = es[0] && es[0].contentRect.width; if (w) pbodyW = w; }).observe(pbody); } catch {}
    // drag the panel's left edge to make it wider or narrower (double-click puts it back); the width is remembered
    const grip = el("div", "grip"); grip.title = "Drag to resize · double-click to reset";
    const PW_KEY = "hush:tv:panelw";
    const clampW = (w) => Math.round(Math.max(300, Math.min(w, window.innerWidth * 0.85, 1200)));
    const setW = (w) => root.style.setProperty("--pw", w + "px");
    const savedW = Number(lsGet(PW_KEY, 0)); if (savedW > 0) setW(Math.round(clampW(savedW) / ((cfg ? cfg.tv.uiScale : 100) / 100)));
    grip.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); try { grip.setPointerCapture(e.pointerId); } catch {} grip.classList.add("on"); });
    const zoom = () => (cfg ? cfg.tv.uiScale / 100 : 1);
    let gripRaf = 0;
    grip.addEventListener("pointermove", (e) => {
      if (!grip.classList.contains("on")) return;
      if (!(e.buttons & 1)) return gripEnd(e); // the button was let go outside the window
      setW(Math.round(clampW(window.innerWidth - e.clientX) / zoom()));
      if (!gripRaf) gripRaf = requestAnimationFrame(() => { gripRaf = 0; refitRows(); });
    });
    grip.addEventListener("lostpointercapture", (e) => gripEnd(e));
    const gripEnd = (e) => { if (!grip.classList.contains("on")) return; grip.classList.remove("on"); try { grip.releasePointerCapture(e.pointerId); } catch {} lsSet(PW_KEY, Math.round(panel.getBoundingClientRect().width)); refitRows(); };
    grip.addEventListener("pointerup", gripEnd); grip.addEventListener("pointercancel", gripEnd);
    grip.addEventListener("dblclick", () => { root.style.removeProperty("--pw"); lsSet(PW_KEY, 0); });
    const nowbar = el("button", "nowbar"); nowbar.type = "button"; nowbar.title = "Show what’s playing in the list";
    const totop = el("button", "totop"); totop.type = "button"; totop.title = "Back to the top"; totop.setAttribute("aria-label", "Back to the top"); totop.append(icon("chevron"));
    totop.addEventListener("click", () => pbody.scrollTo({ top: 0, behavior: motionOn() ? "smooth" : "auto" }));
    const pickbar = el("div", "pickbar"); // when you've picked several videos
    pickbar.append(el("span", "pn", ""), btn("Explore together", "Play the picked videos as their own topic", () => bulk("explore")), btn("Add to Feed", "Add the picked videos to your Feed", () => bulk("add")),
      btn("Remove", "Remove the picked videos", () => bulk("rm")), iconBtn("x", "Let go of them (Esc)", () => clearPicks(), "pclose"));
    const pwrap = el("div", "pwrap"); pwrap.append(pbody, nowbar, totop, pickbar);
    // a small arrow on the list's left edge: closes it with the mouse (U does it with the keyboard)
    const closeArrow = iconBtn("chevron", "Close the list (U)", () => showPanel(""), "phide");
    panel.append(grip, phead, pwrap, chmenu, fpop, twpop);
    panel.addEventListener("pointerdown", (e) => { if (!e.composedPath().some((n) => n === chmenu || (n.classList && n.classList.contains("chtab")))) closeChanMenu(); });
    const start = el("div", "start");
    start.append(btn("▶  Start watching", "Start watching", () => { root.classList.remove("show-start"); cmd({ cmd: "play" }); }));
    const msg = el("div", "msg");
    const guide = el("div", "guide");
    const explore = el("div", "explore"); explore.hidden = true;
    explore.setAttribute("role", "dialog"); explore.setAttribute("aria-label", "Explore a topic");
    const pop = el("div", "pop"); pop.hidden = true; pop.setAttribute("role", "menu");
    const toastEl = el("div", "toast"); toastEl.setAttribute("role", "status");
    const scrim = el("div", "scrim"); // catches clicks outside an open dialog / menu so they only close it
    scrim.addEventListener("click", (e) => { e.stopPropagation(); closeExplore(); closePop(); });
    root.append(curtain, top, bar, panel, closeArrow, start, msg, guide, scrim, explore, pop, setFrame, toastEl);
    shadow.append(style, root);
    document.documentElement.appendChild(host);
    ui = { hideB, host, root, curtain, tTitle, tSub, nT, nC, nowbar, totop, pickbar, stay, stayTxt, stayBtn, prevB, addB, wlRemove, wlClear, pbody, ptabs, tabInd, chmenu, clearB, refB, filtB, sdot, fdot, fstrip, fpop, histPB, twsB, twpop, setFrame, bar, infoB, comB, msg, guide, explore, pop, toast: toastEl };
    applyTheme();
    watchControls();
  };
  const applyTheme = () => {
    if (!ui || !cfg) return;
    ui.root.style.setProperty("--acc", cfg.tv.theme.accent);
    ui.root.style.setProperty("--pnl", cfg.tv.theme.panel);
    const tw = cfg.tv.thumbPx;
    ui.root.style.setProperty("--tw", tw + "px");
    ui.bar.hidden = !!cfg.tv.keysOn && !cfg.tv.showBar; // the keys do the same; buttons only show if you ask for them (or keys are off)
    for (const st of ["card", "bar", "fade"]) ui.root.classList.toggle("top-" + st, cfg.tv.topStyle === st); // how the top bar looks
    // your styling (Settings → Look & feel)
    const L = cfg.tv.look, px = (n) => n + "px", pc = (n) => n + "%";
    for (const [k, v] of Object.entries({ "--trad": px(L.topRadius), "--tpady": px(L.topPadY), "--tpadx": px(L.topPadX), "--tfade": px(L.topFade), "--treach": String(L.topBlurReach / 100), "--tbg": L.topBg || cfg.tv.theme.panel, "--talpha": pc(L.topAlpha), "--tblur": px(L.topBlur),
      "--tfs": px(L.topTitlePx), "--tfs2": px(L.topMetaPx), "--palpha": pc(L.panelAlpha), "--pblur": px(L.panelBlur), "--prad": px(L.panelRadius), "--pgap": px(L.panelGap),
      "--rrad": px(L.rowRadius), "--gap": px(L.rowGap), "--ralpha": pc(L.rowAlpha),
      "--tabh": px(L.tabHeight), "--tabpad": px(L.tabPad), "--tabw": px(L.tabWidth), "--tabs": String(L.tabScale / 100) })) ui.root.style.setProperty(k, v);
    ui.root.classList.toggle("edgefade", L.edgeFade);
    ui.root.style.setProperty("--addc", cfg.tv.swipeAddColor); ui.root.style.setProperty("--nxc", cfg.tv.swipeNextColor); ui.root.style.setProperty("--rmc", cfg.tv.swipeRmColor); ui.root.style.setProperty("--aico", cfg.tv.swipeIconPx + "px");
    ui.root.classList.toggle("dense", cfg.tv.density === "compact");
    ui.root.classList.toggle("motion", motionOn());
    const rowh = Math.round(Math.max(cfg.tv.rowPx, tw * 9 / 16 + 10)); // never shorter than its picture
    ui.root.style.setProperty("--lines", String(cfg.tv.titleLines));
    ui.root.style.setProperty("--fs", cfg.tv.textPx + "px");
    ui.root.style.setProperty("--fs2", cfg.tv.metaPx + "px");
    ui.root.style.setProperty("--hb", cfg.tv.hbSize + "px");
    ui.root.style.setProperty("--ui", String(cfg.tv.uiScale / 100));
    ui.root.style.setProperty("--rowh", rowh + "px");
    ui.root.style.setProperty("--edgew", cfg.tv.edgeWidth + "px");
    ui.root.classList.toggle("edgeon", cfg.tv.edgeOpen);
    ui.root.classList.toggle("nox", !cfg.tv.tabCloseX);
    ui.root.classList.toggle("ricons", cfg.tv.rowIcons); ui.root.classList.toggle("topicons", cfg.tv.topIcons);
    setHideBtn();
  };
  const HIDE_MODES = { always: ["eye", "The list hides with the player controls — click: only in full screen (H)"], fullscreen: ["fs", "The list hides only in full screen — click: never (H)"], never: ["eye-off", "The list stays — click: hide it with the player controls (H)"] };
  const setHideBtn = () => {
    if (!ui || !cfg) return;
    const [k, t] = HIDE_MODES[cfg.tv.listHide] || HIDE_MODES.always;
    ui.hideB.replaceChildren(icon(k)); ui.hideB.title = t; ui.hideB.setAttribute("aria-label", t);
  };
  const cycleHide = async () => {
    const order = ["always", "fullscreen", "never"], next = order[(order.indexOf(cfg.tv.listHide) + 1) % 3];
    cfg.tv.listHide = next; setHideBtn(); wake();
    toast(next === "always" ? "The list hides with the player controls" : next === "fullscreen" ? "The list hides only in full screen" : "The list stays");
    await writeCfg();
  };
  // Show and hide together with YouTube's own player controls (they hide after a moment of no mouse movement).
  // In full screen YouTube sometimes puts its controls up by itself (a new video, buffering, a "mouse move" from the
  // system that didn't move anything). YTV only counts what you really do: a mouse that moved, a key, a click, a scroll.
  let controlsObs = null;
  const IDLE_MS = 2800;
  let actAt = performance.now(), actPt = null, stillT = 0;
  const realMove = (e) => {
    if (!e.isTrusted) return;
    const pt = [e.screenX, e.screenY];
    if (actPt && Math.abs(pt[0] - actPt[0]) < 3 && Math.abs(pt[1] - actPt[1]) < 3) return; // didn't actually move
    actPt = pt; actAt = performance.now(); unstill();
  };
  const realAct = (e) => { if (e.isTrusted) { actAt = performance.now(); unstill(); } };
  let stillOn = false;
  const unstill = () => { if (stillOn && ui && state.syncControls) state.syncControls(); }; // you moved: everything comes back
  document.addEventListener("mousemove", realMove, { capture: true, passive: true });
  for (const t of ["keydown", "pointerdown", "wheel", "touchstart"]) document.addEventListener(t, realAct, { capture: true, passive: true });
  const watchControls = () => {
    const sync = () => {
      if (!ui) return;
      const mp = document.getElementById("movie_player");
      const onTw = ui.root.classList.contains("on-twitch");
      let ytHidden = onTw ? Date.now() - (state.twIdleAt || 0) > 3000 : mp ? mp.classList.contains("ytp-autohide") : false;
      // full screen and YouTube shows its controls though nothing happened: treat them as hidden (and keep them hidden)
      let still = false;
      if (!ytHidden && !onTw && mp && document.fullscreenElement && !mp.classList.contains("paused-mode") && !mp.classList.contains("ad-showing")) {
        const left = IDLE_MS - (performance.now() - actAt);
        if (left <= 0) { ytHidden = true; still = true; }
        else { clearTimeout(stillT); stillT = setTimeout(sync, left + 60); }
      }
      if (onTw) { clearTimeout(state.twIdleT); state.twIdleT = setTimeout(sync, 3100); }
      // Never hide while you're pointing at or using YTV's own controls.
      const inUse = !!ui.root.querySelector(".top:hover, .bar:hover, .top:has(:focus-visible), .bar:has(:focus-visible)");
      // the list hides along with them (Settings → Swiping & lists), unless you're pointing at it or using it
      const mode = cfg.tv.listHide, hides = mode === "always" || (mode === "fullscreen" && !!document.fullscreenElement);
      const listStays = isListTab(state.panel) || PAGES.has(state.panel) ? !hides || !!ui.root.querySelector(".panel:hover, .phide:hover, .panel:has(:focus-visible), .chmenu.on, .sw.gone, .pickbar.on") : !!state.panel;
      const awake = performance.now() < (state.wakeUntil || 0); // you just pressed a key or clicked: stay up a moment
      // the mouse went off the page (to the browser's tabs or another window): nothing hides until it's back over the video
      const outNow = state.mouseOut && Date.now() - (state.mouseOutAt || 0) < 4000; // a quick overshoot to the browser's tabs keeps it up; a while away and it hides as usual
      if (outNow) { clearTimeout(state.outT); state.outT = setTimeout(sync, 4100); }
      const busy = outNow || awake || listStays || ui.root.classList.contains("show-guide") || !ui.explore.hidden || !ui.pop.hidden || !ui.fpop.hidden || !ui.twpop.hidden || !ui.setFrame.hidden || inUse;
      const fadeNow = ytHidden && !busy;
      if (fadeNow && !ui.root.classList.contains("fade")) setTimeout(pageHidden, 400); // (once it has faded out)
      ui.root.classList.toggle("fade", fadeNow);
      stillOn = still; document.documentElement.classList.toggle("ytv-still", still && !busy);
    };
    // Mouse movement over YTV's controls is passed on to YouTube's player, so YouTube's own controls
    // don't think you've gone idle and both stay in step.
    let lastFwd = 0;
    ui.root.addEventListener("mousemove", () => { if (ui.root.classList.contains("on-twitch")) { const was = Date.now() - (state.twIdleAt || 0); state.twIdleAt = Date.now(); if (was > 100) sync(); } }, true);
    ui.root.addEventListener("mousemove", (e) => {
      if (e.target === ui.root || Date.now() - lastFwd < 120) return;
      lastFwd = Date.now();
      const mp = document.getElementById("movie_player");
      if (mp) mp.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: e.clientX, clientY: e.clientY }));
      sync();
    });
    ui.root.addEventListener("mouseover", () => sync());
    ui.root.addEventListener("mouseout", () => setTimeout(sync, 0));
    ui.root.addEventListener("focusin", () => sync());
    ui.root.addEventListener("focusout", () => setTimeout(sync, 0));
    const mine = ui && ui.root;
    const attach = () => {
      if (!ui || ui.root !== mine) return; // TV was closed (or opened again): this one stops waiting
      const mp = document.getElementById("movie_player");
      if (!mp) return setTimeout(attach, 500);
      controlsObs = new MutationObserver(sync);
      controlsObs.observe(mp, { attributes: true, attributeFilter: ["class"] });
      sync();
    };
    attach();
    state.syncControls = sync;
    const onFs = () => sync();
    document.addEventListener("fullscreenchange", onFs);
    // the right edge: point at it and the list slides out; leave the list and it goes again after a moment
    // the strip you point at only covers the middle (not the top bar's buttons, not YouTube's controls), but its glow
    // runs the full height of the screen edge, so it looks like one edge
    const edge = el("div", "edge"), edgeGlow = el("div", "edgeglow"); ui.root.append(edgeGlow, edge);
    let edgeT = 0, leaveT = 0;
    // (not from the top bar's buttons above it, nor YouTube's player controls below it: only the strip in between)
    const bandTop = () => { const acts = ui.root.querySelector(".top .acts"), ab = acts ? acts.getBoundingClientRect().bottom : 0; return Math.max(ab + 8, 70); };
    const inBand = (y) => y > bandTop() && y < window.innerHeight - 90;
    // the strip itself starts below the top bar's buttons and ends above YouTube's controls: it never covers either
    let edgeTop = -1;
    const placeEdge = () => { if (!ui) return; const z = (cfg ? cfg.tv.uiScale : 100) / 100, t = Math.round(bandTop()); if (t === edgeTop) return; edgeTop = t; edge.style.top = t / z + "px"; edge.style.bottom = 90 / z + "px"; };
    state.placeEdge = placeEdge;
    const edgeAt = (e) => {
      if (!inBand(e.clientY)) { clearTimeout(edgeT); edgeT = 0; return; }
      if (edgeT) return;
      edgeT = setTimeout(() => { edgeT = 0; if (!state.panel && cfg.tv.edgeOpen) { showPanel(playingTab()); state.edgeOpened = true; } }, 90);
    };
    const onResize = () => { edgeTop = -1; placeEdge(); };
    placeEdge(); window.addEventListener("resize", onResize);
    edge.addEventListener("mouseenter", edgeAt);
    edge.addEventListener("mousemove", edgeAt);
    edge.addEventListener("mouseleave", () => { clearTimeout(edgeT); edgeT = 0; });
    const pnl = ui.root.querySelector(".panel");
    // it only goes once the mouse is back over the video: overshooting to the browser's tabs doesn't count
    const armLeave = () => {
      if (leaveT || !state.edgeOpened || !cfg.tv.edgeHideMs) return;
      leaveT = setTimeout(() => {
        leaveT = 0;
        if (!ui || !state.edgeOpened || state.mouseOut || ui.root.querySelector(".panel:hover, .phide:hover, .edge:hover, .chmenu.on, .pickbar.on, .sw.gone") || !ui.explore.hidden || !ui.pop.hidden) return;
        state.edgeOpened = false; showPanel("");
      }, cfg.tv.edgeHideMs);
    };
    const disarm = () => { clearTimeout(leaveT); leaveT = 0; };
    pnl.addEventListener("mouseenter", disarm);
    let lastMove = 0, edgeMeasured = 0;
    const onMove = (e) => {
      if (state.mouseOut) { state.mouseOut = false; sync(); }
      const t = performance.now(); if (t - lastMove < 80) return; lastMove = t;
      if (!state.panel && t - edgeMeasured > 1000) { edgeMeasured = t; placeEdge(); } // (a layout read: not on every move)
      if (!state.edgeOpened) return;
      const p = e.composedPath ? e.composedPath() : [];
      if (p.includes(pnl) || p.includes(edge) || p.includes(ui.chmenu)) disarm(); else armLeave();
    };
    document.addEventListener("mousemove", onMove, true);
    // left the page itself (to the browser's tabs or another window) — not just into Twitch's player, which also has no "related target"
    const onOut = (e) => { const W = window.innerWidth, H = window.innerHeight; if (!e.relatedTarget && (e.clientX <= 1 || e.clientY <= 1 || e.clientX >= W - 2 || e.clientY >= H - 2)) { state.mouseOut = true; state.mouseOutAt = Date.now(); disarm(); sync(); } };
    document.addEventListener("mouseout", onOut, true);
    // the mouse moving over Twitch's player (its helper tells YTV): it's over the video, so the list may go
    state.overVideo = () => { if (state.mouseOut) { state.mouseOut = false; sync(); } if (state.edgeOpened) armLeave(); };
    state.offPage = () => { window.removeEventListener("resize", onResize); document.removeEventListener("mousemove", onMove, true); document.removeEventListener("mouseout", onOut, true); document.removeEventListener("fullscreenchange", onFs); disarm(); clearTimeout(state.twIdleT); clearTimeout(edgeT); };
    ui.root.addEventListener("pointerdown", () => poke(), true); // a click on any of YTV's buttons keeps it all in view
  };

  // ---------------------------------------------------------------- panels
  // The panel shows one tab at a time: your Feed, the topic you're exploring, or any channel. Lists are drawn
  // once and then updated in place (rows are reused by video id), so swiping, removing and re-ordering never
  // rebuild the list under your fingers.
  // Animations follow YTV's own switch; your computer's "Reduce motion" only counts if you ask for that in settings.
  const motionOn = () => !!(cfg && cfg.tv.motion) && !(cfg.tv.motionSystem && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const wlAdded = new Set(); // added to Watch Later from the hover button this session
  // The clock on a picture: saves to your Watch Later, and when it's already there, takes it off again.
  const inWl = (v) => wlAdded.has(v.id) || (currentCol() && currentCol().watchLater && !wlGone.has(v.id) && state.queue.some((x) => x.id === v.id));
  const wlGone = new Set();
  const toggleWl = async (v, b) => {
    const bad = (msg) => { b.classList.remove("bad"); void b.offsetWidth; b.classList.add("bad"); b.title = msg; };
    if (inWl(v)) {
      b.classList.remove("on"); b.title = "Save to Watch Later";
      if (await SW.yt.removeFromWatchLater([v.id], state.wlCtx)) { wlAdded.delete(v.id); wlGone.add(v.id); toast("Removed from Watch Later", { label: "Undo", fn: () => toggleWl(v, b) }); return; }
      b.classList.add("on"); return bad("YouTube didn’t accept that — are you signed in?");
    }
    b.classList.add("on"); b.title = "In your Watch Later — click to remove";
    const ok = (await SW.yt.addToWatchLater([v.id], state.wlCtx)).length > 0;
    if (ok) { wlAdded.add(v.id); wlGone.delete(v.id); return; }
    b.classList.remove("on"); bad("YouTube didn’t accept that — are you signed in?");
  };
  const thumbOf = (v, o = {}) => {
    const box = el("div", "thumb");
    const img = el("img"); img.alt = ""; img.loading = "lazy"; img.decoding = "async";
    img.addEventListener("error", () => { img.style.visibility = "hidden"; }); // never show a broken-image icon
    img.addEventListener("load", () => img.classList.add("ok"));
    if (v.tw) { // a Twitch stream: its live preview with a LIVE pill and how many watch; someone offline: their picture
      if (v.thumb) img.src = v.thumb;
      if (!v.off && v.viewers) { const tv0 = el("span", "twv"); tv0.title = `${v.viewers.toLocaleString()} watching`; tv0.append(icon("eye"), document.createTextNode(Intl.NumberFormat(undefined, { notation: "compact" }).format(v.viewers))); box.append(tv0); } // how many watch, with an eye (no LIVE pill: everything up top is live)
    }
    else img.src = `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`;
    if (img.complete && img.naturalWidth) img.classList.add("ok");
    box.append(img);
    if (o.explore && cfg.tv.hbExplore) box.append(iconBtn("search", "Explore this video (a creator or topic)", o.explore, "hb exb"));
    if (o.info) box.append(iconBtn("info", "About this stream, and past broadcasts", o.info, "hb exb")); // Twitch
    if (o.wl && cfg.tv.hbWl) {
      const on = inWl(v);
      const b = iconBtn("clock", on ? "In your Watch Later — click to remove" : "Save to Watch Later", () => toggleWl(v, b), "hb wlb" + (on ? " on" : ""));
      box.append(b);
    }
    const pct = progressOf(v);
    if (pct > 0) { const t = el("div", "pgt"); const b = el("div", "pg"); b.style.width = `${Math.max(3, pct)}%`; box.append(t, b); }
    return box;
  };
  // Cards that don't name their channel get it looked up (a few at a time) and written into the row.
  const setLines = (api) => {
    fillLine(api.it, api.v, 1); fillLine(api.ic, api.v, 2);
  };
  const fillNames = async (pairs) => {
    const todo = pairs.filter(([v]) => !goodName(v.channel)).slice(0, 60);
    const worker = async () => {
      for (let p = todo.shift(); p; p = todo.shift()) {
        const [v, node] = p;
        const name = await SW.yt.channelNameOf(v.id);
        if (!name) continue;
        v.channel = name;
        if (node.wrap.isConnected) setLines(node);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  };
  const idsOfHistory = () => state.history.map((i) => (state.queue[i] || {}).id);
  const fixHistory = (ids) => { state.history = ids.map((id) => state.queue.findIndex((x) => x.id === id)).filter((i) => i >= 0); };

  // ---- Undo: Cmd/Ctrl+Z takes back the last removal, re-ordering, add or clear. Quietly: no message.
  // Each step remembers which list it belongs to and is skipped once that list is gone (another channel, a closed topic).
  const scopeOf = (kind) => kind === "group" ? "group" : kind === "live" ? `live|${state.colId}|${state.tuneToken}|${state.stay ? state.stay.query : ""}`
    : kind === "idle" ? (onFeed() ? "-" : "idle") : kind;
  const undoStack = [];
  const pushUndo = (kind, fn) => { undoStack.push({ scope: scopeOf(kind), kind, fn }); if (undoStack.length > 60) undoStack.shift(); };
  // several changes that belong together (adding to the Feed and taking it out of this list) undo as one step
  const groupUndo = (n0) => {
    const parts = undoStack.splice(n0);
    if (parts.length < 2) { undoStack.push(...parts); return; }
    undoStack.push({ scope: "group", kind: "group", fn: () => { for (const u of parts.reverse()) if (u.scope === scopeOf(u.kind)) u.fn(); } });
  };
  const clearUndo = () => { for (let i = undoStack.length - 1; i >= 0; i--) if (undoStack[i].kind === "live") undoStack.splice(i, 1); };
  const undoLast = () => {
    while (undoStack.length) {
      const u = undoStack.pop();
      if (u.scope === scopeOf(u.kind)) { u.fn(); return; }
    }
  };

  // ---- the lists behind the tabs
  // live  = what's playing now (a channel, your Feed, or the topic you're exploring)
  // base  = the channel (or Feed) you'll go back to while you explore
  // idle  = your Feed while something else plays
  // browse = another channel's videos
  const FEED_TAB = "src:" + FEED_ID;
  // xbrowse = a topic you explored earlier and left open in its own tab
  const playingTab = () => (state.stay ? "explore" : "src:" + state.colId);
  const HIST_TAB = "history", CONT_TAB = "src:__cont";
  const isListTab = (t) => t === "explore" || t === HIST_TAB || (typeof t === "string" && (t.startsWith("src:") || t.startsWith("x:")));
  const xtabOf = (t) => (state.xtabs || []).find((x) => "x:" + x.id === t);
  const tabKind = (t) => {
    if (t === HIST_TAB) return "hist";
    if (t === "explore") return state.stay ? "live" : null;
    if (typeof t === "string" && t.startsWith("x:")) return xtabOf(t) ? "xbrowse" : null;
    if (!isListTab(t)) return null;
    const id = t.slice(4);
    if (id === state.colId) return state.stay ? "base" : "live";
    return id === FEED_ID ? "idle" : "browse";
  };
  // Your Feed right now, wherever it lives.
  const feedNow = () => !onFeed() ? feedStore : state.stay ? (state.base || []) : state.queue.slice(state.pos);
  const inFeed = (id) => { // (no copy of the list: this runs for every row and every video that loads)
    const arr = !onFeed() ? feedStore : state.stay ? (state.base || []) : state.queue;
    for (let i = !onFeed() || state.stay ? 0 : state.pos; i < arr.length; i++) if (arr[i] && arr[i].id === id) return true;
    return false;
  };
  const feedLen = () => feedNow().length;
  const afterFeed = () => { if (onFeed()) saveSession(); else writeFeed(); schedulePanel(); };

  // Add a video to the end of your Feed (from any tab). Returns false if it's already there.
  const addToFeed = (v, from = null) => {
    if (!v || inFeed(v.id)) return false;
    const item = slim(from ? { ...v, src: from } : v);
    if (onFeed() && state.stay) state.base.push(item);
    else if (onFeed()) state.queue.push(item);
    else feedStore.push(item);
    removed.delete(v.id);
    afterFeed();
    state.bump = true;
    pushUndo(onFeed() ? "live" : "idle", () => takeFromFeed(v.id));
    return true;
  };
  const takeFromFeed = (id) => {
    if (onFeed() && state.stay) state.base = state.base.filter((x) => x.id !== id);
    else if (onFeed()) { const i = state.queue.findIndex((x, k) => k > state.pos && x.id === id); if (i >= 0) { const h = idsOfHistory(); state.queue.splice(i, 1); fixHistory(h); } }
    else feedStore = feedStore.filter((x) => x.id !== id);
    afterFeed();
  };
  // Empty your Feed (the video playing keeps playing). Cmd+Z brings it all back.
  const clearFeed = () => {
    if (onFeed() && state.stay) {
      const old = state.base; state.base = [];
      pushUndo("live", () => { state.base = [...old, ...state.base.filter((x) => !old.some((o) => o.id === x.id))]; afterFeed(); });
    } else if (onFeed()) {
      const old = state.queue.slice(state.pos + 1);
      state.queue.length = state.pos + 1;
      pushUndo("live", () => { state.queue.push(...old.filter((x) => !state.queue.some((q) => q.id === x.id))); afterFeed(); });
    } else {
      const old = feedStore; feedStore = [];
      pushUndo("idle", () => { feedStore = [...old, ...feedStore.filter((x) => !old.some((o) => o.id === x.id))]; afterFeed(); });
    }
    afterFeed();
  };

  // Put the playing list back in an earlier order (videos added since stay at the end; the playing one keeps playing).
  const restoreOrder = (ids) => {
    const cur = current(), hist = idsOfHistory(), by = new Map(state.queue.map((x) => [x.id, x])), known = new Set(ids);
    state.queue = [...ids.filter((id) => by.has(id)).map((id) => by.get(id)), ...state.queue.filter((x) => !known.has(x.id))];
    state.pos = Math.max(0, cur ? state.queue.findIndex((x) => x.id === cur.id) : 0);
    fixHistory(hist);
    saveSession();
    schedulePanel();
  };
  // Move a video in the playing list (`to` = the gap it goes in).
  const moveItem = (from, to) => {
    if (from < 0 || from >= state.queue.length || from === to || from + 1 === to) return;
    const ids0 = state.queue.map((x) => x.id);
    const hist = idsOfHistory(), cur = state.pos;
    const [it] = state.queue.splice(from, 1);
    const dest = to > from ? to - 1 : to;
    state.queue.splice(dest, 0, it);
    if (from === cur) state.pos = dest;
    else if (from < cur && dest >= cur) state.pos--;
    else if (from > cur && dest <= cur) state.pos++;
    fixHistory(hist);
    if (dest > state.pos) { played.delete(it.id); removed.delete(it.id); it.nx = 1; } // put there by you: it shows and plays, even one you've seen
    pushUndo("live", () => restoreOrder(ids0));
    saveSession();
    schedulePanel();
  };
  // Take a video out of the playing list (never the one playing).
  const removeLive = (id) => {
    const i = state.queue.findIndex((x) => x.id === id);
    if (i < 0 || i === state.pos) return;
    const hist = idsOfHistory();
    const [it] = state.queue.splice(i, 1);
    if (i < state.pos) state.pos--;
    removed.add(it.id);
    fixHistory(hist);
    saveSession();
    schedulePanel();
    pushUndo("live", () => {
      removed.delete(it.id);
      if (state.queue.some((x) => x.id === it.id)) return;
      const h2 = idsOfHistory(), at = Math.max(state.pos + 1, Math.min(i, state.queue.length)); // always back into "up next"
      state.queue.splice(at, 0, it);
      fixHistory(h2);
      saveSession();
      schedulePanel();
    });
  };
  // Shift + swipe (the plus side): this video plays next in the list that's playing now, from any tab.
  // Always possible for a YouTube video (from any tab, also one that's further down this list: it moves up, never twice),
  // except for the one that's playing itself, or while a Twitch stream is on (its list only holds streams).
  const canPlayNext = (v) => { const cur = current(); return !!(v && !v.tw && cur && !cur.tw && cur.id !== v.id); };
  const isNextUp = (v) => { const nx = state.queue[state.pos + 1]; return !!(nx && v && nx.id === v.id); };
  const playNext = (v) => {
    if (!canPlayNext(v)) return false;
    if (isNextUp(v)) return true; // already up next: nothing to do
    const i = state.queue.findIndex((x) => x.id === v.id);
    removed.delete(v.id); played.delete(v.id);
    // (nx: you asked for this one, so it plays even if a filter, a hidden creator or your Feed would leave it out)
    if (i >= 0) { moveItem(i, state.pos + 1); if (state.queue[state.pos + 1]) state.queue[state.pos + 1].nx = 1; saveSession(); schedulePanel(); return true; }
    const hist = idsOfHistory(), item = { ...v, nx: 1 };
    state.queue.splice(state.pos + 1, 0, item);
    fixHistory(hist);
    saveSession(); schedulePanel();
    pushUndo("live", () => { const k = state.queue.findIndex((x, n) => n > state.pos && x.id === v.id); if (k < 0) return; const h2 = idsOfHistory(); state.queue.splice(k, 1); fixHistory(h2); saveSession(); schedulePanel(); });
    return true;
  };
  // A video you take off your Feed without having watched it goes back to the list it came from, where it was.
  const backToSource = (v) => {
    const src = v && v.src;
    if (!src || played.has(v.id)) return;
    removed.delete(v.id);
    const back = { ...v, f: 0 }; delete back.src; delete back.f;
    if (src.c === state.colId && !onFeed()) { // the channel that's playing: back into up next
      if (state.queue.some((x) => x.id === v.id)) return;
      const hist = idsOfHistory(); state.queue.splice(Math.max(state.pos + 1, Math.min(src.i, state.queue.length)), 0, back); fixHistory(hist); saveSession();
    } else {
      const e = browse.get(src.c);
      if (e && !e.items.some((x) => x.id === v.id)) e.items.splice(Math.min(src.i, e.items.length), 0, back);
    }
    schedulePanel();
  };
  // Simple lists (Feed while idle, the list you'll go back to, another channel's videos): take out, move, re-order.
  const listOps = (get, save, kind) => ({
    remove(id) {
      const arr = get(); const i = arr ? arr.findIndex((x) => x.id === id) : -1;
      if (i < 0) return;
      const [it] = arr.splice(i, 1);
      if (kind !== "idle") removed.add(id);
      save();
      pushUndo(kind === "idle" ? "idle" : kind === "base" ? "live" : "browse", () => {
        removed.delete(id);
        const a = get(); if (!a || a.some((x) => x.id === id)) return;
        a.splice(Math.min(i, a.length), 0, it); save();
      });
    },
    move(fromId, toId, after) {
      const arr = get(); if (!arr) return;
      const ids0 = arr.map((x) => x.id);
      const from = arr.findIndex((x) => x.id === fromId);
      if (from < 0) return;
      const [it] = arr.splice(from, 1);
      let to = toId == null ? 0 : arr.findIndex((x) => x.id === toId);
      if (to < 0) { arr.splice(from, 0, it); return; }
      if (after) to += 1;
      arr.splice(to, 0, it);
      save();
      pushUndo(kind === "idle" ? "idle" : kind === "base" ? "live" : "browse", () => {
        const a = get(); if (!a) return;
        const by = new Map(a.map((x) => [x.id, x])), known = new Set(ids0);
        const re = [...ids0.filter((id) => by.has(id)).map((id) => by.get(id)), ...a.filter((x) => !known.has(x.id))];
        a.splice(0, a.length, ...re); save();
      });
    },
  });
  const feedOps = listOps(() => feedStore, () => { writeFeed(); schedulePanel(); }, "idle");
  const baseOps = listOps(() => state.base, () => { saveSession(); schedulePanel(); }, "base");
  const browse = new Map(); // channel id -> { items, at, busy }
  const browseOps = (cid) => listOps(() => (browse.get(cid) || {}).items, () => schedulePanel(), "browse");
  const xOps = (xid) => listOps(() => ((state.xtabs || []).find((x) => x.id === xid) || {}).items, () => { saveSession(); schedulePanel(); }, "browse");

  // What a row can do, per list. Swipe one way (trash) takes it out; the other way (plus) adds it to your Feed —
  // or, in your Feed itself, moves it up to play next.
  const actionsFor = (kind, v, c) => {
    if (v.tw) { // Twitch: just a list to pick from. No swiping or removing; dragging sets your order.
      const a = actionsFor0(kind, v, c);
      return { ...a, canRm: () => false, canAdd: () => false, rm: () => {}, add: () => false, feedRow: () => false,
        open: v.off ? () => { state.twInfo = v; showPanel("info"); } : a.open, // offline: what they streamed before
        drop: (fromId, after) => { twitchReorder(fromId, v.id, after); a.drop(fromId, after); } };
    }
    return actionsFor0(kind, v, c);
  };
  const twitchReorder = (fromId, toId, after) => {
    const L = cfg.tv.twitch.logins.slice(), f = fromId.slice(3), t = toId.slice(3);
    if (!L.includes(f) || !L.includes(t) || f === t) return;
    L.splice(L.indexOf(f), 1); L.splice(L.indexOf(t) + (after ? 1 : 0), 0, f);
    cfg.tv.twitch.logins = L; cfg.tv.twitch.sort = "yours"; writeCfg();
  };
  const actionsFor0 = (kind, v, c) => {
    const idx = () => state.queue.findIndex((x) => x.id === v.id);
    if (kind === "live") return {
      feedRow: () => onFeed() && !state.stay,
      canRm: () => { const i = idx(); return i >= 0 && i !== state.pos; },
      canAdd: () => (onFeed() && !state.stay ? idx() > state.pos + 1 : !inFeed(v.id)),
      rm: () => { const it = state.queue[idx()]; removeLive(v.id); if (onFeed() && !state.stay) backToSource(it); },
      add: () => { if (onFeed() && !state.stay) { const i = idx(); if (i <= state.pos + 1) return false; moveItem(i, state.pos + 1); return true; } return addToFeed(v, { c: state.colId, i: idx() }); },
      open: () => jumpTo(idx()),
      drop: (fromId, after) => { const f = state.queue.findIndex((x) => x.id === fromId), t = idx(); if (f >= 0 && t >= 0) moveItem(f, t + (after ? 1 : 0)); },
    };
    if (kind === "hist") return { // History: plus adds to your Feed (it stays here), the bin forgets it, a click plays it again
      keepOnAdd: true, feedRow: () => false,
      canRm: () => true, rm: () => forgetHistory(v.id),
      canAdd: () => !v.tw && !inFeed(v.id), add: () => addToFeed(v),
      open: () => { const i = ghist.list.map((e) => e.v.id).lastIndexOf(v.id); if (i >= 0 && i !== ghist.pos) historyGo(i); },
    };
    if (kind === "base") return {
      feedRow: () => onFeed(),
      canRm: () => true,
      canAdd: () => (onFeed() ? (state.base || [])[0] !== undefined && state.base[0].id !== v.id : !inFeed(v.id)),
      rm: () => { const it = (state.base || []).find((x) => x.id === v.id); baseOps.remove(v.id); if (onFeed()) backToSource(it); },
      add: () => (onFeed() ? (baseOps.move(v.id, null, false), true) : addToFeed(v)),
      open: () => playFromMain(v),
      drop: (fromId, after) => baseOps.move(fromId, v.id, after),
    };
    if (kind === "idle") return {
      feedRow: () => true,
      canRm: () => true,
      canAdd: () => feedStore.length > 0 && feedStore[0].id !== v.id,
      rm: () => { const it = feedStore.find((x) => x.id === v.id); feedOps.remove(v.id); backToSource(it); },
      add: () => (feedOps.move(v.id, null, false), true),
      open: () => playFeedFrom(v),
      drop: (fromId, after) => feedOps.move(fromId, v.id, after),
    };
    if (kind === "xbrowse") return { // a topic you explored earlier
      canRm: () => true,
      canAdd: () => !inFeed(v.id),
      rm: () => xOps(c.id).remove(v.id),
      add: () => addToFeed(v),
      open: () => activateExplore(c.id, v),
      drop: (fromId, after) => xOps(c.id).move(fromId, v.id, after),
    };
    return { // browse
      canRm: () => true,
      canAdd: () => !inFeed(v.id),
      rm: () => browseOps(c.id).remove(v.id),
      add: () => addToFeed(v, { c: c.id, i: ((browse.get(c.id) || { items: [] }).items).findIndex((x) => x.id === v.id) }),
      open: () => stayInChannel(c, v),
      drop: (fromId, after) => browseOps(c.id).move(fromId, v.id, after),
    };
  };

  // ---- picking several videos: shift-click picks a range, Cmd/Ctrl-click one at a time; then explore them together,
  // add them all to your Feed, or remove them all (one Cmd+Z undoes it). Esc lets go.
  const sel = { ids: new Set(), anchor: null, tab: "" };
  const rowsInList = () => [...ui.pbody.querySelectorAll(":scope > .lbox > .list > .sw:not(.gone)")];
  const pick = (api, e) => {
    if (sel.tab !== state.panel) { sel.ids.clear(); sel.tab = state.panel; }
    const id = api.v.id;
    if (e.shiftKey && sel.anchor) {
      const ids = rowsInList().map((w) => w.dataset.id), a = ids.indexOf(sel.anchor), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) for (let k = Math.min(a, b); k <= Math.max(a, b); k++) sel.ids.add(ids[k]);
    } else if (sel.ids.has(id)) sel.ids.delete(id);
    else sel.ids.add(id);
    sel.anchor = id;
    drawPicks();
  };
  const clearPicks = () => { if (!sel.ids.size) return false; sel.ids.clear(); sel.anchor = null; drawPicks(); return true; };
  const pickedApis = () => rowsInList().filter((w) => sel.ids.has(w.dataset.id)).map((w) => rowApi.get(w)).filter(Boolean);
  const drawPicks = () => {
    if (!ui) return;
    if (sel.tab !== state.panel) { sel.ids.clear(); sel.anchor = null; }
    for (const w of rowsInList()) w.classList.toggle("picked", sel.ids.has(w.dataset.id));
    const bar = ui.pickbar, n = sel.ids.size;
    bar.classList.toggle("on", n > 0);
    if (n) bar.querySelector(".pn").textContent = `${n} picked`;
  };
  const bulk = (what) => {
    const apis = pickedApis();
    if (!apis.length) return clearPicks();
    if (what === "explore") {
      const items = apis.map((a) => a.v), id = Math.random().toString(36).slice(2, 9);
      state.xtabs = [...(state.xtabs || []), { id, query: `Your pick (${items.length})`, by: "", pick: true, items }];
      clearPicks(); activateExplore(id, items[0]); return;
    }
    const n0 = undoStack.length;
    for (const a of apis) {
      if (what === "add" && a.canAdd() && a.add() !== false && cfg.tv.swipeMove && !isFeedRow(a) && a.canRm()) { a.rm(); leave(a.wrap); }
      if (what === "rm" && a.canRm()) { a.rm(); leave(a.wrap); }
    }
    groupUndo(n0);
    if (what === "add") { state.bump = true; toast(`Added ${apis.length} to your ${nameOf(FEED_ID)}`); }
    clearPicks(); schedulePanel();
  };

  // ---- rows
  // Every row is its own sideways scroller with snap points (Swipe Lab's "Native snap"): [left action | video | right action],
  // resting on the video. The browser moves it with your fingers, knows when you let go and snaps it to an action or
  // back, so YTV never has to guess where a gesture starts or ends. Normally the plus is on the left and the trash on
  // the right; "Reverse swipe direction" swaps them.
  const rowApi = new WeakMap(); // .sw element -> what that row is and can do
  // Reordering: hold a row and move it. A copy follows the pointer every frame (pointer events, not the browser's
  // drag-and-drop, which only updates a few times a second), a line shows where it will land, and the list
  // scrolls smoothly when you hold it near the top or bottom.
  let dragging = false;
  const dragRow = (api, e) => {
    if (e.button !== 0 || e.pointerType === "touch" || e.target.closest(".hb") || dragging) return;
    const w = api.wrap, x0 = e.clientX, y0 = e.clientY, z = (cfg ? cfg.tv.uiScale : 100) / 100;
    let on = false, ghost = null, lastY = y0, raf = 0, target = null, after = false;
    const frame = () => {
      raf = 0;
      if (!on || !ui) return;
      const b = ui.pbody.getBoundingClientRect(), edge = 56;
      let auto = 0;
      if (lastY < b.top + edge) auto = -Math.ceil((b.top + edge - lastY) * 0.35);
      else if (lastY > b.bottom - edge) auto = Math.ceil((lastY - (b.bottom - edge)) * 0.35);
      if (auto) ui.pbody.scrollTop += auto;
      ghost.style.transform = `translate3d(0, ${(lastY - y0) / z}px, 0) scale(1.02)`;
      const n = ui.root.getRootNode().elementFromPoint(x0, lastY), over = n && n.closest ? n.closest(".sw") : null;
      clearMarks(); target = null;
      if (over && over !== w && over.parentNode === w.parentNode && !over.classList.contains("gone")) {
        const r = over.getBoundingClientRect(); after = lastY > r.top + r.height / 2;
        target = rowApi.get(over); if (target) over.querySelector(".item").classList.add(after ? "drop-after" : "drop-before");
      }
      if (auto) raf = requestAnimationFrame(frame);
    };
    const move = (ev) => {
      lastY = ev.clientY;
      if (!on) {
        if (Math.abs(ev.clientY - y0) < 6 || Math.abs(ev.clientX - x0) > Math.abs(ev.clientY - y0)) return;
        on = dragging = true;
        const r = w.getBoundingClientRect(), rr = ui.root.getBoundingClientRect();
        ghost = w.cloneNode(true); ghost.classList.add("dragghost"); ghost.classList.remove("enter", "gone");
        Object.assign(ghost.style, { left: (r.left - rr.left) / z + "px", top: (r.top - rr.top) / z + "px", width: r.width / z + "px" });
        ui.root.append(ghost); ghost.scrollLeft = w.scrollLeft;
        w.classList.add("dragslot");
      }
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true); window.removeEventListener("pointercancel", up, true);
      cancelAnimationFrame(raf); raf = 0;
      if (!on) return;
      dragging = false;
      const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); }; // the release isn't a click
      window.addEventListener("click", eat, true); setTimeout(() => window.removeEventListener("click", eat, true), 0);
      w.classList.remove("dragslot"); clearMarks();
      if (ghost) ghost.remove();
      if (target && target.drop) target.drop(api.v.id, after);
    };
    window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", up, true); window.addEventListener("pointercancel", up, true);
  };
  const clearMarks = () => { if (ui) for (const r of ui.pbody.querySelectorAll(".drop-before,.drop-after")) r.classList.remove("drop-before", "drop-after"); };
  const thr = () => (cfg ? cfg.tv.swipeThreshold : 100);
  // how far a row slides open: twice the threshold, so letting go past the threshold lands on the action
  // the panel changed width: rows keep resting on their video, nothing is rebuilt (so nothing slides in again)
  const refitRows = () => {
    if (!ui) return;
    const list = ui.pbody.querySelector(":scope > .lbox > .list"); if (!list) return;
    const R = restWidth(); list.style.setProperty("--R", R + "px");
    for (const n of list.children) if (!n.classList.contains("gone") && !busyRows.has(n)) { n._R = R; n.scrollLeft = R; }
  };
  let pbodyW = 0; // the list's width, kept up to date by a ResizeObserver
  const restWidth = () => Math.round(Math.min(Math.max(thr() * 2, 80), Math.max(120, (pbodyW || (ui && (pbodyW = ui.pbody.clientWidth)) || 400) * 0.62)));
  const flipped = () => !!(cfg && cfg.tv.swipeFlip);
  const makeRow = (v, kind, c) => {
    const wrap = el("div", "sw" + (v.tw ? " still" : "") + (v.off ? " twoff" : "")); wrap.dataset.id = v.id;
    wrap._flip = flipped();
    const leftAdd = !wrap._flip;
    const track = el("div", "track");
    const la = el("div", "act left " + (leftAdd ? "add" : "rm")), ra = el("div", "act right " + (leftAdd ? "rm" : "add"));
    la.append(icon(leftAdd ? "plus" : "trash-2")); ra.append(icon(leftAdd ? "trash-2" : "plus"));
    const row = el("div", "item" + (v.tw ? " twrow" : ""));
    row.setAttribute("role", "button"); row.tabIndex = 0;
    const it = el("div", "it"), ic = el("div", "ic"), txt = el("div", "txt");
    fillLine(it, v, 1); fillLine(ic, v, 2);
    txt.append(it, ic);
    const chan = kind === "browse" ? c : currentCol();
    const api = { v, kind, c, wrap, row, it, ic, ...actionsFor(kind, v, c) };
    row.append(thumbOf(v, v.tw ? (v.off ? {} : { info: () => { state.twInfo = api.v; showPanel("info"); } }) : { explore: () => openExplore(api.v), wl: !(chan && chan.watchLater) }), txt);
    if (v.tw) { const base = api.canAdd; api.canAdd = () => false; void base; } // live streams don't go on your Feed
    track.append(la, row, ra);
    wrap.append(track);
    rowApi.set(wrap, api);
    row.addEventListener("click", (e) => {
      if (e.target.closest(".hb")) return;
      if (e.shiftKey || e.metaKey || e.ctrlKey || sel.ids.size) return pick(api, e); // picking several
      api.open();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter") api.open();
      else if ((e.key === "Delete" || e.key === "Backspace") && api.canRm()) { e.preventDefault(); e.stopPropagation(); fire(api, "rm"); }
    });
    if (api.drop) row.addEventListener("pointerdown", (e) => dragRow(api, e));
    if (v.tw && !v.off) { let wt = 0; row.addEventListener("mouseenter", () => { clearTimeout(wt); wt = setTimeout(() => warmTwitch(api.v), 250); }); row.addEventListener("mouseleave", () => clearTimeout(wt)); } // point at it: it starts loading
    return api;
  };
  const updateRow = (api) => {
    const { row, v, kind } = api;
    const i = kind === "live" ? (qIdx ? (qIdx.has(v.id) ? qIdx.get(v.id) : -1) : state.queue.findIndex((x) => x.id === v.id)) : -1;
    const cur = kind === "live" ? i === state.pos : kind === "hist" && !!current() && current().id === v.id;
    row.classList.toggle("cur", cur);
    api.wrap.classList.toggle("curw", cur);
    row.classList.toggle("done", kind === "live" && !cur && !v.tw && !sortOff() && (i < state.pos || played.has(v.id))); // everything above what's playing is behind you
    setLines(api);
  };
  // Make `list` show `items` (in order), reusing the rows already there. Rows that move glide to their new place.
  let qIdx = null; // id → place in the playing list, only while a list is being redrawn
  const reconcile = (list, items, kind, c, animate) => {
    if (kind === "live") { qIdx = new Map(); state.queue.forEach((x, k) => { if (x && !qIdx.has(x.id)) qIdx.set(x.id, k); }); }
    try { return reconcile0(list, items, kind, c, animate); } finally { qIdx = null; }
  };
  const reconcile0 = (list, items, kind, c, animate) => {
    const old = new Map();
    for (const n of list.children) if (!n.classList.contains("gone") && n.classList.contains("sw")) old.set(n.dataset.id, n); // (rows only: the Watched bar stays)
    const glide = animate && motionOn();
    const before = glide ? new Map([...old].map(([id, n]) => [id, n.getBoundingClientRect().top])) : null;
    const want = [], names = [], fresh = [], seenIds = new Set();
    let k = 0;
    for (const v of items) {
      if (!v || seenIds.has(v.id)) continue;
      seenIds.add(v.id);
      let n = old.get(v.id), api = n && rowApi.get(n);
      if (api && api.kind === kind && api.wrap._flip === flipped() && (kind !== "browse" || (api.c && c && api.c.id === c.id))) { old.delete(v.id); api.v = v; }
      else {
        api = makeRow(v, kind, c); n = api.wrap; fresh.push(n); names.push([v, api]);
        if (motionOn() && !state.quiet) {
          n.classList.add("enter"); n.style.animationDelay = animate ? "0ms" : `${Math.min(k, 12) * 18}ms`;
          const done = (e) => { if (e.target === n) { n.classList.remove("enter"); n.style.animationDelay = ""; n.removeEventListener("animationend", done); } };
          n.addEventListener("animationend", done);
        }
      }
      updateRow(api);
      want.push(n);
      k++;
    }
    for (const n of old.values()) n.remove();
    let cursor = list.firstChild;
    const moved = [];
    for (const n of want) {
      while (cursor && cursor !== n && (cursor.classList.contains("gone") || !cursor.classList.contains("sw"))) cursor = cursor.nextSibling;
      if (cursor === n) { cursor = n.nextSibling; continue; }
      if (n.isConnected) moved.push(n);
      list.insertBefore(n, cursor);
    }
    const R = restWidth();
    list.style.setProperty("--R", R + "px");
    for (const n of fresh) { n._R = R; n.scrollLeft = R; }
    for (const n of moved) { n.scrollLeft = n._R; n._user = 0; } // moving an element resets its scroll: put it back on the video
    if (fresh.length) requestAnimationFrame(() => { for (const n of fresh) if (!n._user && n.isConnected && !busyRows.has(n) && Math.abs(n.scrollLeft - n._R) > 1) n.scrollLeft = n._R; });
    if (before) for (const n of want) {
      const top0 = before.get(n.dataset.id);
      if (top0 === undefined) continue;
      const dy = top0 - n.getBoundingClientRect().top;
      if (Math.abs(dy) < 1) continue;
      n.style.transition = "none"; n.style.transform = `translateY(${dy}px)`;
      requestAnimationFrame(() => { n.style.transition = "transform .28s cubic-bezier(.4,0,.2,1)"; n.style.transform = ""; });
      setTimeout(() => { n.style.transition = ""; }, 320);
    }
    if (names.length) fillNames(names);
    return want.length;
  };
  // Rows taken out stay behind, invisible and zero-height, until the pointer moves: the browser keeps sending a
  // trackpad gesture to the element it started on, so the next swipe still lands even if you don't move the mouse.
  const gcGhosts = () => { if (ui) for (const n of ui.pbody.querySelectorAll(".sw.gone")) if (!n._busy) n.remove(); };

  // ---- drawing a tab
  const EMPTY = {
    hist: ["Nothing watched yet", "Everything you watch shows up here, across channels and Twitch."],
    cont: ["Nothing half-watched", "YouTube videos you start and don’t finish show up here, also ones from YouTube itself."],
    idle: ["Your Feed is empty", "Swipe a video in any channel to add it here."],
    live: ["Nothing here yet", "Pull past the end of the list to load more."],
    base: ["Nothing to go back to yet", ""],
    browse: ["Nothing on this channel right now", "Pull down past the top to try again."],
    xbrowse: ["Nothing left in this topic", ""],
  };
  const canPull = (kind) => !!kind && kind !== "idle" && kind !== "xbrowse" && kind !== "hist" && kind !== "cont" && !(onFeed() && (kind === "base" || (kind === "live" && !state.stay)));
  const skeleton = () => { const box = el("div", "skel"); for (let i = 0; i < 7; i++) { const r = el("div", "srow"); r.append(el("div", "sth"), el("div", "stx")); r.style.animationDelay = `${i * 60}ms`; box.append(r); } return box; };
  const drawList = (tab, fresh) => {
    const kind = tabKind(tab);
    if (!kind) return;
    const x = kind === "xbrowse" ? xtabOf(tab) : null;
    const c = x || (tab === "explore" ? currentCol() : tab === HIST_TAB ? null : chanById(tab.slice(4)));
    let box = ui.pbody.querySelector(":scope > .lbox");
    if (fresh || !box || box.dataset.tab !== tab || box.dataset.kind !== kind) {
      box = el("div", "lbox"); box.dataset.tab = tab; box.dataset.kind = kind;
      const list = el("div", "list"), empty = el("div", "empty"), hint = el("p", "hintline", "");
      empty.hidden = true; hint.hidden = true;
      const more = el("button", "more"); more.type = "button"; more.hidden = true; more.append(icon("chevron"), el("span", null, "Load more"));
      more.addEventListener("click", () => loadMoreClick(more));
      const endl = el("p", "endline"); endl.hidden = true;
      box.append(hint, list, empty, more, endl);
      ui.pbody.replaceChildren(box);
      fresh = true;
    }
    const list = box.querySelector(".list"), empty = box.querySelector(".empty"), hint = box.querySelector(".hintline");
    let items = [];
    if (kind === "live") items = sortOff() ? state.queue.slice() : state.queue.filter((v, i) => i <= state.pos || v.f || !played.has(v.id)); // up next never shows what you've already watched (sorting off: it's all there)
    else if (kind === "base") items = state.base || [];
    else if (kind === "idle") items = feedStore;
    else if (kind === "xbrowse") items = x.items;
    else if (kind === "hist") items = histItems();
    else {
      let e = browse.get(c.id);
      const m = state.mem[c.id];
      if (!e && m && m.queue.length) { e = { items: m.queue.slice(m.pos), at: Date.now(), busy: null }; browse.set(c.id, e); } // the list you left, as you left it
      if (!e) loadBrowse(c, "open").then(() => state.panel === tab && schedulePanel());
      e = browse.get(c.id);
      items = e ? e.items : [];
      if ((!e || e.busy) && !items.length) { empty.hidden = false; empty.replaceChildren(skeleton()); list.replaceChildren(); if (fresh) ui.pbody.scrollTop = 0; return; }
    }
    const own = kind === "hist"; // (History shows everything it holds)
    if (kind !== "idle" && kind !== "xbrowse" && !own) items = items.filter((v, i) => (kind === "live" && i <= state.pos) || v.f || v.nx || !isBlocked(c || currentCol() || {}, v));
    const feedTab = tab === FEED_TAB || (kind === "live" && onFeed());
    if (!feedTab && kind !== "idle" && !own) items = items.filter((v, i) => (kind === "live" && i <= state.pos) || v.nx || !inFeed(v.id)); // on your Feed: in no other list
    if (!(c && c.twitch)) notePartial(items);
    // what this channel wouldn't play any more (seen since the list loaded, a creator you hid, music…) isn't shown
    // either, so the list is what will really play
    const ucol = kind === "live" || kind === "base" ? currentCol() : kind === "browse" ? c : null;
    if (ucol && !ucol.twitch && !(sortOff() && kind === "live")) {
      const cur = current(), curAt0 = kind === "live" && cur ? items.findIndex((v) => v.id === cur.id) : -1;
      items = items.filter((v, i) => i <= curAt0 || v.f || v.nx || usable(ucol, v));
    }
    // the filter (funnel above the list): what's playing and what you watched above it always stay
    const fOn = filterCount() > 0 && kind !== "idle" && kind !== "hist" && !feedTab && !(c && c.twitch);
    const fTotal = items.length;
    if (fOn) {
      if (flt().subbed !== "any") loadSubs();
      const cur = current(), curAt = kind === "live" && cur ? items.findIndex((v) => v.id === cur.id) : -1;
      items = items.filter((v, i) => i <= curAt || v.nx || passFilter(v));
    }
    state.fShown = { tab, shown: items.length, total: fTotal };
    hint.hidden = kind !== "base" && kind !== "xbrowse";

    if (kind === "base") hint.textContent = `What’s next on ${c ? c.name : "the channel"}. Pick one to close the topic and play it.`;
    if (kind === "xbrowse") hint.textContent = `Pick a video to carry on exploring “${x.query}” from there.`;
    // A long list opens at once: the rows you'll see first are made now, the rest a moment later in the background
    let n;
    if (fresh && items.length > 70) {
      const curAt = kind === "live" ? items.findIndex((v) => current() && v.id === current().id) : -1;
      const key0 = tab + "|" + kind + (kind === "live" && !sortOff() ? "|" + ((current() || {}).id || "") : "");
      const memAt = scrollMem.has(key0) ? Math.ceil(scrollMem.get(key0) / 60) : 0; // (rows are at least ~60px tall)
      const first = Math.min(items.length, Math.max(50, curAt + 30, memAt + 30));
      n = reconcile(list, items.slice(0, first), kind, c, false);
      if (first < items.length) appendLater(box, list, items.slice(first), kind, c);
      n = items.length;
    } else n = reconcile(list, items, kind, c, !fresh);
    empty.hidden = n > 0;
    const wlEnd = !!(c && c.watchLater && kind !== "xbrowse" && !(tab === "explore" && state.stay));
    box.querySelector(".more").hidden = (!n && !(fOn && fTotal)) || !canPull(kind) || !!(c && (c.twitch || c.cont)) || wlEnd;
    const endl = box.querySelector(".endline"); endl.hidden = !(wlEnd && (n || fTotal)); if (wlEnd && (n || fTotal)) endl.textContent = `End of your ${c.name} · ${fTotal} video${fTotal === 1 ? "" : "s"}${fOn && n !== fTotal ? ` (${n} match your filters)` : ""}`;
    if (fresh && !box.querySelector(".more").hidden) setTimeout(() => { if (ui && ui.pbody.scrollHeight <= ui.pbody.clientHeight + 40) autoMore(); }, 400); // too short to scroll: fill it up
    // Twitch: who's offline folds away under one line (open or closed, as you left it)
    // what you already watched on this channel sits folded away right above what's playing, under one "Watched" bar
    // (open or closed, as you left it)
    const curAtW = kind === "live" && !(c && c.twitch) && current() ? items.findIndex((v) => v.id === current().id) : -1;
    const wIds = new Set(curAtW > 0 && !sortOff() && cfg.tv.watchedFold ? items.slice(0, curAtW).map((v) => v.id) : []); // (off in settings: they stay in view, greyed)
    for (const w of list.children) if (w.classList.contains("sw")) w.classList.toggle("wfold", wIds.has(w.dataset.id));
    let wb = box._wbar;
    if (wIds.size) {
      if (!wb) { wb = box._wbar = el("button", "wbar"); wb.type = "button"; wb.addEventListener("click", () => foldToggle("ytv:wopen", "wfold", drawWatched)); }
      wb.dataset.n = wIds.size;
      const curRow = list.querySelector(".sw.curw"); if (curRow && wb.nextSibling !== curRow) list.insertBefore(wb, curRow);
      drawWatched();
    } else if (wb) wb.remove();
    const offN = c && c.twitch ? items.filter((v) => v.off).length : 0;
    let ob = box.querySelector(".twoffbar");
    if (offN) {
      if (!ob) {
        ob = el("button", "twoffbar"); ob.type = "button";
        ob.addEventListener("click", () => foldToggle("ytv:twoff", "twoff", drawOff));
      }
      const firstOff = list.querySelector(":scope > .sw.twoff");
      if (firstOff && ob.nextSibling !== firstOff) list.insertBefore(ob, firstOff); else if (!firstOff && ob.parentNode !== list) list.append(ob);
      ob.hidden = false; ob.dataset.n = offN;
      drawOff();
    } else if (ob) ob.hidden = true;
    if (!n && fOn && fTotal) empty.replaceChildren(el("b", null, "Nothing here matches your filters"), document.createTextNode(`${fTotal} video${fTotal === 1 ? "" : "s"} hidden. Loosen the filter (the funnel above), or load more.`));
    else if (!n) { const [b, t] = EMPTY[kind] || EMPTY.browse; empty.replaceChildren(el("b", null, b), document.createTextNode(t)); }
    if (fresh) {
      // each tab remembers where you were; the first time, what's playing sits at the very top (what you
      // already watched is just above it, out of view: scroll up to see it)
      // (sorting off: the list stays where you scrolled it, whatever plays)
      const keepPlace = kind === "live" && sortOff();
      const key = tab + "|" + kind + (kind === "live" && !keepPlace ? "|" + ((current() || {}).id || "") : ""); // once something else plays, it's shown at the top again
      ui.pbody.scrollTop = 0;
      if (scrollMem.has(key)) ui.pbody.scrollTop = scrollMem.get(key);
      else if (!keepPlace) { const cur = list.querySelector(".sw.curw:not(.still)"), wbar = list.querySelector(":scope > .wbar"); if (cur) ui.pbody.scrollTop = (wbar || cur).offsetTop; } // Twitch starts at the top
      box.dataset.key = key;
    }
    markStuck();
    requestAnimationFrame(markStuck); // once the rows have their final size
    drawPicks();
    updateFilterUi();
  };
  // open or close a folded group (Watched, Offline): its rows fade and slide a touch, quickly, instead of popping
  const foldToggle = (key, rowCls, draw) => {
    const open = !lsGet(key, false);
    if (open || !motionOn() || !ui) { lsSet(key, open); draw(); return; }
    const rows = [...ui.pbody.querySelectorAll(".sw." + rowCls)];
    let left = rows.length;
    if (!left) { lsSet(key, false); draw(); return; }
    const done = () => { if (--left > 0) return; lsSet(key, false); draw(); };
    for (const r of rows) r.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-4px)" }], { duration: 120, easing: "ease-in" }).onfinish = done;
  };
  const drawWatched = () => {
    if (!ui) return;
    const open = !!lsGet("ytv:wopen", false), wb = ui.pbody.querySelector(".wbar");
    ui.root.classList.toggle("wopen", open);
    if (wb) { if (!wb.firstChild) wb.append(icon("chevron"), el("span", null, "Watched")); wb.classList.toggle("open", open); wb.title = open ? "Fold away what you watched" : "Show what you watched on this channel"; }
    markStuck();
  };
  const drawOff = () => {
    if (!ui) return;
    const open = !!lsGet("ytv:twoff", false), ob = ui.pbody.querySelector(".twoffbar");
    ui.root.classList.toggle("twoff-open", open);
    if (ob) { if (!ob.firstChild) ob.append(icon("chevron"), el("span", null, "Offline"), el("i")); ob.lastChild.textContent = ob.dataset.n || ""; ob.title = open ? "Fold away who’s offline" : "Show who’s offline"; ob.classList.toggle("open", open); }
  };
  const appendLater = (box, list, rest, kind, c) => {
    const R = restWidth();
    const step = () => {
      if (!ui || !box.isConnected || !rest.length) return;
      const frag = document.createDocumentFragment(), names = [], made = [];
      const have = new Set([...list.children].map((x) => x.dataset.id));
      if (kind === "live") { qIdx = new Map(); state.queue.forEach((x, k) => { if (x && !qIdx.has(x.id)) qIdx.set(x.id, k); }); }
      try {
        for (const v of rest.splice(0, 40)) { // (small batches: the page stays smooth while a long list fills in)
          if (!v || have.has(v.id)) continue;
          const api = makeRow(v, kind, c); updateRow(api); frag.append(api.wrap); names.push([v, api]); made.push(api.wrap);
        }
      } finally { qIdx = null; }
      list.append(frag);
      for (const w of made) { w._R = R; w.scrollLeft = R; }
      if (names.length) fillNames(names);
      if (rest.length) (window.requestIdleCallback || setTimeout)(step, { timeout: 120 });
    };
    (window.requestIdleCallback || setTimeout)(step, { timeout: 120 });
  };
  // Loading a channel's videos for its tab ("more" adds, "refresh" starts over). Nothing loads by itself after that.
  const loadBrowse = (c, mode) => {
    let e = browse.get(c.id);
    if (e && e.busy) return e.busy;
    if (!e) { e = { items: [], at: 0, busy: null }; browse.set(c.id, e); }
    e.busy = (async () => {
      let got = [];
      if (mode === "more") { // the next pages of this channel's sources: there's always more
        const have = new Set(e.items.map((x) => x.id));
        try { got = await moreLineup(c, 15, have); } catch {}
        let add = got.filter((x) => !have.has(x.id));
        if (!add.length) add = await moreFallback(c, e.items[e.items.length - 1], have);
        add = [...new Map(add.map((x) => [x.id, x])).values()];
        e.items.push(...add); return add.length;
      }
      try { got = await buildLineup(c, () => {}, () => {}, mode !== "open"); } catch {}
      e.items = c.watchLater ? got : got.slice(0, 150);
      return got.length;
    })().finally(() => { e.busy = null; e.at = Date.now(); });
    return e.busy;
  };
  // ↻ or a pull from the top: a fresh list for this tab. Your Feed is yours, so it never changes by itself.
  const refreshTab = async () => {
    const tab = state.panel, kind = tabKind(tab);
    if (!canPull(kind)) return 0;
    const col = currentCol();
    if (kind === "browse") return loadBrowse(chanById(tab.slice(4)), "refresh");
    if (kind === "base") {
      const got = await buildLineup(col, () => {}, () => {}, true);
      if (!state.stay) return 0;
      const fresh = got.filter((x) => !played.has(x.id) && (!state.from || x.id !== state.from.item.id));
      state.base = fresh; saveSession(); schedulePanel();
      return fresh.length;
    }
    // what's playing: keep the video that's on, replace everything after it
    let got = [];
    if (state.stay && state.stay.by) got = await creatorVideos(current());
    else if (state.stay) got = (await Promise.all(SORTS.map((so) => searchTopic(state.stay.query, so)))).flat().filter((x) => matchesTopic(x, state.stay.query, true));
    else got = await buildLineup(col, () => {}, () => {}, true);
    const cur = current();
    const fresh = []; const ids = new Set([cur && cur.id]);
    for (const x of got) if (x && !ids.has(x.id) && !played.has(x.id) && usable(col, x)) { ids.add(x.id); fresh.push(x); }
    if (!fresh.length) return 0;
    if (col && col.shuffle) fresh.sort(() => Math.random() - 0.5);
    state.queue = [...state.queue.slice(0, state.pos + 1), ...(col && col.watchLater ? fresh : fresh.slice(0, 120))];
    saveSession(); schedulePanel();
    return fresh.length;
  };
  // A pull past the end: more videos for this tab.
  const loadMoreTab = async () => {
    const tab = state.panel, kind = tabKind(tab);
    if (!canPull(kind)) return 0;
    if (kind === "live") return topUp();
    if (kind === "browse") return loadBrowse(chanById(tab.slice(4)), "more");
    if (kind === "base") {
      const got = await moreLineup(currentCol(), 15, new Set([...(state.base || []), ...state.queue].map((x) => x.id)));
      if (!state.stay) return 0;
      const have = new Set(state.base.map((x) => x.id));
      const add = got.filter((x) => !have.has(x.id) && !played.has(x.id));
      state.base.push(...add); saveSession(); schedulePanel();
      return add.length;
    }
    return 0;
  };

  // ---- swiping: YTV only watches where the browser has scrolled a row
  const busyRows = new WeakSet();
  // a row only acts when you moved it: your wheel / touch input was on that row a moment ago
  const userSwiped = (w) => w._user && performance.now() - w._user < 2500;
  const actOf = (w, leftShows) => (leftShows !== !!w._flip ? "add" : "rm"); // which action the revealed side does
  let shiftDown = false; // Shift held while swiping: the plus plays the video next instead
  for (const t of ["keydown", "keyup"]) window.addEventListener(t, (e) => { shiftDown = !!e.shiftKey; }, true);
  window.addEventListener("blur", () => { shiftDown = false; });
  const nextMode = () => shiftDown;
  const can = (api, act) => (act === "rm" ? api.canRm() : nextMode() ? canPlayNext(api.v) : api.canAdd());
  const isFeedRow = (api) => !!(api.feedRow && api.feedRow());
  const NO_GIVE = 34;
  const onRowScroll = (e) => {
    const w = e.target;
    if (!w.classList || !w.classList.contains("sw") || busyRows.has(w)) return;
    const api = rowApi.get(w);
    if (!api) return;
    if (!userSwiped(w)) { if (Math.abs(w.scrollLeft - w._R) > 1) w.scrollLeft = w._R; return; } // the browser moved it (a layout change), not you: put it back
    let d = w._R - w.scrollLeft;
    // a short stop in the middle: coming back past it from one side halts the row there for a moment, so getting to
    // the other side takes a new, deliberate swipe (Settings → Swiping → Stop in the middle)
    if (Math.abs(d) > 10 && !w._side) w._side = Math.sign(d);
    if (w._side && Math.sign(d) === -w._side && cfg.tv.swipeHoldMs > 0) {
      w._side = 0; w.scrollLeft = w._R; d = 0;
      w.style.overflowX = "hidden";
      clearTimeout(w._ht); w._ht = setTimeout(() => { w.style.overflowX = ""; }, cfg.tv.swipeHoldMs);
      w.classList.remove("armed", "no"); w.style.setProperty("--p", "0");
      return;
    }
    const a = Math.abs(d), act = actOf(w, d > 0), ok = can(api, act);
    if (!ok && a > 4) return refuse(api, act); // (checked first: a very fast swipe can reach the end in one go)
    // fully uncovered: act now, without waiting for the browser's "scroll ended" (which waits out every bit of coasting)
    const max = w.scrollWidth - w.clientWidth;
    if ((w.scrollLeft <= 1 || w.scrollLeft >= max - 1) && a > 4) { fire(api, actOf(w, w.scrollLeft <= 1)); return; }
    // a way this row can't go (the playing video can't be removed; something already in your Feed can't be added
    // again): it gives a little, then the rest of that gesture is ignored and it glides back once, calmly (no fighting
    // the trackpad, so no twitching), with one note saying why
    if (!ok && a > NO_GIVE) return refuse(api, act);
    const instant = cfg.tv.swipeStyle === "instant", line = instant ? thr() : w._R / 2;
    w.style.setProperty("--p", String(Math.min(1, a / line)));
    w.classList.toggle("armed", ok && a >= line);
    w.classList.toggle("no", !ok && a > 4); // that way does nothing here: it stays grey and snaps back
    w.classList.toggle("toadd", act === "add" && !nextMode() && cfg.tv.swipeMove && !isFeedRow(api) && !api.keepOnAdd && api.canRm());
    w.classList.toggle("nextup", act === "add" && nextMode());
    if (instant && ok && a >= thr()) fire(api, act);
  };
  // Feedback stays on the row: a short flash when it worked, a small shake when that way isn't possible. No notes.
  const rowMark = (api, kind) => {
    const r = api && api.row; if (!r || !r.isConnected || !motionOn()) return;
    if (kind === "no") { r.animate([{ transform: "translateX(0)" }, { transform: "translateX(-7px)" }, { transform: "translateX(5px)" }, { transform: "translateX(0)" }], { duration: 260, easing: "ease-out" }); return; }
    r.classList.remove("flash"); void r.offsetWidth; r.classList.add("flash");
  };
  const sayNo = (api) => rowMark(api, "no");
  const whyNot = (api, act) => act === "add" && nextMode() ? (api.v.tw ? "Live streams can’t be queued" : current() && current().tw ? "Plays next works while a YouTube video is on" : "That’s what’s playing") : act === "add" ? (inFeed(api.v.id) ? `Already in your ${nameOf(FEED_ID)}` : api.v.tw ? "Live streams can’t go on your Feed" : "This one can’t move up")
    : current() && api.v.id === current().id ? "What’s playing stays in the list" : "This one can’t be removed here";
  const nudge = (api, act, dir) => {
    const w = api.wrap;
    if (motionOn() && !(w._nudge && performance.now() - w._nudge < 450)) { w._nudge = performance.now(); api.row.animate([{ transform: "translateX(0)" }, { transform: `translateX(${dir * 12}px)` }, { transform: "translateX(0)" }], { duration: 280, easing: "cubic-bezier(.3,.7,.4,1)" }); }
  };
  const refuse = (api, act) => {
    const w = api.wrap;
    if (busyRows.has(w)) return;
    busyRows.add(w);
    w.style.overflowX = "hidden"; // the rest of this gesture can't move it
    w.classList.remove("armed", "toadd", "nextup"); w.classList.add("no"); w.style.setProperty("--p", "0");
    const d0 = w._R - w.scrollLeft; if (Math.abs(d0) > NO_GIVE) w.scrollLeft = w._R - Math.sign(d0) * NO_GIVE; // never further than a little give
    w.scrollTo({ left: w._R, behavior: motionOn() ? "smooth" : "auto" });
    const t0 = performance.now();
    const settle = () => { // free again once your fingers (and the coasting) have stopped
      if (!w.isConnected) { busyRows.delete(w); return; }
      if (performance.now() - (w._user || 0) < 350 && performance.now() - t0 < 3000) { setTimeout(settle, 120); return; }
      w.scrollLeft = w._R; w._user = 0; w._side = 0; w.style.overflowX = ""; w.classList.remove("no"); busyRows.delete(w);
    };
    setTimeout(settle, 300);
  };
  const onRowScrollEnd = (e) => {
    const w = e.target;
    if (!w.classList || !w.classList.contains("sw") || busyRows.has(w)) return;
    const api = rowApi.get(w);
    if (!api) return;
    if (!userSwiped(w)) { if (Math.abs(w.scrollLeft - w._R) > 1) w.scrollLeft = w._R; return; } // not a swipe: just put it back
    const max = w.scrollWidth - w.clientWidth;
    if (w.scrollLeft <= 2) fire(api, actOf(w, true));
    else if (w.scrollLeft >= max - 2) fire(api, actOf(w, false));
    else if (Math.abs(w.scrollLeft - w._R) > 2) w.scrollTo({ left: w._R, behavior: motionOn() ? "smooth" : "auto" });
    else { w.classList.remove("armed", "no", "nextup"); w.style.setProperty("--p", "0"); w._side = 0; }
  };
  // A row leaves the list: it fades (your fade-out time) while the rows below glide up into its place.
  const leave = (w) => {
    const move = motionOn();
    // its "slide in" animation (kept on with fill-mode) would pin the opacity and skip the fade: drop it first
    w.classList.remove("enter"); w.style.animation = "none";
    w.classList.add("gone", "armed"); w._busy = true; w._user = 0;
    // fade where it is, then the gap closes as the rows below move up (Settings → Swiping & lists → Remove animation)
    const total = move ? cfg.tv.swipeFadeMs : 0, fade = Math.round(total * 0.55), collapse = total - fade;
    if (!total) { w.style.opacity = "0"; w.style.height = "0px"; w.style.margin = "0"; w._busy = false; return; }
    const h = w.offsetHeight;
    w.style.overflow = "hidden";
    w.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade, easing: "ease", fill: "forwards" }).onfinish = () => {
      w.animate([{ height: h + "px", marginBottom: getComputedStyle(w).marginBottom }, { height: "0px", marginBottom: "0px" }], { duration: collapse, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" })
        .onfinish = () => { w._busy = false; };
    };
  };
  // Do a row's action. Trash: it leaves. Plus: it goes to your Feed and (by default) leaves this list the same way;
  // in your Feed itself the plus moves it up to play next.
  const fire = (api, act) => {
    const w = api.wrap;
    if (busyRows.has(w)) return;
    busyRows.add(w);
    w.style.overflowX = "hidden"; // the rest of the gesture can't move it any more
    const move = motionOn();
    // back to rest, and it stays put until your fingers (and the trackpad's coasting) have stopped: the end of the
    // same gesture can't slide it again
    const home = () => {
      w.scrollTo({ left: w._R, behavior: move ? "smooth" : "auto" });
      const t0 = performance.now();
      const settle = () => {
        if (!w.isConnected) { busyRows.delete(w); return; }
        const quiet = performance.now() - (w._user || 0) > 350;
        if (!quiet && performance.now() - t0 < 3000) { setTimeout(settle, 120); return; }
        w.scrollLeft = w._R; w._user = 0; w._side = 0; w.style.overflowX = ""; busyRows.delete(w); w.classList.remove("armed", "no", "toadd", "nextup"); w.style.setProperty("--p", "0");
      };
      setTimeout(settle, move ? 420 : 0);
    };
    if (act === "rm") {
      if (!api.canRm()) return home();
      const rc = api.kind === "browse" ? api.c : currentCol();
      if (rc && rc.cont) { contHide.add(api.v.id); lsSet("ytv:conthide", [...contHide].slice(-500)); }
      api.rm();
      return leave(w);
    }
    if (nextMode()) { // Shift: plays next in the list that's on now; the row stays where it is
      if (playNext(api.v)) rowMark(api, "next");
      else sayNo(api, "add");
      return home();
    }
    if (!api.canAdd()) { sayNo(api, "add"); return home(); }
    if (cfg.tv.swipeMove && !isFeedRow(api) && !api.keepOnAdd && api.canRm()) { // to the Feed, and out of this list (one Cmd+Z undoes both)
      const n0 = undoStack.length;
      if (api.add() === false) return home();
      api.rm();
      groupUndo(n0);
      w.classList.add("moved"); rowMark(api, "ok");
      return leave(w);
    }
    const done = api.add() !== false;
    if (done) rowMark(api, isFeedRow(api) ? "next" : "ok"); // (the playing video stays where it is: it's still on)
    home();
  };
  // Chrome hands a whole trackpad gesture to whatever it starts on, so a downward scroll that starts a little sideways
  // could slide a row instead of scrolling the list. YTV looks at a gesture's first movement: unless it's clearly
  // sideways (Settings → Sideways detection), YTV scrolls the list itself for that gesture and the rows stay put.
  const AXIS = { strict: 2.2, normal: 1.4, loose: 1 };
  const wg = { manual: false, last: 0, endT: 0 };
  let lastPt = { x: 0, y: 0 };
  const onWheel = (e) => {
    if (!ui) return;
    lastPt = { x: e.clientX, y: e.clientY };
    const unit = e.deltaMode === 1 ? 16 : 1, dx = e.deltaX * unit, dy = e.deltaY * unit;
    const hit = e.target && e.target.closest && e.target.closest(".sw");
    if (hit && dx !== 0) hit._user = performance.now();
    shiftDown = e.shiftKey;
    const gap = e.timeStamp - wg.last; wg.last = e.timeStamp;
    const start = gap > 100 || (!wg.manual && !wg.no && e.cancelable);
    if (start) {
      wg.manual = false; wg.no = null;
      if (hit && dx !== 0 && Math.abs(dx) <= Math.abs(dy) * (AXIS[cfg.tv.swipeAxis] || 2.2)) wg.manual = true;
      // sideways, from rest, the way this row can't go (what's playing can't be removed…): the row doesn't move at
      // all for the whole gesture, however fast; it just gives a little nudge and says why, once
      else if (hit && dx !== 0 && !busyRows.has(hit) && Math.abs(hit.scrollLeft - hit._R) < 3) {
        const api = rowApi.get(hit), act = api && actOf(hit, dx < 0);
        if (api && !can(api, act)) { wg.no = hit; nudge(api, act, dx < 0 ? 1 : -1); }
      }
    }
    if (wg.no) { if (e.cancelable) e.preventDefault(); clearTimeout(wg.endT); wg.endT = setTimeout(() => { wg.no = null; }, 160); return; }
    if (!wg.manual) return;
    if (e.cancelable) e.preventDefault();
    ui.pbody.scrollTop += dy;
    clearTimeout(wg.endT); wg.endT = setTimeout(() => { wg.manual = false; }, 140);
  };

  // ---- loading more: scroll near the end of a list and the next page loads by itself (the button still works too).
  // When YouTube has nothing new it waits a little before asking again, so a list at its end doesn't keep asking.
  const autoMoreState = { quietUntil: 0, chain: 0 };
  const autoMore = () => {
    if (!ui) return;
    const b = ui.pbody.querySelector(":scope > .lbox > .more");
    if (!b || b.hidden || b.classList.contains("go") || performance.now() < autoMoreState.quietUntil) return;
    const pb = ui.pbody, left = pb.scrollHeight - pb.scrollTop - pb.clientHeight;
    if (left > Math.max(500, pb.clientHeight * 0.75)) { autoMoreState.chain = 0; return; }
    loadMoreClick(b, true);
  };
  const loadMoreClick = async (b, auto = false) => {
    if (b.classList.contains("go")) return;
    if (!auto) autoMoreState.quietUntil = 0;
    b.classList.add("go"); b.lastChild.textContent = "Loading"; busy(+1);
    let n = 0;
    try { n = await loadMoreTab(); } catch {}
    busy(-1);
    if (n) schedulePanel(); // (a channel you're looking at, not playing, didn't redraw: the new videos stayed out of sight)
    if (!b.isConnected) return;
    b.classList.remove("go"); b.lastChild.textContent = n ? `${n} more — load more` : "Nothing new for now — try again";
    if (!n) { autoMoreState.quietUntil = performance.now() + 8000; autoMoreState.chain = 0; }
    else if (++autoMoreState.chain < 4) requestAnimationFrame(() => requestAnimationFrame(autoMore)); // still at the end (a short list): the next page too
    else autoMoreState.quietUntil = performance.now() + 1500;
    setTimeout(() => { if (b.isConnected && !b.classList.contains("go")) b.lastChild.textContent = "Load more"; }, 2200);
  };
  // Once the playing row scrolls away over the top, a slim copy of it slides in over the list, in step with your
  // scrolling (only opacity and transform change, so it stays smooth). Scrolling the other way, it slides back out.
  // Never at the bottom.
  const scrollMem = new Map(); // tab → how far down you were
  let stuckRaf = 0;
  const markStuck = () => { if (!stuckRaf) stuckRaf = requestAnimationFrame(updateNowBar); };
  const updateNowBar = () => {
    stuckRaf = 0;
    if (!ui) return;
    const box = ui.pbody.querySelector(":scope > .lbox");
    if (box && box.dataset.key) scrollMem.set(box.dataset.key, ui.pbody.scrollTop);
    const b = ui.pbody, st = b.scrollTop, more = b.scrollHeight - b.clientHeight - st;
    b.classList.toggle("ft", st > 2); b.classList.toggle("fb", more > 2); // the soft fades at the edges
    ui.totop.classList.toggle("on", st > b.clientHeight * 1.5); // far down: a way back up
    const bar = ui.nowbar, cur = ui.pbody.querySelector(".sw.curw:not(.gone):not(.still)"); // (Twitch is a plain list: no copy of what's on at the top)
    let p = 0;
    if (cur) {
      p = Math.max(0, Math.min(1, (st - cur.offsetTop) / Math.max(1, cur.offsetHeight * 0.7))); // 0 = the row is in view, 1 = it has scrolled away (no layout reads while scrolling)
      if (bar._id !== cur.dataset.id) { // what's playing changed: show it
        bar._id = cur.dataset.id;
        const img = cur.querySelector(".thumb img"), t = cur.querySelector(".it");
        const th = el("span", "nth"); if (img && img.src) th.style.backgroundImage = `url("${img.src}")`;
        bar.replaceChildren(th, el("span", "nt", t ? t.textContent : ""));
      }
    }
    if (bar._p !== p) { // only when it changed
      bar._p = p;
      bar.style.opacity = String(p);
      bar.style.transform = `translateY(${(p - 1) * 105}%)`;
      bar.classList.toggle("on", p > 0.5);
    }
  };
  const setupBody = () => {
    if (ui.pbody._hw) return;
    ui.pbody._hw = true;
    ui.nowbar.addEventListener("click", () => { const cur = ui.pbody.querySelector(".sw.curw"); if (cur) ui.pbody.scrollTo({ top: cur.offsetTop, behavior: motionOn() ? "smooth" : "auto" }); });
    ui.pbody.addEventListener("wheel", onWheel, { passive: false });
    ui.pbody.addEventListener("scroll", (e) => { if (e.target === ui.pbody) { markStuck(); autoMore(); } else onRowScroll(e); }, true);
    ui.pbody.addEventListener("scrollend", onRowScrollEnd, true);
    let lastMove = 0;
    ui.pbody.addEventListener("pointerdown", (e) => { if (e.pointerType === "touch") { const w = e.target.closest && e.target.closest(".sw"); if (w) w._user = performance.now() + 60000; } });
    ui.pbody.addEventListener("pointerup", (e) => { if (e.pointerType === "touch") { const w = e.target.closest && e.target.closest(".sw"); if (w) w._user = performance.now(); } });
    ui.pbody.addEventListener("pointermove", (e) => {
      lastPt = { x: e.clientX, y: e.clientY };
      if (e.timeStamp - lastMove > 200) { lastMove = e.timeStamp; gcGhosts(); }
    });
  };
  const rowAt = (x, y) => {
    if (!ui.pbody.matches(":hover")) return null; // the pointer isn't over the list: A / D / Delete act on nothing
    const n = ui.root.getRootNode().elementFromPoint(x, y);
    const w = n && n.closest ? n.closest(".sw") : null;
    return w && !w.classList.contains("gone") && ui.pbody.contains(w) ? rowApi.get(w) : null;
  };
  // Delete removes the row under the pointer (found by position, so it's right even after rows moved under it).
  const deleteHovered = () => {
    if (!isListTab(state.panel)) return false;
    const api = rowAt(lastPt.x, lastPt.y);
    if (!api || !api.canRm()) return false;
    fire(api, "rm");
    return true;
  };
  // The keyboard version of a swipe, on the row under the pointer: A = the plus (Shift+A: plays next), D = the bin.
  const swipeHovered = (act, shift) => {
    if (!isListTab(state.panel)) return false;
    const api = rowAt(lastPt.x, lastPt.y);
    if (!api || busyRows.has(api.wrap)) return false;
    shiftDown = !!shift;
    if (act === "rm" && !api.canRm()) { sayNo(api, "rm"); return true; }
    if (act === "add" && !can(api, "add")) { sayNo(api, "add"); return true; }
    fire(api, act);
    return true;
  };

  // ---- the list filter (the funnel above the list): one set for every YouTube tab, kept in settings and used for
  // everything that loads later too. Never your Feed, never Twitch, and what's playing always stays.
  const F_DEFAULT = { under: false, underMin: 10, over: false, overMin: 8, age: "any", ageN: 2, ageUnit: "weeks", watched: "any", watchedPct: 80, subbed: "any" };
  const F_UNIT = { days: 1, weeks: 7, months: 30 };
  const flt = () => (cfg && cfg.tv.filter) || F_DEFAULT;
  const filterCount = () => { const f = flt(); return (f.under ? 1 : 0) + (f.over ? 1 : 0) + (f.age !== "any" ? 1 : 0) + (f.watched !== "any" ? 1 : 0) + (f.subbed !== "any" ? 1 : 0); };
  /** "12:34" / "1:02:03" → seconds (null when it isn't a length, e.g. a live stream). */
  const lenSecs = (t) => { const m = String(t || "").trim().match(/^(\d{1,3})(?::(\d{2}))(?::(\d{2}))?$/); if (!m) return null; return [m[1], m[2], m[3]].filter((x) => x != null).map(Number).reduce((a, b) => a * 60 + b, 0); };
  // who you're subscribed to: read from YouTube once a day, only when the Subscribed filter is used
  let subKeys = null, subLoading = null;
  const SUBS_KEY = "ytv:subscribed";
  const loadSubs = () => {
    if (subKeys || subLoading) return subLoading;
    subLoading = (async () => {
      try { const c = (await chrome.storage.local.get(SUBS_KEY))[SUBS_KEY]; if (c && Array.isArray(c.keys) && c.keys.length && Date.now() - c.at < 24 * 3600 * 1000) { subKeys = new Set(c.keys); return; } } catch {}
      const keys = await SW.yt.subscribedChannels();
      subKeys = new Set(keys);
      if (keys.length) try { await chrome.storage.local.set({ [SUBS_KEY]: { at: Date.now(), keys } }); } catch {}
    })().finally(() => { subLoading = null; if (ui) { schedulePanel(); updateFilterUi(); } });
    return subLoading;
  };
  /** true / false, or null while YTV doesn't know who you're subscribed to (then the video stays). */
  const isSubbed = (v) => {
    if (!subKeys || !subKeys.size) return null;
    for (const k of [creatorKey(v.creator), v.channel && !SW.yt.isStat(v.channel) ? creatorKey(v.channel) : ""]) {
      if (!k) continue;
      if (subKeys.has(k)) return true;
      const al = creatorAlias.get(k); if (al) for (const x of al) if (subKeys.has(x)) return true;
    }
    return false;
  };
  /** Does a video get through the filter? Anything YouTube didn't say (no length, no date) gets through. */
  const passFilter = (v) => {
    const f = flt();
    if (!v || v.tw) return true;
    if (f.under || f.over) { const s = lenSecs(v.len); if (s !== null) { if (f.under && s >= f.underMin * 60) return false; if (f.over && s <= f.overMin * 60) return false; } }
    if (f.age !== "any") { const d = ageOf(v); if (d !== null) { const lim = f.ageN * (F_UNIT[f.ageUnit] || 7); if (f.age === "within" ? d > lim : d <= lim) return false; } }
    if (f.watched !== "any") { const w = progressOf(v) >= f.watchedPct; if (f.watched === "yes" ? !w : w) return false; }
    if (f.subbed !== "any") { const s = isSubbed(v); if (s !== null && (f.subbed === "yes" ? !s : s)) return false; }
    return true;
  };
  /** Is the filter on for what this channel plays? (not your Feed, not Twitch) */
  const filterFor = (col) => filterCount() > 0 && !!col && !col.twitch && !(col.feed && !state.stay);
  /** Can this tab be filtered? */
  const filterable = (tab) => {
    const kind = tabKind(tab);
    if (!kind || kind === "idle") return false;
    if (kind === "hist") return false;
    if (kind === "xbrowse" || tab === "explore") return true;
    const c = chanById(String(tab).slice(4));
    return !!c && !c.twitch && !c.feed;
  };
  let fSaveT = 0;
  const setFilter = (patch) => {
    if (!cfg) return;
    cfg.tv.filter = { ...flt(), ...patch };
    if (cfg.tv.filter.subbed !== "any") loadSubs();
    updateFilterUi(); schedulePanel();
    clearTimeout(fSaveT); fSaveT = setTimeout(() => writeCfg(), 450);
  };
  const filterChips = () => {
    const f = flt(), out = [];
    if (f.under && f.over) out.push([`${f.overMin}–${f.underMin} min`, { under: false, over: false }]);
    else if (f.under) out.push([`Under ${f.underMin} min`, { under: false }]);
    else if (f.over) out.push([`Over ${f.overMin} min`, { over: false }]);
    if (f.age !== "any") out.push([`${f.age === "within" ? "Past" : "Older than"} ${f.ageN} ${f.ageN === 1 ? f.ageUnit.replace(/s$/, "") : f.ageUnit}`, { age: "any" }]);
    if (f.watched !== "any") out.push([f.watched === "yes" ? `Watched ≥${f.watchedPct}%` : `Not watched (<${f.watchedPct}%)`, { watched: "any" }]);
    if (f.subbed !== "any") out.push([f.subbed === "yes" ? "Subbed" : "Not subbed", { subbed: "any" }]);
    return out;
  };
  // the funnel's badge, the chips under the tabs and the counts in the open panel
  const updateFilterUi = () => {
    if (!ui || !ui.filtB) return;
    const n = filterCount(), can = filterable(state.panel);
    ui.filtB.hidden = !can;
    ui.filtB.classList.toggle("on", n > 0);
    ui.fdot.hidden = !n; ui.fdot.textContent = n ? String(n) : "";
    const off = sortOff(); ui.sdot.hidden = !off;
    ui.filtB.title = n ? `Filter the list (${n} on)` : "Filter the list";
    ui.histPB.title = "History: everything you watched (H)" + (off ? " · Sorting off (S)" : "");
    ui.fstrip.hidden = !(can && n);
    if (can && n) {
      const sig = JSON.stringify(flt());
      if (ui.fstrip.dataset.sig !== sig) {
        ui.fstrip.dataset.sig = sig;
        const chips = filterChips();
        const pill = el("div", "fpill");
        const what = el("button", "fpw", chips.length === 1 ? chips[0][0] : `${chips.length} filters`); what.type = "button"; what.title = chips.map(([l]) => l).join(" · ") + " — change";
        what.addEventListener("click", (e) => { e.stopPropagation(); toggleFilter(); });
        const clr = el("button", "fclear", "Clear"); clr.type = "button"; clr.title = "Turn all filters off";
        clr.addEventListener("click", (e) => { e.stopPropagation(); setFilter({ under: false, over: false, age: "any", watched: "any", subbed: "any" }); if (!ui.fpop.hidden) drawFilterPop(); });
        pill.append(what, el("span", "fdotsep", "·"), clr);
        ui.fstrip.replaceChildren(pill);
      }
    }
    if (!can && !ui.fpop.hidden) closeFilter();
    const cnt = ui.fpop.querySelector(".fcount"), sh = state.fShown;
    if (cnt) cnt.textContent = n && sh && sh.tab === state.panel ? `${sh.shown} of ${sh.total} shown` : n ? "" : "Nothing filtered";
    const sn = ui.fpop.querySelector(".fsubnote");
    if (sn) sn.textContent = flt().subbed === "any" ? "" : subLoading ? "Reading your subscriptions…" : subKeys && !subKeys.size ? "Couldn’t read your subscriptions (are you signed in?) — nothing is hidden by this one." : "";
  };
  const fNum = (val, min, max, key) => {
    const i = el("input", "fnum"); i.type = "number"; i.min = String(min); i.max = String(max); i.value = String(val); i.setAttribute("aria-label", key);
    i.addEventListener("input", () => { const n = Math.round(Number(i.value)); if (i.value !== "" && Number.isFinite(n) && n >= min && n <= max) setFilter({ [key]: n }); });
    i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); closeFilter(); } else if (e.key === "Enter") { e.preventDefault(); i.blur(); } });
    i.addEventListener("blur", () => { i.value = String(flt()[key]); });
    return i;
  };
  const fSeg = (opts, key, onPick) => {
    const box = el("div", "fseg"); box.setAttribute("role", "radiogroup");
    for (const [v, label] of opts) {
      const b = el("button", flt()[key] === v ? "on" : null, label); b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(flt()[key] === v));
      b.addEventListener("click", () => { setFilter({ [key]: v }); for (const x of box.children) { x.classList.toggle("on", x === b); x.setAttribute("aria-checked", String(x === b)); } if (onPick) onPick(v); });
      box.append(b);
    }
    return box;
  };
  const fCheck = (key, label, numKey) => {
    const line = el("div", "fline"), b = el("button", "fck" + (flt()[key] ? " on" : "")); b.type = "button"; b.setAttribute("role", "checkbox"); b.setAttribute("aria-checked", String(!!flt()[key])); b.setAttribute("aria-label", label);
    const flip = () => { const on = !flt()[key]; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); setFilter({ [key]: on }); };
    b.addEventListener("click", flip);
    const t = el("span", "ftx", label); t.addEventListener("click", flip);
    line.append(b, t, fNum(flt()[numKey], 1, 600, numKey), el("span", null, "min"));
    return line;
  };
  const drawFilterPop = () => {
    const f = flt(), pop = ui.fpop;
    const head = el("h4"); head.append(el("b", null, "Filter the list"), el("span", "fcount", ""));
    const len = el("div", "fsec"); len.append(el("div", "flbl", "Length"), fCheck("under", "Under", "underMin"), fCheck("over", "Over", "overMin"), el("div", "fnote", "Tick both for a range, e.g. over 8 and under 30."));
    const ageLine = el("div", "fline" + (f.age === "any" ? " off" : ""));
    const unit = el("select", "fsel"); unit.setAttribute("aria-label", "Unit");
    for (const [v, l] of [["days", "days"], ["weeks", "weeks"], ["months", "months"]]) { const o = el("option", null, l); o.value = v; o.selected = f.ageUnit === v; unit.append(o); }
    unit.addEventListener("change", () => setFilter({ ageUnit: unit.value }));
    unit.addEventListener("keydown", (e) => e.stopPropagation());
    ageLine.append(el("span", null, "past"), fNum(f.ageN, 1, 999, "ageN"), unit);
    const age = el("div", "fsec"); age.append(el("div", "flbl", "Uploaded"), fSeg([["any", "Any"], ["within", "Within"], ["older", "Older than"]], "age", (v) => ageLine.classList.toggle("off", v === "any")), ageLine);
    const pctLine = el("div", "fline"); pctLine.append(el("span", null, "Counts as watched from"), fNum(f.watchedPct, 1, 100, "watchedPct"), el("span", null, "%"));
    const wat = el("div", "fsec"); wat.append(el("div", "flbl", "Watched"), fSeg([["any", "Any"], ["yes", "Watched"], ["no", "Not watched"]], "watched"), pctLine);
    const sub = el("div", "fsec"); sub.append(el("div", "flbl", "Subscribed"), fSeg([["any", "Any"], ["yes", "Subbed"], ["no", "Not subbed"]], "subbed"), el("div", "fnote fsubnote", ""));
    const reset = el("button", null, "Reset"); reset.type = "button"; reset.addEventListener("click", () => { setFilter({ ...F_DEFAULT }); drawFilterPop(); });
    const foot = el("div", "ffoot"); foot.append(el("span", null, "Every YouTube tab · not Feed or Twitch"), reset);
    pop.replaceChildren(head, len, age, wat, sub, foot);
    updateFilterUi();
  };
  const openFilter = () => { if (!ui) return; closeChanMenu(); drawFilterPop(); ui.fpop.hidden = false; ui.filtB.classList.add("open"); wake(); };
  const closeFilter = () => { if (!ui || ui.fpop.hidden) return false; ui.fpop.hidden = true; ui.filtB.classList.remove("open"); wake(); return true; };
  const toggleFilter = () => (ui && !ui.fpop.hidden ? closeFilter() : openFilter());
  // a click anywhere else (also on the video or YouTube's own page) closes it
  window.addEventListener("pointerdown", (e) => {
    if (!ui || !ui.fpop) return;
    const path = e.composedPath();
    if (!ui.fpop.hidden && !path.some((n) => n === ui.fpop || n === ui.filtB)) closeFilter();
    if (!ui.twpop.hidden && !path.some((n) => n === ui.twpop || n === ui.twsB)) closeTwSearch();
  }, true);

  // ---- Twitch: find streamers by name (the magnifier above the Twitch list) and add them with +
  let twsLast = { q: "", r: null }, twsTok = 0, twsT = 0;
  const twHit = (u) => {
    const have = () => cfg.tv.twitch.logins.includes(u.login);
    const row = el("div", "twhit" + (u.live ? " tson" : ""));
    const av = el("span", "twav"); if (/^https:\/\/static-cdn\.jtvnw\.net\//.test(u.avatar || "")) { const img = el("img"); img.alt = ""; img.loading = "lazy"; img.src = u.avatar; av.append(img); }
    const meta = [u.live ? `● live · ${Number(u.viewers || 0).toLocaleString()} watching` : "offline", u.followers ? `${Intl.NumberFormat(undefined, { notation: "compact" }).format(u.followers)} followers` : ""].filter(Boolean).join(" · ");
    const tx = el("span", "twtx"); tx.append(el("b", null, u.name || u.login), el("span", null, meta));
    const add = el("button", "twadd" + (have() ? " on" : ""), have() ? "✓" : "+"); add.type = "button";
    add.title = have() ? `Take ${u.name || u.login} off your list` : `Add ${u.name || u.login} to Twitch Live`;
    add.addEventListener("click", async () => {
      const L = cfg.tv.twitch.logins;
      cfg.tv.twitch.logins = have() ? L.filter((x) => x !== u.login) : [...L, u.login];
      add.classList.toggle("on", have()); add.textContent = have() ? "✓" : "+";
      toast(have() ? `${u.name || u.login} added to Twitch Live` : `${u.name || u.login} taken off Twitch Live`);
      const fc = ui && ui.twpop.querySelector(".fcount"); if (fc) fc.textContent = `${cfg.tv.twitch.logins.length} on your list`;
      await writeCfg();
      twitchCache.at = 0; twitchTick(); if (state.panel === "src:" + TWITCH_ID) { browse.delete(TWITCH_ID); schedulePanel(); }
    });
    row.append(av, tx, add);
    return row;
  };
  const drawTwResults = (out, r) => {
    if (!r) return out.replaceChildren(el("p", "fnote", "No answer from Twitch. Try again in a moment."));
    if (!r.found || !r.found.length) return out.replaceChildren(el("p", "fnote", r.error ? `Twitch didn’t answer as expected (${r.error}).` : "Nobody by that name."));
    out.replaceChildren(...r.found.map(twHit));
  };
  const openTwSearch = () => {
    if (!ui) return;
    closeFilter(); closeChanMenu();
    const pop = ui.twpop, head = el("h4"); head.append(el("b", null, "Find streamers"), el("span", "fcount", `${cfg.tv.twitch.logins.length} on your list`));
    const q = el("input", "twq"); q.type = "search"; q.placeholder = "Twitch name or link"; q.autocomplete = "off"; q.spellcheck = false; q.value = twsLast.q;
    const out = el("div", "twres");
    q.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); closeTwSearch(); } });
    q.addEventListener("input", () => {
      clearTimeout(twsT);
      const v = q.value.trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, "").replace(/[/?#].*$/, "");
      if (v.length < 2) { twsLast = { q: q.value, r: null }; out.replaceChildren(); return; }
      twsT = setTimeout(async () => {
        const my = ++twsTok; out.replaceChildren(el("p", "fnote", "Searching…"));
        let r = null; try { r = await chrome.runtime.sendMessage({ ytv: "twitchSearch", q: v }); } catch {}
        if (my === twsTok && ui) { twsLast = { q: q.value, r }; drawTwResults(out, r); }
      }, 300);
    });
    pop.dataset.mode = "names";
    pop.replaceChildren(head, q, out);
    if (twsLast.r) drawTwResults(out, twsLast.r);
    pop.hidden = false; ui.twsB.classList.add("open"); wake();
    setTimeout(() => q.focus({ preventScroll: true }), 0);
  };
  const closeTwSearch = () => { if (!ui || !ui.twpop || ui.twpop.hidden) return false; ui.twpop.hidden = true; ui.twsB.classList.remove("open"); wake(); return true; };
  const toggleTwSearch = () => (ui && !ui.twpop.hidden && ui.twpop.dataset.mode === "names" ? closeTwSearch() : openTwSearch());

  // ---- Twitch: browse what's live in a game or category (E on the Twitch tab). Click a stream to watch it, + to add them.
  let twbLast = { q: "", cats: null, game: null, streams: null }, twbTok = 0, twbT = 0;
  const toLiveItem = (x) => ({ id: "tw:" + x.login, tw: true, login: x.login, title: String(x.title || "").slice(0, 200) || `${x.name || x.login} is live`, channel: String(x.name || x.login).slice(0, 60), creator: "",
    len: x.viewers ? `${Intl.NumberFormat(undefined, { notation: "compact" }).format(x.viewers)} watching` : "live", age: String(x.game || "").slice(0, 60),
    viewers: Number(x.viewers) || 0, since: Date.parse(x.since || "") || 0, game: String(x.game || "").slice(0, 60), avatar: /^https:\/\/static-cdn\.jtvnw\.net\//.test(x.avatar || "") ? x.avatar : "",
    thumb: /^https:\/\/static-cdn\.jtvnw\.net\//.test(x.thumb || "") ? x.thumb : "", progress: 0, watched: false });
  const watchStream = (v) => {
    closeTwSearch();
    const col = currentCol();
    if (col && col.twitch) { let i = state.queue.findIndex((x) => x.id === v.id); if (i < 0) { state.queue.splice(state.pos + 1, 0, v); i = state.pos + 1; } return goTo(i); }
    startOnTwitch(v);
  };
  // a picture from Twitch's image server only (anything else: no picture)
  const twPic = (url) => { const safe = String(url || ""); if (!/^https:\/\/static-cdn\.jtvnw\.net\//.test(safe)) return null; const img = el("img"); img.alt = ""; img.loading = "lazy"; img.src = safe; return img; };
  const compact = (n) => Intl.NumberFormat(undefined, { notation: "compact" }).format(n || 0);
  const drawTwBrowse = (out) => {
    const L = twbLast;
    if (L.streams) { // who's live in the game you picked
      const back = el("button", "twback2"); back.type = "button"; back.append(icon("back"), el("span", null, `${L.game}`), el("i", null, L.streams.length ? `${L.streams.length} live` : ""));
      back.addEventListener("click", () => { twbLast = { ...twbLast, game: null, streams: null }; drawTwBrowse(out); });
      const rows = L.streams.map((x) => {
        const v = toLiveItem(x), have = () => cfg.tv.twitch.logins.includes(x.login);
        const row = el("div", "twhit tson twstream"); row.title = `Watch ${x.name || x.login}`;
        const av = el("span", "twav"); const pa = twPic(v.avatar); if (pa) av.append(pa);
        const tx = el("span", "twtx"); tx.append(el("b", null, x.name || x.login), el("span", null, `${compact(x.viewers)} watching · ${String(x.title || "").slice(0, 90)}`));
        const add = el("button", "twadd" + (have() ? " on" : ""), have() ? "✓" : "+"); add.type = "button"; add.title = have() ? "On your list" : `Add ${x.name || x.login} to Twitch Live`;
        add.addEventListener("click", async (e) => { e.stopPropagation(); if (have()) return; cfg.tv.twitch.logins = [...cfg.tv.twitch.logins, x.login]; add.classList.add("on"); add.textContent = "✓"; await writeCfg(); twitchCache.at = 0; twitchTick(); });
        row.addEventListener("click", () => watchStream(v));
        row.append(av, tx, add);
        return row;
      });
      return out.replaceChildren(back, ...(rows.length ? rows : [el("p", "fnote", "Nobody is live in this one right now.")]));
    }
    if (!L.cats) return out.replaceChildren();
    if (!L.cats.length) return out.replaceChildren(el("p", "fnote", L.error ? `Twitch didn’t answer as expected (${L.error}).` : "No game or category by that name."));
    out.replaceChildren(...L.cats.map((g) => {
      const row = el("button", "twcat"); row.type = "button"; row.title = `Who’s live in ${g.title}`;
      const art = el("span", "twart"); const pg = twPic(g.art); if (pg) art.append(pg);
      const tx = el("span", "twtx"); tx.append(el("b", null, g.title), el("span", null, g.viewers ? `${compact(g.viewers)} watching` : ""));
      row.append(art, tx);
      row.addEventListener("click", async () => {
        const my = ++twbTok; out.replaceChildren(el("p", "fnote", `Who’s live in ${g.title}…`));
        let r = null; try { r = await chrome.runtime.sendMessage({ ytv: "twitchGame", name: g.name }); } catch {}
        if (my !== twbTok || !ui) return;
        twbLast = { ...twbLast, game: (r && r.game) || g.title, streams: r && Array.isArray(r.live) ? r.live.filter((x) => x && /^[a-z0-9_]{2,25}$/.test(x.login)) : [] };
        drawTwBrowse(out);
      });
      return row;
    }));
  };
  const openTwBrowse = () => {
    if (!ui) return;
    closeFilter(); closeChanMenu();
    const pop = ui.twpop, head = el("h4"); head.append(el("b", null, "Live on Twitch"), el("span", "fcount", "Shift+E: find streamers"));
    const q = el("input", "twq"); q.type = "search"; q.placeholder = "Game or category"; q.autocomplete = "off"; q.spellcheck = false; q.value = twbLast.q;
    const out = el("div", "twres");
    q.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); closeTwSearch(); } });
    q.addEventListener("input", () => {
      clearTimeout(twbT);
      const v = q.value.trim();
      if (v.length < 2) { twbLast = { q: q.value, cats: null, game: null, streams: null }; out.replaceChildren(); return; }
      twbT = setTimeout(async () => {
        const my = ++twbTok; out.replaceChildren(el("p", "fnote", "Searching…"));
        let r = null; try { r = await chrome.runtime.sendMessage({ ytv: "twitchCategories", q: v }); } catch {}
        if (my !== twbTok || !ui) return;
        twbLast = { q: q.value, cats: r && Array.isArray(r.found) ? r.found : [], error: r ? r.error : "no answer", game: null, streams: null };
        drawTwBrowse(out);
      }, 300);
    });
    pop.dataset.mode = "browse";
    pop.replaceChildren(head, q, out);
    drawTwBrowse(out);
    pop.hidden = false; ui.twsB.classList.add("open"); wake();
    setTimeout(() => q.focus({ preventScroll: true }), 0);
  };
  const toggleTwBrowse = () => (ui && !ui.twpop.hidden && ui.twpop.dataset.mode === "browse" ? closeTwSearch() : openTwBrowse());

  // ---- Settings, opened right over TV (no new tab, so full screen stays as it is). Esc or ✕ closes it.
  const openSettings = (hash = "#channels") => {
    if (!ui) return;
    const w = ui.setFrame;
    if (!w.firstChild) {
      const box = el("div", "setbox"), bar = el("div", "setbar");
      bar.append(el("b", null, "YTV settings"), el("span", null, "Changes apply straight away"), btn("✕", "Close settings (Esc)", () => closeSettings(), "setx"));
      const f = document.createElement("iframe"); f.className = "setf"; f.title = "YTV settings";
      f.src = chrome.runtime.getURL("settings.html" + (/^#[\w-]{0,24}$/.test(hash) ? hash : ""));
      box.append(bar, f); w.append(box);
      w.onclick = (e) => { if (e.target === w) closeSettings(); };
    }
    w.hidden = false; ui.root.classList.add("show-set"); wake();
  };
  const closeSettings = () => {
    if (!ui || !ui.setFrame || ui.setFrame.hidden) return false;
    ui.setFrame.hidden = true; ui.setFrame.replaceChildren(); ui.root.classList.remove("show-set"); wake(); // (the page goes, so it costs nothing while closed)
    return true;
  };

  // ---- Info and Comments (no tabs: their keys or the buttons under the channel name open them)
  const comments = new Map(); // video id -> { list, next, cfg, off, failed, loading }
  // Twitch: the stream's title, LIVE, how long and how many watch; and below it, their past broadcasts to watch here
  const vodCache = new Map(); // login → { at, vods }
  const vodsOf = async (login) => {
    const hit = vodCache.get(login);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.vods;
    let r = null; try { r = await chrome.runtime.sendMessage({ ytv: "twitchVods", login }); } catch {}
    const vods = (r && Array.isArray(r.vods) ? r.vods : []).filter((x) => x && /^\d{1,15}$/.test(x.id)).slice(0, 24);
    vodCache.set(login, { at: Date.now(), vods }); if (vodCache.size > 30) vodCache.delete(vodCache.keys().next().value);
    return vods;
  };
  const hms = (s) => { s = Math.max(0, s | 0); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}` : `${m}:${String(s % 60).padStart(2, "0")}`; };
  const whenAgo = (iso) => { const t = Date.parse(iso); if (!t) return ""; const d = Math.round((Date.now() - t) / 86400000); return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : `${Math.round(d / 30)} month${d < 45 ? "" : "s"} ago`; };
  const renderTwitchInfo = (v) => {
    const box = el("div", "desc twinfo");
    if (v.off) box.append(el("h3", null, v.channel), el("div", "twfacts", "Offline right now"));
    else {
      const live = el("div", "twfacts");
      const pill = el("span", "twpill"); pill.append(el("i"), document.createTextNode("LIVE"));
      live.append(pill, ...iconLine("x", [["clock", v.since ? `for ${liveFor(v.since)}` : ""], ["eye", v.viewers ? `${v.viewers.toLocaleString()} watching` : ""], ["game", v.game || ""]]).querySelectorAll(".fact"));
      box.append(el("h3", null, state.twVod && state.twVod.login === v.login ? `Watching a past broadcast · ${v.channel}` : v.title || ""), live);
      if (state.twVod && state.twVod.login === v.login) { const back = btn("● Back to live", "Back to the live stream", () => playTwitch(v)); back.classList.add("twback"); box.append(back); }
      else if (!(current() && current().login === v.login)) { const go = btn("● Watch live", `Watch ${v.channel} live`, () => { const i = state.queue.findIndex((x) => x.id === v.id); if (currentCol() && currentCol().twitch && i >= 0) goTo(i); else playTwitch(v); }); go.classList.add("twback"); box.append(go); }
    }
    // on your list or not: add them, or take them off (what's playing keeps playing until you switch)
    const onList = () => cfg.tv.twitch.logins.includes(v.login);
    const mb = el("button", "twmine"); mb.type = "button";
    const drawMine = () => { mb.replaceChildren(icon(onList() ? "trash-2" : "plus"), el("span", null, onList() ? `Remove ${v.channel} from Twitch Live` : `Add ${v.channel} to Twitch Live`)); mb.classList.toggle("on", onList()); };
    mb.addEventListener("click", async () => {
      const had = onList();
      cfg.tv.twitch.logins = had ? cfg.tv.twitch.logins.filter((x) => x !== v.login) : [...cfg.tv.twitch.logins, v.login];
      if (had) cfg.tv.twitch.alerts = (cfg.tv.twitch.alerts || []).filter((x) => x !== v.login); // (no go-live notes for someone you took off)
      drawMine(); await writeCfg();
      twitchCache.at = 0; twitchTick(); browse.delete(TWITCH_ID);
    });
    drawMine(); box.append(mb);
    const head = el("div", "twvh", `Past broadcasts${v.off ? "" : " from " + v.channel}`), list = el("div", "twvods");
    list.append(el("p", "muted", "Loading…"));
    box.append(head, list);
    ui.pbody.replaceChildren(box);
    vodsOf(v.login).then((vods) => {
      if (!list.isConnected) return;
      if (!vods.length) { list.replaceChildren(el("p", "muted", "No past broadcasts to watch.")); return; }
      list.replaceChildren(...vods.map((x) => {
        const item = { id: "twv:" + x.id, tw: true, vod: x.id, login: v.login, channel: v.channel, title: x.title || "Past broadcast", thumb: x.thumb, len: hms(x.secs), age: whenAgo(x.at) };
        const row = el("button", "twvod" + (state.twVod && state.twVod.vod === x.id ? " on" : "")); row.type = "button"; row.title = x.title;
        const th = el("span", "vth"); const img = el("img"); img.alt = ""; img.loading = "lazy"; img.addEventListener("error", () => { img.style.visibility = "hidden"; });
        { const v = item; if (/^https:\/\/(static-cdn\.jtvnw\.net|vod-secure\.twitch\.tv|[\w-]+\.cloudfront\.net)\//.test(v.thumb || "")) img.src = v.thumb; } // Twitch's picture servers only
        th.append(img, el("span", "vlen", item.len));
        const tx = el("span", "vtx"); tx.append(el("b", null, item.title), el("span", null, [item.age, x.views ? `${Intl.NumberFormat(undefined, { notation: "compact" }).format(x.views)} views` : ""].filter(Boolean).join(" · ")));
        row.append(th, tx);
        row.addEventListener("click", () => { const base = v.off ? v : current() && current().tw && current().login === v.login ? current() : v; playTwitch(base, item); });
        return row;
      }));
    });
  };
  // a line of facts, each with its small icon (Info)
  const iconLine = (cls, parts) => {
    const d = el("div", cls);
    parts.filter(([, t]) => t).forEach(([k, t], n) => { if (n) d.append(document.createTextNode(" · ")); const sp = el("span", "fact"), ic = el("span", "ico"); ic.append(icon(k)); sp.append(ic, document.createTextNode(t)); d.append(sp); });
    return d;
  };
  // ---- Continue watching: YouTube videos you started and didn't finish, from YTV or YouTube itself (lists show how far
  // you got on its own pictures). Not Twitch. Kept on this computer, the last 200.
  const PART_KEY = "ytv:partial";
  const partial = (() => { const o = lsGet(PART_KEY, {}); return o && typeof o === "object" ? o : {}; })();
  let partT = 0;
  const notePartial = (items) => {
    let changed = false;
    for (const v of items) {
      if (!v || v.tw || !ID_RE.test(v.id) || partial[v.id]) continue;
      const p = Number(v.progress) || 0;
      if (p >= 3 && p < fullPct()) { partial[v.id] = { v: slimV(v), p, at: Date.now() }; changed = true; }
    }
    if (!changed) return;
    const ids = Object.keys(partial); if (ids.length > 200) ids.sort((x, y) => partial[x].at - partial[y].at).slice(0, ids.length - 200).forEach((k) => delete partial[k]);
    clearTimeout(partT); partT = setTimeout(() => lsSet(PART_KEY, partial), 1500);
  };
  const unfinished = () => {
    const by = new Map();
    ghist.list.forEach((e, n) => { if (e && e.v && !e.v.tw) by.set(e.v.id, { v: e.v, colId: e.colId, at: e.at || n }); });
    for (const [id, x] of Object.entries(partial)) if (!by.has(id)) by.set(id, { v: x.v, colId: "", at: x.at, yp: x.p });
    const out = [];
    for (const x of by.values()) {
      const p = Math.max(progressOf(x.v), x.yp || 0), r = resumeOf(x.v.id);
      if (p >= fullPct() || seen.has(x.v.id) && p === 0 && !r) continue; // finished (or YTV doesn't know how far)
      if (p >= 3 || r > 20) out.push({ ...x, p });
    }
    return out.sort((a, b) => b.at - a.at).slice(0, 100);
  };
  // play any YouTube video right here, from where you were in it (it comes in right after what's playing)
  const playHere = (v, pct = 0) => {
    if (!resumeOf(v.id) && pct > 0) { const d = lenSecs(v.len); if (d) resumeAt[v.id] = Math.floor(d * pct / 100); }
    const col = currentCol();
    if (!col || col.twitch) { const ci = chans().findIndex((c) => !c.feed && !c.twitch); if (ci < 0) return; pendingFirst = { v, t: resumeOf(v.id), similar: false }; return tune(ci); }
    let i = state.queue.findIndex((x) => x.id === v.id);
    if (i < 0) { const hist = idsOfHistory(); state.queue.splice(state.pos + 1, 0, { ...v, nx: 1 }); fixHistory(hist); i = state.pos + 1; }
    played.delete(v.id); goTo(i);
  };
  // History rows: newest first, each video once. Continue watching: what you started and didn't finish (not Twitch).
  const contHide = new Set((lsGet("ytv:conthide", []) || []).filter((x) => typeof x === "string"));
  const histItems = () => { const seenIds = new Set(), out = []; for (let i = ghist.list.length - 1; i >= 0; i--) { const v = ghist.list[i].v; if (v && !seenIds.has(v.id)) { seenIds.add(v.id); out.push(v); } } return out; };
  const contItems = () => unfinished().filter((x) => !contHide.has(x.v.id)).map((x) => ({ ...x.v, progress: x.p }));
  const forgetHistory = (id) => {
    const cur = ghist.list[ghist.pos];
    ghist.list = ghist.list.filter((e) => e.v.id !== id);
    ghist.pos = cur ? ghist.list.lastIndexOf(cur) : ghist.list.length - 1;
    if (ghist.pos < 0) ghist.pos = ghist.list.length - 1;
    saveGhist();
  };
  const renderInfo = async () => {
    const v = current();
    state.panelVid = v ? v.id : "";
    if (!v) return ui.pbody.replaceChildren(el("p", "empty", "Nothing playing."));
    if (state.twInfo && state.twInfo.tw) { const w = state.twInfo; return renderTwitchInfo(w); } // an offline streamer you picked
    if (v.tw) return renderTwitchInfo(v);
    const box = el("div", "desc");
    const subsLine = el("div", "subs"); subsLine.hidden = true;
    box.append(el("h3", null, v.title || ""), iconLine("by", [["user", whoOf(v)], ["cal", v.age], ["clock", v.len]]), subsLine);
    ownerOf(v.id).then((o) => { if (!ui || !o || !subsLine.isConnected) return; const parts = [["subs", o.subs], ["eye", o.views]].filter(([, t]) => t); if (parts.length) { subsLine.replaceChildren(...iconLine("subs", parts).childNodes); subsLine.hidden = false; } });
    const body = el("div", null, state.desc[v.id] || "Loading description…");
    box.append(body);
    ui.pbody.replaceChildren(box);
    if (state.desc[v.id] === undefined) {
      const d = await descriptionOf(v.id);
      state.desc[v.id] = d || "This video has no description.";
      const ks = Object.keys(state.desc); if (ks.length > 60) for (const k of ks.slice(0, ks.length - 60)) delete state.desc[k]; // keep the last few only
      if (ui && state.panel === "info" && current() && current().id === v.id) body.textContent = state.desc[v.id];
    }
  };
  const renderComments = () => {
    const v = current();
    state.panelVid = v ? v.id : "";
    if (!v) return ui.pbody.replaceChildren(el("p", "empty", "Nothing playing."));
    if (v.tw) return renderTwitchChatPanel(v); // a stream's chat, YTV style
    const comBox = el("div", "coms");
    ui.pbody.replaceChildren(comBox);
    loadComments(v, comBox);
  };
  const fetchComments = (v) => { // also called quietly after ~10 s of watching so the tab opens ready
    let entry = comments.get(v.id);
    if (entry) return entry;
    entry = { list: [], next: "", loading: true };
    comments.set(v.id, entry);
    entry.p = (async () => {
      try {
        const res = await SW.yt.commentsFor(await watchPage(v.id), null);
        Object.assign(entry, { list: res.comments, next: res.next, cfg: res.cfg, off: !!res.off, failed: !!res.failed, loading: false });
      } catch { Object.assign(entry, { failed: true, loading: false }); }
      entry.p = null;
      if (comments.size > 20) comments.delete(comments.keys().next().value);
    })();
    return entry;
  };
  const loadComments = async (v, boxEl) => {
    let entry = comments.get(v.id);
    const draw = () => {
      if (!ui || state.panel !== "comments" || !current() || current().id !== v.id || !boxEl.isConnected) return;
      const parts = [];
      if (!entry || (entry.loading && !entry.list.length)) parts.push(el("p", "muted", "Loading comments…"));
      else if (entry.off) parts.push(el("p", "muted", "Comments are turned off for this video."));
      else if (!entry.list.length) parts.push(el("p", "muted", entry.failed ? "YouTube didn’t send the comments. Try again in a moment." : "No comments yet."));
      for (const c of entry ? entry.list : []) {
        const item = el("div", "com");
        const head = el("div", "ch");
        head.append(el("b", null, c.author || "Someone"), el("span", null, [c.age, c.likes && `👍 ${c.likes}`].filter(Boolean).join(" · ")));
        item.append(head, el("div", "ct", c.text));
        parts.push(item);
      }
      if (entry && entry.next && !entry.off) {
        const more = btn(entry.loading ? "Loading…" : "Load more comments", "Load more comments", () => loadMore());
        more.disabled = !!entry.loading;
        parts.push(more);
      }
      boxEl.replaceChildren(...parts);
    };
    const loadMore = async () => {
      if (!entry || entry.loading) return;
      entry.loading = true; draw();
      const res = await SW.yt.commentsFor("", entry);
      entry.loading = false;
      entry.list.push(...res.comments); entry.next = res.next; entry.failed = !!res.failed && !entry.list.length;
      draw();
    };
    if (entry && entry.failed && !entry.list.length && !entry.loading) { comments.delete(v.id); entry = null; } // opening the tab again retries
    if (!entry) { fetchComments(v); entry = comments.get(v.id); }
    draw();
    if (entry.p) { await entry.p; draw(); }
  };

  // ---- tabs: Feed · channels you pinned · the channel you're looking at (▾ picks any) · topics you're exploring · +
  // An underline slides to the selected tab; a red dot marks what's playing.
  // The main tab is the channel that's playing (or, while your Feed plays, the last one that did); its ▾ lists every
  // channel. A channel you open from there gets its own tab, on the far right, with a ✕ to close it.
  const mainChan = () => {
    const pl = chanById(state.colId);
    const ownTab = pl && (pinned().includes(pl.id) || (state.openChans || []).includes(pl.id));
    if (!cfg.tv.chanMenu) return pl && !pl.feed && !ownTab ? pl : null; // no ▾ tab: just the channel that's on, when it has no tab of its own
    if (ownTab) { // it plays in its own tab: the ▾ tab stays as it was, so no tab jumps
      const lm = chanById(state.lastMain);
      if (lm && lm.id !== pl.id && !lm.feed) return lm;
      const other = chans().find((c) => !c.feed && c.id !== pl.id && !pinned().includes(c.id) && !(state.openChans || []).includes(c.id));
      if (other) { state.lastMain = other.id; return other; }
    }
    if (pl && !pl.feed) { state.lastMain = pl.id; return pl; }
    return chanById(state.lastMain) || chans().find((c) => !c.feed);
  };
  const pinned = () => (cfg ? cfg.tv.pins : []).filter((id) => id !== FEED_ID && chanById(id));
  let tabsSig = "";
  const tabSeq = [].concat(lsGet("ytv:tabseq", [])).filter((k) => typeof k === "string").slice(0, 40); // the order of the tabs: as opened, or as you dragged them
  const moveIndicator = () => {
    if (!ui) return;
    const sel = ui.ptabs.querySelector('.tab[aria-selected="true"]'), ind = ui.tabInd;
    if (!sel) { ind.style.opacity = "0"; return; }
    ind.style.opacity = "1";
    ind.style.width = sel.offsetWidth + "px";
    ind.style.transform = `translateX(${sel.offsetLeft}px)`;
    const box = ui.ptabs, l = sel.offsetLeft, r = l + sel.offsetWidth;
    if (l < box.scrollLeft || r > box.scrollLeft + box.clientWidth) box.scrollTo({ left: l - 24, behavior: motionOn() ? "smooth" : "auto" });
  };
  const setPins = async (ids) => { cfg.tv.pins = ids.slice(0, 8); tabsSig = ""; renderTabs(); await writeCfg(); };
  const closeXtab = (xid) => {
    state.xtabs = (state.xtabs || []).filter((x) => x.id !== xid);
    if (state.panel === "x:" + xid) state.panel = playingTab();
    saveSession(); tabsSig = ""; renderPanel(true);
  };
  const openChan = (id) => { // a channel gets a tab of its own (unless it has one already)
    const m = mainChan();
    if (!id || id === FEED_ID || (m && m.id === id) || pinned().includes(id)) return;
    state.openChans = [...(state.openChans || []).filter((x) => x !== id), id];
  };
  const closeTab = (id) => { // a ✕: the tab goes; if you were on it, you're back on what's playing
    state.openChans = (state.openChans || []).filter((x) => x !== id);
    if (state.panel === "src:" + id) state.panel = playingTab();
    tabsSig = ""; if (isListTab(state.panel)) renderPanel(true); else renderTabs();
  };
  // Drag a tab sideways to move it: the others make room as you go, and the order is kept.
  const tabDrag = (b, e) => {
    if (e.button !== 0 || !b.dataset.k || b.classList.contains("add") || !b.classList.contains("pin") && !b.classList.contains("xtab")) return;
    const kind = b.dataset.k.startsWith("src:") ? "src" : "x"; // channels move among channels, topics among topics
    const others = () => [...ui.ptabs.querySelectorAll(".tab.pin, .tab.xtab")].filter((t) => (t.dataset.k.startsWith("src:") ? "src" : "x") === kind);
    const x0 = e.clientX, zoom = (cfg.tv.uiScale || 100) / 100;
    let on = false, target = -1;
    const move = (ev) => {
      const dx = (ev.clientX - x0) / zoom;
      if (!on) { if (Math.abs(dx) < 6) return; on = true; b.classList.add("tdrag"); try { b.setPointerCapture(e.pointerId); } catch {} }
      b.style.transform = `translateX(${dx}px)`;
      const list = others(), mid = b.getBoundingClientRect().left + b.getBoundingClientRect().width / 2;
      const from = list.indexOf(b); target = from;
      list.forEach((t, i) => {
        if (t === b) return;
        const r = t.getBoundingClientRect(), c = r.left + r.width / 2, w = b.getBoundingClientRect().width;
        let shift = 0;
        if (i > from && mid > c) { shift = -w; target = Math.max(target, i); }
        if (i < from && mid < c) { shift = w; target = Math.min(target, i); }
        t.classList.add("tshift"); t.style.transform = shift ? `translateX(${shift / zoom}px)` : "";
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true); window.removeEventListener("pointercancel", up, true);
      if (!on) return;
      b._dragged = true; setTimeout(() => { b._dragged = false; }, 0);
      const list = others(), from = list.indexOf(b);
      for (const t of list) { t.classList.remove("tshift", "tdrag"); t.style.transform = ""; }
      if (target >= 0 && target !== from) {
        const keys = list.map((t) => t.dataset.k), [k] = keys.splice(from, 1); keys.splice(target, 0, k);
        for (const kk of keys) { const i = tabSeq.indexOf(kk); if (i >= 0) tabSeq.splice(i, 1); }
        tabSeq.push(...keys); lsSet("ytv:tabseq", tabSeq);
        // channel tabs: their new order becomes the channels' order (the numbers follow, as when you drag in the overview)
        const moved = keys.filter((kk) => kk.startsWith("src:")).map((kk) => kk.slice(4));
        const all = SW.tvOrder(cfg.tv), slots = all.map((id, i) => (moved.includes(id) ? i : -1)).filter((i) => i >= 0);
        if (moved.length > 1 && slots.length === moved.length) { slots.forEach((slot, n) => { all[slot] = moved[n]; }); cfg.tv.order = all; dropChans(); writeCfg(); }
        tabsSig = ""; renderTabs();
      }
    };
    window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", up, true); window.addEventListener("pointercancel", up, true);
  };
  const renderTabs = () => {
    if (!ui || !cfg) return;
    const main = mainChan(), pins = pinned().filter((id) => !main || id !== main.id), n = feedLen(), kind = tabKind(state.panel);
    state.openChans = (state.openChans || []).filter((id) => chanById(id) && !pins.includes(id) && (!main || id !== main.id));
    ui.clearB.hidden = state.panel !== FEED_TAB || !n;
    ui.refB.hidden = !canPull(kind);
    ui.twsB.hidden = state.panel !== "src:" + TWITCH_ID;
    if (ui.twsB.hidden) closeTwSearch();
    updateFilterUi();
    const sig = [state.panel, state.colId, !!state.stay, n, state.stay ? state.stay.query : "", (state.xtabs || []).map((x) => x.id + x.query).join(","),
      pins.join(","), state.openChans.join(","), main ? main.id + main.name : "", chans().map((c) => c.name).join(","), state.bump ? 1 : 0].join("~");
    if (sig !== tabsSig) {
      tabsSig = sig;
      const mk = (id, title, parts, cls = "tab") => {
        const b = el("button", cls); b.type = "button"; b.title = title;
        b.dataset.k = id === "explore" || id.startsWith("x:") ? "q:" + (id === "explore" ? state.stay.query : (xtabOf(id) || {}).query) : id;
        b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(state.panel === id));
        b.append(...parts);
        // a middle click closes a tab that can close (Settings → Swiping & lists)
        b.addEventListener("mousedown", (e) => { if (e.button === 1 && cfg.tv.tabMiddleClose) e.preventDefault(); }); // no auto-scroll
        b.addEventListener("auxclick", (e) => { if (e.button === 1 && cfg.tv.tabMiddleClose && b._close) { e.preventDefault(); e.stopPropagation(); b._close(); } });
        b.addEventListener("pointerdown", (e) => tabDrag(b, e));
        b.addEventListener("click", (e) => {
          if (b._dragged) { b._dragged = false; return; } // that was a drag, not a click
          if (b.classList.contains("chtab") && cfg.tv.chanMenu && state.panel === id) return toggleChanMenu(b, "view"); // the selected main tab opens the channel list
          closeChanMenu(); showPanel(id); if (e.detail > 0) b.blur();
        });
        return b;
      };
      const closable = (b, fn) => { b._close = fn; return b; };
      const x = (title, fn) => { const s = el("span", "tx"); s.append(icon("x")); s.title = title; s.setAttribute("role", "button"); s.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); return s; };
      const live = (id) => (id === state.colId && !state.stay ? [el("span", "live")] : []);
      const cnt = el("span", "cnt" + (state.bump ? " bump" : ""), String(n));
      state.bump = false;
      const ti = (id, name) => (cfg.tv.tabIcons && CHAN_ICON[id] ? [chanIcon(id, "tico"), el("span", "tl sr", name)] : [el("span", "tl", name)]); // icon tabs keep their name for the tooltip and screen readers
      const feed = mk(FEED_TAB, `${nameOf(FEED_ID)}: your own list`, [...(onFeed() && !state.stay ? [el("span", "live")] : []), ...ti(FEED_ID, nameOf(FEED_ID))]); void cnt;

      const first = [];
      if (main) {
        const car = el("span", "car"); car.append(icon("chevron"));
        car.addEventListener("click", (e) => { e.stopPropagation(); toggleChanMenu(car.parentNode, "view"); });
        first.push(cfg.tv.chanMenu ? mk("src:" + main.id, `${main.num}  ${main.name} — ▾ opens another channel`, [...live(main.id), ...ti(main.id, main.name), car], "tab chtab")
          : mk("src:" + main.id, `${main.num}  ${main.name}`, [...live(main.id), ...ti(main.id, main.name)], "tab"));
      }
      const rest = [];
      for (const id of pins) {
        const c = chanById(id);
        const close = () => { setPins(cfg.tv.pins.filter((p) => p !== id)); closeTab(id); };
        rest.push(closable(mk("src:" + id, `${c.num}  ${c.name}`, [...live(id), ...ti(id, c.name), x(`Close ${c.name}`, close)], "tab pin"), close));
      }
      for (const id of state.openChans) {
        const c = chanById(id);
        rest.push(closable(mk("src:" + id, `${c.num}  ${c.name}`, [...live(id), ...ti(id, c.name), x(`Close ${c.name}`, () => closeTab(id))], "tab pin"), () => closeTab(id)));
      }
      const xtab = (id, q, isLive, close, title) => { const s = icon("search"); s.classList.add("si"); return closable(mk(id, title, [...(isLive ? [el("span", "live")] : []), s, el("span", "tl", q), x("Close this topic", close)], "tab xtab"), close); };
      if (state.stay) rest.push(xtab("explore", String(state.stay.query || "").slice(0, 40), true, () => endTopic(), `Exploring “${state.stay.query}” (playing)`));
      for (const t of state.xtabs || []) rest.push(xtab("x:" + t.id, String(t.query).slice(0, 40), false, () => closeXtab(t.id), `“${t.query}”: pick a video to carry on exploring it`));
      const plus = el("button", "tab add"); plus.type = "button"; plus.title = "Pin a channel as a tab"; plus.append(icon("plus"));
      plus.addEventListener("click", (e) => { e.stopPropagation(); toggleChanMenu(plus, "pin"); });
      // the other tabs keep the order you opened them in: a new one always appears on the far right
      const keyOf = (b) => b.dataset.k, present = new Set(rest.map(keyOf));
      for (let k = tabSeq.length - 1; k >= 0; k--) if (!present.has(tabSeq[k])) tabSeq.splice(k, 1); // closed tabs forget their place
      for (const b of rest) if (!tabSeq.includes(keyOf(b))) tabSeq.push(keyOf(b));
      lsSet("ytv:tabseq", tabSeq);
      // channels in their channel order (as in the overview, G); topics after them, in the order you opened them
      const num = (b) => { const k = keyOf(b); if (!k.startsWith("src:")) return Infinity; const c = chanById(k.slice(4)); return c ? c.num : Infinity; };
      const chTabs = [...first, ...rest.filter((b) => keyOf(b).startsWith("src:"))].sort((a, b) => num(a) - num(b));
      const topics = rest.filter((b) => !keyOf(b).startsWith("src:")).sort((a, b) => tabSeq.indexOf(keyOf(a)) - tabSeq.indexOf(keyOf(b)));
      ui.ptabs.replaceChildren(feed, ...chTabs, ...topics, plus, ui.tabInd);
    }
    requestAnimationFrame(moveIndicator);
  };
  // The ▾ list of channels: look at one's videos here without changing what's playing. From the +, it pins one as a tab.
  const closeChanMenu = () => { if (ui && ui.chmenu.classList.contains("on")) { ui.chmenu.classList.remove("on"); setTimeout(() => ui && !ui.chmenu.classList.contains("on") && (ui.chmenu.hidden = true), 160); } };
  const toggleChanMenu = (anchor, mode) => {
    const m = ui.chmenu;
    if (m.classList.contains("on") && m.dataset.mode === mode) return closeChanMenu();
    m.dataset.mode = mode;
    const pins = cfg.tv.pins;
    const items = chans().filter((c) => !c.feed).map((c) => {
      const isPin = pins.includes(c.id);
      const b = el("button", "cm" + (mode === "view" && "src:" + c.id === state.panel ? " sel" : "") + (mode === "pin" && isPin ? " sel" : "")); b.type = "button";
      b.append(el("span", "n", String(c.num)), ...(CHAN_ICON[c.id] ? [chanIcon(c.id, "cmi")] : []), el("span", "nm", c.name), ...(c.id === state.colId ? [el("span", "live")] : []), ...(mode === "pin" ? [el("span", "ck", isPin ? "✓" : "")] : []));
      b.addEventListener("click", () => {
        if (mode === "pin") { closeChanMenu(); setPins(isPin ? pins.filter((p) => p !== c.id) : [...pins, c.id]); if (!isPin) showPanel("src:" + c.id); return; }
        closeChanMenu(); openChan(c.id); showPanel("src:" + c.id);
      });
      return b;
    });
    const head = el("div", "mh", mode === "pin" ? "Pin a channel as a tab" : "Look at a channel");
    const ov = el("button", "cm more"); ov.type = "button"; ov.append(el("span", "n", "▦"), el("span", "nm", "Channel overview"));
    ov.addEventListener("click", () => { closeChanMenu(); showGuide(true); });
    m.replaceChildren(head, ...items, el("div", "sep"), ov);
    const r = anchor.getBoundingClientRect(), pr = ui.root.querySelector(".panel").getBoundingClientRect();
    m.style.left = `${Math.max(8, Math.min(r.left - pr.left, pr.width - 258))}px`; m.style.top = `${r.bottom - pr.top + 6}px`;
    m.hidden = false; void m.offsetWidth; m.classList.add("on");
    const sel = m.querySelector(".cm.sel") || m.querySelector(".cm"); sel && sel.focus();
  };
  // A video in another channel's tab: play it there and carry on with that channel.
  const stayInChannel = (c, v) => {
    if (!c) return;
    const idx = chans().findIndex((x) => x.id === c.id);
    if (idx < 0) return;
    if (c.id === state.colId) {
      if (state.stay) return playFromMain(v);
      removed.delete(v.id); played.delete(v.id);
      const at = state.queue.findIndex((x) => x.id === v.id);
      if (at >= 0) return jumpTo(at);
      state.queue.splice(state.pos + 1, 0, { ...v });
      return goTo(state.pos + 1);
    }
    pendingFirst = { v, t: v.tw ? 0 : resumeOf(v.id), similar: false }; // (where you were in it, if you watched some before)
    const seen = browse.get(c.id);
    pendingLineup = seen && seen.items.length ? { id: c.id, items: seen.items.slice() } : null;
    tune(idx);
  };
  // A video in your Feed while something else plays: the Feed starts with it.
  const playFeedFrom = (v) => {
    feedStore = [v, ...feedStore.filter((x) => x.id !== v.id)];
    writeFeed();
    delete state.mem[FEED_ID];
    tune(0);
  };
  // From the list you left behind: pick a video there and the topic closes, then it plays.
  const playFromMain = (v) => {
    state.pickedId = v && v.id;
    if (!state.stay) return;
    state.from = null;
    state.base = [v, ...(state.base || []).filter((x) => x.id !== v.id)];
    backToMix();
  };
  const renderPanel = (fresh = false) => {
    if (!ui) return;
    const p = state.panel || "";
    renderTabs();
    if (p === "info") return renderInfo();
    if (p === "comments") return renderComments();
    if (isListTab(p)) { setupBody(); drawList(p, fresh); }
  };
  // Lists redraw at most once per frame, however many changes come in.
  let panelRaf = 0;
  const schedulePanel = () => {
    if (!ui || panelRaf) return;
    panelRaf = requestAnimationFrame(() => {
      panelRaf = 0;
      if (!ui) return;
      try { if (isListTab(state.panel)) renderPanel(false); else renderTabs(); } catch (err) { logErr("list", err); } // (one bad row never breaks the list for good)
      });
  };
  const refreshList = () => schedulePanel();
  const showPanel = (which) => {
    if (!ui) return;
    which = which || "";
    if (which !== "info") state.twInfo = null; // (an offline streamer's page is only for that one visit)
    ui.root.classList.toggle("panchat", which === "comments" && ui.root.classList.contains("on-twitch")); // the chat in the panel: the panel itself see-through
    if (ui.root.classList.contains("on-twitch")) setTimeout(() => { if (!ui) return; if (which !== "comments" && !cfg.tv.twitch.chat.show) stopChat(); chatBox(); }, 0); // one chat at a time; none showing: no chat connection at all
    if (which === "explore" && !state.stay) which = playingTab();
    if (which.startsWith("src:") && !chanById(which.slice(4))) which = playingTab();
    if (which.startsWith("src:")) openChan(which.slice(4)); // any channel you look at has a tab (on the right)
    const changed = which !== state.panel;
    if (!which || !state.panel) state.edgeOpened = false; // opened with a key or a click: it stays until you close it
    closeChanMenu();
    state.panel = which;
    const pnl = ui.root.querySelector(".panel"), was = ui.root.classList.contains("show-panel");
    if (was && !which && motionOn()) { pnl.classList.add("closing"); clearTimeout(pnl._ct); pnl._ct = setTimeout(() => pnl.classList.remove("closing"), 220); }
    else if (which) pnl.classList.remove("closing");
    ui.root.classList.toggle("show-panel", !!which);
    ui.infoB.setAttribute("aria-pressed", String(which === "info"));
    ui.comB.setAttribute("aria-pressed", String(which === "comments"));
    ui.histPB.setAttribute("aria-pressed", String(which === "history"));
    lsSet("ytv:lastpanel", which && which !== "explore" && !which.startsWith("x:") ? which : ""); // opened again like this next time
    if (which) renderPanel(changed); else renderTabs();
    wake();
  };
  let lastListTab = "";
  const PAGES = new Set(["info", "comments", HIST_TAB]);
  const togglePanel = (which) => {
    if (state.panel !== which) { // from the list (or from nothing): remember that, so the same key brings you back there
      if (!PAGES.has(state.panel)) lastListTab = isListTab(state.panel) ? state.panel : "";
      return showPanel(which);
    }
    showPanel(lastListTab && isListTab(lastListTab) ? lastListTab : ""); // pressed again: the list you were on, or no panel at all
  };
  // the panel hid by itself (the mouse went away) while Info, Comments or History was open: it comes back as the list
  const pageHidden = () => { if (ui && PAGES.has(state.panel) && ui.root.classList.contains("fade")) showPanel(lastListTab && isListTab(lastListTab) ? lastListTab : playingTab()); };
  // The list key: opens the tab of what's playing (or closes the panel).
  const toggleList = () => showPanel(isListTab(state.panel) ? "" : playingTab());

  // ---------------------------------------------------------------- channel overview (guide)
  // A card per channel: what's on now and next. Drag cards to put the channels in your order (the numbers follow),
  // double-click a name (or use the pencil) to rename it, and make a new channel from the last card.
  // Previews are kept for a while, so the pictures don't change every time you open it.
  const previews = new Map(); // channel id -> { at, items }
  const PREV_MS = 10 * 60 * 1000;
  const previewOf = async (c, fetchIt) => {
    if (c.id === state.colId && state.queue.length) return state.queue.slice(state.pos, state.pos + 4);
    if (c.feed) return feedStore.slice(0, 4);
    const m = state.mem[c.id];
    if (m && m.queue.length) return m.queue.slice(m.pos, m.pos + 4);
    const hit = previews.get(c.id);
    if (hit && Date.now() - hit.at < PREV_MS) return hit.items;
    const b = browse.get(c.id);
    if (b && b.items.length) return b.items.slice(0, 4);
    if (!c.watchLater && !c.subs && !c.homeFeed && !c.watchedChip && !c.cont) {
      try {
        const k = cacheKey(c), got = (await chrome.storage.local.get(k))[k];
        if (got && Array.isArray(got.items) && got.items.length) { const items = got.items.filter((v) => usable(c, v)).slice(0, 4); previews.set(c.id, { at: Date.now(), items }); return items; }
      } catch {}
    }
    if (!fetchIt) return undefined;
    let items = [];
    try {
      if (c.watchLater) { const wl = await SW.yt.watchLater(); state.wlCtx = wl.ctx || state.wlCtx; items = wl.videos.filter((v) => usable(c, v)); } // playlist order: the same picture every time
      else items = await buildLineup(c, () => {}, () => {});
    } catch {}
    items = items.slice(0, 4);
    previews.set(c.id, { at: Date.now(), items });
    return items;
  };
  const fillCard = (card, c, items) => {
    const body = card.querySelector(".cb");
    const key = items === null ? "home" : items === undefined ? "?" : items.map((v) => v.id).join(",");
    if (card.dataset.shows === key) return; // nothing changed: leave the picture alone
    card.dataset.shows = key;
    if (items === null) { body.replaceChildren(el("div", "nx", "Random videos from your home page")); return; }
    if (items === undefined) { body.replaceChildren(el("div", "nx", "Tuning in…")); return; }
    if (!items.length) { body.replaceChildren(el("div", "nx", c.feed ? "Empty — swipe videos right in any channel to add them" : "Nothing on right now")); return; }
    const [now, ...next] = items;
    const img = el("img"); img.alt = ""; img.loading = "lazy"; img.decoding = "async";
    img.addEventListener("error", () => { img.style.visibility = "hidden"; });
    img.src = `https://i.ytimg.com/vi/${now.id}/mqdefault.jpg`;
    const t = el("div", "nt"); t.append(el("span", "lbl", "Now "), document.createTextNode(now.title || "Video"));
    // poster wall: what's on now big, then the next ones as a strip of small pictures (their titles on hover)
    const pic = (v, cls) => { const i = el("img", cls); i.alt = ""; i.loading = "lazy"; i.decoding = "async"; i.addEventListener("error", () => { i.style.visibility = "hidden"; }); i.src = v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`; return i; };
    { const v = now; if (v.thumb) img.src = v.thumb; } // Twitch previews (from Twitch's own image server)
    const strip = el("div", "strip");
    for (const x of next.slice(0, 3)) { const p = pic(x, "sm"); p.title = "Next: " + (x.title || "Video"); strip.append(p); }
    // what's next as text too (the classic cards and the TV guide show it; the poster wall shows the strip)
    const nxl = el("div", "nxl");
    for (const x of next.slice(0, 2)) { const n = el("div", "nx"); n.append(el("span", "lbl", "Next "), document.createTextNode(x.title || "Video")); nxl.append(n); }
    const tx = el("div", "ntx"); tx.append(t, el("div", "nw", metaOf(now)), nxl);
    // the TV guide: the next few side by side, each a small picture with its title
    const nxv = el("div", "nxv");
    for (const x of next.slice(0, 3)) { const b = el("div", "nv"); const tt = el("div", "nvt"); tt.append(el("span", "lbl", "Next "), document.createTextNode(x.title || "Video")); b.append(pic(x, "nvp"), tt); nxv.append(b); }
    body.replaceChildren(img, tx, ...(strip.childNodes.length ? [strip] : []), ...(nxv.childNodes.length ? [nxv] : []));
  };
  const renameChannel = async (id, name) => {
    name = String(name || "").replace(/\s+/g, " ").trim().slice(0, 40);
    if (!name || !cfg) return;
    const real = collections().find((c) => c.id === id);
    if (real) real.name = name;
    else if (SW.TV_BUILTIN_NAMES[id]) cfg.tv.names = { ...cfg.tv.names, [id]: name };
    dropChans(); tabsSig = "";
    await writeCfg();
    if (ui) { showNow(); renderTabs(); }
  };
  const setOrder = async (ids) => { cfg.tv.order = ids; dropChans(); tabsSig = ""; await writeCfg(); if (ui) renderTabs(); };
  // A new channel from a name and a few topics or @creators (comma separated).
  const newChannel = async (name, what) => {
    if (!cfg || collections().length >= SW.MAX_CHANNELS) return null;
    const parts = String(what || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
    const channels = [], subjects = [];
    for (const p of parts) {
      const cr = /^@|youtube\.com\/|^channel\//i.test(p) ? SW.normalizeCreator(p) : "";
      if (cr) channels.push(cr); else subjects.push(p.slice(0, 80));
    }
    let n = collections().length + 1, id;
    do { id = "c" + n++; } while (collections().some((c) => c.id === id));
    cfg.tv.collections.push({ id, name: (String(name || "").trim() || subjects[0] || "New channel").slice(0, 40), subjects: subjects.slice(0, 30), channels: channels.slice(0, 40), blocked: [], home: false, skipSeen: true, maxAge: "any", num: 999 });
    cfg.tv.order = SW.tvOrder(cfg.tv);
    dropChans(); tabsSig = "";
    await writeCfg();
    return id;
  };
  let guideToken = 0;
  const renderGuide = () => {
    const my = ++guideToken;
    const list = el("div", "cards");
    const all = chans();
    let dragId = null;
    const clearDrop = () => { for (const n of list.querySelectorAll(".drop-before,.drop-after")) n.classList.remove("drop-before", "drop-after"); };
    const startRename = (nm, card, c) => {
      if (nm.isContentEditable) return;
      const was = nm.textContent;
      nm.contentEditable = "true"; card.draggable = false;
      nm.focus();
      const r = document.createRange(); r.selectNodeContents(nm);
      const sel = ui.root.getRootNode().getSelection ? ui.root.getRootNode().getSelection() : getSelection();
      try { sel.removeAllRanges(); sel.addRange(r); } catch {}
      const done = (keep) => {
        nm.removeEventListener("keydown", onKey); nm.removeEventListener("blur", onBlur);
        nm.contentEditable = "false"; card.draggable = !c.feed;
        const v = nm.textContent.replace(/\s+/g, " ").trim().slice(0, 40);
        if (!keep || !v || v === was) { nm.textContent = was; return; }
        nm.textContent = v;
        renameChannel(c.id, v);
      };
      const onKey = (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.preventDefault(); done(false); } };
      const onBlur = () => done(true);
      nm.addEventListener("keydown", onKey); nm.addEventListener("blur", onBlur);
    };
    const cards = all.map((c, i) => {
      const card = el("div", "card" + (c.id === state.colId ? " on" : ""));
      card.style.animationDelay = `${Math.min(i, 16) * 22}ms`;
      card.tabIndex = 0; card.setAttribute("role", "button"); card.dataset.id = c.id;
      const head = el("div", "chd"), nm = el("span", "nm", c.name);
      head.append(el("span", "n", String(c.num)), nm, ...(c.id === state.colId ? [el("span", "live", "● On now")] : []),
        iconBtn("pencil", `Rename ${c.name}`, () => startRename(nm, card, c), "ren"),
        ...(c.feed ? [] : [(() => {
          const on = () => cfg.tv.pins.includes(c.id);
          const b = iconBtn(on() ? "check" : "plus", on() ? `${c.name} is a tab — click to unpin` : `Pin ${c.name} as a tab`, async () => {
            await setPins(on() ? cfg.tv.pins.filter((p) => p !== c.id) : [...cfg.tv.pins, c.id]);
            b.replaceChildren(icon(on() ? "check" : "plus")); b.classList.toggle("on", on()); b.title = on() ? `${c.name} is a tab — click to unpin` : `Pin ${c.name} as a tab`;
            toast(on() ? `${c.name} is now a tab` : `${c.name} isn’t a tab any more`);
          }, "pinb" + (on() ? " on" : ""));
          return b;
        })()]));
      const src = c.feed ? "Your own list — fill it from any channel" : c.watchLater ? "Your Watch Later list" : c.cont ? "What you started and didn’t finish" : c.subs ? "Newest from your subscriptions" : c.watchedChip ? "Videos you watched before" : c.homeFeed ? (c.shuffle ? "Your home feed, shuffled" : "Your home feed")
        : [c.subjects.length && `${c.subjects.length} topic${c.subjects.length > 1 ? "s" : ""}`, c.channels.length && `${c.channels.length} creator${c.channels.length > 1 ? "s" : ""}`, c.home && "home feed"].filter(Boolean).join(" · ") || "Empty — add topics in settings";
      card.append(head, el("div", "cb"), el("div", "cs", src));
      const watch = () => { showGuide(false); tune(i); };
      // a click on the name waits a moment in case it's a double-click (rename); anywhere else tunes in right away
      let clickT = 0;
      card.addEventListener("click", (e) => {
        if (nm.isContentEditable) return;
        if (nm.contains(e.target) && e.detail === 1) { clearTimeout(clickT); clickT = setTimeout(watch, 260); return; }
        if (e.detail <= 1) watch();
      });
      card.addEventListener("keydown", (e) => { if (e.target === card && e.key === "Enter") watch(); if (e.target === card && e.key === "F2") startRename(nm, card, c); });
      nm.addEventListener("dblclick", (e) => { e.stopPropagation(); clearTimeout(clickT); startRename(nm, card, c); });
      nm.addEventListener("click", (e) => { if (nm.isContentEditable) e.stopPropagation(); });
      if (!c.feed) { // Feed is always channel 0; everything else can move
        card.draggable = true;
        card.addEventListener("dragstart", (e) => { dragId = c.id; card.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; try { e.dataTransfer.setData("text/plain", c.id); } catch {} });
        card.addEventListener("dragend", () => { card.classList.remove("dragging"); clearDrop(); dragId = null; });
        card.addEventListener("dragover", (e) => {
          if (!dragId || dragId === c.id) return;
          e.preventDefault(); e.dataTransfer.dropEffect = "move";
          const r = card.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
          clearDrop(); card.classList.add(after ? "drop-after" : "drop-before");
        });
        card.addEventListener("drop", async (e) => {
          if (!dragId || dragId === c.id) return;
          e.preventDefault();
          const after = card.classList.contains("drop-after"), from = dragId;
          dragId = null; clearDrop();
          const ids = all.filter((x) => !x.feed).map((x) => x.id).filter((x) => x !== from);
          ids.splice(ids.indexOf(c.id) + (after ? 1 : 0), 0, from);
          await setOrder(ids);
          renderGuide();
        });
      }
      list.append(card);
      return { card, c };
    });
    // make a channel right here
    const nc = el("div", "newc");
    const nmIn = el("input"); nmIn.type = "text"; nmIn.maxLength = 40; nmIn.placeholder = "Name"; nmIn.setAttribute("aria-label", "New channel name");
    const what = el("input"); what.type = "text"; what.maxLength = 400; what.placeholder = "Topics or @creators, comma separated"; what.setAttribute("aria-label", "Topics or creators");
    const note = el("div", "hint", "e.g. “dashcam, rally, @veritasium”. Fine-tune it later in settings.");
    const make = btn("Create", "Create this channel", async () => {
      if (!nmIn.value.trim() && !what.value.trim()) { nmIn.focus(); return; }
      const id = await newChannel(nmIn.value, what.value);
      if (!id) { note.textContent = `That’s the most channels YTV can have (${SW.MAX_CHANNELS}).`; return; }
      renderGuide();
      const card = ui.guide.querySelector(`.card[data-id="${id}"]`);
      if (card) { card.scrollIntoView({ block: "center" }); card.focus(); }
    }, "acc");
    for (const inp of [nmIn, what]) inp.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); make.click(); } if (e.key === "Escape") { e.preventDefault(); inp.blur(); } });
    const mrow = el("div", "row"); mrow.append(make);
    nc.append(el("b", null, "＋ New channel"), nmIn, what, note, mrow);
    list.append(nc);
    const gtop = el("div", "gtop");
    gtop.append(btn("＋ Add links to Watch Later", "Paste video links (one per line) to add them to your Watch Later list", () => openBulkAdd()),
      btn("⚙ Settings", "Open YTV settings", () => openSettings("#channels")),
      btn("✕ Close", "Close the overview", () => (!state.colId ? closeTv() : showGuide(false))));
    const help = cfg.tv.keysOn
      ? SW.TV_ACTIONS.filter(([id]) => keyOf(id)).map(([id, label]) => `${keyName(id)} ${label.toLowerCase()}`).join(" · ") + " · Shift with the tab keys: go there and play · Shift+E search YouTube · Shift+[ and Shift+] back and forth through everything you watched · Cmd+Z undo · Esc close"
      : "Keyboard shortcuts are off (turn them on in settings). Esc closes / turns TV off.";
    ui.guide.className = "guide gl-" + (cfg.tv.guideLayout || "posters"); // the layout you picked in settings
    ui.guide.replaceChildren(gtop, el("h2", null, "Channels"), el("p", null, "Click a channel to watch it. Drag channels to reorder them — the numbers follow. Double-click a name to rename it."), list, el("div", "keys", help));
    (async () => {
      const missing = [];
      for (const { card, c } of cards) { const items = await previewOf(c, false); if (my !== guideToken) return; fillCard(card, c, items); if (items === undefined) missing.push({ card, c }); }
      for (const { card, c } of missing) { // fill unknown channels one by one (this also makes tuning to them instant)
        if (my !== guideToken || !ui || !ui.root.classList.contains("show-guide")) return;
        const items = await previewOf(c, true);
        if (my !== guideToken) return;
        fillCard(card, c, items);
      }
    })();
  };
  const showGuide = (on) => {
    if (!ui) return;
    if (on) renderGuide();
    const was = ui.root.classList.contains("show-guide");
    ui.root.classList.toggle("show-guide", on);
    if (!on && was && motionOn()) { // fade out softly instead of vanishing
      ui.root.classList.add("guide-out"); clearTimeout(state.guideOutT);
      state.guideOutT = setTimeout(() => ui && ui.root.classList.remove("guide-out"), 220);
    } else if (on) ui.root.classList.remove("guide-out");
    if (on) { const b = ui.guide.querySelector(".card.on, .card"); b && b.focus(); }
    else guideToken++;
  };

  const message = (title, sub) => {
    const box = el("div"); const t = el("b", null, title);
    t.style.cssText = "display:block;font-size:24px;color:#fff;margin-bottom:6px";
    box.append(t, el("div", null, sub));
    ui.msg.replaceChildren(box);
    ui.root.classList.add("show-msg");
  };

  const showNow = () => {
    const c = currentCol(), v = state.twVod || current(); // (a Twitch past broadcast shows its own title)
    if (v && v.title) document.title = `${v.title} - YouTube`; // the browser tab follows the video
    ui.stay.hidden = !state.stay;
    if (state.stay) {
      ui.stayTxt.textContent = state.stay.by ? `Only ${state.stay.query}` : state.stay.mode === "explore" ? `Exploring: ${state.stay.query}` : `Only: ${state.stay.title || "this creator"}`;
      ui.stayBtn.title = `Back to ${c ? c.name : "the mix"}`;
    }
    // the two lines of the top bar, as set up in Settings → Look & feel → Top bar text
    const bit = { title: v && v.title, age: v && v.age, creator: whoOf(v), len: v && v.len, channel: c && c.name };
    const line = (n) => {
      const out = [];
      for (const [f] of cfg.tv.topFields.filter(([, l]) => l === n)) {
        const t = bit[f]; if (!t) continue;
        if (out.length && f !== "channel") out.push(el("span", "sep", " · "));
        if (f === "age" && v && v.tw && v.since) { out.push(bitNode("up", liveFor(v.since), n === 1 ? "age" : "bit", true), el("span", "sep", " · ")); } // how long they've been live, before the game
        out.push(f === "channel" ? el("span", "chn", t) : f === "title" ? document.createTextNode(t) : bitNode(f, t, n === 1 ? "age" : "bit", !!(v && v.tw)));
      }
      return out;
    };
    ui.nT.replaceChildren(...line(1)); ui.nC.replaceChildren(...line(2));
    ui.nT.hidden = !ui.nT.childNodes.length; ui.nC.hidden = !ui.nC.childNodes.length;
    ui.prevB.disabled = !state.history.length;
    refreshCreatorButton();
    if (state.panel === "explore" && !state.stay) state.panel = playingTab(); // the topic was closed
    if (state.panel && isListTab(state.panel)) schedulePanel();
    else if ((state.panel === "info" || state.panel === "comments") && v && state.panelVid !== v.id) renderPanel();
    else renderTabs();
    wake();
  };

  // ---------------------------------------------------------------- playback
  // (the channels you left are remembered, the last 8 of them: the session is saved often, so it stays small)
  const trimMem = () => { const ks = Object.keys(state.mem); if (ks.length > 8) for (const k of ks.sort((a, b) => (state.mem[a].at || 0) - (state.mem[b].at || 0)).slice(0, ks.length - 8)) delete state.mem[k]; };
  const saveSession = () => { syncFeed(); trimMem(); writeSession({ colId: state.colId || "", queue: state.queue.slice(0, 150), pos: state.pos, history: state.history.slice(-50),
    stay: state.stay, base: state.base ? state.base.slice(0, 120) : null, from: state.from, t: state.t, mem: state.mem,
    xtabs: (state.xtabs || []).map((x) => ({ ...x, items: x.items.slice(0, 40) })) }); };
  // Each channel remembers its lineup, the video that was on and where you were in it.
  const MEM_MS = 4 * 3600 * 1000;
  const snapshot = () => ({ queue: state.queue.slice(Math.max(0, state.pos - 10), state.pos + 50), pos: Math.min(state.pos, 10),
    history: [], stay: state.stay, base: state.base ? state.base.slice(0, 60) : null, from: state.from, t: state.t, at: Date.now() });

  // "Start watching" only appears if the video really isn't playing (a replay, a seek or a resume never trips it).
  const armStart = (ms) => {
    clearTimeout(state.startTimer);
    state.startTimer = setTimeout(() => {
      if (!ui || state.lastEvt === "playing") return;
      const vid = document.querySelector("#movie_player video");
      if (vid && !vid.paused && vid.readyState > 2) return;
      ui.root.classList.add("show-start");
    }, ms);
  };
  const pruneMusic = () => {
    const col = currentCol();
    if (!cfg || !cfg.tv.skipMusic || !col || col.watchLater || col.feed || col.homeFeed || col.watchedChip) return;
    state.queue = state.queue.filter((x, i) => i <= state.pos || !musicLike(x));
    if (state.base) state.base = state.base.filter((x) => !musicLike(x));
  };
  const syncVideoUrl = (id) => {
    if (!onWatchTv() || !ID_RE.test(String(id || ""))) return;
    const next = `/watch?v=${encodeURIComponent(id)}`;
    if (`${location.pathname}${location.search}` !== next) {
      // Replace rather than push: changing videos in YTV shouldn't fill browser history,
      // but refreshing or copying the URL should target the video currently playing.
      history.replaceState(history.state, "", next);
    }
  };
  // Keep only the last few videos you watched on this channel as a trail above what's playing (Settings → Lists).
  const trimTrail = () => {
    if (sortOff()) return; // sorting off: everything stays where it is
    const col = currentCol(); if (col && col.twitch) return; // Twitch is a list you pick from: nothing is "behind" you
    const cut = state.pos - (cfg ? cfg.tv.trail : 5);
    if (cut <= 0) return;
    state.queue = state.queue.slice(cut); state.pos -= cut;
    state.history = state.history.map((n) => n - cut).filter((n) => n >= 0);
  };
  // Twitch: its player sits over YouTube's (paused) one, or over any other YouTube page. The mouse goes to Twitch's
  // player itself (its volume and quality controls, and hover overlays like card pop-ups, work as on Twitch); YTV's
  // helper inside it (src/twitch-frame.js) passes your keys, mouse movement and double-clicks back to YTV.
  const TW_PLAYER = "https://player.twitch.tv/", TW_ORIGIN = "https://player.twitch.tv";
  const TW_LOGIN = /^[a-z0-9_]{2,25}$/, TW_VOD = /^\d{1,15}$/, TW_Q = /^[\w]{1,12}$/;
  const twEvents = []; // what the player said lately (for the health report)
  const tw = { muted: false, vol: 1, playing: false, waitT: 0, warmT: 0 };
  window.addEventListener("message", (e) => {
    if (e.origin !== TW_ORIGIN || !ui) return; // only Twitch's player, nobody else
    const mine = e.data && typeof e.data === "object" && e.data.ytvTw && typeof e.data.ytvTw === "object" ? e.data.ytvTw : null; // from YTV's helper in the player
    if (!mine) return;
    if (mine.hello) { const f = ui.root.querySelector(".twframe"); if (f && f.contentWindow === e.source) twFrameCmd(f, { cmd: "go" }); return; } // a player that loaded ahead and is wanted now: go
    if (mine.going) { clearInterval(tw.goT); return; }
    if (typeof mine.key === "string" && mine.key.length <= 12 && state.forwardKey) { state.forwardKey(mine); return; } // a key pressed over the stream
    if (mine.move) { state.twIdleAt = Date.now(); if (state.overVideo) state.overVideo(); if (state.syncControls) state.syncControls(); return; } // the mouse over the stream wakes YTV's UI
    if (mine.dbl) { toggleFullscreen(); return; }
    if (mine.qualityLocked) { if (!tw.lockedSaid) { tw.lockedSaid = true; toast("Twitch only plays higher quality when you’re logged in to twitch.tv in this browser"); } return; }
    try { twEvents.push(JSON.stringify(mine).slice(0, 120)); if (twEvents.length > 12) twEvents.shift(); } catch {}
    if (mine.playing) { tw.playing = true; if (mine.muted) { tw.muted = true; toast("The browser held the sound back — press M, or use the stream’s volume"); } }
  });
  const twFrameCmd = (f, m) => { try { if (f && f.contentWindow) f.contentWindow.postMessage({ ytvTw: m }, TW_ORIGIN); } catch {} };
  const twCmd = (cmd, extra = {}) => twFrameCmd(ui && ui.root.querySelector(".twframe"), { cmd, ...extra });
  const twKey = (e) => { // Space / K pause and play, M and ↑ ↓ for the stream's sound (a click on the picture never pauses)
    const k = e.key;
    if (k === " " || k === "k" || k === "K") return () => { tw.paused = !tw.paused; twCmd(tw.paused ? "pause" : "play"); toast(tw.paused ? "Paused" : "Playing"); };
    if (k === "m" || k === "M") return () => { tw.muted = !tw.muted; twCmd("mute", { on: tw.muted }); toast(tw.muted ? "Muted" : "Sound on"); };
    if (k === "ArrowUp" || k === "ArrowDown") return () => { tw.vol = Math.max(0, Math.min(1, Math.round((tw.vol + (k === "ArrowUp" ? 0.1 : -0.1)) * 10) / 10)); if (tw.muted) { tw.muted = false; twCmd("mute", { on: false }); } twCmd("volume", { v: tw.vol }); toast(`Volume ${Math.round(tw.vol * 100)}%`); };
    return null;
  };
  const twSrc = (v, warm) => {
    const q = TW_Q.test(cfg.tv.twitch.quality || "") ? cfg.tv.twitch.quality : "chunked";
    const what = v.vod ? `video=v${v.vod}` : `channel=${encodeURIComponent(v.login)}`;
    return `${TW_PLAYER}?${what}&parent=www.youtube.com&autoplay=true&muted=${warm ? "true" : "false"}&ytvq=${q}${warm ? "&ytvwarm=1" : ""}`;
  };
  const twKeyOf = (v) => (v.vod ? "v" + v.vod : v.login);
  const newTwFrame = (v, warm) => {
    if (!(v.vod ? TW_VOD.test(v.vod) : TW_LOGIN.test(v.login))) return null;
    const f = document.createElement("iframe"); f.className = warm ? "twwarm" : "twframe"; f.dataset.k = twKeyOf(v);
    f.allow = "autoplay; fullscreen; encrypted-media; picture-in-picture"; f.tabIndex = -1;
    const src = twSrc(v, warm); f.src = src;
    return f;
  };
  // Point at a live stream in the list a moment and its player starts loading out of sight, so a click plays it at once.
  const warmTwitch = (v) => {
    if (!ui || !v || !v.tw || v.off || v.vod) return;
    const cur = ui.root.querySelector(".twframe");
    if (cur && cur.dataset.k === twKeyOf(v)) return;
    const old = ui.root.querySelector(".twwarm");
    if (old && old.dataset.k === twKeyOf(v)) return;
    if (old) old.remove();
    const f = newTwFrame(v, true); if (!f) return;
    ui.root.append(f);
    clearTimeout(tw.warmT); tw.warmT = setTimeout(() => { if (f.isConnected && f.classList.contains("twwarm")) f.remove(); }, 25000); // not picked: let it go
  };
  const hideTwitch = () => {
    if (!ui) return;
    for (const n of ui.root.querySelectorAll(".twframe, .twwarm")) n.remove();
    ui.root.classList.remove("on-twitch", "panchat"); clearTimeout(tw.warmT); clearInterval(tw.goT);
    state.twVod = null;
    stopChat();
    ui.comB.title = "Comments"; ui.comB.setAttribute("aria-label", "Comments");
  };
  const playTwitch = (v, vod = null) => {
    if (v.off && !vod) { state.twInfo = v; showPanel("info"); return; } // offline: their past broadcasts
    state.t = 0; saveSession();
    ui.root.classList.remove("show-msg", "show-start");
    // no need for a YouTube video page first: Twitch's player simply goes over whatever page you're on (much faster)
    if (onWatchTv()) cmd({ cmd: "pause" }); else pauseYouTube();
    state.twVod = vod;
    const what = vod || v;
    let f = ui.root.querySelector(".twframe");
    if (!f || f.dataset.k !== twKeyOf(what)) {
      if (f) f.remove();
      const warm = ui.root.querySelector(".twwarm");
      if (warm && warm.dataset.k === twKeyOf(what)) { // already loading: go (again until it hears it, in case it's still starting up)
        f = warm; f.className = "twframe"; clearTimeout(tw.warmT);
        const fr = f; let n = 0; clearInterval(tw.goT); twFrameCmd(fr, { cmd: "go" });
        tw.goT = setInterval(() => { if (++n > 40 || !fr.isConnected) clearInterval(tw.goT); else twFrameCmd(fr, { cmd: "go" }); }, 150);
      }
      else { if (warm) warm.remove(); f = newTwFrame(what, false); if (!f) return; }
      ui.root.insertBefore(f, ui.root.firstChild.nextSibling);
      tw.playing = false; tw.paused = false;
    }
    ui.root.classList.add("on-twitch");
    ui.comB.title = "Chat (O) · Shift+O: move it between the video and the list"; ui.comB.setAttribute("aria-label", "Chat");
    if (!vod && chatWanted()) startChat(v); else stopChat(); // the chat only runs while you can see it (and starts with what was just said)
    ui.curtain.style.display = "none";
    clearTimeout(state.startTimer);
    state.lastEvt = "playing"; state.twIdleAt = Date.now();
    showNow();
    if (state.panel === "info" || state.panel === "comments") renderPanel();
  };
  // While YTV is open: look again every 90 s. New streams join the Twitch channel (in your order) and you hear who went live.
  let twWatchT = 0, twKnown = null;
  const stopTwitchWatch = () => { clearInterval(twWatchT); twWatchT = 0; twKnown = null; };
  const twitchTick = async () => {
    if (!ui || !cfg || !cfg.tv.twitch.enabled || !cfg.tv.twitch.logins.length || document.hidden) return;
    const items = await twitchLive(true);
    if (!ui) return;
    const ids = new Set(items.filter((v) => !v.off).map((v) => v.id));
    if (twKnown && cfg.tv.twitch.alerts.length) { const fresh = items.filter((v) => !v.off && !twKnown.has(v.id) && cfg.tv.twitch.alerts.includes(v.login)); if (fresh.length) toast(fresh.length === 1 ? `${fresh[0].channel} is live on Twitch` : `${fresh.map((v) => v.channel).slice(0, 3).join(", ")} went live on Twitch`); }
    twKnown = ids;
    const col = currentCol();
    if (col && col.twitch && !state.stay && items.length) { // refresh the list, keeping what's playing where it is
      const cur = current(), byId = new Map(items.map((v) => [v.id, v]));
      const next = items.slice();
      if (cur && !byId.has(cur.id)) next.splice(Math.min(state.pos, next.length), 0, cur); // it just ended: keep it until you move on
      state.queue = next; state.pos = Math.max(0, next.findIndex((v) => cur && v.id === cur.id));
      state.history = [];
      saveSession(); refreshList(); showNow();
    }
    if (browse.has(TWITCH_ID)) { browse.delete(TWITCH_ID); if (state.panel === "src:" + TWITCH_ID) schedulePanel(); }
  };
  const startTwitchWatch = () => { if (twWatchT || !cfg || !cfg.tv.twitch.enabled) return; twWatchT = setInterval(twitchTick, 90 * 1000); twitchLive(false).then((items) => { if (!twKnown) twKnown = new Set(items.filter((v) => !v.off).map((v) => v.id)); }); };
  // Everything you watch, across all channels, tabs and Twitch, in order: Shift+[ and Shift+] go back and forth through it.
  // What was on when you last left TV: the channel, the video, where you were in it and what came next.
  // Opening TV again simply carries on there (kept on this computer, across tabs and restarts).
  const LAST_KEY = "ytv:lastplay";
  let lastSaveAt = 0;
  const saveLast = (force = false) => {
    const v = current();
    if (!ui || !v || !state.colId || (!force && performance.now() - lastSaveAt < 5000)) return;
    lastSaveAt = performance.now();
    const done = !v.tw && state.dur > 0 && state.dur - state.t < 15; // as good as finished: next time, what comes after it
    const next = state.stay ? [] : state.queue.slice(state.pos + 1).filter((x) => x && !x.tw && !played.has(x.id)).slice(0, 80).map(slimV);
    lsSet(LAST_KEY, { colId: state.colId, v: slimV(v), t: Math.floor(state.t || 0), done, next, at: Date.now() });
  };
  window.addEventListener("pagehide", () => saveLast(true));
  // (kept for this tab, so a reload or a page change doesn't lose it)
  const GHIST_KEY = "ytv:ghist";
  const ghist = (() => { try { const g = lsGet(GHIST_KEY, null) || JSON.parse(sessionStorage.getItem(GHIST_KEY) || "null"); if (g && Array.isArray(g.list) && Number.isInteger(g.pos)) { const list = g.list.filter((e) => e && e.v && typeof e.v.id === "string").slice(-2000); return { list, pos: Math.min(Math.max(-1, g.pos), list.length - 1) }; } } catch {} return { list: [], pos: -1 }; })();
  let ghistT = 0;
  // (written at most twice a second, never later than that)
  const saveGhist = () => { if (!ghistT) ghistT = setTimeout(() => { ghistT = 0; lsSet(GHIST_KEY, ghist); }, 500); if (ui && (state.panel === "history" || state.panel === "cont")) schedulePanel(); };
  window.addEventListener("pagehide", () => { if (ghistT) lsSet(GHIST_KEY, ghist); });
  const slimV = (v) => { const o = {}; for (const k of ["id", "title", "channel", "creator", "len", "age", "tw", "login", "vod", "off", "thumb"]) if (v[k] !== undefined) o[k] = v[k]; return o; };
  // Whatever plays is where you are in it: the same one as here (you stepped to it) or the next one changes nothing
  // but your place; anything else starts a new branch from here, like a browser's back and forward.
  const noteWatched = (v) => {
    if (!v) return;
    const here = ghist.list[ghist.pos], next = ghist.list[ghist.pos + 1];
    if (here && here.v.id === v.id) return;
    if (next && next.v.id === v.id) { ghist.pos++; saveGhist(); return; }
    ghist.list = ghist.list.slice(0, ghist.pos + 1); ghist.list.push({ colId: state.colId, v: slimV(v), at: Date.now() });
    const max = cfg ? cfg.tv.histMax : 200; // (Settings → List → History)
    while (ghist.list.length > max) { ghist.list.shift(); ghist.pos--; }
    ghist.pos = ghist.list.length - 1;
    saveGhist();
  };
  const historyStep = (d) => historyGo(ghist.pos + d);
  const historyGo = (to) => {
    if (to < 0) return toast("That’s the first thing you watched");
    if (to >= ghist.list.length) return nextVideo(); // forward past the end: simply what's next
    const e = ghist.list[to], from = ghist.pos;
    const cols = chans(), ci = cols.findIndex((c) => c.id === e.colId);
    if (e.colId === state.colId) {
      let i = state.queue.findIndex((x) => x.id === e.v.id);
      if (i < 0 && state.queue.length) { // no longer in the list (watched ones leave it): it comes back right after what's playing
        const hist = idsOfHistory(); state.queue.splice(state.pos + 1, 0, { ...e.v, nx: 1 }); fixHistory(hist); i = state.pos + 1;
      }
      if (i >= 0) { played.delete(e.v.id); ghist.pos = to; saveGhist(); return goTo(i); }
    }
    const at = ci >= 0 ? ci : cols.findIndex((c) => e.v.tw ? c.twitch : !c.feed && !c.twitch); // its channel is gone: play it on another one
    if (at < 0) { ghist.pos = from; return toast("That channel isn’t there any more"); }
    ghist.pos = to; saveGhist();
    pendingFirst = { v: e.v, t: e.v.tw ? 0 : resumeOf(e.v.id), similar: false }; tune(at);
  };
  const playCurrent = (start = 0, keep = false) => {
    pruneMusic();
    trimTrail();
    const v = current();
    if (!v) return;
    noteWatched(v);
    lastSaveAt = 0; saveLast(true);
    if (v.tw) return playTwitch(v);
    state.twVod = null;
    hideTwitch();
    syncVideoUrl(v.id);
    state.t = start;
    saveSession();
    ui.root.classList.remove("show-msg", "show-start");
    if (!onWatchTv()) { location.assign(`/watch?v=${v.id}${start > 5 ? "&t=" + Math.floor(start) + "s" : ""}`); return; } // TV continues on that page (from where you were in it)
    if (keep) { // TV was switched on over this very video: it simply keeps playing
      state.lastEvt = "playing";
      cmd({ cmd: "announce" });
      ui.curtain.style.display = "none";
      showNow();
      return;
    }
    cmd({ cmd: "load", id: v.id, start });
    ui.curtain.style.display = "none";
    clearTimeout(state.startTimer);
    armStart(5000);
    showNow();
  };
  const goTo = (i, { pushHistory = true } = {}) => {
    if (i < 0 || i >= state.queue.length) return;
    const was = current();
    if (was && state.t > 0 && state.lastEvt) { resumeT = 0; saveResume(was.id, state.t, state.dur || 0); } // remember exactly where you left it
    if (pushHistory && i !== state.pos) state.history.push(state.pos);
    state.pos = i;
    state.lastEvt = "";
    playCurrent(resumeOf(state.queue[i].id)); // carries on where you left it
  };
  // Picking a video in Up next plays it now without passing over the ones before it: it moves to
  // right after the current video, and the list carries on from where it was afterwards.
  const jumpTo = (i) => {
    if (i === state.pos || i < 0 || i >= state.queue.length) return;
    state.pickedId = state.queue[i] && state.queue[i].id; // you picked this one: it plays whatever its date
    const col = currentCol(); if ((col && col.twitch) || sortOff()) return goTo(i); // Twitch, or sorting off: nothing moves, you just switch
    const [item] = state.queue.splice(i, 1);
    if (i < state.pos) state.pos -= 1;
    state.queue.splice(state.pos + 1, 0, item);
    goTo(state.pos + 1);
  };
  // Sorting back on: from now on watched videos grey, fold and leave as usual. What you fully watched in the tab you're
  // on goes now (Cmd+Z brings it back, and sorting stays on); what's playing moves to the top, the rest keeps its order.
  const toggleSorting = () => {
    if (!cfg) return;
    const turningOn = cfg.tv.keepOrder;
    cfg.tv.keepOrder = !turningOn; writeCfg();
    if (!turningOn) { toast("Sorting off"); updateFilterUi(); schedulePanel(); return; }
    for (const id of dumbPlayed) { const it = state.queue.find((x) => x.id === id); if (progressOf(it || { id }) < fullPct()) played.delete(id); }
    dumbPlayed.clear();
    const tab = isListTab(state.panel) ? state.panel : playingTab(), kind = tabKind(tab), cur = current();
    const full = (x) => x && !x.tw && !x.f && !(cur && x.id === cur.id) && progressOf(x) >= fullPct();
    let gone = 0;
    if (kind === "live") {
      const ids0 = state.queue.map((x) => x.id), drop = state.queue.filter(full);
      if (drop.length) {
        const hist = idsOfHistory(); state.queue = state.queue.filter((x) => !full(x)); state.pos = Math.max(0, state.queue.findIndex((x) => cur && x.id === cur.id)); fixHistory(hist); gone = drop.length;
        pushUndo("live", () => { // back where they were (you want to see them: they show and can play again)
          const c2 = current(), h2 = idsOfHistory();
          for (const x of drop) { // each goes back in front of whatever followed it before (everything else stays as it is now)
            played.delete(x.id);
            if (state.queue.some((y) => y.id === x.id)) continue;
            const after = ids0.slice(ids0.indexOf(x.id) + 1).map((id) => state.queue.findIndex((y) => y.id === id)).find((k) => k >= 0);
            state.queue.splice(after === undefined ? state.queue.length : after, 0, { ...x, nx: 1 });
          }
          state.pos = Math.max(0, state.queue.findIndex((x) => c2 && x.id === c2.id)); fixHistory(h2); saveSession(); schedulePanel();
        });
        saveSession();
      }
      // what's playing goes to the top; everything else keeps its order after it (and stays visible: nothing counts as
      // "behind you" yet)
      const ci = state.queue.findIndex((x) => cur && x.id === cur.id);
      if (ci > 0) { const hist = idsOfHistory(), [c0] = state.queue.splice(ci, 1); state.queue.unshift(c0); state.pos = 0; fixHistory(hist); }
      for (const x of state.queue) if (!(cur && x.id === cur.id)) played.delete(x.id);
      saveSession();
    } else if (kind === "browse" || kind === "base") {
      const arr = kind === "base" ? state.base : (browse.get(tab.slice(4)) || {}).items;
      if (arr) {
        const before = arr.slice(), drop = arr.filter(full);
        if (drop.length) {
          arr.splice(0, arr.length, ...arr.filter((x) => !full(x))); gone = drop.length;
          pushUndo(kind === "base" ? "live" : "browse", () => { const by = new Set(arr.map((x) => x.id)); arr.splice(0, arr.length, ...before.filter((x) => by.has(x.id) || drop.includes(x)), ...arr.filter((x) => !before.includes(x))); schedulePanel(); });
        }
      }
    }
    updateFilterUi(); toast(gone ? `Sorting on · ${gone} watched cleared (Cmd+Z)` : "Sorting on");
    schedulePanel();
  };
  const remaining = () => state.queue.slice(state.pos + 1).filter((v) => !played.has(v.id)).length;
  // Fetch more videos for what's playing now: on-topic videos while exploring, similar ones while
  // staying on a topic, fresh recommendations on Home, a rebuilt lineup on a normal channel.
  let topping = null;
  const EXPLORE_VARIANTS = ["", "compilation", "best", "new", "2025", "2026", "highlights", "moments"];
  // When YouTube has no next page to give (or only things you've seen): a fresh look at the channel's sources, then
  // videos like what's on. "Load more" always brings something.
  const moreFallback = async (col, v, have = new Set()) => {
    if (!col || col.watchLater || col.watchedChip || col.cont) return []; // Watch Later is your list and nothing else: it ends where it ends
    const fresh = (list) => list.filter((x) => x && usable(col, x) && !played.has(x.id) && !have.has(x.id));
    let got = [];
    try { got = fresh(await buildLineup(col, () => {}, () => {}, true)); } catch {}
    // still (almost) nothing new: videos like the last ones in the list, then like what's playing
    for (const from of [v, current()]) {
      if (got.length >= 6 || !from || from.tw || !ID_RE.test(from.id)) continue;
      try { const add = fresh(await similarTo(from.id)); const ids = new Set(got.map((x) => x.id)); got.push(...add.filter((x) => !ids.has(x.id))); } catch {}
    }
    return got;
  };
  const topUp = () => {
    if (topping) return topping;
    topping = (async () => {
      const col = currentCol();
      if (!col || !current() || (col.feed && !state.stay) || ((col.watchLater || col.cont) && !state.stay)) return 0; // (Watch Later and Continue watching are loaded whole)
      let more = [];
      if (state.stay && state.stay.pick) more = await similarTo(current().id); // your own pick: then what's like it
      else if (state.stay && state.stay.by) more = await creatorVideos(current());
      else if (state.stay && state.stay.mode === "explore") {
        const q = state.stay.query;
        for (let tries = 0; tries < 3 && more.filter((v) => !state.queue.some((x) => x.id === v.id)).length < 4; tries++) {
          const variant = EXPLORE_VARIANTS[(state.stay.variant = ((state.stay.variant || 0) + 1) % EXPLORE_VARIANTS.length)];
          more.push(...(await searchTopic(variant ? `${q} ${variant}` : q, tries === 1 ? "CAI%253D" : "")).filter((v) => matchesTopic(v, q, true)));
        }
      } else if (state.stay && state.stay.by) more = await creatorVideos(current());
      else if (state.stay) more = await similarTo(current().id);
      else more = await moreLineup(col, 15, new Set(state.queue.map((q) => q.id))); // the next pages: a channel never runs dry
      let fresh = more.filter((v) => usable(col, v) && !played.has(v.id) && !state.queue.some((q) => q.id === v.id)).slice(0, 40);
      if (!fresh.length && !state.stay) { fresh = (await moreFallback(col, state.queue[state.queue.length - 1], new Set(state.queue.map((q) => q.id)))).slice(0, 40); }
      if (fresh.length) { state.queue.push(...fresh); saveSession(); refreshList(); }
      return fresh.length;
    })().finally(() => { topping = null; });
    return topping;
  };

  /** Index of the next playable video after the current one (never a hidden creator or filtered video). */
  const nextIndex = (allowSeen = false) => {
    const col = currentCol(), fOn = filterFor(col);
    for (let i = state.pos + 1; i < state.queue.length; i++) {
      const v = state.queue[i];
      if (sortOff()) { if (v.nx || ((!fOn || passFilter(v)) && (v.f || !col || !isBlocked(col, v)))) return i; continue; } // sorting off: simply the next one in the list
      if (v.nx && !played.has(v.id)) return i; // you put it there yourself
      if ((!col || usable(col, v)) && (!fOn || passFilter(v)) && (allowSeen || v.f || !played.has(v.id))) return i;
    }
    return -1;
  };
  const nextVideo = async () => {
    if (!state.queue.length) return;
    const col = currentCol();
    let i = nextIndex();
    for (let t = 0; i < 0 && t < (filterFor(col) ? 3 : 1); t++) { if (!(await topUp()) && t) break; i = nextIndex(); } // ran dry: wait for more instead of drifting (with filters on, a few pages)
    if (i < 0 && state.stay) {
      toast(state.stay.mode === "explore" ? `That’s all for “${state.stay.query}” for now — back to ${col.name}` : `No more similar videos — back to ${col.name}`);
      return backToMix();
    }
    if (i < 0 && col && (col.watchLater || col.cont)) return toast(`That’s the end of ${col.watchLater ? "your " : ""}${col.name}`); // finite: it stops here
    if (i < 0) i = nextIndex(true); // everything new has been played: allow repeats, still respecting filters
    if (i < 0 && col && col.feed) { toast(`That’s the end of your ${col.name} — swipe videos right in any channel to add more`); return showPanel("src:" + chans()[1 % chans().length].id); }
    if (i < 0 && filterFor(col)) return toast("Nothing more that matches your filters — loosen them with the funnel above the list");
    if (i < 0) return toast(col && (col.skipSeen || col.maxAge !== "any")
      ? `You’ve seen everything new on ${col.name} — loosen its filters in settings for more`
      : "Nothing more to play on this channel right now");
    // videos jumped over (hidden by a filter, on your Feed, a creator you hid…) would otherwise end up above what's
    // playing as if you'd watched them: they leave the list instead
    if (i > state.pos + 1 && !sortOff()) {
      const hist = idsOfHistory(), id = state.queue[i].id;
      const fOn = filterFor(col); // (only hidden by the list filter: they stay, for when you loosen it)
      state.queue = state.queue.filter((x, k) => k <= state.pos || k >= i || played.has(x.id) || (fOn && !passFilter(x) && (!col || usable(col, x))));
      i = state.queue.findIndex((x, k) => k > state.pos && x.id === id);
      fixHistory(hist);
    }
    goTo(i);
  };
  // [ : what you watched before on this channel; else the one above in the list; else what you watched before that, anywhere
  const prevVideo = () => {
    if (state.history.length) return goTo(state.history.pop(), { pushHistory: false });
    if (state.pos > 0) return goTo(state.pos - 1, { pushHistory: false });
    if (ghist.pos > 0) return historyStep(-1);
    toast("Nothing before this one yet");
  };

  // ---------------------------------------------------------------- more / less / creators
  const writeCfg = async () => { try { await chrome.storage.local.set({ cfg: SW.sanitizeConfig(cfg) }); } catch {} };
  // "More like this": stay on this topic — similar videos keep coming (each leads to the next)
  // until you go back to the channel's mix (B). Pressing it again re-anchors on what's playing.
  // the creator's own uploads: their Videos tab, or (when YouTube didn't say who) a search narrowed to that channel name
  const creatorVideos = async (v) => {
    const who = SW.normalizeCreator(creatorOf(v));
    try {
      if (who && (who.startsWith("@") || who.startsWith("channel/"))) return await readSource({ label: who, path: `/${who}/videos`, creator: who });
      const name = goodName(v.channel);
      if (name) return (await searchTopic(name, "")).filter((x) => creatorKey(x.channel) === creatorKey(name));
    } catch {}
    return [];
  };
  // "Explore topic": a side path that plays only one topic (e.g. "dashcam") until you go back.
  // Lineup = YouTube searches for the topic (by relevance, newest and most viewed), topped up with
  // related videos whose title matches the topic, so it doesn't drift.
  const SORTS = ["", "CAI%253D", "CAM%253D"]; // relevance, upload date, view count
  const searchTopic = async (query, sort) => {
    if (String(query).includes(" + ")) { // several topics: each searched, mixed together
      const lists = await Promise.all(String(query).split(" + ").map((q) => searchTopic(q.trim(), sort)));
      const out = []; for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]);
      return out;
    }
    return readSource({ path: `/results?search_query=${encodeURIComponent(query)}&sp=${sort || spFor(currentCol())}` });
  };
  const focusExploreTab = () => { if (isListTab(state.panel)) state.panel = "explore"; };
  // Several topics can be open at once: the one playing is "explore", the others wait as tabs with what was left of them.
  const parkStay = (keepId) => {
    if (!state.stay || state.stay.mode !== "explore") return;
    const items = state.queue.slice(state.pos + 1).filter((x) => !played.has(x.id) && x.id !== keepId).slice(0, 40);
    const q = state.stay.query;
    state.xtabs = [{ id: Math.random().toString(36).slice(2, 9), query: q, by: state.stay.by || "", pick: !!state.stay.pick, items },
      ...(state.xtabs || []).filter((x) => x.query !== q)].slice(0, 6);
  };
  const activateExplore = (xid, v) => {
    const x = (state.xtabs || []).find((t) => t.id === xid);
    if (!x || !current()) return;
    const cur = current(), first = v || x.items[0];
    if (!first) return;
    if (state.stay) parkStay(first.id);
    else { state.base = state.queue.slice(state.pos + 1).filter((y) => !played.has(y.id) && y.id !== first.id); state.from = { item: cur, t: state.t }; }
    state.xtabs = (state.xtabs || []).filter((t) => t.id !== xid);
    state.stay = { mode: "explore", query: x.query, by: x.by || "", pick: !!x.pick };
    state.queue = [...state.queue.slice(0, state.pos + 1), first, ...x.items.filter((y) => y.id !== first.id && y.id !== cur.id)];
    state.panel = "explore"; tabsSig = "";
    saveSession();
    goTo(state.pos + 1);
  };
  const exploreTopic = async (query, anchor = null) => {
    const v = current(); const col = currentCol();
    query = String(query || "").trim().slice(0, 160);
    if (!v || !col || !query) return;
    closeExplore();
    toast(`Finding “${query}” videos…`);
    // Only that topic: YouTube searches (relevance, newest, most viewed), kept to videos that really match it.
    const found = await Promise.all(SORTS.map((s) => searchTopic(query, s)));
    let lists = found.map((l) => l.filter((x) => matchesTopic(x, query, true)));
    if (!lists.some((l) => l.length)) lists = found; // none mention it word for word (a hashtag, a nickname): what YouTube found for it
    const first = anchor && anchor.id !== v.id ? anchor : null;
    const taken = new Set([v.id, first && first.id]), items = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) { const x = l[i]; if (x && !taken.has(x.id) && usable(col, x) && !played.has(x.id)) { taken.add(x.id); items.push(x); } }
    if (!items.length && !first) return toast(`Couldn’t find videos about “${query}”`);
    if (!state.stay) { state.base = state.queue.slice(state.pos + 1).filter((x) => !played.has(x.id) && (!first || x.id !== first.id)); state.from = { item: v, t: state.t }; }
    else if (state.stay.query !== query) parkStay(first && first.id);
    state.xtabs = (state.xtabs || []).filter((x) => x.query !== query);
    state.stay = { mode: "explore", query, sortsUsed: SORTS.length };
    state.queue = [...state.queue.slice(0, state.pos + 1), ...(first ? [first] : []), ...items]; // the chosen video starts the chain
    saveSession();
    focusExploreTab();
    showNow();
    if (first) goTo(state.pos + 1); // a video picked in the list starts now; otherwise what's playing carries on and the topic follows
  };
  // Explore a creator: only their videos until you go back.
  const exploreCreator = async (anchor = null) => {
    const v = current(); const col = currentCol();
    const src = anchor || v;
    if (!v || !col || !src) return;
    closeExplore();
    const who = SW.normalizeCreator(creatorOf(src));
    const name = goodName(src.channel) || (who && who.startsWith("@") ? who : "this creator");
    toast(`Finding videos from ${name}…`);
    const list = await creatorVideos(src);
    const first = anchor && anchor.id !== v.id ? anchor : null;
    const taken = new Set([v.id, first && first.id]), vids = [];
    for (const x of list) if (x && !taken.has(x.id) && usable(col, x) && !played.has(x.id)) { taken.add(x.id); vids.push(x); }
    if (!vids.length && !first) return toast(`Couldn’t find videos from ${name}`);
    if (!state.stay) { state.base = state.queue.slice(state.pos + 1).filter((x) => !played.has(x.id) && (!first || x.id !== first.id)); state.from = { item: v, t: state.t }; }
    else if (state.stay.query !== name) parkStay(first && first.id);
    state.xtabs = (state.xtabs || []).filter((x) => x.query !== name);
    state.stay = { mode: "explore", query: name, by: who || "" };
    state.queue = [...state.queue.slice(0, state.pos + 1), ...(first ? [first] : []), ...vids.slice(0, 30)];
    saveSession();
    focusExploreTab();
    showNow();
    if (first) goTo(state.pos + 1);
  };
  // Explore box. For = which video it's about (the one playing, or one picked in Up next).
  // Offers: only this creator, topics the video is about (its game or show first), or your own words.
  const openExplore = async (forVideo) => {
    const v = forVideo || current();
    if (!ui || !v) return;
    const anchor = forVideo && current() && forVideo.id !== current().id ? forVideo : null;
    const box = ui.explore;
    const who = SW.normalizeCreator(creatorOf(v));
    const name = goodName(v.channel) || (who && who.startsWith("@") ? who : "");
    const input = el("input"); input.type = "text"; input.maxLength = 80; input.placeholder = "Or type a topic (commas for several)"; input.setAttribute("aria-label", "Topic to explore");
    const ideas = el("div", "ideas");
    // Cmd/Ctrl-click topics to pick several: they're explored together (a video about any of them plays)
    const picked = [];
    const together = (extra) => [...new Set([...picked, ...String(extra || "").split(",").map((x) => x.trim()).filter(Boolean)])].join(" + ");
    const go = btn("Explore", "Start exploring", () => exploreTopic(together(input.value), anchor), "acc");
    const drawGo = () => { go.textContent = picked.length > 1 ? `Explore ${picked.length} together` : "Explore"; };
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); exploreTopic(together(input.value), anchor); } if (e.key === "Escape") { e.preventDefault(); closeExplore(); } });
    const row = el("div", "row"); row.append(input, go);
    const parts = [el("h3", null, "Explore"), el("p", null, anchor ? `Starts with “${anchor.title || "this video"}”, then only what you pick, until you go back.` : "Only what you pick will play until you go back.")];
    if (who || name) parts.push(btn(`👤 Only ${name || "this creator"}’s videos`, "Play only this creator’s videos", () => exploreCreator(anchor), "acc"));
    parts.push(el("p", "sub", "Topics in this video · Cmd-click to pick several"), ideas, row, (() => { const c = btn("Cancel", "Close", () => closeExplore()); c.style.marginTop = "14px"; return c; })());
    box.replaceChildren(...parts);
    box.hidden = false;
    wake();
    const fill = (list, th) => {
      const label = (t) => (th && th.game && t === th.game ? "🎮 " : th && (th.tags || []).includes(t) ? "# " : "") + t;
      ideas.replaceChildren(...(list.length ? list : ["…"]).map((t) => {
        const b = btn(label(t), `Explore “${t}” (Cmd-click to pick several)`, (e) => {
          if (t === "…") return;
          if (e.metaKey || e.ctrlKey || e.shiftKey) { const i = picked.indexOf(t); if (i >= 0) picked.splice(i, 1); else picked.push(t); b.classList.toggle("picked", i < 0); drawGo(); return; }
          exploreTopic(together(t), anchor);
        });
        if (picked.includes(t)) b.classList.add("picked");
        return b;
      }));
    };
    fill(topicIdeas(v, v.keywords, {}), {});
    themeOf(v.id).then((th) => {
      if (!ui || box.hidden) return;
      if (th.keywords.length && !(v.keywords && v.keywords.length)) v.keywords = th.keywords;
      fill(topicIdeas(v, v.keywords, th), th);
    });
  };
  const closeExplore = () => { if (ui) { ui.explore.hidden = true; ui.explore.classList.remove("searchbox"); wake(); } };
  // Shift+E: search YouTube for videos. The results open as a tab in the list: swipe one to add it to your Feed,
  // click one to watch it (and carry on exploring the rest of the results from there).
  let lastSearch = "";
  const openSearch = () => {
    if (!ui) return;
    const box = ui.explore;
    const input = el("input"); input.type = "search"; input.maxLength = 100; input.placeholder = "Search YouTube for videos"; input.setAttribute("aria-label", "Search YouTube for videos"); input.value = lastSearch;
    const note = el("p", "bulknote", "");
    let busy = false;
    const go = async () => {
      const q = input.value.trim().slice(0, 100);
      if (!q) { input.focus(); return; }
      if (busy) return;
      busy = true; goB.disabled = true; note.textContent = `Searching for “${q}”…`;
      let items = [];
      try {
        const pg = await SW.yt.videosPage(`/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D`); // videos only
        items = pg.videos.slice();
        if (pg.more && items.length < 40) { const more = await SW.yt.moreVideos(pg.more); items.push(...more.videos); }
      } catch {}
      busy = false; goB.disabled = false;
      if (!ui) return;
      items = [...new Map(items.filter((x) => x && ID_RE.test(x.id)).map((x) => [x.id, x])).values()].slice(0, 80);
      if (!items.length) { note.textContent = `Nothing found for “${q}”. Try other words.`; return; }
      lastSearch = q;
      const id = Math.random().toString(36).slice(2, 9);
      state.xtabs = [{ id, query: q, by: "", items }, ...(state.xtabs || []).filter((x) => x.query !== q)].slice(0, 6);
      saveSession(); closeExplore(); tabsSig = "";
      showPanel("x:" + id);
      toast(`${items.length} videos for “${q}”: swipe to add to your ${nameOf(FEED_ID)}, click to watch`);
    };
    const goB = btn("Search", "Search YouTube", () => go(), "acc");
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); go(); } if (e.key === "Escape") { e.preventDefault(); closeExplore(); } });
    const row = el("div", "row"); row.append(input, goB);
    box.replaceChildren(el("h3", null, "Search"), el("p", null, `The results open as a tab in the list: swipe one to add it to your ${nameOf(FEED_ID)}, click one to watch it.`), row, note,
      (() => { const c = btn("Cancel", "Close", () => closeExplore()); c.style.marginTop = "6px"; return c; })());
    box.classList.add("searchbox");
    box.hidden = false;
    input.focus(); input.select();
    wake();
  };

  // Bulk add: paste video links, one per line, and add them all to your YouTube Watch Later list.
  const openBulkAdd = () => {
    if (!ui) return;
    const box = ui.explore;
    const area = el("textarea"); area.rows = 8; area.spellcheck = false; area.setAttribute("aria-label", "Video links, one per line");
    area.placeholder = "https://www.youtube.com/watch?v=…\nhttps://youtu.be/…\n(one link per line)";
    const note = el("p", "bulknote", "");
    const stopKeys = (e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); closeExplore(); } };
    area.addEventListener("keydown", stopKeys);
    let busy = false;
    const go = btn("Add to Watch Later", "Add these videos to your YouTube Watch Later list", async () => {
      if (busy) return;
      const { ids, skipped } = SW.parseVideoLinks(area.value);
      if (!ids.length) { note.textContent = skipped.length ? `Couldn’t find a video link in “${skipped[0].slice(0, 60)}”` : "Paste at least one video link first."; return; }
      busy = true; go.disabled = true; note.textContent = `Adding ${ids.length} video${ids.length > 1 ? "s" : ""}…`;
      const added = await SW.yt.addToWatchLater(ids, state.wlCtx);
      busy = false; go.disabled = false;
      const failed = ids.length - added.length;
      if (!added.length) { note.textContent = "YouTube didn’t accept that — are you signed in? Try again in a moment."; return; }
      toast(`Added ${added.length} video${added.length > 1 ? "s" : ""} to Watch Later` + (failed ? ` · ${failed} failed` : "") + (skipped.length ? ` · ${skipped.length} skipped (not video links)` : ""));
      closeExplore();
    }, "acc");
    const row = el("div", "row"); row.append(go, (() => { const c = btn("Cancel", "Close", () => closeExplore()); return c; })());
    box.replaceChildren(el("h3", null, "Add links to Watch Later"), el("p", null, "Paste YouTube video links, one per line. They’re added to your real YouTube Watch Later list."), area, note, row);
    box.hidden = false;
    area.focus();
    wake();
  };

  // Closing the topic's tab: the list goes back to the channel; the video playing now just keeps playing.
  const endTopic = () => {
    if (!state.stay) return;
    const col = currentCol();
    const base = (state.base || []).filter((x) => (x.f || !played.has(x.id)) && (x.f || usable(col, x)));
    state.stay = null; state.base = null; state.from = null;
    state.queue = [...state.queue.slice(0, state.pos + 1), ...base];
    if (remaining() < 3) topUp();
    if (state.panel === "explore") state.panel = playingTab();
    tabsSig = "";
    saveSession();
    showNow();
  };
  const backToMix = async () => {
    if (!state.stay) return;
    const col = currentCol();
    const from = state.from;
    const base = (state.base || []).filter((x) => (x.f || !played.has(x.id)) && (x.f || usable(col, x)) && (!from || x.id !== from.item.id));
    state.stay = null; state.base = null; state.from = null;
    if (from && from.item && current() && current().id === from.item.id) { // still on that video: only the list changes
      state.queue = [...state.queue.slice(0, state.pos + 1), ...base];
      if (remaining() < 3) topUp();
      saveSession();
      showNow();
      return;
    }
    if (from && from.item) { // the same video, at the moment you left it
      state.queue = [...state.queue.slice(0, state.pos + 1), from.item, ...base];
      state.history.push(state.pos);
      state.pos += 1;
      state.lastEvt = "";
      saveSession();
      return playCurrent(from.t || 0);
    }
    state.queue = [...state.queue.slice(0, state.pos + 1), ...base];
    if (remaining() < 3) await topUp();
    saveSession();
    showNow();
    nextVideo();
  };
  const creatorOf = (v) => v && (v.creator || v.channel || "");
  const refreshCreatorButton = () => {
    if (!ui || !ui.addB) return;
    const v = current(), col = currentCol();
    const on = collections().filter((c) => creatorIn(v, c)).map((c) => c.name);
    ui.addB.classList.toggle("on", !!on.length);
    ui.addB.title = on.length ? `On ${on.length === 1 ? on[0] : on.length + " channels"}: add to another channel, or make a new one` : "Add this creator to a channel, or make a new channel with them";
    ui.addB.setAttribute("aria-label", ui.addB.title);
    const wl = !!(col && col.watchLater);
    ui.wlRemove.hidden = !wl; ui.wlClear.hidden = !wl;
  };
  /** Is the playing video's creator on channel c? */
  const creatorIn = (v, c) => {
    if (!v || !c || !c.channels) return false;
    const keys = new Set(c.channels.map(creatorKey));
    return keys.has(creatorKey(SW.normalizeCreator(creatorOf(v)))) || keys.has(creatorKey(v.channel)) || keys.has(creatorKey(v.creator));
  };
  // Creator menu: tick the channels this creator should be on, or make a new channel with them.
  // Twitch quality, from the top bar: the stream starts again in the one you pick (and every stream after it)
  const TW_QUALITIES = [["chunked", "Source (best)"], ["1080p60", "1080p60"], ["720p60", "720p60"], ["720p30", "720p"], ["480p30", "480p"], ["360p30", "360p"], ["auto", "Auto"]];
  // The ⋯ in the top bar: everything that isn't back, info or comments, with its key where it has one.
  const openMoreMenu = (anchor) => {
    if (!ui.pop.hidden) return closePop();
    const v = current(), tw = !!(v && v.tw) || ui.root.classList.contains("on-twitch");
    const item = (ic, label, key, fn) => {
      const b = btn("", label, () => { closePop(); setTimeout(() => fn(anchor), 0); });
      b.setAttribute("role", "menuitem"); b.classList.add("mi");
      const i = el("span", "mic"); i.append(icon(ic)); b.append(i, el("span", "ml", label)); if (key) b.append(el("span", "mk", key));
      return b;
    };
    const k = (a) => (keyOf(a) && cfg.tv.keysOn ? keyName(a) : "");
    const items = [item("fwd", "Forward", "Shift+]", () => historyStep(1)), item("search", "Explore a creator or topic", k("explore"), () => openExplore())];
    if (v && !tw) {
      items.push(item("user-plus", ui.addB.classList.contains("on") ? "This creator’s channels" : "Add this creator to a channel", "", (a) => openCreatorMenu(a)));
      items.push(item("eye-off", "Hide this creator on this channel", "", () => hideCreator()));
      if (ui.wlRemove.hidden) items.push(item("clock", inWl(v) ? "Take off Watch Later" : "Save to Watch Later", "", () => toggleWl(v, el("button"))));
      else items.push(item("clock-x", "Remove from Watch Later", "", () => wlRemoveCurrent()));
      if (!ui.wlClear.hidden) items.push(item("sweep", "Remove watched ones from Watch Later", "", () => wlRemoveWatched()));
    }
    if (tw) items.push(item("gear", "Stream quality", "", (a) => openQualityMenu(a)));
    ui.pop.replaceChildren(...items);
    const r = anchor.getBoundingClientRect(), host = ui.root.getBoundingClientRect(), z = cfg.tv.uiScale / 100;
    ui.pop.style.left = `${Math.max(8, Math.min((r.right - host.left) / z - 260, host.width / z - 270))}px`; ui.pop.style.top = `${(r.bottom - host.top) / z + 6}px`;
    ui.pop.hidden = false; anchor.setAttribute("aria-pressed", "true"); wake();
  };
  const openQualityMenu = (anchor) => {
    if (!ui.pop.hidden) return closePop();
    const pop = ui.pop, cur = cfg.tv.twitch.quality;
    const items = TW_QUALITIES.map(([q, label]) => {
      const b = btn("", label, async () => {
        cfg.tv.twitch.quality = q; closePop(); await writeCfg();
        const f = ui && ui.root.querySelector(".twframe"), v = state.twVod || current();
        if (f && v && v.tw) { f.remove(); playTwitch(current(), state.twVod); toast(`Quality: ${label}`); }
      });
      b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(q === cur));
      b.append(el("span", "ck", q === cur ? "✓" : ""), el("span", null, label));
      return b;
    });
    pop.replaceChildren(el("div", "ph", "Stream quality"), ...items);
    const r = anchor.getBoundingClientRect(), host = ui.root.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left - host.left, host.width - 240))}px`; pop.style.top = `${r.bottom - host.top + 6}px`;
    pop.hidden = false; wake();
  };
  const openCreatorMenu = (anchor) => {
    if (!ui.pop.hidden) return closePop(); // click the button again to close
    const v = current();
    const who = SW.normalizeCreator(creatorOf(v));
    if (!v || !who) return toast("Don’t know this video’s creator yet");
    const pop = ui.pop;
    const draw = () => {
      const items = collections().map((c) => {
        const b = btn("", `${creatorIn(v, c) ? "Remove from" : "Add to"} ${c.name}`, async () => {
          const real = collections().find((x) => x.id === c.id);
          if (creatorIn(v, real)) { const ks = new Set([creatorKey(who), creatorKey(v.channel), creatorKey(v.creator)].filter(Boolean)); real.channels = real.channels.filter((x) => !ks.has(creatorKey(x))); }
          else { real.channels.push(who); real.blocked = real.blocked.filter((x) => creatorKey(x) !== creatorKey(who)); }
          await writeCfg(); draw(); refreshCreatorButton();
        });
        b.setAttribute("role", "menuitemcheckbox"); b.setAttribute("aria-checked", String(creatorIn(v, c)));
        b.append(el("span", "ck", creatorIn(v, c) ? "✓" : ""), el("span", null, `${(chanById(c.id) || {}).num ?? ""}  ${c.name}`));
        return b;
      });
      const name = el("input"); name.type = "text"; name.maxLength = 40; name.placeholder = "New channel name"; name.value = whoOf(v) || "";
      name.setAttribute("aria-label", "New channel name");
      const make = btn("Create", "Create a new channel with this creator", async () => {
        const nm = name.value.trim() || whoOf(v) || "New channel";
        let n = collections().length + 1, id; do { id = "c" + n++; } while (collections().some((c) => c.id === id));
        cfg.tv.collections.push({ id, name: nm.slice(0, 40), subjects: [], channels: [who], blocked: [], home: false, skipSeen: true, maxAge: "any", num: 999 });
        cfg.tv.order = SW.tvOrder(cfg.tv); dropChans(); tabsSig = "";
        await writeCfg(); draw(); refreshCreatorButton();
      }, "acc");
      name.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") make.click(); if (e.key === "Escape") closePop(); });
      const row = el("div", "row"); row.append(name, make);
      pop.replaceChildren(el("div", "ph", `${whoOf(v) || who} — on which channels?`), ...items, row);
    };
    draw();
    const r = anchor.getBoundingClientRect(), host = ui.root.getBoundingClientRect();
    pop.style.left = `${Math.max(8, r.left - host.left)}px`; pop.style.top = `${r.bottom - host.top + 6}px`;
    pop.hidden = false; wake();
    const first = pop.querySelector("button"); first && first.focus();
  };
  const closePop = () => { if (ui) { ui.pop.hidden = true; const m = ui.root.querySelector(".moreb"); if (m) m.setAttribute("aria-pressed", "false"); wake(); } };
  // Videos clicked on the page itself (e.g. the "More videos" grid in full screen) take over TV and join the list.
  const onPageClick = (e) => {
    if (!ui || !onWatchTv() || e.button) return;
    const path = e.composedPath();
    if (path.includes(ui.host)) return;
    const a = path.find((n) => n && n.tagName === "A" && /\/watch\?(?:[^#]*&)?v=[\w-]{11}/.test(n.getAttribute("href") || ""));
    if (!a) return;
    let id = ""; try { id = new URL(a.getAttribute("href"), location.origin).searchParams.get("v") || ""; } catch {}
    if (!ID_RE.test(id)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const cur = current();
    if (cur && cur.id === id) return;
    const later = state.queue.findIndex((x, i) => i > state.pos && x.id === id);
    if (later >= 0) return jumpTo(later);
    const t = a.querySelector("#video-title, [class*='title' i]");
    const item = { id, title: ((t && t.textContent) || "").replace(/\s+/g, " ").trim().slice(0, 200), channel: "", creator: "", len: "", age: "", progress: 0, watched: false };
    state.queue.splice(state.pos + 1, 0, item);
    goTo(state.pos + 1);
  };

  // ---------------------------------------------------------------- Watch Later
  const wlRemoveCurrent = async () => {
    const v = current();
    if (!v || !confirm(`Remove “${v.title || "this video"}” from your YouTube Watch Later list?`)) return;
    const ok = await SW.yt.removeFromWatchLater([v.id], state.wlCtx);
    if (!ok) return toast("YouTube didn’t accept that — try again from YouTube’s own Watch Later page");
    nextVideo();
  };
  const wlRemoveWatched = async () => {
    const wl = await SW.yt.watchLater();
    state.wlCtx = wl.ctx || state.wlCtx;
    const done = wl.videos.filter((v) => progressOf(v) >= fullPct() || seen.has(v.id));
    if (!done.length) return toast("Nothing watched in your Watch Later list");
    if (!confirm(`Remove ${done.length} watched video${done.length > 1 ? "s" : ""} from your YouTube Watch Later list?`)) return;
    const ok = await SW.yt.removeFromWatchLater(done.map((v) => v.id), state.wlCtx);
    if (!ok) return toast("YouTube didn’t accept that — try again from YouTube’s own Watch Later page");
    const gone = new Set(done.map((v) => v.id));
    state.queue = state.queue.filter((v, i) => i <= state.pos || !gone.has(v.id));
    refreshList();
  };

  // Hide the playing video's creator on this channel. YouTube names a creator in more than one way (an @handle, a
  // channel id, a display name), so every name this video carries is saved; otherwise their other videos slip through.
  const hideCreator = async () => {
    const v = current(); const col = currentCol();
    const ids = v ? [...new Set([SW.normalizeCreator(v.creator || ""), goodName(v.channel) ? SW.normalizeCreator(v.channel) : ""].filter(Boolean))] : [];
    if (!ids.length || !col) return toast("Don’t know this video’s creator yet");
    let list;
    if (col.homeFeed) list = cfg.tv.homeBlocked;
    else {
      const real = collections().find((x) => x.id === col.id);
      if (!real) return toast(`Hiding creators works on Home and your own channels — not on ${col.name}`);
      list = real.blocked;
      real.channels = real.channels.filter((c) => !ids.some((k) => creatorKey(c) === creatorKey(k)));
    }
    for (const k of ids) if (!list.some((x) => creatorKey(x) === creatorKey(k))) list.push(k);
    const keys = new Set(ids.map(creatorKey));
    const gone = (x) => keys.has(creatorKey(x.creator)) || keys.has(creatorKey(x.channel));
    state.queue = state.queue.filter((x, i) => i <= state.pos || x.f || !gone(x));
    if (state.base) state.base = state.base.filter((x) => x.f || !gone(x));
    const seen = browse.get(col.id); if (seen) seen.items = seen.items.filter((x) => !gone(x));
    dropChans();
    await writeCfg();
    nextVideo();
  };


  // =====================================================================================
  /* global WebSocket */
  // Twitch chat over the video: read only, clean, with BetterTTV / FrankerFaceZ / 7TV emotes
  // =====================================================================================
  // The connection lives in the background (src/background.js); this side only draws. Emote pictures come from
  // the emote services' own image servers, built from an id the background checked.
  const EMOTE_URL = {
    bttv: (id) => `https://cdn.betterttv.net/emote/${id}/1x`,
    ffz: (id) => `https://cdn.frankerfacez.com/emote/${id}/1`,
    stv: (id) => `https://cdn.7tv.app/emote/${id}/1x.webp`,
    tw: (id) => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0`,
  };
  const EMOTE_OK = /^[\w-]{1,40}$/;
  // ◐: the bars behind the messages, a step darker each press (and back to none after black)
  const BAR_STEPS = [0, 30, 55, 80, 100];
  const nextBars = (cur) => BAR_STEPS.find((x) => x > cur) ?? BAR_STEPS[0];
  const barsName = (bg) => "Bars behind the chat: " + (bg === 0 ? "none" : bg <= 30 ? "light" : bg <= 55 ? "medium" : bg < 100 ? "dark" : "black");
  const chat = { port: null, login: "", emotes: new Map(), box: null, pending: [], history: [], raf: 0, ws: null, state: "", why: "", got: 0, fallT: 0, statusT: 0 };
  // a small line at the top of the chat while it connects (and if it can't)
  const chatStatus = (text, sticky = false) => {
    const box = chatBox(); if (!box) return;
    let s = chat.lines.querySelector(".cstat");
    if (!text) { if (s) s.remove(); return; }
    if (!s) { s = el("div", "cstat"); chat.lines.prepend(s); }
    s.textContent = text; clearTimeout(chat.statusT);
    if (!sticky) chat.statusT = setTimeout(() => { if (s.isConnected) s.remove(); }, 4000);
  };
  const setChatState = (st, why = "") => {
    chat.state = st; chat.why = why;
    const pc = panelChat(), ps = pc && pc.querySelector(".cstat"); if (ps) { ps.textContent = chatStateText(); ps.hidden = !ps.textContent; }
    if (st === "connecting") chatStatus("Connecting to chat…", true);
    else if (st === "live") chatStatus(chat.got ? "" : "Connected to chat — waiting for messages");
    else if (st === "error") { chatStatus(`Chat couldn’t connect${why ? ` (${why})` : ""}`, true); logErr("twitch chat", new Error(why || st)); }
  };
  // Plan B: if the background can't reach the chat, this page reads it itself (same anonymous, read-only connection)
  const chatDirect = (login) => {
    if (chat.ws || !ui) return;
    let ws; try { ws = new WebSocket(SW.TWITCH_CHAT_WS); } catch (e) { setChatState("error", String((e && e.message) || e).slice(0, 120)); return; }
    chat.ws = ws; chat.direct = true; setChatState("connecting");
    if (chat.port) try { chat.port.postMessage({ quiet: true }); } catch {}
    ws.onopen = () => { ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands"); ws.send("PASS SCHMOOPIIE"); ws.send("NICK justinfan" + (10000 + Math.floor(Math.random() * 80000))); ws.send("JOIN #" + login); };
    ws.onmessage = (e) => {
      const list = [];
      for (const line of String(e.data).split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) { try { ws.send("PONG :tmi.twitch.tv"); } catch {} continue; }
        const p = SW.parseIrcLine(line); if (!p) continue;
        if (p.cmd === "JOIN") setChatState("live");
        else if (p.cmd === "ROOMSTATE" && /^\d{1,20}$/.test(p.tags["room-id"] || "")) { setChatState("live"); if (chat.port) try { chat.port.postMessage({ room: p.tags["room-id"] }); } catch {} }
        else if (p.cmd === "PRIVMSG") list.push(SW.chatMsg(p));
        else if (p.cmd === "CLEARMSG") list.push({ del: String(p.tags["target-msg-id"] || "") });
        else if (p.cmd === "CLEARCHAT") list.push({ clearUser: p.text.toLowerCase() });
      }
      if (list.length) onChat({ t: "msgs", list });
    };
    ws.onerror = () => setChatState("error", "this page couldn’t reach Twitch’s chat either");
    ws.onclose = () => { if (chat.ws === ws) chat.ws = null; };
  };
  const NAME_COLORS = ["#ff7a7a", "#ffb36b", "#ffe07a", "#8ee88e", "#6fd6ff", "#9ea7ff", "#d69bff", "#ff8fd1", "#7ff0d0", "#c4e17f"];
  const nameColor = (m) => {
    let c = m.color;
    if (!c) { let h = 0; for (const ch of m.user || m.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return NAME_COLORS[h % NAME_COLORS.length]; }
    // too dark to read on video: lift it
    const n = parseInt(c.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255, lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (lum < 140) { const t = (140 - lum) / (255 - lum), up = (x) => Math.round(x + (255 - x) * t); c = `rgb(${up(r)},${up(g)},${up(b)})`; } // mix in white until it reads well
    return c;
  };
  const emoteImg = (kind, id, name) => {
    if (!EMOTE_OK.test(id) || !EMOTE_URL[kind]) return document.createTextNode(name);
    const i = el("img", "emo"); i.alt = name; i.title = name; i.decoding = "async"; i.loading = "lazy";
    i.addEventListener("error", () => i.replaceWith(el("span", "emoalt", name))); // a picture that doesn't load: its name
    const url = EMOTE_URL[kind](id); i.src = url;
    return i;
  };
  // the message's text, with Twitch's own emotes (by position) and the others (by word) as pictures
  const chatText = (m) => {
    const cps = Array.from(m.text), marks = new Map();
    for (const part of (m.emotes || "").split("/")) {
      const [id, ranges] = part.split(":");
      if (!id || !ranges || !EMOTE_OK.test(id)) continue;
      for (const r of ranges.split(",")) { const [a, b] = r.split("-").map(Number); if (Number.isInteger(a) && Number.isInteger(b) && b >= a && b < cps.length) marks.set(a, [b, id]); }
    }
    const out = []; let word = "";
    const pushWord = () => {
      if (!word) return;
      for (const piece of word.split(/(\s+)/)) {
        const e = piece && chat.emotes.get(piece);
        if (e) out.push(emoteImg(e[0], e[1], piece)); else if (piece) out.push(document.createTextNode(piece));
      }
      word = "";
    };
    for (let i = 0; i < cps.length; i++) {
      const mk = marks.get(i);
      if (mk) { pushWord(); out.push(emoteImg("tw", mk[1], cps.slice(i, mk[0] + 1).join(""))); i = mk[0]; continue; }
      word += cps[i];
    }
    pushWord();
    return out;
  };
  // The chat over the video. While YTV's UI is up it shows a slim handle: drag it anywhere, pull its corner to resize,
  // ⤢ puts it back in its corner, ☰ moves it into the list panel. Only one chat shows at a time.
  // where this streamer's chat goes (and its own text size / bars): each stream looks different
  const myBox = () => (chat.login && cfg.tv.twitch.chat.boxes[chat.login]) || {};
  const placedBox = () => { const b = myBox(); return "x" in b ? b : cfg.tv.twitch.chat.box; };
  const setMyBox = (patch) => {
    const c = cfg.tv.twitch.chat;
    if (!chat.login) { if ("x" in patch) c.box = patch.x === null ? null : patch; return; }
    const b = { ...(c.boxes[chat.login] || {}), ...patch };
    for (const k of Object.keys(patch)) if (patch[k] === null) delete b[k];
    c.boxes = { ...c.boxes, [chat.login]: b };
  };
  const chatBox = () => {
    if (!ui) return null;
    if (!chat.login) { if (chat.box) { chat.box.remove(); chat.box = null; } return null; } // no chat running: nothing on screen
    if (!chat.box || !chat.box.isConnected) {
      chat.box = el("div", "twchatov"); chat.box.setAttribute("aria-live", "off");
      chat.lines = el("div", "lines");
      const bar = el("div", "chdl"), grip = el("div", "chgrip");
      const size = (d) => { const cur = myBox().size || cfg.tv.twitch.chat.size; setMyBox({ size: Math.max(6, Math.min(120, cur + d)) }); chatBox(); writeCfg(); };
      const bgNext = () => { const bg = nextBars(myBox().bg ?? cfg.tv.twitch.chat.bg); setMyBox({ bg }); chatBox(); writeCfg(); toast(barsName(bg)); };
      const txt = (t, title, fn) => btn(t, title, fn, "chb chbt");
      bar.append(el("span", "chdt", "Chat"), txt("A−", "Smaller text (for this streamer)", () => size(-1)), txt("A+", "Bigger text (for this streamer)", () => size(+1)), txt("◐", "Bars behind the messages: none / light / medium / dark (for this streamer)", bgNext));
      chat.box.append(bar, chat.lines, grip);
      chatDrag(bar, "move"); chatDrag(grip, "size");
      chat.box.hidden = true; // (filled below as it shows)
      ui.root.append(chat.box);
    }
    const c = cfg.tv.twitch.chat, b = placedBox(), mine = myBox(), s = chat.box.style;
    chat.box.classList.toggle("right", c.side === "right" && !b);
    chat.box.classList.toggle("placed", !!b);
    if (b) { s.left = b.x * 100 + "%"; s.top = b.y * 100 + "%"; s.width = b.w * 100 + "%"; s.height = b.h * 100 + "%"; s.bottom = "auto"; s.right = "auto"; s.maxHeight = "none"; }
    else for (const k of ["left", "top", "width", "height", "bottom", "right", "maxHeight"]) s[k] = "";
    s.setProperty("--cfs", (mine.size || c.size) + "px"); s.setProperty("--cbg", ((mine.bg ?? c.bg) / 100).toFixed(2));
    const hide = !c.show || (state.panel === "comments" && ui.root.classList.contains("on-twitch")); // the panel's chat is open: just that one
    if (chat.box.hidden && !hide) { // shown (again, or moved here from the panel): what was said so far, not an empty box
      chat.lines.replaceChildren(...[...chat.lines.children].filter((n) => n.classList.contains("cstat")));
      if (chat.history.length) applyBatch(chat.lines, chat.history.slice(-60), b ? 0 : Number(c.life) || 0, b ? 120 : Number(c.max) || 14);
    }
    chat.box.hidden = hide;
    return chat.box;
  };
  const chatDrag = (handle, mode) => handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest("button")) return;
    e.preventDefault();
    const box = chat.box, r = box.getBoundingClientRect(), W = window.innerWidth, H = window.innerHeight, x0 = e.clientX, y0 = e.clientY;
    box.classList.add("placed", "dragging");
    const at = (ev) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0;
      const nb = mode === "move" ? { x: (r.left + dx) / W, y: (r.top + dy) / H, w: r.width / W, h: Math.max(r.height, 220) / H } : { x: r.left / W, y: r.top / H, w: Math.max(160, r.width + dx) / W, h: Math.max(90, r.height + dy) / H };
      nb.x = Math.min(0.95, Math.max(0, nb.x)); nb.y = Math.min(0.95, Math.max(0, nb.y)); nb.w = Math.min(1, nb.w); nb.h = Math.min(1, nb.h);
      return nb;
    };
    // a see-through sheet over everything while dragging, so the stream's player can't swallow the movement
    const shield = el("div", "dragshield"); shield.style.cursor = mode === "move" ? "grabbing" : "nwse-resize"; ui.root.append(shield);
    let last = e;
    const move = (ev) => { last = ev; setMyBox(at(ev)); chatBox(); };
    const up = () => { window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true); window.removeEventListener("blur", up); shield.remove();
      box.classList.remove("dragging"); setMyBox(at(last)); chatBox(); writeCfg(); };
    window.addEventListener("pointermove", move, true); window.addEventListener("pointerup", up, true); window.addEventListener("blur", up);
  });
  const chatLine = (m, life) => {
    const line = el("div", "cm" + (m.me ? " me" : ""));
    line.dataset.mid = m.id; line.dataset.user = (m.user || "").toLowerCase();
    const nm = el("b", null, m.name || m.user); nm.style.color = nameColor(m);
    const tx = el("span", "ct"); tx.append(...chatText(m));
    line.append(nm, tx);
    if (life) { line.style.setProperty("--life", life + "s"); line.addEventListener("animationend", (e) => { if (e.animationName === "cmout") line.remove(); }); }
    return line;
  };
  // the chat in the list panel (O): the same messages, kept longer, scrolling along unless you scrolled up to read
  const PANEL_MAX = 150;
  const panelChat = () => (ui && state.panel === "comments" ? ui.pbody.querySelector(".twchatp") : null);
  // Put a batch of messages into a chat (deletions first), then trim it once: cheap even when chat flies by.
  // A big batch shows without the slide-in, and only its last part (the rest would be gone the same frame).
  const applyBatch = (box, list, life, max) => {
    const add = [];
    for (const m of list) {
      if (m.del) { const i = add.findIndex((x) => x.id === m.del); if (i >= 0) add.splice(i, 1); else for (const n of box.children) if (n.dataset.mid === m.del) { n.remove(); break; } continue; }
      if (m.clearUser) { for (let i = add.length - 1; i >= 0; i--) if ((add[i].user || "").toLowerCase() === m.clearUser) add.splice(i, 1); for (const n of [...box.children]) if (n.dataset.user === m.clearUser) n.remove(); continue; }
      if (m.text) add.push(m);
    }
    if (!add.length) return;
    const frag = document.createDocumentFragment(), still = add.length > 12;
    for (const m of add.slice(-max)) { const l = chatLine(m, life); if (still) l.classList.add("still"); frag.append(l); }
    box.append(frag);
    let extra = box.childElementCount - max - (box.querySelector(":scope > .cstat") ? 1 : 0);
    while (extra-- > 0) { const f = box.firstElementChild; if (!f) break; if (f.classList.contains("cstat")) { const n2 = f.nextElementSibling; if (!n2) break; n2.remove(); } else f.remove(); }
  };
  const drawChat = () => {
    chat.raf = 0;
    if (!chat.login || !ui) { chat.pending = []; return; } // the chat was closed meanwhile: nothing comes back
    const list = chat.pending.splice(0), c = cfg.tv.twitch.chat;
    for (const m of list) { if (m.text) chat.history.push(m); else if (m.del) chat.history = chat.history.filter((x) => x.id !== m.del); else if (m.clearUser) chat.history = chat.history.filter((x) => (x.user || "").toLowerCase() !== m.clearUser); }
    if (chat.history.length > PANEL_MAX) chat.history.splice(0, chat.history.length - PANEL_MAX);
    const box = chatBox();
    // moved somewhere of its own (a pop-out): it keeps the messages, as many as fit; in its corner they fade as set
    const placed = !!placedBox(), max = placed ? 120 : Number(c.max) || 14, life = placed ? 0 : Number(c.life) || 0;
    if (box && c.show) applyBatch(chat.lines, list, life, max);
    const pc = panelChat();
    if (pc) {
      const atEnd = ui.pbody.scrollHeight - ui.pbody.scrollTop - ui.pbody.clientHeight < 40;
      applyBatch(pc, list, 0, PANEL_MAX);
      if (atEnd) ui.pbody.scrollTop = ui.pbody.scrollHeight;
    }
  };
  const chatStateText = () => chat.state === "error" ? `Chat couldn’t connect${chat.why ? ` (${chat.why})` : ""}` : chat.state === "live" || chat.got ? "" : "Connecting to chat…";
  const panelChatLook = () => { const pc = ui && ui.pbody.querySelector(".twchatp"), c = cfg.tv.twitch.chat; if (pc) { pc.style.setProperty("--cfs", c.panelSize + "px"); pc.style.setProperty("--cbg", (c.panelBg / 100).toFixed(2)); } };
  const renderTwitchChatPanel = (v) => {
    startChat(v); // (a different stream: its own chat, from the start)
    const box = el("div", "twchatp"), c = cfg.tv.twitch.chat;
    const ctl = el("div", "chctl"), txt = (t, title, fn) => btn(t, title, fn, "chb chbt");
    const set = async (patch) => { Object.assign(cfg.tv.twitch.chat, patch); panelChatLook(); await writeCfg(); };
    ctl.append(txt("A−", "Smaller text", () => set({ panelSize: Math.max(6, c.panelSize - 1) })), txt("A+", "Bigger text", () => set({ panelSize: Math.min(120, c.panelSize + 1) })),
      txt("◐", "Bars behind the messages: none / light / medium / dark / black", () => { const bg = nextBars(c.panelBg); set({ panelBg: bg }); toast(barsName(bg)); }));
    box.append(ctl);
    const st = el("div", "cstat", chatStateText()); st.hidden = !st.textContent;
    box.append(st);
    for (const m of chat.history) box.append(chatLine(m, 0));
    ui.pbody.replaceChildren(box);
    panelChatLook();
    ui.pbody.scrollTop = ui.pbody.scrollHeight;
  };
  const onChat = (msg) => {
    if (!msg || typeof msg !== "object" || !ui) return;
    if (msg.t === "state" && typeof msg.s === "string") {
      if (chat.direct) return; // the page has its own connection now
      setChatState(msg.s, typeof msg.why === "string" ? msg.why.slice(0, 160) : "");
      if (msg.s === "error" || msg.s === "closed") { clearTimeout(chat.fallT); chat.fallT = setTimeout(() => { if (chat.state !== "live" && chat.login) chatDirect(chat.login); }, msg.s === "error" ? 300 : 2500); }
      return;
    }
    if (msg.t === "emotes" && msg.map && typeof msg.map === "object") {
      chat.emotes = new Map(Object.entries(msg.map).filter(([k, v]) => k.length <= 60 && Array.isArray(v) && EMOTE_URL[v[0]] && EMOTE_OK.test(v[1])));
    } else if (msg.t === "msgs" && Array.isArray(msg.list) && chat.login) {
      for (const m of msg.list) if (m && typeof m === "object") chat.pending.push({ id: String(m.id || ""), user: String(m.user || ""), name: String(m.name || ""), color: String(m.color || ""),
        emotes: String(m.emotes || ""), text: String(m.text || ""), me: !!m.me, del: m.del ? String(m.del) : "", clearUser: m.clearUser ? String(m.clearUser) : "" });
      if (chat.pending.length > 300) chat.pending.splice(0, chat.pending.length - 300);
      if (!chat.got && msg.list.length) { chat.got = msg.list.length; chatStatus(""); const pc = panelChat(), ps = pc && pc.querySelector(".cstat"); if (ps) ps.hidden = true; } else chat.got += msg.list.length;
      if (!chat.raf) chat.raf = requestAnimationFrame(drawChat);
    }
  };
  const stopChat = () => {
    if (chat.port) { try { chat.port.disconnect(); } catch {} }
    if (chat.ws) { const w = chat.ws; chat.ws = null; w.onclose = null; try { w.close(); } catch {} }
    clearTimeout(chat.fallT); clearTimeout(chat.statusT); cancelAnimationFrame(chat.raf); chat.raf = 0;
    chat.port = null; chat.login = ""; chat.pending = []; chat.history = []; chat.emotes = new Map(); chat.direct = false; chat.got = 0; chat.state = "";
    if (chat.box) { chat.box.remove(); chat.box = null; }
  };
  const startChat = (v) => {
    if (!ui || !v || !v.tw || v.off) return; // (always connected while a stream is on, so the panel's chat has what was said)
    if (chat.port && chat.login === v.login) { chatBox(); return; }
    stopChat();
    chat.login = v.login;
    chatBox(); setChatState("connecting");
    try { chat.port = chrome.runtime.connect({ name: "ytv-twchat" }); } catch { chatDirect(v.login); return; }
    // no word from the background within 6 s: read the chat from this page instead
    chat.fallT = setTimeout(() => { if (chat.state !== "live" && !chat.got && chat.login === v.login) chatDirect(v.login); }, 6000);
    chat.port.onMessage.addListener((m) => { if (chat.direct && m && m.t === "msgs") return; onChat(m); }); // once the page reads the chat itself, only emotes come this way
    const port = chat.port;
    port.onDisconnect.addListener(() => { // the browser restarted YTV's background part: connect again (or read the chat from here)
      if (chat.port !== port) return; chat.port = null;
      if (!chat.login || chat.ws) return;
      const who = chat.login, v2 = current();
      setTimeout(() => { if (ui && chat.login === who && !chat.port && !chat.ws) { if (v2 && v2.tw && v2.login === who) { const keep = chat.history; chat.login = ""; startChat(v2); chat.history = keep; } else chatDirect(who); } }, 1000);
    });
    const c = cfg.tv.twitch.chat;
    chat.port.postMessage({ join: v.login, want: { bttv: c.bttv, ffz: c.ffz, stv: c.stv, recent: c.recent } });
    chatBox();
  };
  const chatWanted = () => !!(cfg && (cfg.tv.twitch.chat.show || state.panel === "comments"));
  // O: a video's comments in the list panel; on a stream, its chat where you keep it (over the video, or in the list panel)
  const commentsOrChat = () => {
    const v = current();
    if (v && v.tw && ui.root.classList.contains("on-twitch") && cfg.tv.twitch.chat.where === "video") return toggleChat();
    togglePanel("comments");
  };
  // Shift+O on a stream: move the chat to the other place (and O toggles it there from then on)
  const moveChat = async () => {
    const c = cfg.tv.twitch.chat, v = current(); if (!v || !v.tw) return;
    c.where = c.where === "video" ? "panel" : "video";
    if (c.where === "panel") { c.show = false; if (state.panel !== "comments") togglePanel("comments"); chatBox(); }
    else { c.show = true; if (state.panel === "comments") showPanel(""); startChat(v); chatBox(); }
    toast(c.where === "video" ? "Chat over the video (O shows and hides it)" : "Chat in the list panel (O shows and hides it)");
    await writeCfg();
  };
  const toggleChat = async () => {
    const c = cfg.tv.twitch.chat; c.show = !c.show;
    const v = current();
    if (c.show) startChat(v); else if (state.panel !== "comments") stopChat(); chatBox();
    toast(c.show ? "Chat over the video: on" : "Chat over the video: off");
    await writeCfg();
  };
  // ---------------------------------------------------------------- tuning
  let pendingFirst = null; // { v, t, similar }: a video from the normal page that TV should start with
  let pendingLineup = null; // { id, items }: the list you were looking at in a channel's tab, played as you saw it
  const similarForFirst = async (v) => { // only this creator's videos, then Back returns to the channel
    if (!ui || !current() || current().id !== v.id) return;
    await exploreCreator();
  };
  const tune = async (i) => {
    const cols = chans();
    if (!cols.length) return;
    const leaving = currentCol();
    const nextIdx = ((i % cols.length) + cols.length) % cols.length;
    if (leaving && leaving.id === cols[nextIdx].id && state.queue.length) { showNow(); return; } // already on this channel
    const col = cols[nextIdx];
    if (col.feed && !feedStore.length && !pendingFirst && !(leaving && leaving.feed)) { // nothing in your Feed yet: show where to find videos instead
      toast(`Your ${col.name} is empty — swipe videos to the right in any channel to add them`);
      if (leaving && !isListTab(state.panel)) showPanel("src:" + leaving.id);
      else if (!leaving) { const first = cols.find((c) => !c.feed); if (first) return tune(cols.indexOf(first)); }
      return;
    }
    if (leaving && leaving.feed) syncFeed();
    if (leaving && leaving.twitch) { delete state.mem[leaving.id]; browse.delete(leaving.id); } // who's live changes: Twitch is always looked up fresh
    else if (leaving && state.queue.length) { state.mem[leaving.id] = snapshot(); browse.delete(leaving.id); } // its tab shows the list you left
    const follow = isListTab(state.panel) && (state.panel === playingTab() || state.panel === "src:" + col.id);
    let feedT = 0;
    if (col.feed) { // your Feed may have changed since: always start from it (where you were, if it's the same video)
      const fm = state.mem[FEED_ID];
      if (fm && fm.queue[fm.pos] && feedStore[0] && fm.queue[fm.pos].id === feedStore[0].id && Date.now() - fm.at < MEM_MS) feedT = fm.t || 0;
      delete state.mem[FEED_ID];
    }
    state.colId = col.id;
    clearUndo();
    if (follow) state.panel = "src:" + col.id;
    if (pendingFirst) delete state.mem[col.id];
    const m = state.mem[col.id];
    if (m && Date.now() - m.at < MEM_MS && m.queue.length) { // flip back: same video, same moment
      ++state.tuneToken;
      lsSet("hush:tv:last", col.id);
      state.queue = m.queue; state.pos = m.pos; state.history = m.history || []; state.stay = m.stay; state.base = m.base; state.from = m.from || null;
      ui.root.classList.remove("show-msg", "show-start");
      playCurrent(m.t || (current() && !current().tw ? resumeOf(current().id) : 0));
      return;
    }
    lsSet("hush:tv:last", col.id);
    const token = ++state.tuneToken;
    const live = () => ui && state.tuneToken === token;
    ui.root.classList.remove("show-msg", "show-start");
    const keeping = !!(pendingFirst && pendingFirst.keep);
    ui.curtain.style.display = keeping ? "none" : "";
    if (onWatchTv() && !keeping) cmd({ cmd: "pause" });
    ui.tTitle.textContent = `${col.num}  ${col.name}`;
    state.stay = null; state.base = null; state.from = null;
    ui.tSub.textContent = "Tuning in…";
    showNow();
    let started = false;
    const start = (items, asSeen = false) => {
      if (!live() || started) return;
      let pf = pendingFirst;
      if (pf && col.twitch && !pf.v.tw) { pf = null; pendingFirst = null; } // a YouTube video never goes into the Twitch list
      if (!pf && !items.length) return;
      started = true;
      if (pf && col.twitch) { // Twitch: the list stays as it is; you're just on the one you picked
        pendingFirst = null;
        state.queue = items.some((x) => x.id === pf.v.id) ? items : [pf.v, ...items];
        state.pos = Math.max(0, state.queue.findIndex((x) => x.id === pf.v.id));
      } else if (pf) { // the video you were watching goes first, then this channel carries on
        pendingFirst = null;
        const rest = items.filter((x) => x.id !== pf.v.id);
        state.queue = [pf.v, ...(col.shuffle && !asSeen ? rest.sort(() => Math.random() - 0.5) : rest)]; state.pos = 0;
      } else {
        state.queue = col.shuffle && !asSeen ? [...items].sort(() => Math.random() - 0.5) : items;
        let p0 = filterFor(col) ? items.findIndex((v) => !played.has(v.id) && passFilter(v)) : -1; // the first one that gets through your filters
        if (p0 < 0) p0 = items.findIndex((v) => !played.has(v.id));
        state.pos = col.feed || col.twitch ? 0 : Math.max(0, p0);
      }
      state.history = [];
      state.lastEvt = "";
      playCurrent(pf ? pf.t : feedT || (current() && !current().tw ? resumeOf(current().id) : 0), !!(pf && pf.keep));
      if (pf && pf.similar) similarForFirst(pf.v);
    };
    // a list you've already seen in the channel's tab plays exactly as you saw it: nothing is loaded again or reshuffled
    const seenList = (pendingLineup && pendingLineup.id === col.id && pendingLineup.items) || (!col.feed && browse.get(col.id) && browse.get(col.id).items.length ? browse.get(col.id).items.slice() : null);
    pendingLineup = null;
    if (seenList && seenList.length) { browse.delete(col.id); return start(seenList, true); }
    const items = await buildLineup(col, (what) => live() && (ui.tSub.textContent = `Tuning in… ${what}`), start);
    if (!live()) return;
    if (!items.length && pendingFirst) return start([]);
    if (!items.length) {
      ui.curtain.style.display = "none";
      const filtered = col.skipSeen || col.maxAge !== "any";
      message(`Nothing on “${col.name}” right now`, filtered && (sourcesOf(col).length || col.homeFeed)
        ? `Nothing left after your filters (${[col.maxAge !== "any" && "only recent videos", col.skipSeen && "skip videos you’ve seen"].filter(Boolean).join(", ")}). Loosen them for this channel in YTV settings, or add more topics.`
        : col.homeFeed ? "YouTube didn’t return any home recommendations. Make sure you’re signed in, or try again in a moment." : sourcesOf(col).length
        ? "YouTube returned no videos for these topics or creators. Try another spelling, or add more topics in YTV settings."
        : "Add topics or creators to this channel in YTV settings.");
      return;
    }
    if (!started) return start(items);
    if (state.stay || col.feed) return; // already on a topic path (or your own Feed): leave that list alone
    // the rest of the lineup arrived: it joins the end, and what you already see never moves
    const have = new Set(state.queue.map((v) => v.id)), add = items.filter((v) => !have.has(v.id));
    if (!add.length) return;
    state.queue.push(...add);
    saveSession();
    refreshList();
  };
  // Channel up / down. An empty Feed is skipped.
  // , and . walk through the list's tabs (only looking); with Shift they switch channel and play it
  // , and . walk through the list's tabs (only looking); with Shift they go there and play its first video
  const stepTab = (d, play = false) => {
    if (!state.panel || !isListTab(state.panel)) { showPanel(playingTab()); if (!play) return; }
    const tabsNow = [...ui.ptabs.querySelectorAll(".tab:not(.add)")];
    if (tabsNow.length < 2) return;
    let i = tabsNow.findIndex((b) => b.getAttribute("aria-selected") === "true");
    if (i < 0) i = 0;
    const b = tabsNow[(i + d + tabsNow.length) % tabsNow.length];
    closeChanMenu(); b.click(); b.blur();
    b.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (play) playFirstInTab(state.panel);
  };
  const playFirstInTab = async (tab) => {
    for (let k = 0; k < 40; k++) { // its list may still be loading
      if (!ui || state.panel !== tab) return;
      const w = [...ui.pbody.querySelectorAll(":scope > .lbox > .list > .sw:not(.gone)")].find((x) => !x.querySelector(".item.done") && !x.classList.contains("twoff"));
      const api = w && rowApi.get(w);
      if (api) { api.open(); return; }
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  // Full screen uses YouTube's own full-screen mode, so YouTube enters and leaves it cleanly (including
  // macOS Spaces swipes). The TV overlay moves into YouTube's full-screen view so it stays visible.
  const toggleFullscreen = () => {
    const b = document.querySelector("#movie_player .ytp-fullscreen-button");
    if (b) return b.click();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  // After full screen changes or the tab comes back, YouTube's player can be left with a stale size, or the
  // browser can drop the video layer (black picture, sound still playing). Make YouTube re-measure, then redraw.
  let repairTimers = [];
  const repairPlayer = () => {
    repairTimers.forEach(clearTimeout);
    repairTimers = [0, 200, 700, 1500].map((ms) => setTimeout(() => {
      if (onWatchTv() && !document.fullscreenElement) { // the page can't scroll in TV: a leftover scroll offset shows black
        window.scrollTo(0, 0);
        if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
      }
      window.dispatchEvent(new Event("resize"));
      if (ms >= 200) cmd({ cmd: "repaint" });
    }, ms));
  };
  const onFullscreenChange = () => {
    if (!ui) return;
    const fe = document.fullscreenElement;
    const target = fe && fe !== document.documentElement && fe.nodeType === 1 ? fe : document.documentElement;
    if (ui.host.parentNode !== target) target.appendChild(ui.host); // keep the overlay inside the full-screen view
    if (menu && menu.parentNode !== target) target.appendChild(menu);
    repairPlayer();
    wake();
  };
  const onVisible = () => { if (ui && document.visibilityState === "visible") repairPlayer(); };

  // ---------------------------------------------------------------- keys
  // Keys come from your settings (YTV settings → Keyboard shortcuts), or can be turned off.
  // YouTube's own player keys (arrows, M, J/K/L, C, 0–9…) are never taken. Escape always closes / turns TV off.
  const keyOf = (action) => (cfg && cfg.tv.keys[action]) || "";
  const keyName = (action) => { const k = keyOf(action); return !k || !cfg.tv.keysOn ? "the button" : k.length === 1 ? k.toUpperCase() : k.replace("Page", "Page "); };
  const ACTIONS = {
    chUp: () => stepTab(+1), chDown: () => stepTab(-1), next: () => nextVideo(), prev: () => prevVideo(),
    list: () => toggleList(), info: () => togglePanel("info"), comments: () => commentsOrChat(), explore: () => exploreKey(),
    back: () => backToMix(), toggle: () => closeTv(), autohide: () => cycleHide(), history: () => togglePanel("history"), sorting: () => toggleSorting(), overview: () => showGuide(!ui.root.classList.contains("show-guide")), fullscreen: () => toggleFullscreen(),
  };
  // E: on the Twitch tab (or with a stream on and no panel open) it finds streamers; anywhere else it explores YouTube
  const exploreKey = () => {
    const twTab = "src:" + TWITCH_ID, onStream = !!(current() && current().tw) && !state.panel;
    if (cfg.tv.twitch.enabled && (state.panel === twTab || onStream)) {
      if (state.panel !== twTab) { showPanel(twTab); return setTimeout(() => openTwBrowse(), 0); }
      return toggleTwBrowse();
    }
    return ui.explore.hidden ? openExplore() : closeExplore();
  };
  const escape = () => {
    if (clearPicks()) return;
    if (closeSettings() || closeFilter() || closeTwSearch()) return;
    if (ui.chmenu.classList.contains("on")) closeChanMenu();
    else if (!ui.pop.hidden) closePop();
    else if (!ui.explore.hidden) closeExplore();
    else if (ui.root.classList.contains("show-guide") && state.colId) showGuide(false);
    else if (state.panel) showPanel("");
    // (Esc never turns TV off: only YTV's own key, or the ✕, does)
  };
  const actionFor = (e) => {
    if (e.key === "Escape") return escape;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && /^[np]$/i.test(e.key)) return e.key.toLowerCase() === "n" ? () => nextVideo() : () => prevVideo();
    if (!cfg || !cfg.tv.keysOn) return null;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (e.shiftKey && e.code === "KeyO" && ui.root.classList.contains("on-twitch")) return () => moveChat(); // Shift+O: the chat moves between the video and the list panel
    if (e.shiftKey && (e.code === "BracketLeft" || e.code === "BracketRight")) return () => historyStep(e.code === "BracketLeft" ? -1 : +1); // back / forward through everything you watched
    if (e.shiftKey) { // Shift + the tab keys: switch channel and play (Shift+, types "<", so look at the key itself too)
      const base = e.code === "Comma" ? "," : e.code === "Period" ? "." : e.code === "BracketLeft" ? "[" : e.code === "BracketRight" ? "]" : e.code && e.code.startsWith("Key") ? e.code.slice(3).toLowerCase() : e.code && e.code.startsWith("Digit") ? e.code.slice(5) : k;
      if (keyOf("explore") && base === keyOf("explore")) return () => { // Shift+E: search YouTube; on the Twitch tab, find streamers by name
        const twTab = "src:" + TWITCH_ID;
        if (cfg.tv.twitch.enabled && (state.panel === twTab || (current() && current().tw && !state.panel))) { if (state.panel !== twTab) { showPanel(twTab); return setTimeout(() => openTwSearch(), 0); } return toggleTwSearch(); }
        return openSearch();
      }; // Shift+E: search YouTube for videos
      if (keyOf("chUp") && base === keyOf("chUp")) return () => stepTab(+1, true);
      if (keyOf("chDown") && base === keyOf("chDown")) return () => stepTab(-1, true);
    }
    for (const [action, fn] of Object.entries(ACTIONS)) if (keyOf(action) && keyOf(action) === k) return fn;
    return null;
  };
  // The on / off key (default Y) also works while TV is off: on a video page TV starts over the video that's playing.
  const openKey = (e) => {
    if (ui || !cfg || !cfg.enabled || !cfg.tv.keysOn || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.composedPath()[0];
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable)) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (!keyOf("toggle") || keyOf("toggle") !== k) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (location.pathname === "/watch" && ID_RE.test(videoParam())) openVideoInTv(false); else openTv("last");
  };
  window.addEventListener("keydown", openKey, true);
  // a key pressed while Twitch's player had the focus, passed on by YTV's helper inside it
  state.forwardKey = (k) => {
    if (!ui) return;
    const fake = { key: k.key, code: k.code || "", shiftKey: !!k.shift, ctrlKey: !!k.ctrl, metaKey: !!k.meta, altKey: !!k.alt, repeat: false,
      composedPath: () => [document.body], preventDefault() {}, stopImmediatePropagation() {}, stopPropagation() {} };
    keyHandler(fake);
  };
  const keyHandler = (e) => { try { keyHandler0(e); } catch (err) { logErr("key", err); } };
  const keyHandler0 = (e) => {
    const t = e.composedPath()[0];
    if (!ui || (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable))) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && String(e.key).toLowerCase() === "z") { e.preventDefault(); e.stopImmediatePropagation(); undoLast(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === "Delete" || e.key === "Backspace") && deleteHovered()) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if ((e.code === "KeyA" || e.code === "KeyD") && !e.repeat && swipeHovered(e.code === "KeyA" ? "add" : "rm", e.shiftKey)) { e.preventDefault(); e.stopImmediatePropagation(); return; } // A / D: swipe the hovered row
    const twFn = ui.root.classList.contains("on-twitch") && !e.shiftKey ? twKey(e) : null; // pause, mute and volume for a Twitch stream
    if (twFn && !(e.key === " " && t && t.closest && t.closest("button"))) { e.preventDefault(); e.stopImmediatePropagation(); poke(); twFn(); return; }
    const fn = actionFor(e);
    if (fn) { e.preventDefault(); e.stopImmediatePropagation(); poke(); fn(); }
  };

  // ---------------------------------------------------------------- player events (main-world.js)
  document.addEventListener("ytv-evt", (e) => { try { onPlayerEvt(e); } catch (err) { logErr("player event", err); } });
  const onPlayerEvt = (e) => {
    if (!ui || !onWatchTv()) return;
    let d; try { d = JSON.parse(e.detail); } catch { return; }
    const v = current();
    // a stream is on: YouTube's own player (e.g. the page's video after a reload) stays paused and has no say
    if (ui.root.classList.contains("on-twitch") || (v && v.tw)) { if (d.evt === "playing" || d.evt === "time") cmd({ cmd: "pause" }); return; }
    if (d.evt === "time" && v && d.id === v.id && Number.isFinite(d.t)) {
      if (state.seekOnPlay && state.seekOnPlay.id === d.id) { const s0 = state.seekOnPlay; state.seekOnPlay = null; if (d.t < s0.at - 3) { cmd({ cmd: "seek", start: s0.at }); return; } }
      state.t = d.t;
      if (d.t >= 10 && !comments.has(v.id)) fetchComments(v);
      if (!played.has(v.id) && (d.t >= WATCHED_SECONDS || (Number(d.d) > 0 && d.t / d.d >= WATCHED_FRACTION))) { countWatched(v.id); refreshList(); }
      if (state.lastEvt !== "playing") { state.lastEvt = "playing"; ui.root.classList.remove("show-start"); ui.curtain.style.display = "none"; } // it's playing, whatever the overlay thought
      if (Number(d.d) > 0) saveProgress(v.id, (d.t / d.d) * 100);
      state.dur = Number(d.d) || 0;
      saveResume(v.id, d.t, state.dur);
      saveLast();
      return;
    }
    if (d.evt === "playing") {
      state.lastEvt = "playing";
      // YouTube labels a video's category on its page: skip music there too (lists don't say).
      const col0 = currentCol();
      if (cfg.tv.skipMusic && d.category === "Music" && v && d.id === v.id && col0 && !col0.watchLater && !col0.homeFeed && !col0.watchedChip && !v.f) {
        for (const k of [creatorKey(v.creator), creatorKey(d.author || v.channel)]) if (k) musicBy.add(k); // and everything else they post
        lsSet("hush:tv:musicby", [...musicBy].slice(-400));
        pruneMusic();
        toast("Skipping music"); skipped.add(v.id); return void nextVideo();
      }
      ui.root.classList.remove("show-start");
      ui.curtain.style.display = "none";
      if (v && d.id === v.id) {
        // Fill in anything the lineup didn't know (e.g. after "resume" on a fresh page).
        if (!v.title && d.title) v.title = String(d.title).slice(0, 200);
        if ((!v.channel || SW.yt.isStat(v.channel)) && d.author) v.channel = String(d.author).slice(0, 100);
        if (typeof d.publishDate === "string" && d.publishDate) { const rel = SW.yt.relativeDate(d.publishDate); if (rel) v.age = rel; if (Number.isFinite(Date.parse(d.publishDate))) v.pub = d.publishDate.slice(0, 40); }
        // the list didn't say how old it was (or said it wrongly): now YouTube does. Outside your date filter, or this
        // channel's "only videos from", and it came up by itself (you didn't pick it)? On to the next one.
        if (v.pub && !v.f && !v.nx && state.pickedId !== v.id) {
          const f0 = flt(), d0 = ageOf(v), lim0 = f0.ageN * (F_UNIT[f0.ageUnit] || 7);
          const outFilter = filterFor(col0) && f0.age !== "any" && d0 !== null && (f0.age === "within" ? d0 > lim0 : d0 <= lim0);
          if (outFilter || (col0 && !col0.feed && tooOld(col0, v))) { toast(outFilter ? "Skipping — outside your date filter" : "Skipping — older than this channel allows"); return void nextVideo(); } // (not remembered as skipped: change the filter and it can play again)
        }
        if (typeof d.desc === "string" && d.desc) state.desc[v.id] = d.desc.slice(0, 20000);
        if (Array.isArray(d.keywords) && d.keywords.length) v.keywords = d.keywords.filter((k) => typeof k === "string").slice(0, 30);
        if (!v.creator && typeof d.channelId === "string" && /^UC[\w-]{20,24}$/.test(d.channelId)) v.creator = "channel/" + d.channelId;
        showNow();
      }
    }
    if (d.evt === "ended" && v && d.id === v.id) countWatched(v.id);
    if ((d.evt === "ended" || d.evt === "error") && (!d.id || !v || d.id === v.id)) {
      if (d.evt === "error") toast("This video can’t play here — skipping");
      nextVideo();
    }
  };

  // ---------------------------------------------------------------- open / resume / close
  const pauseYouTube = () => document.querySelectorAll("video").forEach((v) => { try { v.pause(); } catch {} });
  const ensureUi = () => {
    if (ui) return;
    buildUi();
    watchButtons(false);
    window.addEventListener("keydown", keyHandler, true);
    window.addEventListener("click", onPageClick, true);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    startTwitchWatch();
    // Home, ready before you look: its tab and its card in the overview aren't empty (one more try if YouTube sent nothing)
    setTimeout(() => {
      const h = chanById(HOME_ID);
      if (!ui || !h || h.id === state.colId || (browse.get(h.id) || { items: [] }).items.length) return;
      loadBrowse(h, "open").then((n) => { if (!n && ui) setTimeout(() => ui && loadBrowse(h, "open").then(() => schedulePanel()), 3000); else schedulePanel(); });
    }, 2500);
    if (cfg && cfg.tv.twitch.enabled) for (const href of ["https://player.twitch.tv", "https://usher.ttvnw.net", "https://static-cdn.jtvnw.net"]) { // Twitch starts faster when the browser already knows the way
      if (document.head && !document.head.querySelector(`link[rel="preconnect"][href="${href}"]`)) { const l = document.createElement("link"); l.rel = "preconnect"; l.href = href; l.crossOrigin = ""; document.head.append(l); }
    }
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    if (!onWatchTv()) document.documentElement.style.overflow = "hidden";
  };

  // On a video page, TV starts right there: no reload, so the video you're watching keeps playing until TV picks something.
  const enterTvHere = () => {
    const h = document.documentElement;
    SW.tvActive = true;
    h.classList.add("ytv"); h.classList.remove("hush-wide"); h.setAttribute("data-ytv", "1");
    pageStyle();
    window.dispatchEvent(new Event("resize"));
  };
  const openTv = (colId) => {
    if (!cfg || !cfg.enabled) return;
    if (!ui && location.pathname === "/watch" && !onWatchTv()) enterTvHere();
    ensureUi();
    if (!onWatchTv()) pauseYouTube();
    const cols = chans();
    let i = cols.findIndex((c) => c.id === colId);
    if (i < 0 && colId === "last") {
      // carry on with the video you left, from where you were, with what came after it (no waiting for YouTube)
      const lp = lsGet(LAST_KEY, null);
      const li = lp && lp.v && typeof lp.v.id === "string" ? cols.findIndex((c) => c.id === lp.colId) : -1;
      if (li >= 0 && !pendingFirst && !(lp.v.tw && cols[li].twitch === false)) {
        i = li;
        const c = cols[li], next = (Array.isArray(lp.next) ? lp.next : []).filter((x) => x && typeof x.id === "string" && (c.feed || !inFeed(x.id)));
        if (!lp.v.tw && !lp.done) pendingFirst = { v: lp.v, t: resumeOf(lp.v.id) || lp.t || 0, similar: false };
        else if (lp.v.tw && c.twitch) pendingFirst = { v: lp.v, t: 0, similar: false };
        if (next.length && !c.twitch && !c.feed) pendingLineup = { id: c.id, items: next };
      }
      if (i < 0) i = cols.findIndex((c) => c.id === lsGet("hush:tv:last", ""));
    }
    if (i >= 0 && cols[i].twitch && pendingFirst && !pendingFirst.v.tw) i = cols.findIndex((c) => !c.feed && !c.twitch); // a YouTube video plays in a YouTube channel
    if (i < 0 && pendingFirst && cols.length) i = Math.max(0, cols.findIndex((c) => !c.feed));
    if (i >= 0) tune(i);
    if (i >= 0 && colId === "last") { // and the panel as you left it (the list, History, Info…)
      const lpn = lsGet("ytv:lastpanel", "");
      if (typeof lpn === "string" && lpn && lpn !== "comments") showPanel(lpn === "cont" ? CONT_TAB : lpn.startsWith("src:") && !chanById(lpn.slice(4)) ? playingTab() : lpn);
    }
    if (i >= 0) return;
    { ui.curtain.style.display = ""; ui.tTitle.textContent = "YTV"; ui.tSub.textContent = ""; showGuide(true); }
  };

  /** Straight to one Twitch stream (from a "went live" note). */
  const startOnTwitch = (v) => { pendingFirst = { v, t: 0, similar: false }; openTv(TWITCH_ID); };
  /** Open TV with the video you're watching now (from where you are in it); optionally followed by YouTube's recommendations for it. */
  const openVideoInTv = (withSimilar) => {
    if (!cfg || !cfg.enabled || location.pathname !== "/watch" || !ID_RE.test(videoParam())) return;
    const id = videoParam();
    const link = document.querySelector("ytd-watch-metadata ytd-channel-name a[href^='/']");
    const video = document.querySelector("#movie_player video, video");
    const v = {
      id, title: ((document.querySelector("ytd-watch-metadata h1") || {}).textContent || document.title.replace(/\s*-\s*YouTube$/, "")).trim().slice(0, 200),
      channel: link ? link.textContent.trim().slice(0, 100) : "",
      creator: link && /^\/(@[^/]+|channel\/UC[\w-]{20,24})/.test(link.getAttribute("href")) ? link.getAttribute("href").slice(1).split("/").slice(0, link.getAttribute("href").startsWith("/channel/") ? 2 : 1).join("/") : "",
      len: "", age: "", progress: 0, watched: false,
    };
    pendingFirst = { v, t: video && Number.isFinite(video.currentTime) ? Math.floor(video.currentTime) : 0, similar: !!withSimilar, keep: true };
    openTv("last");
  };

  const resume = () => {
    const sess = readSession();
    if (!sess) return;
    ensureUi();
    if (location.pathname === "/watch") pageStyle(); // (a stream can be on over any YouTube page)
    const cols = chans();
    state.colId = (cols.find((c) => c.id === sess.colId) || cols.find((c) => !c.feed) || cols[0] || {}).id || "";
    state.stay = sess.stay && typeof sess.stay === "object"
      ? (sess.stay.mode === "explore" ? { mode: "explore", query: String(sess.stay.query || "").slice(0, 80), by: typeof sess.stay.by === "string" ? sess.stay.by.slice(0, 80) : "" } : { mode: "similar", title: String(sess.stay.title || "").slice(0, 120), by: typeof sess.stay.by === "string" ? sess.stay.by.slice(0, 80) : "" })
      : null;
    state.base = Array.isArray(sess.base) ? sess.base.filter((v) => v && isItem(v.id)) : null;
    state.from = sess.from && sess.from.item && ID_RE.test(sess.from.item.id) ? { item: sess.from.item, t: Number(sess.from.t) || 0 } : null;
    state.queue = sess.queue.filter((v) => v && isItem(v.id) && !(currentCol() && currentCol().twitch && !v.tw)); // (the Twitch list only holds streams)
    state.pos = Math.min(Math.max(0, sess.pos | 0), Math.max(0, state.queue.length - 1));
    { const col0 = currentCol(); if (col0) { const keep = state.queue[state.pos]; state.queue = state.queue.filter((v, i) => i <= state.pos || v.f || !isBlocked(col0, v)); state.pos = Math.max(0, state.queue.indexOf(keep)); } } // creators you hid since
    state.history = (Array.isArray(sess.history) ? sess.history : []).filter((n) => Number.isInteger(n) && n >= 0 && n < state.queue.length);
    state.mem = sess.mem && typeof sess.mem === "object" ? Object.fromEntries(Object.entries(sess.mem).filter(([k, m]) => /^[\w-]{1,24}$/.test(k) && m && Array.isArray(m.queue))
      .map(([k, m]) => [k, { ...m, queue: m.queue.filter((v) => v && isItem(v.id)) }])) : {};
    state.xtabs = (Array.isArray(sess.xtabs) ? sess.xtabs : []).filter((x) => x && /^[\w]{1,12}$/.test(x.id) && typeof x.query === "string" && Array.isArray(x.items))
      .slice(0, 6).map((x) => ({ id: x.id, query: x.query.slice(0, 80), by: typeof x.by === "string" ? x.by.slice(0, 80) : "", items: x.items.filter((v) => v && ID_RE.test(v.id)) }));
    state.t = 0;
    if (videoParam() && current() && current().id !== videoParam()) {
      const i = state.queue.findIndex((v) => v.id === videoParam());
      if (i >= 0) state.pos = i;
    }
    // a reload (or coming back from a stream on another page): the video carries on where you were, not from the start
    { const c0 = current(); state.seekOnPlay = null;
      if (c0 && !c0.tw) { const at = Math.max(resumeOf(c0.id), c0.id === videoParam() ? Number(sess.t) || 0 : 0); if (at > 5 && !new URLSearchParams(location.search).get("t")) state.seekOnPlay = { id: c0.id, at }; } }
    ui.curtain.style.display = "none";
    showNow();
    clearTimeout(state.startTimer);
    if (current() && current().tw) playTwitch(current()); // a stream was on (or picked from another page): Twitch's player goes back over the page
    else armStart(6000);
    window.dispatchEvent(new Event("resize")); // let YouTube size the player to the full screen
    const col = currentCol();
    if (col && !col.homeFeed && !col.feed && !state.stay && state.queue.length < 15) buildLineup(col, () => {}, () => {}).then((items) => { // finish a lineup cut short by the page change
      if (!ui || !items.length) return;
      const have = new Set(state.queue.map((v) => v.id)), add = items.filter((v) => !have.has(v.id));
      if (!add.length) return;
      state.queue.push(...add); // joins the end; nothing you see moves
      saveSession();
      refreshList();
    });
  };

  const closeTv = () => {
    if (!ui) return;
    saveLast(true);
    syncFeed();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    window.removeEventListener("keydown", keyHandler, true);
    window.removeEventListener("click", onPageClick, true);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", onVisible);
    repairTimers.forEach(clearTimeout);
    if (controlsObs) { controlsObs.disconnect(); controlsObs = null; }
    clearTimeout(state.hideTimer); clearTimeout(state.startTimer); clearTimeout(state.toastTimer);
    if (state.offPage) { state.offPage(); state.offPage = null; }
    hideTwitch(); // Twitch's player, the chat connection and its timers go too
    stopTwitchWatch(); state.mouseOut = false;
    ui.host.remove();
    ui = null;
    const wasWatch = onWatchTv();
    const id = current() && !current().tw && ID_RE.test(current().id) ? current().id : ""; // (a Twitch stream has no YouTube page to go to: you stay where you are)
    if (wasWatch && !(current() && current().tw) && (!id || id === videoParam())) cmd({ cmd: "play" }); // same video as the page: simply carry on
    const leaveTo = wasWatch && id && id !== videoParam() ? id : "", leaveAt = Math.floor(state.t);
    if (leaveTo) cmd({ cmd: "navigate", id: leaveTo, start: leaveAt }); // the normal page of what's playing, without a reload
    writeSession(null);
    SW.tvActive = false;
    watchButtons(true); setTimeout(syncButtons, 0);
    document.documentElement.classList.remove("ytv", "ytv-still");
    document.documentElement.removeAttribute("data-ytv");
    document.documentElement.style.overflow = "";
    document.documentElement.style.overscrollBehaviorX = ""; if (document.body) document.body.style.overscrollBehaviorX = "";
    const st = document.getElementById("ytv-page"); st && st.remove();
    if (!leaveTo && state.origTitle) document.title = state.origTitle;
    document.dispatchEvent(new Event("ytv-closed")); // lets the normal page layout (wide / theater) come back
    if (leaveTo) setTimeout(() => { // if YouTube didn't take the in-page jump, fall back to a normal page load
      if (!ui && location.pathname === "/watch" && videoParam() !== leaveTo) location.assign(`/watch?v=${leaveTo}${leaveAt > 5 ? "&t=" + leaveAt + "s" : ""}`);
    }, 2200);
    else window.dispatchEvent(new Event("resize"));
    Object.assign(state, { colId: "", queue: [], pos: 0, history: [], panel: "", stay: null, xtabs: [], base: null, mem: {}, t: 0, tuneToken: state.tuneToken + 1 });
    tabsSig = ""; browse.clear();
  };
  SW.openTv = openTv;

  // =====================================================================================
  // Buttons on YouTube: top bar (next to your channel icon, with a channel menu) and sidebar
  // =====================================================================================
  const NS = "http://www.w3.org/2000/svg";
  const tvIcon = (size) => {
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("width", size); svg.setAttribute("height", size);
    svg.setAttribute("fill", "none"); svg.setAttribute("aria-hidden", "true");
    // the YTV mark: a TV with a red play button, on a little stand
    const add = (tag, a) => { const n = document.createElementNS(NS, tag); for (const k in a) n.setAttribute(k, a[k]); svg.appendChild(n); };
    add("rect", { x: 2.5, y: 4, width: 19, height: 13, rx: 3, stroke: "currentColor", "stroke-width": 1.9 });
    add("path", { d: "M10 8.2v5.6l4.6-2.8z", fill: "#f22a2a", stroke: "#f22a2a", "stroke-width": 1.2, "stroke-linejoin": "round" });
    add("path", { d: "M8.5 20.5h7", stroke: "currentColor", "stroke-width": 1.9, "stroke-linecap": "round" });
    return svg;
  };
  const makeSideEntry = (mini) => {
    const a = document.createElement("a");
    a.id = mini ? "ytv-mini" : "ytv-entry";
    a.href = "#"; a.setAttribute("role", "button"); a.title = "YTV";
    const label = document.createElement("span"); label.textContent = "YTV";
    a.append(tvIcon(24), label);
    a.style.cssText = mini
      ? "display:flex;flex-direction:column;align-items:center;gap:6px;padding:16px 0 14px;color:var(--yt-spec-text-primary,#f1f1f1);text-decoration:none;font:10px Roboto,Arial,sans-serif;border-radius:10px;width:64px"
      : "display:flex;align-items:center;gap:24px;height:40px;padding:0 12px;margin:0 12px 4px;color:var(--yt-spec-text-primary,#f1f1f1);text-decoration:none;font:14px Roboto,Arial,sans-serif;border-radius:10px;background:var(--yt-spec-badge-chip-background,rgba(255,255,255,.1))";
    a.addEventListener("click", (e) => { e.preventDefault(); openTv("last"); });
    appear(a);
    return a;
  };
  const appear = (n) => { try { n.animate([{ opacity: 0, transform: "scale(.9)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: "cubic-bezier(.4,0,.2,1)" }); } catch {} };
  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; document.removeEventListener("mousedown", outside, true); } };
  const outside = (e) => { if (menu && !e.composedPath().includes(menu) && !e.composedPath().some((n) => n.id === "ytv-header")) closeMenu(); };
  const openMenu = (anchor) => {
    closeMenu();
    menu = document.createElement("div");
    menu.id = "ytv-menu";
    const shadow = menu.attachShadow({ mode: "open" });
    const r = anchor.getBoundingClientRect();
    const st = el("style");
    st.textContent = `:host{all:initial}
      .m{position:fixed;top:${Math.round(r.bottom + 8)}px;right:${Math.max(8, Math.round(innerWidth - r.right))}px;z-index:2147483647;width:270px;max-height:70vh;overflow:auto;
        padding:8px;border-radius:14px;background:#1d1f26;border:1px solid #3a3d48;box-shadow:0 12px 32px rgba(0,0,0,.45);font:14px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e0ebf6}
      .t{padding:8px 10px 6px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#aab3c4}
      button{display:flex;align-items:center;gap:12px;width:100%;min-height:44px;padding:0 10px;border:0;border-radius:10px;background:none;color:#fff;font:inherit;font-weight:600;text-align:left;cursor:pointer}
      button:hover,button:focus-visible{background:#5a2328;outline:none}
      .n{min-width:18px;color:#ff8a8a;font-weight:800} button:hover .n{color:#fff}
      .sep{height:1px;margin:6px 4px;background:#3a3d48} .muted{color:#aab3c4;font-weight:400}
      .e{padding:6px 10px 8px;color:#aab3c4;font-size:12px}`;
    const box = el("div", "m"); box.setAttribute("role", "menu");
    box.append(el("div", "t", "YTV"));
    if (!ui && location.pathname === "/watch" && ID_RE.test(videoParam())) { // on a video page: bring it into TV
      for (const [icon, label, topic] of [["▶", "Open this video in TV", false], ["👍", "Open in TV, then only this creator", true]]) {
        const b = el("button"); b.type = "button"; b.setAttribute("role", "menuitem");
        b.append(el("span", "n", icon), el("span", null, label));
        b.addEventListener("click", () => { closeMenu(); openVideoInTv(topic); });
        box.append(b);
      }
      box.append(el("div", "sep"));
    }
    const cols = chans();
    cols.forEach((c, i) => {
      const b = el("button"); b.type = "button"; b.setAttribute("role", "menuitem");
      b.append(el("span", "n", labelOf(i)), el("span", null, c.name));
      b.addEventListener("click", () => { closeMenu(); openTv(c.id); });
      box.append(b);
    });
    if (!cols.length) box.append(el("div", "e", "No channels yet — add some in YTV settings."));
    box.append(el("div", "sep"));
    const g = el("button"); g.type = "button"; g.setAttribute("role", "menuitem");
    g.append(el("span", "n", "▦"), el("span", "muted", "Channel overview"));
    g.addEventListener("click", () => { closeMenu(); openTv(""); });
    box.append(g);
    box.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeMenu(); anchor.focus(); } });
    shadow.append(st, box);
    document.documentElement.appendChild(menu);
    document.addEventListener("mousedown", outside, true);
    const first = box.querySelector("button"); first && first.focus();
  };
  const makeHeaderButton = () => {
    const b = document.createElement("button");
    b.id = "ytv-header"; b.type = "button"; b.title = "YTV";
    b.setAttribute("aria-label", "YTV channels"); b.setAttribute("aria-haspopup", "menu");
    b.append(tvIcon(24));
    b.style.cssText = "display:inline-grid;place-items:center;width:40px;height:40px;margin:0 8px 0 0;padding:0;border:0;border-radius:50%;background:transparent;color:var(--yt-spec-text-primary,#f1f1f1);cursor:pointer;flex:none";
    b.addEventListener("mouseenter", () => (b.style.background = "var(--yt-spec-badge-chip-background,rgba(255,255,255,.1))"));
    b.addEventListener("mouseleave", () => (b.style.background = "transparent"));
    b.addEventListener("click", () => (menu ? closeMenu() : openMenu(b)));
    appear(b);
    return b;
  };
  const btnPrefs = () => cfg ? { on: cfg.enabled, s: cfg.tv.sidebarButton, h: cfg.tv.headerButton } : lsGet("ytv:btns", { on: true, s: true, h: true });
  let watchButtons = () => {};
  const syncButtons = () => {
    const pr = btnPrefs(), on = pr.on;
    const wantSide = on && pr.s;
    const full = document.querySelector("ytd-guide-renderer #sections");
    const mini = document.querySelector("ytd-mini-guide-renderer #items");
    const have = document.getElementById("ytv-entry"), haveMini = document.getElementById("ytv-mini");
    if (!wantSide) { have && have.remove(); haveMini && haveMini.remove(); }
    else { if (full && !have) full.prepend(makeSideEntry(false)); if (mini && !haveMini) mini.prepend(makeSideEntry(true)); }
    const wantHead = on && pr.h;
    const hb = document.getElementById("ytv-header");
    if (!wantHead) { hb && hb.remove(); closeMenu(); return; }
    const buttons = document.querySelector("ytd-masthead #buttons");
    if (!buttons) return;
    const avatar = [...buttons.children].find((c) => c.querySelector("#avatar-btn, img, a[href*='ServiceLogin']"));
    if (hb && hb.parentNode === buttons && (!avatar || hb.nextElementSibling === avatar)) return;
    const b = hb || makeHeaderButton();
    avatar ? buttons.insertBefore(b, avatar) : buttons.appendChild(b);
  };

  // Health check (Settings → Health check): every way YTV reads YouTube, tried for real from this tab, with how long
  // it took and what came back. Nothing is changed on your account (Watch Later is only read).
  const healthCheck = async () => {
    const out = [], t0 = Date.now();
    const run = async (name, fn) => {
      const t = performance.now();
      try { const r = await fn(); out.push({ name, ok: !!r.ok, detail: String(r.detail || "").slice(0, 300), ms: Math.round(performance.now() - t) }); return r; }
      catch (e) { out.push({ name, ok: false, detail: "Error: " + String((e && e.message) || e).slice(0, 300), ms: Math.round(performance.now() - t) }); return {}; }
    };
    const signedIn = /(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=/.test(document.cookie);
    await run("Signed in to YouTube", async () => ({ ok: signedIn, detail: signedIn ? "yes" : "no — Home, Subscriptions and Watch Later need you signed in" }));
    const home = await run("Home feed", async () => { const v = await SW.yt.videosAt("/"); return { ok: v.length > 0, detail: `${v.length} videos`, v }; });
    await run("Subscriptions", async () => { const v = await SW.yt.videosAt("/feed/subscriptions"); return { ok: v.length > 0, detail: `${v.length} videos` }; });
    const srch = await run("Search", async () => { const p = await SW.yt.videosPage("/results?search_query=nature%20documentary&sp=EgIQAQ%253D%253D"); return { ok: p.videos.length > 0, detail: `${p.videos.length} videos, ${p.more ? "can load more" : "no next page"}`, p }; });
    await run("Search: load more", async () => { const m = srch.p && srch.p.more ? await SW.yt.moreVideos(srch.p.more) : null; return { ok: !!m && m.videos.length > 0, detail: m ? `${m.videos.length} more videos` : "no next page to ask for" }; });
    const cre = await run("Creator’s videos", async () => { const p = await SW.yt.videosPage("/@YouTube/videos"); return { ok: p.videos.length > 0, detail: `${p.videos.length} videos from “${p.title}”, ${p.more ? "can load more" : "no next page"}`, p }; });
    await run("Creator’s videos: load more", async () => { const m = cre.p && cre.p.more ? await SW.yt.moreVideos(cre.p.more) : null; return { ok: !!m && m.videos.length > 0, detail: m ? `${m.videos.length} more videos` : "no next page to ask for" }; });
    const vid = ((home.v || []).concat((srch.p && srch.p.videos) || []))[0];
    await run("Video page and related videos", async () => { if (!vid) return { ok: false, detail: "no video to try" }; const r = await similarTo(vid.id); return { ok: r.length > 0, detail: `${r.length} related videos for ${vid.id}` }; });
    await run("Comments", async () => { if (!vid) return { ok: false, detail: "no video to try" }; const c = await SW.yt.commentsFor(await watchPage(vid.id)); return { ok: !!c && Array.isArray(c.comments), detail: c ? `${c.comments.length} comments` : "none" }; });
    await run("Channel names", async () => { if (!vid) return { ok: false, detail: "no video to try" }; const n = await SW.yt.channelNameOf(vid.id); return { ok: !!n, detail: n ? "found" : "not found" }; });
    await run("Watch Later (read only)", async () => { const w = await SW.yt.watchLater(); return { ok: !!w.ctx, detail: `${w.videos.length} videos${w.ctx ? "" : ", but no page settings (can’t edit it)"}` }; });
    await run("Your subscriptions (for the Subscribed filter)", async () => { const k = await SW.yt.subscribedChannels(); return { ok: k.length > 0, detail: `${k.length} names for your channels` }; });
    if (cfg && cfg.tv.twitch.enabled) await run("Twitch Live", async () => { const v = await twitchLive(true); return { ok: !twitchCache.err, detail: twitchCache.err ? "Error: " + twitchCache.err : `${v.filter((x) => !x.off).length} of ${cfg.tv.twitch.logins.length} streamers live` }; });
    if (cfg && cfg.tv.twitch.enabled) await run("Twitch chat (through YTV’s background)", () => new Promise((done) => {
      const who = (twitchCache.items[0] || {}).login || cfg.tv.twitch.logins[0] || "twitch";
      let port, seen = [], n = 0, emotes = -1;
      const end = (ok, detail) => { clearTimeout(t); try { port.disconnect(); } catch {} done({ ok, detail: `${detail} · #${who} · ${seen.join(" → ") || "no answer"}${emotes >= 0 ? ` · ${emotes} extra emotes` : ""}` }); };
      const t = setTimeout(() => end(n > 0 || seen.includes("live"), n ? `${n} messages in 8 s` : "no messages in 8 s"), 8000);
      try { port = chrome.runtime.connect({ name: "ytv-twchat" }); } catch (e) { clearTimeout(t); done({ ok: false, detail: "can’t reach YTV’s background: " + ((e && e.message) || e) }); return; }
      port.onMessage.addListener((m) => { if (!m) return; if (m.t === "state") seen.push(m.s + (m.why ? ` (${m.why})` : "")); if (m.t === "msgs") n += (m.list || []).length; if (m.t === "emotes") emotes = Object.keys(m.map || {}).length; });
      port.onDisconnect.addListener(() => { if (seen.length < 1) end(false, "the background closed the connection"); });
      port.postMessage({ join: who, want: { bttv: true, ffz: true, stv: true } });
    }));
    if (cfg && cfg.tv.twitch.enabled) await run("Twitch player and chat right now", async () => ({ ok: true,
      detail: `chat: ${chat.state || "not open"}${chat.why ? ` (${chat.why})` : ""}${chat.direct ? ", read by the page" : ""}, ${chat.got} messages · player said: ${twEvents.slice(-4).join(" | ") || "nothing"}` }));
    await run("YouTube page parts YTV uses", async () => {
      const parts = { "top bar buttons": "ytd-masthead #buttons", "sidebar": "ytd-guide-renderer #sections, ytd-mini-guide-renderer #items", "player": "#movie_player" };
      const miss = Object.entries(parts).filter(([k, sel]) => !document.querySelector(sel) && !(k === "player" && location.pathname !== "/watch")).map(([k]) => k);
      return { ok: !miss.length, detail: miss.length ? "missing: " + miss.join(", ") : "all found" + (location.pathname !== "/watch" ? " (player not checked: not on a video page)" : "") };
    });
    return { results: out, errors: lsGet("ytv:errors", []), page: location.pathname, ms: Date.now() - t0, ua: navigator.userAgent, lang: document.documentElement.lang || "" };
  };

  SW.ytvHealth = healthCheck; // (the settings page reaches it through the message below)
  // Relays for the settings page (messages from YTV itself only): creator search, and the health check.
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !msg) return;
    if (msg.ytv === "health") { healthCheck().then(sendResponse, (e) => sendResponse({ error: String(e) })); return true; }
    if (typeof msg.q !== "string" || msg.q.length > 120) return;
    if (msg.ytv === "searchCreators") { SW.yt.searchChannels(msg.q).then((r) => sendResponse({ results: r || [] })); return true; }
    if (msg.ytv === "relatedCreators") { SW.yt.relatedChannels(msg.q).then((r) => sendResponse({ results: r || [] })); return true; }
  });

  // =====================================================================================
  // Start
  // =====================================================================================
  let pendingOpen = null;
  const checkHash = () => {
    const m = location.hash.match(/#ytv(?:=([\w-]+))?(?:@([a-z0-9_]{2,25}))?/);
    if (!m) return;
    SW.tvOpening = true; document.documentElement.setAttribute("data-ytv-opening", "1"); // tells Hush (if installed) not to redirect this page away, e.g. home → Subscriptions
    history.replaceState(history.state, "", location.pathname + location.search);
    const go = () => { SW.tvOpening = false;
      if (m[2] && cfg && cfg.tv.twitch.enabled) { twitchLive(true).then((items) => { const v = items.find((x) => x.login === m[2]) || { id: "tw:" + m[2], tw: true, login: m[2], title: m[2], channel: m[2], creator: "", len: "", age: "" }; startOnTwitch(v); }); return; } // from a "went live" note
      openTv(m[1] || "last"); setTimeout(() => document.documentElement.removeAttribute("data-ytv-opening"), 3000); };
    cfg ? go() : (pendingOpen = go);
  };
  const load = async () => {
    let fresh = false;
    try { ({ cfg, fresh } = await SW.load()); } catch { return; }
    const imp = lsGet("ytv:import", null); // channels and settings handed over from Hush TV (once)
    if (imp) {
      try { localStorage.removeItem("ytv:import"); } catch {}
      if (fresh && imp.tv && typeof imp.tv === "object") { cfg = SW.sanitizeConfig({ enabled: true, tv: imp.tv }); await writeCfg(); }
    }
    lsSet("ytv:btns", btnPrefs());
    if ((resumed || resumedTw) && cfg.enabled) resume();
    else if (resumed || resumedTw) { writeSession(null); document.documentElement.classList.remove("ytv"); }
    syncButtons();
    if (pendingOpen) { const f = pendingOpen; pendingOpen = null; f(); }
    // YouTube opened as an app (its own window with an icon in the Dock): straight into YTV
    else if (cfg.enabled && !ui && !resumed && !resumedTw) {
      if (appSetupTab() && !inAppWindow()) appSetupBanner();
      else if ((APP_LINK && (cfg.tv.appStart || APP_Q.has("ytvapp"))) || (cfg.tv.appStart && location.pathname === "/" && inAppWindow())) { endAppSetup(); openTv("last"); }
    }
  };
  // The tab you make the app from: how to do it in this browser. Once the tab becomes the app's window, YTV starts.
  const appSetupBanner = () => {
    if (document.getElementById("ytv-appsetup")) return;
    const brave = !!navigator.brave, mac = /Mac/.test(navigator.platform || navigator.userAgent);
    const box = document.createElement("div"); box.id = "ytv-appsetup";
    box.style.cssText = "position:fixed;left:50%;top:72px;transform:translateX(-50%);z-index:2147483647;max-width:560px;width:calc(100% - 32px);box-sizing:border-box;padding:16px 18px;border-radius:14px;background:#1d1f26;color:#e0ebf6;font:14px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 12px 40px rgba(0,0,0,.45);border:1px solid #f22a2a";
    const t = document.createElement("b"); t.textContent = "Make YTV an app"; t.style.cssText = "display:block;font-size:16px;margin-bottom:6px";
    const p = document.createElement("div");
    p.textContent = brave
      ? "In Brave: menu ☰ → Save and share → Install page as app… — or menu ☰ → More tools → Create shortcut…, tick “Open as window”, and click Create. Keep this page’s address as it is (it ends in ?ytvapp)."
      : "In Chrome: menu ⋮ → Cast, save and share → Install page as app… (or Create shortcut… with “Open as window” ticked). Keep this page’s address as it is (it ends in ?ytvapp).";
    const p2 = document.createElement("div"); p2.style.cssText = "margin-top:6px;color:#aab3c4;font-size:12.5px";
    p2.textContent = (mac ? "It lands in your Applications folder and Launchpad; drag it to the Dock. " : "") + "Each time you open it, YTV starts by itself.";
    const x = document.createElement("button"); x.type = "button"; x.textContent = "Close"; x.style.cssText = "margin-top:10px;padding:6px 14px;border:0;border-radius:8px;background:#f22a2a;color:#fff;font:inherit;font-weight:700;cursor:pointer";
    x.addEventListener("click", endAppSetup);
    box.append(t, p, p2, x);
    document.documentElement.append(box);
    const mq = matchMedia(APP_MQ);
    const onApp = () => { if (!mq.matches || !appSetupTab()) return; mq.removeEventListener("change", onApp); endAppSetup(); if (cfg && cfg.enabled && !ui) openTv("last"); };
    mq.addEventListener("change", onApp);
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.cfg) {
      cfg = SW.sanitizeConfig(changes.cfg.newValue);
      lsSet("ytv:btns", btnPrefs());
      dropChans(); tabsSig = "";
      syncButtons(); refreshCreatorButton(); applyTheme();
      if (ui) { if (cfg.tv.twitch.enabled) startTwitchWatch(); else stopTwitchWatch(); const v = current(); if (v && v.tw && ui.root.classList.contains("on-twitch")) { if (chatWanted()) startChat(v); else stopChat(); chatBox(); panelChatLook(); } } // chat settings show right away
      if (ui) {
        if (state.panel && state.panel.startsWith("src:") && !chanById(state.panel.slice(4))) state.panel = playingTab();
        state.quiet = true; // a settings change redraws the rows in place, without them sliding in again
        if (isListTab(state.panel)) renderPanel(true); else renderTabs(); // rows follow your swipe settings right away
        state.quiet = false;
      }
    }
  });
  document.addEventListener("yt-navigate-start", () => { if (ui && onWatchTv()) writeSession(null); });
  document.addEventListener("yt-navigate-finish", () => { syncButtons(); setTimeout(saveHomeTopics, 2500); });
  document.addEventListener("DOMContentLoaded", () => { syncButtons(); setTimeout(saveHomeTopics, 3000); });
  window.addEventListener("hashchange", checkHash);
  // YouTube builds (and sometimes rebuilds) its header and sidebar late: add the buttons the moment those appear.
  // (at most 4 times a second: YouTube's page changes constantly while a video plays, and checking every frame costs battery)
  let syncQ = 0;
  // (not while TV is on: the page is covered, and YouTube's player changes the page all the time)
  const btnObs = new MutationObserver(() => { if (!syncQ && !ui) syncQ = setTimeout(() => { syncQ = 0; syncButtons(); }, 250); });
  watchButtons = (on) => { if (on) btnObs.observe(document.documentElement, { childList: true, subtree: true }); else { btnObs.disconnect(); clearTimeout(syncQ); syncQ = 0; } };
  watchButtons(!ui);
  setInterval(() => { if (!ui) syncButtons(); }, 5000); // a slow safety net
  checkHash();
  load();
})();
