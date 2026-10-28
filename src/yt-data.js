/*
 * YTV — reading YouTube's own page data.
 *
 * Used by YTV (in your YouTube tab) and by the creator search in settings.
 * There is exactly one way to make a request in all of YTV: SW.yt.fetchPage, which refuses
 * anything that isn't https://www.youtube.com. verify.py checks this is the only request.
 * The returned pages are only parsed as data (JSON.parse) — nothing from them is ever run.
 */
(() => {
  "use strict";
  const SW = (globalThis.SW = globalThis.SW || {});
  const ORIGIN = "https://www.youtube.com";
  const ID_RE = /^[\w-]{11}$/;

  /** Fetch a YouTube page as text. Refuses anything that isn't youtube.com itself. */
  const fetchPage = async (path) => {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error("YTV only talks to youtube.com");
    const r = await fetch(url.href, { credentials: "include", cache: "no-cache" });
    if (!r.ok) throw new Error("YouTube said " + r.status);
    return r.text();
  };

  /**
   * Ask YouTube's own web API for more data — the same request YouTube's page makes, e.g. to
   * load comments or the next page of a list. Only these endpoints on youtube.com are allowed.
   */
  const API_ENDPOINTS = ["next", "browse/edit_playlist", "browse", "search"]; // comments; your Watch Later; more of a list ("browse"/"search" continuations)
  const apiPost = async (endpoint, body, headers = {}) => {
    if (!API_ENDPOINTS.includes(endpoint)) throw new Error("YTV only uses YouTube's next, browse, search and edit_playlist endpoints");
    const url = new URL(`/youtubei/v1/${endpoint}?prettyPrint=false`, ORIGIN);
    if (url.origin !== ORIGIN) throw new Error("YTV only talks to youtube.com");
    const r = await fetch(url.href, { method: "POST", credentials: "include", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("YouTube said " + r.status);
    return r.json();
  };

  /** Parse the JSON object starting at html[start] (a "{"), without eval. */
  const objectAt = (html, start) => {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; } }
    }
    return null;
  };
  /** Pull a JSON object that YouTube embeds in its HTML (e.g. ytInitialData) without eval. */
  const embeddedJson = (html, name) => {
    for (const m of [`var ${name} = `, `window["${name}"] = `, `${name} = `]) {
      const at = html.indexOf(m);
      if (at < 0) continue;
      const start = html.indexOf("{", at + m.length - 1);
      if (start >= 0) { const o = objectAt(html, start); if (o) return o; }
    }
    return null;
  };
  /** YouTube's page settings (ytcfg.set({...})), needed to ask its web API for comments. */
  const ytcfgFrom = (html) => {
    const out = {};
    for (let at = html.indexOf("ytcfg.set({"); at >= 0; at = html.indexOf("ytcfg.set({", at + 10)) {
      const o = objectAt(html, at + 10);
      if (o) Object.assign(out, o);
    }
    return out;
  };

  const text = (v) => (!v ? "" : typeof v === "string" ? v : v.simpleText || v.content || (Array.isArray(v.runs) ? v.runs.map((r) => r.text).join("") : ""));
  const findKey = (obj, key, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 14) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const v of Object.values(obj)) { const f = findKey(v, key, depth + 1); if (f !== undefined) return f; }
    return undefined;
  };
  const SKIP = new Set(["adSlotRenderer", "reelShelfRenderer", "reelItemRenderer", "shortsLockupViewModel", "promotedSparklesWebRenderer",
    "searchPyvRenderer", "promotedVideoRenderer", "movieRenderer", "radioRenderer", "playlistRenderer", "channelRenderer"]);
  const AGE_RE = /\b(ago|geleden|vor|il y a|hace|fa|siden|sedan|temu|назад|前)\b|\d+\s*(sec|min|hour|day|week|month|year|seconde|minuut|uur|dag|week|maand|jaar)/i;
  /** Members-only / members-first videos: YouTube labels them with a badge style or label. Titles are never checked. */
  const MEMBERS_RE = /"(?:style|badgeStyle|iconType|iconName|label|badgeText|tooltip|accessibilityLabel)":"[^"]*(?:members?[ _-]?(?:only|first)|alleen voor leden|leden eerst|nur f\u00fcr mitglieder|r\u00e9serv\u00e9 aux membres|solo para miembros)/i;
  const isMembersOnly = (v) => { try { return MEMBERS_RE.test(JSON.stringify(v)); } catch { return false; } };
  /** A views / subscribers / age line, which is never a channel name. */
  const STAT_RE = /(?:^|\s)(?:\d[\d.,\s]*[KMBkmb]?|no|geen|een)\s*(?:views?|weergaven|weergave|keer bekeken|aufrufe|vues|visualizaciones|visualiza\u00e7\u00f5es|watching|kijkers|subscribers?|abonnees?)\b|\d+\s*(?:sec|min|hour|day|week|month|year|seconde|minuut|uur|dag|maand|jaar)|\b(?:ago|geleden|streamed|premiered)\b/i;
  // a bare count such as "655K", "1.2M", "1,2 mln." or "12 345" is a view count too
  const COUNT_RE = /^\s*\d[\d.,\s\u00a0]*\s*(?:k|m|b|mln\.?|mld\.?|mil|mio\.?|mrd\.?|duizend|miljoen|tsd\.?|\u4e07|\u5343)?\s*$/i;
  // button / UI labels that sometimes sit where a name should be
  const UI_RE = /^\s*(?:watch later|bekijk later|sp\u00e4ter ansehen|\u00e0 regarder plus tard|ver m\u00e1s tarde|assistir mais tarde|guarda pi\u00f9 tardi|add to queue|toevoegen aan wachtrij|now playing|share|delen|save|opslaan)\s*$/i;
  const isStat = (t) => STAT_RE.test(String(t || "")) || COUNT_RE.test(String(t || "")) || UI_RE.test(String(t || ""));
  /** Watch progress (0–100) YouTube shows on a thumbnail, or 0. */
  const progressOf = (v) => {
    const r = findKey(v, "thumbnailOverlayResumePlaybackRenderer");
    if (r && Number.isFinite(Number(r.percentDurationWatched))) return Math.max(0, Math.min(100, Number(r.percentDurationWatched)));
    const b = findKey(v, "thumbnailOverlayProgressBarViewModel");
    if (b && Number.isFinite(Number(b.startPercent))) return Math.max(0, Math.min(100, Number(b.startPercent)));
    return 0;
  };
  const handleFrom = (be) => (be ? (be.canonicalBaseUrl || "").replace(/^\//, "") || (be.browseId ? "channel/" + be.browseId : "") : "");

  /**
   * Every regular video in a YouTube data blob:
   * { id, title, channel, creator (@handle or channel/UC…), len ("12:34"), age ("3 days ago") }.
   * Skips ads, Shorts and live streams.
   */
  const extractVideos = (data) => {
    const out = [], seen = new Set();
    const add = (v) => { if (v && ID_RE.test(v.id) && !seen.has(v.id)) { seen.add(v.id); out.push(v); } };
    const stack = [data];
    while (stack.length && out.length < 120) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]); continue; }
      for (const [k, v] of Object.entries(node)) {
        if (SKIP.has(k)) continue;
        if ((k === "videoRenderer" || k === "compactVideoRenderer" || k === "gridVideoRenderer" || k === "playlistVideoRenderer") && v && v.videoId) {
          if (JSON.stringify(v.badges || v.thumbnailOverlays || "").includes("LIVE")) continue;
          if (isMembersOnly(v)) continue;
          const owner = ((v.ownerText || v.longBylineText || v.shortBylineText || {}).runs || []);
          const be = owner[0] && owner[0].navigationEndpoint && owner[0].navigationEndpoint.browseEndpoint;
          // Watch Later rows put "views • age" in videoInfo
          const info = (v.videoInfo && v.videoInfo.runs || []).map((r) => r.text).filter((t) => t && t.trim() !== "•");
          const progress = progressOf(v);
          add({ id: v.videoId, title: text(v.title), channel: owner[0] && !isStat(owner[0].text) ? owner[0].text : "", creator: handleFrom(be),
            len: text(v.lengthText), age: text(v.publishedTimeText) || info.find((t) => AGE_RE.test(t)) || "", progress, watched: progress >= 90 });
          continue;
        }
        if (k === "lockupViewModel" && v && v.contentId && /VIDEO/.test(v.contentType || "")) {
          const badge = findKey(v, "thumbnailBadgeViewModel");
          if (JSON.stringify(badge || "").includes("LIVE")) continue;
          if (isMembersOnly(v)) continue;
          const meta = findKey(v, "lockupMetadataViewModel") || {};
          const rows = (findKey(meta, "metadataRows") || []).map((r) => (r.metadataParts || []).map((p) => text(p.text)).filter(Boolean));
          const base = findKey(v, "canonicalBaseUrl");
          const creator = typeof base === "string" ? base.replace(/^\//, "") : handleFrom(findKey(v, "browseEndpoint"));
          // Channel: first part of the first row; fall back to the avatar's label or the @handle.
          const a11y = findKey(findKey(meta, "image") || {}, "accessibilityText") || findKey(v, "accessibilityText") || "";
          // (some cards put "123K views" first, so a stats line is never taken for the channel)
          const first = rows[0] && rows[0][0] && !isStat(rows[0][0]) ? rows[0][0] : "";
          const GO_RE = /^(?:go to channel|ga naar kanaal|zum kanal|aller \u00e0 la cha\u00eene|ir al canal|ir para o canal|vai al canale|przejd\u017a do kana\u0142u)\s+(.+)$/i;
          // only a real "Go to channel X" label counts (other labels on the card are buttons such as "Watch later")
          const fromLabel = (t) => { const m = typeof t === "string" && t.match(GO_RE); return m ? m[1].trim() : ""; };
          const fromA11y = fromLabel(a11y) || fromLabel(findKey(v, "a11yLabel"));
          const channel = first || (isStat(fromA11y) ? "" : fromA11y);
          const parts = rows.flat();
          const age = parts.find((p) => AGE_RE.test(p)) || (rows.length > 1 ? rows[rows.length - 1].slice(-1)[0] : "");
          const progress = progressOf(v);
          add({ id: v.contentId, title: text(meta.title), channel, creator, len: badge ? text(badge.text) : "", age: age || "", progress, watched: progress >= 90 });
          continue;
        }
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return out;
  };

  /** Channel search results: { creator (@handle or channel/UC…), name, subs, avatar }. */
  const extractChannels = (data) => {
    const out = [];
    const stack = [data];
    while (stack.length && out.length < 20) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) { for (let i = node.length - 1; i >= 0; i--) stack.push(node[i]); continue; }
      for (const [k, v] of Object.entries(node)) {
        if ((k === "channelRenderer" || k === "gridChannelRenderer") && v && v.channelId) {
          const be = v.navigationEndpoint && v.navigationEndpoint.browseEndpoint;
          const handle = (be && be.canonicalBaseUrl ? be.canonicalBaseUrl.replace(/^\//, "") : "") || "channel/" + v.channelId;
          const thumbs = (v.thumbnail && v.thumbnail.thumbnails) || [];
          let avatar = thumbs.length ? thumbs[thumbs.length - 1].url || "" : "";
          if (avatar.startsWith("//")) avatar = "https:" + avatar;
          // subscriberCountText sometimes holds the @handle; videoCountText then holds the subscribers.
          const a = text(v.subscriberCountText), b = text(v.videoCountText);
          const subs = a.startsWith("@") ? b : a;
          if (!out.some((c) => c.creator === handle)) out.push({ creator: handle, name: text(v.title), subs, avatar: /^https:\/\/yt3\.(ggpht|googleusercontent)\.com\//.test(avatar) ? avatar : "" });
          continue;
        }
        if (v && typeof v === "object") stack.push(v);
      }
    }
    return out;
  };

  /** Read the video list of a YouTube page path. Returns [] on any problem. */
  const videosAt = async (path) => { try { return extractVideos(embeddedJson(await fetchPage(path), "ytInitialData")); } catch { return []; } };
  /** Like videosAt, but also returns the page's own title (a channel's name on its Videos tab). */
  const pageVideos = async (path) => {
    try {
      const data = embeddedJson(await fetchPage(path), "ytInitialData") || {};
      const md = data.metadata && data.metadata.channelMetadataRenderer;
      const ph = findKey(data.header || {}, "pageHeaderViewModel");
      const title = (md && md.title) || (ph && text(ph.title && (ph.title.dynamicTextViewModel ? ph.title.dynamicTextViewModel.text : ph.title))) || "";
      return { title: String(title || "").slice(0, 100), videos: extractVideos(data), ok: !!data.contents };
    } catch { return { title: "", videos: [], ok: false }; }
  };
  // ---- endless lists: YouTube pages end with a "continuation" token; asking for it gives the next page, again and again
  /** The token for the next page of a list (the last one in the data), or "". */
  const findToken = (data) => {
    let tok = "";
    const stack = [data];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) { for (const x of node) stack.push(x); continue; }
      if (node.continuationItemRenderer) { const t = findKey(node.continuationItemRenderer, "token"); if (typeof t === "string" && t.length < 4000) tok = t; continue; }
      for (const v of Object.values(node)) if (v && typeof v === "object") stack.push(v);
    }
    return tok;
  };
  /** A page's videos, its title (a channel's name), and how to ask for its next page. */
  const videosPage = async (path) => {
    try {
      const html = await fetchPage(path), data = embeddedJson(html, "ytInitialData") || {};
      const md = data.metadata && data.metadata.channelMetadataRenderer;
      const token = findToken(data), ctx = (ytcfgFrom(html) || {}).INNERTUBE_CONTEXT || null;
      return { videos: extractVideos(data), title: String((md && md.title) || "").slice(0, 100),
        more: token && ctx ? { endpoint: path.startsWith("/results") ? "search" : "browse", token, ctx } : null };
    } catch { return { videos: [], title: "", more: null }; }
  };
  /** The next page of a list (from videosPage or an earlier moreVideos). */
  const moreVideos = async (more) => {
    if (!more || !API_ENDPOINTS.includes(more.endpoint)) return { videos: [], more: null };
    try {
      const auth = (await authHeader()) || {}; // your own home / subscriptions need you signed in, like on YouTube
      const res = await apiPost(more.endpoint, { context: more.ctx, continuation: more.token }, auth);
      const token = findToken(res);
      return { videos: extractVideos(res), more: token && token !== more.token ? { ...more, token } : null };
    } catch { return { videos: [], more: null }; }
  };
  /** Creators related to one: the channels it features on its Channels tab. */
  const relatedChannels = async (creator) => {
    if (!/^(@[\p{L}\p{N}._-]{2,100}|channel\/UC[\w-]{20,24})$/u.test(creator)) return [];
    try { return extractChannels(embeddedJson(await fetchPage(`/${creator}/channels`), "ytInitialData")).filter((c) => c.creator !== creator); } catch { return []; }
  };

  /** Music-video heuristics (YouTube doesn't label music in its lists). */
  const MUSIC_TITLE = /(official (music )?video|official audio|official lyric video|lyric video|[(\[]\s*lyrics?\s*[)\]]|visuali[sz]er|music video|\(audio\)|\[audio\]|\bft\.|\bfeat\.|full album|clip officiel|videoclip|\bofficial\b.{0,20}\b(video|audio|visuali[sz]er)\b|[(\[]\s*official\b|[-–|]\s*lyrics?\b|\blyrics?\s*$|[(\[]\s*(remaster(ed)?|live at)\b)/i;
  const isMusic = (v) => /\s-\s*topic$/i.test(v.channel || "") || /vevo/i.test(v.channel || "") || /vevo$/i.test(v.creator || "") || /official artist channel/i.test(v.channel || "") || /(?:music|records|recordings|vevo)$/i.test((v.channel || "").trim()) || /(?:music|vevo)$/i.test(v.creator || "") || MUSIC_TITLE.test(v.title || "");

  /** YouTube's signed-in request header (SAPISIDHASH), as its own page computes it. Content scripts only. */
  const authHeader = async () => {
    if (typeof document === "undefined") return null;
    const m = document.cookie.match(/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/);
    if (!m) return null;
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${ts} ${decodeURIComponent(m[1])} ${ORIGIN}`));
    const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { Authorization: `SAPISIDHASH ${ts}_${hex}`, "X-Origin": ORIGIN, "X-Goog-AuthUser": "0" };
  };
  /** Remove videos from your Watch Later playlist (same request YouTube's page makes). */
  const removeFromWatchLater = async (ids, ctx) => {
    const good = ids.filter((id) => ID_RE.test(id)).slice(0, 200);
    ctx = ctx || (await watchLaterCtx());
    if (!good.length || !ctx) return false;
    const auth = await authHeader();
    if (!auth) return false;
    try {
      const res = await apiPost("browse/edit_playlist", { context: ctx, playlistId: "WL", actions: good.map((id) => ({ action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId: id })) }, auth);
      return !!res && (res.status === "STATUS_SUCCEEDED" || !res.error);
    } catch { return false; }
  };
  /** YouTube page settings needed to edit Watch Later (fetched once, then remembered). */
  let wlCtx = null;
  const watchLaterCtx = async () => {
    if (wlCtx) return wlCtx;
    try { wlCtx = (ytcfgFrom(await fetchPage("/playlist?list=WL")) || {}).INNERTUBE_CONTEXT || null; } catch {}
    return wlCtx;
  };
  /** Add videos to your Watch Later playlist (the same request YouTube's own button makes). Returns the ids that were added. */
  const addToWatchLater = async (ids, ctx) => {
    const good = [...new Set(ids.filter((id) => ID_RE.test(id)))].slice(0, 200);
    if (!good.length) return [];
    ctx = ctx || (await watchLaterCtx());
    const auth = await authHeader();
    if (!ctx || !auth) return [];
    const send = async (batch) => {
      try {
        const res = await apiPost("browse/edit_playlist", { context: ctx, playlistId: "WL", actions: batch.map((id) => ({ action: "ACTION_ADD_VIDEO", addedVideoId: id })) }, await authHeader());
        return !!res && (res.status === "STATUS_SUCCEEDED" || !res.error);
      } catch { return false; }
    };
    const added = [];
    for (let i = 0; i < good.length; i += 25) {
      const batch = good.slice(i, i + 25);
      if (await send(batch)) added.push(...batch);
      else for (const id of batch) if (await send([id])) added.push(id); // one bad link shouldn't sink the rest
    }
    return added;
  };
  /** Watch Later: { videos, ctx } (ctx = page settings needed to edit it). */
  // The whole list, page by page (YouTube sends 100 at a time), and nothing else: Watch Later is finite.
  const watchLater = async () => {
    try {
      const html = await fetchPage("/playlist?list=WL"), data = embeddedJson(html, "ytInitialData");
      const ctx = (ytcfgFrom(html) || {}).INNERTUBE_CONTEXT || null;
      const videos = extractVideos(data), ids = new Set(videos.map((v) => v.id));
      let token = findToken(data);
      for (let page = 0; token && ctx && page < 60; page++) {
        let res = null;
        try { res = await apiPost("browse", { context: ctx, continuation: token }, (await authHeader()) || {}); } catch { break; }
        for (const v of extractVideos(res)) if (!ids.has(v.id)) { ids.add(v.id); videos.push(v); }
        const t = findToken(res); token = t && t !== token ? t : "";
      }
      return { videos, ctx };
    } catch { return { videos: [], ctx: null }; }
  };
  /**
   * Who you're subscribed to, from YouTube's "All subscriptions" page (every page of it): a list of keys that
   * name each channel (its @handle, "channel/UC…" and display name, lower case, no "@"). [] when signed out.
   */
  const subscribedChannels = async () => {
    const keys = new Set();
    const key = (s) => String(s || "").toLowerCase().replace(/^@/, "").trim();
    const grab = (data) => {
      const stack = [data];
      while (stack.length) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node)) { for (const x of node) stack.push(x); continue; }
        for (const [k, v] of Object.entries(node)) {
          if ((k === "channelRenderer" || k === "gridChannelRenderer") && v && v.channelId) {
            keys.add(key("channel/" + v.channelId));
            const be = v.navigationEndpoint && v.navigationEndpoint.browseEndpoint;
            if (be && be.canonicalBaseUrl) keys.add(key(be.canonicalBaseUrl.replace(/^\//, "")));
            const sub = text(v.subscriberCountText); if (sub.startsWith("@")) keys.add(key(sub)); // (newer pages put the @handle there)
            const nm = text(v.title); if (nm) keys.add(key(nm));
            continue;
          }
          if (v && typeof v === "object") stack.push(v);
        }
      }
    };
    try {
      const html = await fetchPage("/feed/channels"), data = embeddedJson(html, "ytInitialData");
      const ctx = (ytcfgFrom(html) || {}).INNERTUBE_CONTEXT || null;
      grab(data);
      let token = findToken(data);
      for (let page = 0; token && ctx && page < 40; page++) {
        let res = null;
        try { res = await apiPost("browse", { context: ctx, continuation: token }, (await authHeader()) || {}); } catch { break; }
        grab(res);
        const t = findToken(res); token = t && t !== token ? t : "";
      }
    } catch {}
    return [...keys].slice(0, 20000);
  };
  /**
   * One of the chips at the top of your YouTube home page (e.g. "Watched" / "Bekeken"), as a list:
   * { videos, more } like videosPage. `re` matches the chip's label in any language.
   */
  const homeChip = async (re) => {
    try {
      const html = await fetchPage("/"), data = embeddedJson(html, "ytInitialData") || {};
      const ctx = (ytcfgFrom(html) || {}).INNERTUBE_CONTEXT || null;
      let token = "";
      const stack = [data];
      while (stack.length && !token) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (Array.isArray(node)) { for (const x of node) stack.push(x); continue; }
        for (const [k, v] of Object.entries(node)) {
          if ((k === "chipCloudChipRenderer" || k === "chipViewModel" || k === "chipShapeViewModel") && v && typeof v === "object") {
            const label = (typeof v.text === "string" ? v.text : text(v.text)) || text(findKey(v, "content")) || "";
            const cc = findKey(v, "continuationCommand");
            if (re.test(String(label).trim()) && cc && typeof cc.token === "string" && cc.token.length < 4000) { token = cc.token; break; }
            continue;
          }
          if (v && typeof v === "object") stack.push(v);
        }
      }
      if (!token || !ctx) return { videos: [], more: null, found: !!token };
      const res = await apiPost("browse", { context: ctx, continuation: token }, (await authHeader()) || {});
      const next = findToken(res);
      return { videos: extractVideos(res), more: next && next !== token ? { endpoint: "browse", token: next, ctx } : null, found: true };
    } catch { return { videos: [], more: null, found: false }; }
  };
  /** A video's channel name, for cards that don't say it (YouTube's oEmbed answer, kept per video). */
  const nameCache = new Map();
  const channelNameOf = async (id) => {
    if (!ID_RE.test(id)) return "";
    if (nameCache.has(id)) return nameCache.get(id);
    let name = "";
    try {
      const j = JSON.parse(await fetchPage(`/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + id)}`));
      name = typeof j.author_name === "string" ? j.author_name.slice(0, 100) : "";
    } catch {}
    nameCache.set(id, name);
    if (nameCache.size > 400) nameCache.delete(nameCache.keys().next().value);
    return name;
  };
  /** Search YouTube for creators. */
  /** Search YouTube for creators. Returns null when YouTube didn't send results (e.g. a consent page). */
  const searchChannels = async (query) => {
    try {
      const data = embeddedJson(await fetchPage(`/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%253D%253D`), "ytInitialData");
      return data ? extractChannels(data) : null;
    } catch { return null; }
  };

  /**
   * "3 days ago" / "2 weken geleden" / "Streamed 1 year ago" → age in days (null when unknown).
   * English and Dutch, plus German, French and Spanish basics.
   */
  // (each unit at the start of the word only: "dia" must not match "media", "an" must not match "Andrew")
  const UNIT_DAYS = [
    [/^(sec|second|seconde|sekunde|segundo)/i, 1 / 86400], [/^(min|minute|minuut|minuten|minuto)/i, 1 / 1440], [/^(hour|hr|uur|stunde|heure|hora)/i, 1 / 24],
    [/^(day|dag|tag|jour|día|dia|giorn)/i, 1], [/^(week|weken|wk|woche|semaine|semana|settiman)/i, 7], [/^(month|mo$|maand|monat|mois|mes|mês|mese)/i, 30], [/^(year|yr|jaar|jahr|ans?$|año|ano|anno|ann)/i, 365],
  ];
  // words without a number: "yesterday", "last month", "vorige week" (how browsers write it)
  const WORD_DAYS = [[/^(today|vandaag|heute|aujourd|hoy|hoje|oggi)/i, 0], [/^(yesterday|gisteren|gestern|hier|ayer|ontem|ieri)/i, 1],
    [/\b(last|previous|vorige?|letzte[nr]?|dernier|derni\u00e8re|pasad[oa]|passad[oa]|scors[oa])\s+(week|woche|semaine|semana|settimana)/i, 7],
    [/\b(last|previous|vorige?|letzte[nr]?|dernier|derni\u00e8re|pasad[oa]|passad[oa]|scors[oa])\s+(month|maand|monat|mois|mes|m\u00eas|mese)/i, 30],
    [/\b(last|previous|vorige?|letzte[nr]?|dernier|derni\u00e8re|pasad[oa]|passad[oa]|scors[oa])\s+(year|jaar|jahr|ann\u00e9e|a\u00f1o|ano|anno)/i, 365]];
  const MONTHS = { jan: 0, feb: 1, mar: 2, mrt: 2, apr: 3, may: 4, mei: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11 };
  /** "3 weeks ago", "1 maand geleden", "last month", "Premiered Oct 3, 2026", "3 okt. 2026" → days (null when it doesn't say). */
  const ageDays = (t) => {
    const s = String(t || "").trim();
    if (!s) return null;
    for (const [re, d] of WORD_DAYS) if (re.test(s)) return d;
    // every number + word in it, the first with a time unit (so "1.2K views · 3 weeks ago" reads as 3 weeks)
    for (const m of s.matchAll(/(\d+)\s*([\p{L}]+)/gu)) for (const [re, d] of UNIT_DAYS) if (re.test(m[2])) return Number(m[1]) * d;
    // a date written out
    const ab = s.match(/(\d{1,2})\s+([\p{L}]{3,})\.?\s+(\d{4})|([\p{L}]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/u);
    if (ab) {
      const day = Number(ab[1] || ab[5]), mon = MONTHS[String(ab[2] || ab[4]).slice(0, 3).toLowerCase()], year = Number(ab[3] || ab[6]);
      if (mon !== undefined) { const at = new Date(year, mon, day).getTime(); if (Number.isFinite(at)) return Math.max(0, (Date.now() - at) / 86400000); }
    }
    return null;
  };

  // ------------------------------------------------------------------ comments
  /** Comments from a "next" response (both YouTube's older and newer comment formats). */
  const parseComments = (resp) => {
    const entities = {};
    for (const m of findKey(resp, "mutations") || []) {
      const p = m && m.payload && m.payload.commentEntityPayload;
      if (p && m.entityKey) entities[m.entityKey] = p;
    }
    const items = [];
    for (const ep of resp.onResponseReceivedEndpoints || []) {
      const cmd = ep.reloadContinuationItemsCommand || ep.appendContinuationItemsAction || {};
      for (const it of cmd.continuationItems || []) items.push(it);
    }
    const out = [];
    let next = "";
    for (const it of items) {
      if (it.continuationItemRenderer) {
        const t = findKey(it.continuationItemRenderer, "token");
        if (typeof t === "string") next = t;
        continue;
      }
      const thread = it.commentThreadRenderer;
      if (!thread) continue;
      const old = thread.comment && thread.comment.commentRenderer;
      if (old) {
        out.push({ author: text(old.authorText), text: text(old.contentText), age: text(old.publishedTimeText),
          likes: text(old.voteCount), replies: Number(old.replyCount) || 0 });
        continue;
      }
      const vm = thread.commentViewModel && (thread.commentViewModel.commentViewModel || thread.commentViewModel);
      const p = vm && entities[vm.commentKey];
      if (p) {
        const pr = p.properties || {}, au = p.author || {}, tb = p.toolbar || {};
        out.push({ author: au.displayName || "", text: text(pr.content), age: pr.publishedTime || "",
          likes: tb.likeCountNotliked || tb.likeCountA11y || "", replies: Number(String(tb.replyCount || "0").replace(/\D/g, "")) || 0 });
      }
    }
    return { comments: out.map((c) => ({ ...c, text: String(c.text || "").slice(0, 5000), author: String(c.author || "").slice(0, 100) })), next };
  };
  /**
   * Comments for a video. First call: pass the watch page HTML (to find YouTube's comment token
   * and page settings). Later calls: pass the previous result to load the next page.
   */
  const commentsFor = async (html, prev) => {
    try {
      let token = prev && prev.next, cfg = prev && prev.cfg;
      if (!token) {
        const data = embeddedJson(html, "ytInitialData") || {};
        cfg = ytcfgFrom(html);
        const stack = [data];
        while (stack.length && !token) {
          const n = stack.pop();
          if (!n || typeof n !== "object") continue;
          if (n.itemSectionRenderer && /comment/i.test(n.itemSectionRenderer.sectionIdentifier || "")) { const t = findKey(n.itemSectionRenderer, "token"); if (typeof t === "string") token = t; }
          for (const v of Object.values(n)) if (v && typeof v === "object") stack.push(v);
        }
        if (!token) return { comments: [], next: "", cfg, off: true };
      }
      const ctx = cfg && cfg.INNERTUBE_CONTEXT;
      if (!ctx) return { comments: [], next: "", cfg };
      const res = parseComments(await apiPost("next", { context: ctx, continuation: token }));
      return { ...res, cfg };
    } catch {
      return { comments: [], next: "", cfg: prev && prev.cfg, failed: true };
    }
  };

  /** "2026-10-16" → "3 days ago" in the browser's language. */
  const relativeDate = (iso) => {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const diff = (t - Date.now()) / 1000;
    const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
    try {
      const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "always" }); // ("1 month ago", never "last month": the date filters read the number)
      for (const [u, s] of units) if (Math.abs(diff) >= s || u === "minute") return rtf.format(Math.round(diff / s), u);
    } catch {}
    return "";
  };

  SW.yt = { ORIGIN, ID_RE, fetchPage, embeddedJson, extractVideos, extractChannels, videosAt, pageVideos, searchChannels, relatedChannels, relativeDate, ageDays, text, findKey,
    commentsFor, parseComments, isMusic, watchLater, homeChip, subscribedChannels, removeFromWatchLater, addToWatchLater, isMembersOnly, isStat, channelNameOf,
    videosPage, moreVideos, findToken };
})();
