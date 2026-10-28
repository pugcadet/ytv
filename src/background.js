/* global WebSocket */
/*
 * YTV — background service worker.
 * Saves clean settings on install/update, opens the settings page when YTV asks, and runs
 * creator searches for the settings page through an open YouTube tab (which has your YouTube session).
 */
"use strict";
importScripts("common.js");

const SW = globalThis.SW;

// After an update, YouTube tabs that were already open still run the old copy; refresh the quiet ones.
const refreshYouTubeTabs = async () => {
  try {
    const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*"] });
    await Promise.all(tabs.filter((t) => !t.audible && !t.discarded).map((t) => chrome.tabs.reload(t.id)));
  } catch {}
};

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const { cfg } = await SW.load();
  await chrome.storage.local.set({ cfg: SW.sanitizeConfig(cfg) });
  if (reason === "update") refreshYouTubeTabs();
});

const badge = async () => {
  try {
    const { cfg } = await SW.load();
    await chrome.action.setBadgeText({ text: cfg.enabled ? "" : "OFF" });
    await chrome.action.setBadgeBackgroundColor({ color: "#6b7280" });
  } catch {}
};
chrome.runtime.onStartup.addListener(badge);
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.cfg) badge(); });

// ---- Twitch Live (only once you switch it on in settings, which asks the browser for access to gql.twitch.tv).
// One request: which of your streamers are live, asked the same way Twitch's own website asks. Nothing about you is sent.
const TWITCH_GQL = "https://gql.twitch.tv/gql";
const TWITCH_CLIENT = "kimne78kx3ncx6brgo4mv6wki5h1ko"; // the public id Twitch's own website uses
const twitchAllowed = () => chrome.permissions.contains({ origins: ["https://gql.twitch.tv/*"] }).catch(() => false);
// one way to ask Twitch anything: public data only, no cookies
const gql = async (query, variables) => {
  const r = await fetch(TWITCH_GQL, { method: "POST", credentials: "omit", headers: { "Client-ID": TWITCH_CLIENT, "Content-Type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ query, variables }) });
  if (!r.ok) throw new Error("Twitch said " + r.status);
  const j = await r.json();
  return { data: (j && j.data) || null, error: j && j.errors && j.errors.length ? String(j.errors[0].message || "error").slice(0, 200) : "" };
};
const LOGIN_RE = /^[a-z0-9_]{2,25}$/;
const str = (x, n) => String(x == null ? "" : x).slice(0, n);
const twitchLive = async (logins) => {
  if (!(await twitchAllowed())) return { live: [], error: "no-access" };
  const names = [...new Set(logins.filter((x) => typeof x === "string" && LOGIN_RE.test(x)))].slice(0, 500);
  if (!names.length) return { live: [] };
  const full = "query($l:[String!]){users(logins:$l){login displayName profileImageURL(width:70) stream{title viewersCount createdAt previewImageURL(width:640,height:360) game{displayName}}}}";
  const basic = "query($l:[String!]){users(logins:$l){login displayName stream{title viewersCount previewImageURL(width:640,height:360) game{displayName}}}}";
  try {
    // Twitch answers up to 100 names per question: more streamers are asked about in batches, side by side
    const ask = async (part) => { let r = await gql(full, { l: part }); if (!r.data || !Array.isArray(r.data.users)) r = await gql(basic, { l: part }); return r; }; // (basic: in case Twitch changed a detail, the essentials still work)
    const parts = []; for (let i = 0; i < names.length; i += 100) parts.push(names.slice(i, i + 100));
    const answers = await Promise.all(parts.map(ask));
    const res = answers.find((r) => !r.data) || answers[0];
    const all = answers.flatMap((r) => (r.data && Array.isArray(r.data.users) ? r.data.users : [])).filter((u) => u && LOGIN_RE.test(String(u.login || "").toLowerCase()));
    const users = all.filter((u) => u.stream);
    const avatar = (u) => (/^https:\/\/static-cdn\.jtvnw\.net\//.test(String(u.profileImageURL || "")) ? String(u.profileImageURL) : "");
    const offline = all.filter((u) => !u.stream).map((u) => ({ login: String(u.login).toLowerCase(), name: str(u.displayName, 60), avatar: avatar(u) }));
    const live = users.map((u) => ({ avatar: avatar(u), login: String(u.login || "").toLowerCase(), name: str(u.displayName, 60), title: str(u.stream.title, 300), viewers: Number(u.stream.viewersCount) || 0,
      game: str(u.stream.game && u.stream.game.displayName, 80), since: str(u.stream.createdAt, 40),
      thumb: String(u.stream.previewImageURL || "").replace(/\?.*$/, "") + "?t=" + Math.floor(Date.now() / 60000) }));
    live.sort((a, b) => b.viewers - a.viewers);
    return { live, offline, error: res.data ? "" : res.error };
  } catch (e) { return { live: [], error: String((e && e.message) || e).slice(0, 200) }; }
};
// ---- "tell me when they go live": a system notification for the streamers you picked, also while YouTube is closed.
// Uses the optional "notifications" and "alarms" permissions, asked for in settings when you pick the first one.
const ALERT_ALARM = "ytv-twitch-alerts";
const alertList = async () => { try { const { cfg } = await chrome.storage.local.get("cfg"); const t = SW.sanitizeConfig(cfg || {}).tv.twitch; return t.enabled ? t.alerts : []; } catch { return []; } };
const syncAlerts = async () => {
  if (!chrome.alarms) return;
  const list = await alertList();
  if (list.length) { const a = await chrome.alarms.get(ALERT_ALARM); if (!a) chrome.alarms.create(ALERT_ALARM, { periodInMinutes: 2, delayInMinutes: 0.1 }); }
  else chrome.alarms.clear(ALERT_ALARM);
};
const checkAlerts = async () => {
  const list = await alertList();
  if (!list.length || !chrome.notifications) return;
  const r = await twitchLive(list);
  if (r.error && !r.live.length) return;
  const { twKnown } = await chrome.storage.local.get("twKnown");
  const known = new Set(Array.isArray(twKnown) ? twKnown : []), now = r.live.map((x) => x.login);
  if (Array.isArray(twKnown)) for (const x of r.live) if (!known.has(x.login)) { // (the very first look only learns who's on)
    chrome.notifications.create("tw:" + x.login, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title: `${x.name || x.login} is live`, message: [x.title, x.game].filter(Boolean).join(" · ").slice(0, 180) || "Live on Twitch" });
  }
  await chrome.storage.local.set({ twKnown: now });
};
if (chrome.alarms) chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALERT_ALARM) checkAlerts(); });
if (chrome.notifications) chrome.notifications.onClicked.addListener(async (id) => {
  const m = /^tw:([a-z0-9_]{2,25})$/.exec(id); if (!m) return;
  chrome.notifications.clear(id);
  chrome.tabs.create({ url: `https://www.youtube.com/#ytv=__twitch@${m[1]}` }); // YouTube with YTV on that stream
});
chrome.permissions.onAdded.addListener(() => syncAlerts());
chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.cfg) syncAlerts(); });
syncAlerts();


