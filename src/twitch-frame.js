/*
 * YTV — inside Twitch's player, only when YTV shows it on YouTube (Twitch Live).
 * Starts the stream right away (pressing Twitch's own Play or "start watching" button when it asks), with sound and in
 * source quality; keeps a live stream from being paused; leaves Twitch's own volume and quality controls (and any
 * hover overlays) working; and passes your keys, mouse movement and double-clicks on to YTV. It reads and sends
 * nothing else, and does nothing on Twitch anywhere else.
 */
(() => {
  "use strict";
  const PARENT = "https://www.youtube.com";
  const anc = location.ancestorOrigins;
  if (window === window.top || !anc || anc.length !== 1 || anc[0] !== PARENT) return; // embedded by YouTube (that is, by YTV), nowhere else
  const params = new URLSearchParams(location.search);
  const live = params.has("channel") && !params.has("video"), quality = /^[\w]{1,12}$/.test(params.get("ytvq") || "") ? params.get("ytvq") : "chunked";
  let warm = params.get("ytvwarm") === "1"; // loaded ahead (when you point at a stream): it already plays, muted and out of sight, until YTV says go
  try { localStorage.setItem("video-muted", JSON.stringify({ default: false })); localStorage.setItem("volume", "1"); } catch {} // Twitch's player: sound on, at full volume
  const say = (m) => { try { window.parent.postMessage({ ytvTw: m }, PARENT); } catch {} };
  const video = () => document.querySelector("video");
  // a live stream has no pause; YTV's full screen is the one that counts (it keeps YTV's own UI)
  const style = document.createElement("style");
  style.textContent = (live ? '[data-a-target="player-play-pause-button"]{display:none!important}' : "") +
    '[data-a-target="player-fullscreen-button"],[data-a-target="player-theatre-mode-button"],button[aria-label^="Theatre"],' +
    // Follow, Subscribe and Gift a Sub (and Twitch's logo link) on the player: not needed here
    '[data-a-target*="follow-button"],[data-a-target*="subscribe-button"],[data-a-target*="gift"],[data-test-selector*="follow-button"],[data-test-selector*="subscribe-button"],[data-test-selector*="gift"],[data-a-target="player-twitch-logo-button"],[data-a-target="player-stream-info-social-panel"],.ytv-hide{display:none!important}' +
    // Twitch's own top bar (picture, title, game: YTV's top bar shows those) and its big Play button and blurred
    // preview while starting (YTV presses Play itself) stay out of sight
    // the volume always stays at full (YouTube's own volume is the one you set): its slider isn't needed, mute stays
    '[data-a-target="player-volume-slider"],.volume-slider__slider-container{display:none!important}' +
    '.video-player__overlay .top-bar,[data-a-target="player-overlay-preview-background"]{display:none!important}[data-a-target="player-overlay-play-button"]{opacity:0!important}' +
    // while YTV picks the quality for you, Twitch's settings menu stays out of sight
    'html.ytv-q [data-a-target="player-settings-menu"],html.ytv-q [role="menu"]{opacity:0!important;pointer-events:none!important}';
  const hideWatchOn = () => { for (const b of document.querySelectorAll("button:not(.ytv-hide), a:not(.ytv-hide)")) if (/^watch on twitch$/i.test((b.textContent || "").trim())) b.classList.add("ytv-hide"); };
  (document.head || document.documentElement).append(style);
  let started = false, lastTry = 0, unmuted = false, held = false; // held: you paused it with Space (only then does a live stream stay paused)
  const START_BUTTONS = ['[data-a-target="player-overlay-mature-accept"]', '[data-a-target*="mature"] button', 'button[data-a-target*="mature"]', '[data-a-target*="start-watching"]', '[data-test-selector*="start-watching"]',
    '[data-a-target*="content-classification"] button', '[data-test-selector*="content-classification"] button', '[data-a-target*="gate"] button', '[data-test-selector*="gate"] button', '[data-a-target="player-overlay-play-button"]'];
  const START_WORDS = /start watching|begin watching|watch now|i understand|continue|kijken|begin met|starten|afspelen|ansehen|regarder|^play$|^watch$/i;
  const startButton = () => {
    for (const sel of START_BUTTONS) { const b = document.querySelector(sel); if (b && b.offsetParent !== null) return b; }
    // anything else over the picture that asks for a click to start (the adult-content notice comes in many wordings)
    for (const b of document.querySelectorAll("button")) {
      if (b.closest('[data-a-target="player-controls"], [data-a-target*="extension"], [data-test-selector*="extension"], [class*="extension"]') || b.offsetParent === null) continue;
      const t = (b.getAttribute("aria-label") || b.textContent || "").trim();
      if (t && t.length < 40 && START_WORDS.test(t)) return b;
    }
    return null;
  };
  const kick = () => {
    if (held) return; // paused with Space: leave it
    const sb = startButton(); if (sb) { sb.click(); return; } // "start watching" (adult content notice) and Play, as you would
    const v = video();
    if (!v) return;
    if (warm) { if (!v.muted) v.muted = true; if (v.paused && v.readyState > 0 && performance.now() - lastTry > 300) { lastTry = performance.now(); v.play().catch(() => {}); } return; } // silent until it's wanted
    if (!v.paused && v.readyState > 2) {
      if (v.muted && !unmuted) { // started without sound: turn it on (if the browser says no, it stays muted and YTV tells you)
        unmuted = true; v.muted = false;
        setTimeout(() => { if (v.paused) { v.muted = true; v.play().catch(() => {}); say({ playing: true, muted: true }); } }, 150);
      }
      if (!started) { started = true; say({ playing: true, muted: v.muted }); setTimeout(pickQuality, 600); }
      return;
    }
    if (v.paused && performance.now() - lastTry > 300) { lastTry = performance.now(); v.play().catch((e) => { if (e && e.name === "NotAllowedError") { v.muted = true; v.play().catch(() => {}); } }); }
  };
  // Twitch ignores a saved quality in its player: pick it in its own settings menu, out of sight, once the stream plays
  const QUALITY_MATCH = { chunked: (t) => /\(source\)/i.test(t), "1080p60": (t) => /^1080p60/i.test(t), "720p60": (t) => /^720p60/i.test(t), "720p30": (t) => /^720p(?!60)/i.test(t), "480p30": (t) => /^480p/i.test(t), "360p30": (t) => /^360p/i.test(t), auto: (t) => /^auto/i.test(t) };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pickQuality = async () => {
    if (quality === "keep" || !QUALITY_MATCH[quality]) return;
    const gear = document.querySelector('[data-a-target="player-settings-button"]'); if (!gear) return;
    document.documentElement.classList.add("ytv-q");
    try {
      gear.click(); await wait(250);
      const item = document.querySelector('[data-a-target="player-settings-menu-item-quality"]'); if (!item) return;
      item.click(); await wait(250);
      const labels = [...document.querySelectorAll('input[type=radio][data-a-target="tw-radio"]')].map((r) => [r, document.querySelector(`label[for="${window.CSS.escape(r.id)}"]`)]).filter(([, l]) => l);
      const hit = labels.find(([, l]) => QUALITY_MATCH[quality](l.textContent.replace(/\s+/g, " ").trim()));
      if (hit && !hit[0].disabled) hit[1].click();
      else if (hit && hit[0].disabled) say({ qualityLocked: true }); // Twitch only gives higher quality to people logged in to twitch.tv
    } finally {
      await wait(150);
      if (document.querySelector('[data-a-target="player-settings-menu"]')) gear.click(); // close the menu again
      await wait(100); document.documentElement.classList.remove("ytv-q");
    }
  };
  let q = 0;
  // Twitch's player changes its page many times a second: until the stream plays, look every frame; after that, at most
  // twice a second (enough for a notice that pops up mid-stream), so a long stream costs next to nothing
  let lastLook = 0;
  const look = () => { q = 0; lastLook = performance.now(); kick(); hideWatchOn(); };
  const obs = new MutationObserver(() => { if (q) return; if (!started || warm) q = requestAnimationFrame(look); else q = setTimeout(look, Math.max(0, 500 - (performance.now() - lastLook))); });
  const onMedia = (e) => { kick(); if (live && started && e.type === "pause" && !warm && !held) setTimeout(() => { const v = video(); if (v && v.paused && !held) v.play().catch(() => {}); }, 50); }; // live never pauses by itself (only with Space)
  const begin = () => { obs.observe(document.documentElement, { childList: true, subtree: true }); for (const ev of ["playing", "loadeddata", "pause", "canplay"]) document.addEventListener(ev, onMedia, true); kick(); };
  if (document.documentElement) begin(); else document.addEventListener("readystatechange", begin, { once: true });
  setInterval(() => { if (warm || !started || (video() && video().muted && !unmuted)) kick(); }, 150);
  setInterval(() => { const v = video(); if (v && !warm && v.volume < 1) v.volume = 1; }, 500); // always at full volume
  say({ hello: true, warm }); // (if YTV already wants this one playing, it answers "go")
  // a click on the picture would pause a live stream: not here. Double-click: YTV's full screen.
  window.addEventListener("click", (e) => { if (live && e.target && e.target.closest && e.target.closest('[data-a-target="player-overlay-click-handler"], video')) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  window.addEventListener("dblclick", (e) => { e.preventDefault(); e.stopImmediatePropagation(); say({ dbl: true }); }, true);
  let lastMove = 0;
  window.addEventListener("mousemove", () => { const t = performance.now(); if (t - lastMove > 150) { lastMove = t; say({ move: true }); } }, true);
  // keys pressed while the player has the focus belong to YTV (its shortcuts work everywhere, also over the stream)
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || "") || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return; // the browser's own shortcuts stay the browser's
    if (e.key.length !== 1 && !/^(Escape|Arrow\w+|Delete|Backspace|Page\w+|F\d+)$/.test(e.key)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    say({ key: e.key.slice(0, 12), code: String(e.code || "").slice(0, 20), shift: e.shiftKey, ctrl: false, meta: false, alt: false });
  }, true);
  window.addEventListener("message", (e) => {
    if (e.origin !== PARENT || !e.data || typeof e.data !== "object" || !e.data.ytvTw || typeof e.data.ytvTw !== "object") return;
    const c = e.data.ytvTw, v = video();
    if (c.cmd === "go") { if (warm) { warm = false; unmuted = false; started = false; kick(); } say({ going: true }); return; }
    if (!v) return;
    if (c.cmd === "mute") { v.muted = !!c.on; unmuted = true; }
    else if (c.cmd === "volume") { v.volume = 1; } // (always full)
    else if (c.cmd === "pause") { held = true; v.pause(); }
    else if (c.cmd === "play") { held = false; v.play().catch(() => {}); }
  });
})();
