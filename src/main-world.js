/*
 * YTV — player bridge (runs in the YouTube page's own JS world).
 * Loads the videos YTV asks for into YouTube's own player and reports playing / time / ended / error.
 * Talks to YTV's content script only through two DOM events (ytv-cmd in, ytv-evt out); it has no
 * extension or storage access and makes no network requests.
 */
(() => {
  "use strict";
  if (window.__ytvBridge) return;
  window.__ytvBridge = true;
  // Only on a watch page with YTV on (YTV's content script marks <html data-ytv>).
  // Loads the videos YTV asks for into YouTube's own player and reports playing / ended / error.
  // It moves on just before a video ends, so YouTube's autoplay never navigates somewhere else.
  const tvOn = () => document.documentElement.hasAttribute("data-ytv") && location.pathname === "/watch";
  const emit = (evt, extra = {}) => document.dispatchEvent(new CustomEvent("ytv-evt", { detail: JSON.stringify({ evt, ...extra }) }));
  const tvPlayer = () => document.getElementById("movie_player");
  document.addEventListener("ytv-cmd", (e) => {
    if (!tvOn()) return;
    let c; try { c = JSON.parse(e.detail); } catch { return; }
    const p = tvPlayer();
    if (!p) return;
    try {
      if ((c.cmd === "load" || c.cmd === "announce") && QUAL.includes(c.q)) { wantQ = c.q; qDoneFor = ""; }
      if (c.cmd === "load" && /^[\w-]{11}$/.test(c.id) && typeof p.loadVideoById === "function") {
        endedFor = ""; playingFor = ""; errorFor = "";
        const start = Number(c.start) > 0 ? Math.floor(Number(c.start)) : 0;
        start ? p.loadVideoById(c.id, start) : p.loadVideoById(c.id);
      }
      if (c.cmd === "announce") playingFor = ""; // report the playing video again (YTV was switched on over it)
      if (c.cmd === "navigate" && /^[\w-]{11}$/.test(c.id)) { // open that video on the normal page without a reload
        const t = Number(c.start) > 0 ? Math.floor(Number(c.start)) : 0, app = document.querySelector("ytd-app");
        if (app) app.dispatchEvent(new CustomEvent("yt-navigate", { bubbles: true, composed: true, detail: { endpoint: {
          commandMetadata: { webCommandMetadata: { url: `/watch?v=${c.id}${t ? "&t=" + t + "s" : ""}`, webPageType: "WEB_PAGE_TYPE_WATCH", rootVe: 3832 } },
          watchEndpoint: { videoId: c.id, startTimeSeconds: t } } } }));
      }
      if (c.cmd === "seek" && Number(c.start) > 0 && typeof p.seekTo === "function") p.seekTo(Number(c.start), true);
      // YTV's own play bar: seek anywhere (also to the start), volume, and the picture quality for this video
      if (c.cmd === "seekto" && Number(c.start) >= 0 && typeof p.seekTo === "function") p.seekTo(Number(c.start), c.done !== false);
      if (c.cmd === "vol" && Number(c.v) >= 0 && Number(c.v) <= 100 && typeof p.setVolume === "function") { p.setVolume(Math.round(Number(c.v))); if (Number(c.v) > 0 && p.isMuted && p.isMuted()) p.unMute(); }
      if (c.cmd === "mute" && typeof p.isMuted === "function") { if (p.isMuted()) p.unMute(); else p.mute(); }
      if (c.cmd === "qlist") emit("qlist", { cur: p.getPlaybackQuality ? p.getPlaybackQuality() : "", list: (p.getAvailableQualityLevels ? p.getAvailableQualityLevels() || [] : []).filter((l) => ORDER.includes(l)) });
      if (c.cmd === "setq" && ORDER.includes(c.q) && typeof p.setPlaybackQualityRange === "function") {
        const prem = c.q === "hd1080" ? premium1080(p) : null; // 1080p is always the higher-bitrate one where the video has it
        if (prem) p.setPlaybackQualityRange("hd1080", "hd1080", prem.formatId);
        else { p.setPlaybackQualityRange(c.q, c.q); if (typeof p.setPlaybackQuality === "function") p.setPlaybackQuality(c.q); }
      }
      if (c.cmd === "repaint") {
        // Give the video a fresh layer so the picture comes back. (YouTube re-measures itself on the
        // resize events YTV sends; its internal size functions are never called — without exact sizes
        // they leave the player at a wrong size.)
        const v = p.querySelector("video");
        if (v) { v.style.transform = "translateZ(0)"; requestAnimationFrame(() => requestAnimationFrame(() => { v.style.transform = ""; })); }
      }
      if (c.cmd === "play" && typeof p.playVideo === "function") p.playVideo();
      if (c.cmd === "pause" && typeof p.pauseVideo === "function") p.pauseVideo();
    } catch {}
  });
  // A reload: YTV's content script put where to carry on from on <html> (data-ytv-seek="id:seconds"). The moment the
  // video element knows its length (before anything plays), it starts there: no jump in picture or sound later.
  const earlySeek = (e) => {
    const v = e.target, m = /^([\w-]{11}):(\d{1,6})$/.exec(document.documentElement.getAttribute("data-ytv-seek") || "");
    if (!m || !v || v.tagName !== "VIDEO" || !tvOn()) return;
    const p = tvPlayer(); if (!p || !p.contains(v)) return;
    let id = ""; try { id = ((p.getVideoData && p.getVideoData()) || {}).video_id || ""; } catch {}
    if (id && id !== m[1]) return;
    document.documentElement.removeAttribute("data-ytv-seek");
    const at = Number(m[2]);
    if (!(at > 0) || (v.duration && at >= v.duration - 5)) return;
    try { if (Math.abs(v.currentTime - at) > 2) v.currentTime = at; } catch {}
    try { applyQuality(p, id); } catch {} // (the quality too, before it plays: no switch half a second in)
  };
  document.addEventListener("loadedmetadata", earlySeek, true);
  document.addEventListener("playing", earlySeek, true);
  setTimeout(() => document.documentElement.removeAttribute("data-ytv-seek"), 20000); // (only for this page load)
  // Skip automatically (Settings → Playing): YouTube's own Skip button on an ad, clicked as
  // soon as it shows. Only buttons inside the player, only when they're visible.
  const SKIP_SEL = ".ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button, [class*='skip-ad'] button";
  const SKIP_TXT = /^(skip|skip ads?|overslaan|advertentie overslaan|advertenties overslaan)$/i;
  let skipAt = 0;
  const autoSkip = (p) => {
    if (!document.documentElement.hasAttribute("data-ytv-skip") || performance.now() - skipAt < 800) return;
    const seen = (b) => b && b.offsetParent !== null && !b.disabled && getComputedStyle(b).visibility !== "hidden";
    let b = [...p.querySelectorAll(SKIP_SEL)].find(seen);
    if (!b) b = [...p.querySelectorAll("button")].find((x) => !x.closest(".ytp-chrome-bottom") && seen(x) && SKIP_TXT.test(String(x.getAttribute("aria-label") || x.textContent || "").trim()));
    if (b) { skipAt = performance.now(); b.click(); }
  };
  let endedFor = "", errorFor = "", playingFor = "", tick = 0;
  // Video quality, once per video as soon as it plays: "premium" is 1080p Premium (YouTube's higher-bitrate 1080p,
  // playable with YouTube Premium) where the video has it, else 1080p; a video without 1080p plays in the best it has.
  const QUAL = ["premium", "hd1080", "hd720", "auto"], ORDER = ["hd2160", "hd1440", "hd1080", "hd720", "large", "medium", "small", "tiny"];
  let wantQ = "premium", qDoneFor = "";
  const premium1080 = (p) => {
    const data = typeof p.getAvailableQualityData === "function" ? p.getAvailableQualityData() || [] : [];
    return data.find((q) => q && q.quality === "hd1080" && /premium/i.test(q.qualityLabel || "") && q.isPlayable !== false && !q.paygatedQualityDetails && q.formatId) || null;
  };
  const applyQuality = (p, id) => {
    if (!id || qDoneFor === id || wantQ === "auto" || typeof p.setPlaybackQualityRange !== "function") return;
    const cap = wantQ === "hd720" ? "hd720" : "hd1080";
    const data = typeof p.getAvailableQualityData === "function" ? p.getAvailableQualityData() || [] : [];
    const levels = (typeof p.getAvailableQualityLevels === "function" ? p.getAvailableQualityLevels() || [] : []).filter((l) => ORDER.includes(l));
    if (!levels.length) return; // not known yet: next tick
    qDoneFor = id;
    if (wantQ === "premium" || wantQ === "hd1080") { // (1080p always means the higher-bitrate 1080p where it plays)
      const prem = premium1080(p);
      if (prem) { p.setPlaybackQualityRange("hd1080", "hd1080", prem.formatId); return; }
    }
    const target = levels.find((l) => ORDER.indexOf(l) >= ORDER.indexOf(cap)) || levels[levels.length - 1];
    p.setPlaybackQualityRange(target, target);
    if (typeof p.setPlaybackQuality === "function") p.setPlaybackQuality(target);
  };
  setInterval(() => {
    if (!tvOn()) return;
    const p = tvPlayer();
    if (!p || typeof p.getPlayerState !== "function") return;
    let s, vd = {}, t = 0, d = 0;
    try { s = p.getPlayerState(); vd = (p.getVideoData && p.getVideoData()) || {}; t = p.getCurrentTime ? p.getCurrentTime() : 0; d = p.getDuration ? p.getDuration() : 0; } catch { return; }
    const id = vd.video_id || "";
    const isAd = p.classList && p.classList.contains("ad-showing");
    const err = document.querySelector(".ytp-error");
    if (err && err.offsetParent !== null && errorFor !== id) { errorFor = id; emit("error", { id }); return; }
    // (a video YouTube won't play here at all, without its error screen showing: the same, so YTV moves on)
    try {
      const pr0 = typeof p.getPlayerResponse === "function" ? p.getPlayerResponse() : null, st0 = pr0 && pr0.playabilityStatus && pr0.playabilityStatus.status, id0 = (pr0 && pr0.videoDetails && pr0.videoDetails.videoId) || id;
      if ((st0 === "ERROR" || st0 === "UNPLAYABLE") && id0 && errorFor !== id0) { errorFor = id0; emit("error", { id: id0 }); return; }
    } catch {}
    if (s === 1 && !isAd && playingFor !== id) {
      playingFor = id;
      let desc = "", channelId = "", keywords = [], publishDate = "", category = "", sb = "";
      try {
        const pr = typeof p.getPlayerResponse === "function" ? p.getPlayerResponse() : null; const vdt = (pr && pr.videoDetails) || {};
        desc = vdt.shortDescription || ""; channelId = vdt.channelId || "";
        keywords = Array.isArray(vdt.keywords) ? vdt.keywords.filter((k) => typeof k === "string").slice(0, 30) : [];
        const mf = pr && pr.microformat && pr.microformat.playerMicroformatRenderer;
        publishDate = (mf && (mf.publishDate || mf.uploadDate)) || "";
        category = (mf && mf.category) || "";
        sb = String((pr && pr.storyboards && pr.storyboards.playerStoryboardSpecRenderer && pr.storyboards.playerStoryboardSpecRenderer.spec) || "").slice(0, 4000); // (the small pictures YouTube shows over its progress bar)
      } catch {}
      emit("playing", { id, title: vd.title || "", author: vd.author || "", desc, channelId, keywords, publishDate, category, sb });
    }
    if ((s === 1 || s === 3 || s === 5 || s === -1) && !isAd && id && qDoneFor !== id) { try { applyQuality(p, id); } catch { qDoneFor = id; } } // (as early as it can: before it plays, if YouTube already knows the qualities)
    if (s === 1 && !isAd && id && ++tick % 3 === 0) emit("time", { id, t: Math.floor(t), d: Math.floor(d), q: p.getPlaybackQuality ? p.getPlaybackQuality() : "" }); // ~every second, so a channel can resume where you left it
    autoSkip(p);
    const nearEnd = !isAd && d > 5 && t >= d - 0.8;
    if ((s === 0 || nearEnd) && id && endedFor !== id) { endedFor = id; emit("ended", { id }); }
  }, 400);

})();