// a streamer's past broadcasts (newest first)
const twitchVods = async (login) => {
  if (!(await twitchAllowed())) return { vods: [], error: "no-access" };
  if (!LOGIN_RE.test(login)) return { vods: [] };
  const pick = (n) => (n && /^\d{1,15}$/.test(String(n.id)) ? { id: String(n.id), title: str(n.title, 200), secs: Number(n.lengthSeconds) || 0, at: str(n.publishedAt || n.createdAt, 40), views: Number(n.viewCount) || 0,
    thumb: /^https:\/\/(static-cdn\.jtvnw\.net|vod-secure\.twitch\.tv|[\w-]+\.cloudfront\.net)\//.test(String(n.previewThumbnailURL || "")) ? String(n.previewThumbnailURL) : "" } : null);
  const q = (args) => `query($l:String!){user(login:$l){videos(first:24${args}){edges{node{id title lengthSeconds publishedAt viewCount previewThumbnailURL(width:320,height:180)}}}}}`;
  try {
    let r = await gql(q(",type:ARCHIVE,sort:TIME"), { l: login });
    if (!r.data || !r.data.user) r = await gql(q(""), { l: login }); // in case Twitch changed the filters: all videos
    const edges = r.data && r.data.user && r.data.user.videos && Array.isArray(r.data.user.videos.edges) ? r.data.user.videos.edges : [];
    return { vods: edges.map((e) => pick(e && e.node)).filter(Boolean), error: r.data ? "" : r.error };
  } catch (e) { return { vods: [], error: String((e && e.message) || e).slice(0, 200) }; }
};
// find streamers by name (for adding them in settings)
const twitchSearch = async (q) => {
  if (!(await twitchAllowed())) return { found: [], error: "no-access" };
  const term = q.trim().slice(0, 60);
  if (!term) return { found: [] };
  const pick = (u) => (u && LOGIN_RE.test(String(u.login || "").toLowerCase()) ? { login: String(u.login).toLowerCase(), name: str(u.displayName, 60), live: !!u.stream, viewers: u.stream ? Number(u.stream.viewersCount) || 0 : 0, followers: u.followers ? Number(u.followers.totalCount) || 0 : 0,
    avatar: /^https:\/\/static-cdn\.jtvnw\.net\//.test(String(u.profileImageURL || "")) ? String(u.profileImageURL).slice(0, 300) : "" } : null);
  const out = [], seen = new Set(), add = (u) => { const x = pick(u); if (x && !seen.has(x.login)) { seen.add(x.login); out.push(x); } };
  let error = "";
  try { // the exact name first, then Twitch's search
    const ex = term.toLowerCase().replace(/^@/, "");
    if (LOGIN_RE.test(ex)) { const r = await gql("query($l:String!){user(login:$l){login displayName profileImageURL(width:70) followers{totalCount} stream{viewersCount}}}", { l: ex }); if (r.data) add(r.data.user); }
  } catch (e) { error = String((e && e.message) || e).slice(0, 200); }
  try {
    const r = await gql("query($q:String!){searchUsers(userQuery:$q,first:12){edges{node{login displayName profileImageURL(width:70) followers{totalCount} stream{viewersCount}}}}}", { q: term });
    const edges = r.data && r.data.searchUsers && Array.isArray(r.data.searchUsers.edges) ? r.data.searchUsers.edges : [];
    for (const e of edges) add(e && e.node);
    if (!r.data && !out.length) error = r.error;
  } catch (e) { if (!out.length) error = String((e && e.message) || e).slice(0, 200); }
  return { found: out.slice(0, 12), error: out.length ? "" : error };
};

// ---- Twitch chat, read only: an anonymous connection to Twitch's chat (no account, nothing you could send),
// plus the extra emotes people use there from BetterTTV, FrankerFaceZ and 7TV. One connection per YouTube tab
// that shows a stream; it closes as soon as that tab stops.
const CHAT_WS = "wss://irc-ws.chat.twitch.tv:443"; // (also SW.TWITCH_CHAT_WS)
const EMOTE_API = { bttv: "https://api.betterttv.net/3/cached/", ffz: "https://api.frankerfacez.com/v1/", stv: "https://7tv.io/v3/" };
const EMOTE_ID = /^[\w-]{1,40}$/;
const RECENT_API = "https://recent-messages.robotty.de/api/v2/recent-messages/"; // a public service that keeps the last chat lines of a channel
const getJson = async (url) => { const r = await fetch(url, { credentials: "omit" }); if (!r.ok) throw new Error(String(r.status)); return r.json(); };
const emoteCache = new Map(); // key → { at, list }
const cachedEmotes = async (key, load) => {
  const hit = emoteCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.list;
  let list = [];
  try { list = await load(); } catch { list = hit ? hit.list : []; }
  emoteCache.set(key, { at: Date.now(), list });
  if (emoteCache.size > 40) emoteCache.delete(emoteCache.keys().next().value);
  return list;
};
const ok3 = (p, id, name) => (EMOTE_ID.test(String(id)) && typeof name === "string" && name.length <= 60 && !/\s/.test(name) ? [name, p, String(id)] : null);
const ffzSets = (sets) => Object.values(sets || {}).flatMap((st) => (st && Array.isArray(st.emoticons) ? st.emoticons : []).map((e) => ok3("ffz", e.id, e.name)));
const emoteSources = {
  bttv: (room) => [
    cachedEmotes("bttv:g", async () => (await getJson(EMOTE_API.bttv + "emotes/global")).map((e) => ok3("bttv", e.id, e.code))),
    room ? cachedEmotes("bttv:" + room, async () => { const j = await getJson(EMOTE_API.bttv + "users/twitch/" + room); return [...(j.channelEmotes || []), ...(j.sharedEmotes || [])].map((e) => ok3("bttv", e.id, e.code)); }) : [],
  ],
  ffz: (room) => [
    cachedEmotes("ffz:g", async () => { const j = await getJson(EMOTE_API.ffz + "set/global"); const keep = new Set((j.default_sets || []).map(String)); return ffzSets(Object.fromEntries(Object.entries(j.sets || {}).filter(([k]) => keep.has(String(k))))); }),
    room ? cachedEmotes("ffz:" + room, async () => ffzSets((await getJson(EMOTE_API.ffz + "room/id/" + room)).sets)) : [],
  ],
  stv: (room) => [
    cachedEmotes("stv:g", async () => ((await getJson(EMOTE_API.stv + "emote-sets/global")).emotes || []).map((e) => ok3("stv", e.id, e.name))),
    room ? cachedEmotes("stv:" + room, async () => (((await getJson(EMOTE_API.stv + "users/twitch/" + room)).emote_set || {}).emotes || []).map((e) => ok3("stv", e.id, e.name))) : [],
  ],
};
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ytv-twchat" || !port.sender || port.sender.id !== chrome.runtime.id) return;
  let ws = null, login = "", room = "", closed = false, retry = 0, buf = [], flushT = 0, want = { bttv: true, ffz: true, stv: true };
  const post = (m) => { try { port.postMessage(m); } catch {} };
  const flush = () => { flushT = 0; if (buf.length) post({ t: "msgs", list: buf.splice(0, 200) }); };
  const queue = (m) => { buf.push(m); if (buf.length > 400) buf.splice(0, buf.length - 400); if (!flushT) flushT = setTimeout(flush, 150); };
  const sendEmotes = async () => {
    const lists = await Promise.all(Object.entries(emoteSources).filter(([k]) => want[k]).flatMap(([, f]) => f(room)));
    if (closed) return;
    const map = {};
    for (const list of lists) for (const e of list) if (e) map[e[0]] = [e[1], e[2]]; // later sources win: the channel's own over global ones
    post({ t: "emotes", map });
  };
  const sendRecent = async (who) => {
    try {
      const j = await getJson(RECENT_API + who + "?limit=60");
      if (closed || who !== login || !j || !Array.isArray(j.messages)) return;
      const list = [];
      for (const line of j.messages.slice(-60)) { const p = SW.parseIrcLine(String(line)); if (p && p.cmd === "PRIVMSG") list.push(SW.chatMsg(p)); }
      if (list.length) post({ t: "msgs", list, recent: true });
    } catch {}
  };
  const connect = () => {
    if (closed || !login) return;
    post({ t: "state", s: "connecting" });
    try { ws = new WebSocket(CHAT_WS); } catch (e) { post({ t: "state", s: "error", why: String((e && e.message) || e).slice(0, 160) }); return; }
    ws.onopen = () => { retry = 0; ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands"); ws.send("PASS SCHMOOPIIE"); ws.send("NICK justinfan" + (10000 + Math.floor(Math.random() * 80000))); ws.send("JOIN #" + login); post({ t: "state", s: "open" }); };
    ws.onmessage = (e) => {
      for (const line of String(e.data).split("\r\n")) {
        if (!line) continue;
        if (line.startsWith("PING")) { try { ws.send("PONG :tmi.twitch.tv"); } catch {} continue; }
        const p = SW.parseIrcLine(line);
        if (!p) continue;
        if (p.cmd === "JOIN") post({ t: "state", s: "live" });
        else if (p.cmd === "ROOMSTATE" && /^\d{1,20}$/.test(p.tags["room-id"] || "") && p.tags["room-id"] !== room) { room = p.tags["room-id"]; post({ t: "state", s: "live" }); sendEmotes(); }
        else if (p.cmd === "PRIVMSG") queue(SW.chatMsg(p));
        else if (p.cmd === "CLEARMSG") queue({ del: String(p.tags["target-msg-id"] || "").slice(0, 40) });
        else if (p.cmd === "CLEARCHAT") queue({ clearUser: p.text.toLowerCase().slice(0, 25) });
      }
    };
    ws.onerror = () => post({ t: "state", s: "error", why: "the connection to Twitch's chat failed" });
    ws.onclose = (e) => { ws = null; post({ t: "state", s: "closed", why: e && e.code ? "code " + e.code : "" }); if (!closed) setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++)); };
  };
  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.quiet) { closed = true; if (ws) { const old = ws; ws = null; old.onclose = null; try { old.close(); } catch {} } closed = false; login = ""; return; } // the page reads the chat itself now
    if (msg.room && /^\d{1,20}$/.test(msg.room) && msg.room !== room) { room = msg.room; sendEmotes(); return; } // the page reads the chat itself: it still wants the emotes
    if (msg.join && LOGIN_RE.test(msg.join) && msg.join !== login) {
      login = msg.join; room = ""; buf = [];
      if (msg.want && typeof msg.want === "object") want = { bttv: msg.want.bttv !== false, ffz: msg.want.ffz !== false, stv: msg.want.stv !== false, recent: msg.want.recent !== false };
      if (want.recent) sendRecent(login);
      if (ws) { const old = ws; ws = null; old.onclose = null; try { old.close(); } catch {} }
      connect();
    }
  });
  port.onDisconnect.addListener(() => { closed = true; clearTimeout(flushT); if (ws) { ws.onclose = null; try { ws.close(); } catch {} } });
});

