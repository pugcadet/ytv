/* YTV — toolbar menu: your channels, one click to watch. */
(() => {
  "use strict";
  const SW = globalThis.SW;
  const $ = (id) => document.getElementById(id);
  let cfg;
  const h = (tag, props = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    e.append(...kids.filter((x) => x != null));
    return e;
  };
  // Open YTV on the YouTube tab you're on, or in a new one.
  const openTv = async (colId) => {
    const hash = "#ytv=" + encodeURIComponent(colId);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && /^https:\/\/www\.youtube\.com\//.test(tab.url)) {
        await chrome.tabs.update(tab.id, { url: tab.url.split("#")[0] + hash });
        return window.close();
      }
    } catch {}
    await chrome.tabs.create({ url: "https://www.youtube.com/" + hash });
    window.close();
  };
  const render = () => {
    $("enabled").checked = cfg.enabled;
    const ids = ["__feed", ...SW.tvOrder(cfg.tv)];
    const btns = ids.slice(0, 13).map((id, i) => h("button", { class: "chan" + (id === "__feed" ? " feed" : ""), type: "button", title: `Watch ${SW.tvName(cfg.tv, id)}`, onclick: () => openTv(id), disabled: !cfg.enabled },
      h("span", { class: "n", text: String(i) }), h("span", { text: SW.tvName(cfg.tv, id) })));
    $("channels").replaceChildren(...btns);
  };
  $("enabled").addEventListener("change", async (e) => { cfg.enabled = e.target.checked; await SW.saveCfg(cfg); });
  const openSettings = (hash) => { chrome.tabs.create({ url: chrome.runtime.getURL("settings.html" + hash) }); window.close(); };
  $("settings").addEventListener("click", () => { chrome.runtime.openOptionsPage(); window.close(); });
  $("edit").addEventListener("click", (e) => { e.preventDefault(); openSettings("#channels"); });
  const load = async () => { ({ cfg } = await SW.load()); render(); };
  chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && changes.cfg) load(); });
  load();
})();
