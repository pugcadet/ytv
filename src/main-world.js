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
  let endedFor = "", errorFor = "", playingFor = "", tick = 0;
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
    if (s === 1 && !isAd && playingFor !== id) {
      playingFor = id;
      let desc = "", channelId = "", keywords = [], publishDate = "", category = "";
      try {
        const pr = typeof p.getPlayerResponse === "function" ? p.getPlayerResponse() : null; const vdt = (pr && pr.videoDetails) || {};
        desc = vdt.shortDescription || ""; channelId = vdt.channelId || "";
        keywords = Array.isArray(vdt.keywords) ? vdt.keywords.filter((k) => typeof k === "string").slice(0, 30) : [];
        const mf = pr && pr.microformat && pr.microformat.playerMicroformatRenderer;
        publishDate = (mf && (mf.publishDate || mf.uploadDate)) || "";
        category = (mf && mf.category) || "";
      } catch {}
      emit("playing", { id, title: vd.title || "", author: vd.author || "", desc, channelId, keywords, publishDate, category });
    }
    if (s === 1 && !isAd && id && ++tick % 3 === 0) emit("time", { id, t: Math.floor(t), d: Math.floor(d) }); // ~every second, so a channel can resume where you left it
    const nearEnd = !isAd && d > 5 && t >= d - 0.8;
    if ((s === 0 || nearEnd) && id && endedFor !== id) { endedFor = id; emit("ended", { id }); }
  }, 400);

})();