// Messages from YTV's own pages and its copy in your YouTube tabs only (websites can't send these).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !msg || typeof msg !== "object") return;
  if (msg.ytv === "twitchLive" && Array.isArray(msg.logins)) { twitchLive(msg.logins).then(sendResponse); return true; }
  if (msg.ytv === "twitchVods" && typeof msg.login === "string") { twitchVods(msg.login).then(sendResponse); return true; }
  if (msg.ytv === "twitchSearch" && typeof msg.q === "string" && msg.q.length <= 60) { twitchSearch(msg.q).then(sendResponse); return true; }
  if (msg.ytv === "openSettings") {
    const hash = typeof msg.hash === "string" && /^#[\w-]{0,24}$/.test(msg.hash) ? msg.hash : "";
    const url = chrome.runtime.getURL("settings.html" + hash);
    (async () => {
      let win = null;
      try { if (sender.tab && sender.tab.windowId >= 0) win = await chrome.windows.get(sender.tab.windowId); } catch {}
      // a normal browser window: a new tab next to YouTube's
      if (!win || win.type === "normal") { try { await chrome.tabs.create({ url, ...(win ? { windowId: win.id, index: sender.tab.index + 1 } : {}) }); return; } catch {} }
      // YouTube installed as an app has no tabs: settings open in a small window of their own
      try { await chrome.windows.create({ url, type: "popup", width: 1180, height: 860, focused: true }); }
      catch { try { await chrome.windows.create({ url, focused: true }); } catch {} }
    })();
    return;
  }
  if (((msg.ytv === "searchCreators" || msg.ytv === "relatedCreators") && typeof msg.q === "string" && msg.q.length <= 120 || msg.ytv === "health") && !sender.tab) {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*"] });
        const tab = tabs.find((t) => !t.discarded);
        if (!tab) return sendResponse({ error: "no-tab" });
        sendResponse(await chrome.tabs.sendMessage(tab.id, msg.ytv === "health" ? { ytv: "health" } : { ytv: msg.ytv, q: msg.q }));
      } catch {
        sendResponse({ error: "failed" });
      }
    })();
    return true; // answer comes asynchronously
  }
});
