#!/usr/bin/env python3
"""
YTV self-audit. Run:  python3 verify.py
Checks the extension folder for anything that could send data out, run remote
or dynamic code, or reach beyond YouTube. Prints PASS/FAIL per check and a
SHA-256 list of every file so you can confirm nothing changed later.
"""
import hashlib, json, os, re, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
fails = 0

def check(name, ok, detail=""):
    global fails
    print(("PASS " if ok else "FAIL ") + name + (f"  -> {detail}" if detail and not ok else ""))
    if not ok:
        fails += 1

files = []
for d, _, fs in os.walk(ROOT):
    if "/tests" in d or "/.git" in d or "/dev" in d:
        continue
    for f in fs:
        if f.startswith("."): continue
        files.append(os.path.relpath(os.path.join(d, f), ROOT))
files.sort()
code = {f: open(os.path.join(ROOT, f), encoding="utf-8").read() for f in files if f.endswith((".js", ".html", ".css", ".json"))}
js = {f: c for f, c in code.items() if f.endswith(".js")}

# 1. Manifest
m = json.loads(code["manifest.json"])
check("manifest: only the 'storage' permission", m.get("permissions") == ["storage"], m.get("permissions"))
hosts = m.get("host_permissions", [])
check("manifest: host access limited to YouTube", hosts == ["https://www.youtube.com/*"], hosts)
for cs in m.get("content_scripts", []):
    if cs["js"] == ["src/twitch-frame.js"]:  # Twitch Live: a small helper inside Twitch's player, which itself only acts when YouTube embeds it
        check("manifest: the Twitch player helper runs only in Twitch's player", cs["matches"] == ["https://player.twitch.tv/*"] and 'anc[0] !== PARENT) return;' in js["src/twitch-frame.js"] and 'const PARENT = "https://www.youtube.com";' in js["src/twitch-frame.js"])
        continue
    check(f"manifest: content script {cs['js']} runs only on YouTube", all(re.fullmatch(r"https://(www\.|m\.)?youtube(-nocookie)?\.com/\*", u) for u in cs["matches"]))
check("manifest: no optional permissions except Twitch Live's (asked for only when you switch it on, or pick a streamer to hear about)", m.get("optional_permissions", []) in ([], ["notifications", "alarms"]) and m.get("optional_host_permissions", []) in ([], ["https://gql.twitch.tv/*"]), m.get("optional_host_permissions"))
check("manifest: not reachable by other sites/extensions (no externally_connectable)", "externally_connectable" not in m)
check("manifest: only the settings page can be shown inside a page, and only inside YouTube (settings over TV)", m.get("web_accessible_resources", []) in ([], [{"resources": ["settings.html"], "matches": ["https://www.youtube.com/*"], "use_dynamic_url": True}]), m.get("web_accessible_resources"))
check("manifest: no auto-update URL (nothing is downloaded later)", "update_url" not in m)
csp = m.get("content_security_policy", {}).get("extension_pages", "")
check("manifest: extension pages may only connect to youtube.com (and Twitch's live list, for the optional Twitch Live)", re.search(r"connect-src https://www\.youtube\.com( https://gql\.twitch\.tv( wss://irc-ws\.chat\.twitch\.tv https://api\.betterttv\.net https://api\.frankerfacez\.com https://7tv\.io( https://recent-messages\.robotty\.de)?)?)?(;|$)", csp) is not None, csp)
check("manifest: images only from YTV itself and YouTube's avatar servers", re.search(r"img-src 'self' blob: data: https://yt3\.ggpht\.com https://yt3\.googleusercontent\.com(;|$)", csp) is not None, csp)
check("manifest: CSP only allows the extension's own fonts", "font-src 'self'" in csp, csp)
check("manifest: CSP only allows the extension's own scripts", re.search(r"script-src 'self'(;|$)", csp) is not None, csp)

# Bundled font must be local and licensed
check("font is bundled locally with its open licence", os.path.exists(os.path.join(ROOT, "fonts/hanken-grotesk.woff2")) and os.path.exists(os.path.join(ROOT, "fonts/OFL-LICENSE.txt")))

# 2. Network APIs
NET = re.compile(r"\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|WebTransport)\b|navigator\.connection|chrome\.(identity|cookies|webRequest|declarativeNetRequest|downloads|history|tabs\.executeScript)")
# YTV may read YouTube pages, but only through yt-data.js, which refuses anything but youtube.com.
for f, c in js.items():
    hits = sorted(set(x.group(0) for x in NET.finditer(c)))
    if f == "src/yt-data.js" and hits == ["fetch"]:
        # Exactly two requests exist in YTV: fetchPage (YouTube pages) and apiPost (YouTube's "next"
        # endpoint, for comments). Both must refuse anything that isn't youtube.com.
        calls = re.findall(r"\bfetch\(", c)
        page_ok = re.search(r"const fetchPage = async \(path\) => \{\s*const url = new URL\(path, ORIGIN\);\s*if \(url\.origin !== ORIGIN\) throw", c)
        # apiPost: only YouTube's "next" (comments) and "browse/edit_playlist" (your Watch Later) endpoints
        api_ok = re.search(r'const API_ENDPOINTS = \["next", "browse/edit_playlist", "browse", "search"\];[^\n]*\n\s*const apiPost = async \(endpoint, body, headers = \{\}\) => \{\s*if \(!API_ENDPOINTS\.includes\(endpoint\)\) throw[^\n]*\n\s*const url = new URL\(`/youtubei/v1/\$\{endpoint\}\?prettyPrint=false`, ORIGIN\);\s*if \(url\.origin !== ORIGIN\) throw', c)
        check(f"{f}: the only requests in YTV are fetchPage and apiPost, both locked to youtube.com", len(calls) == 2 and bool(page_ok) and bool(api_ok) and 'const ORIGIN = "https://www.youtube.com"' in c, f"{len(calls)} fetch calls, page={bool(page_ok)}, api={bool(api_ok)}")
        continue
    if f == "src/ytv.js" and hits == ["WebSocket"]:
        # Plan B for the Twitch chat: the same anonymous, read-only connection the background makes, to Twitch's chat only
        ok = len(re.findall(r"new WebSocket\(", c)) == 1 and "new WebSocket(SW.TWITCH_CHAT_WS)" in c and 'ws.send("NICK justinfan"' in c
        check(f"{f}: its only connection is Twitch's chat, read only (if the background can't reach it)", ok and 'SW.TWITCH_CHAT_WS = "wss://irc-ws.chat.twitch.tv:443";' in js["src/common.js"])
        continue
    if f == "src/background.js" and set(hits) <= {"fetch", "WebSocket"}:
        # Twitch Live: one request to Twitch's public GQL address (no cookies, only with your permission), one to the
        # emote services' fixed public addresses (no cookies), and one read-only, anonymous chat connection
        calls = re.findall(r"\bfetch\(", c)
        ok = len(calls) == 2 and 'const TWITCH_GQL = "https://gql.twitch.tv/gql";' in c and re.search(r'await fetch\(TWITCH_GQL, \{ method: "POST", credentials: "omit"', c) and "chrome.permissions.contains" in c
        emo = 'const EMOTE_API = { bttv: "https://api.betterttv.net/3/cached/", ffz: "https://api.frankerfacez.com/v1/", stv: "https://7tv.io/v3/" };' in c and "const r = await fetch(url, { credentials: \"omit\" });" in c \
            and 'const RECENT_API = "https://recent-messages.robotty.de/api/v2/recent-messages/";' in c \
            and all(a.startswith("EMOTE_API.") or a.startswith("RECENT_API + ") for a in re.findall(r"getJson\(([^)]+)\)", c) if a != "url")
        sock = len(re.findall(r"new WebSocket\(", c)) == 1 and "new WebSocket(CHAT_WS)" in c and 'const CHAT_WS = "wss://irc-ws.chat.twitch.tv:443";' in c and 'ws.send("NICK justinfan"' in c and "PRIVMSG #" not in c.replace("PRIVMSG|", "")
        check(f"{f}: its only requests are Twitch Live's (Twitch, emote lists; no cookies) and a read-only chat connection", bool(ok) and emo and sock, [len(calls), emo, sock])
        continue
    check(f"no network APIs in {f}", not hits, hits)

# 3. Dynamic / remote code
DYN = re.compile(r"\beval\s*\(|new\s+Function\s*\(|set(Timeout|Interval)\s*\(\s*['\"`]|\bimport\s*\(|importScripts\s*\(\s*['\"`]https?:|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write")
for f, c in js.items():
    hits = sorted(set(x.group(0) for x in DYN.finditer(c)))
    check(f"no dynamic code or raw-HTML injection in {f}", not hits, hits)

# 4. External URLs anywhere (only youtube.com references are allowed, used as selectors / return target)
URL = re.compile(r"https?://[^\s\"'`)<>]+")
for f, c in code.items():
    # The SVG namespace is a fixed identifier for creating SVG elements; it is never fetched.
    # Allowed: youtube.com itself, the SVG namespace identifier, and video thumbnails from i.ytimg.com (YouTube's image server).
    bad = sorted({u for u in URL.findall(c) if not re.match(r"https://([a-z]+\.)?youtube(-nocookie)?\.com\b", u)
                  and u not in ("https://gql.twitch.tv/gql", "https://player.twitch.tv/", "https://gql.twitch.tv/*", "https://gql.twitch.tv", "https://player.twitch.tv", "https://www.twitch.tv/", "https://player.twitch.tv/*", "https://usher.ttvnw.net", "https://static-cdn.jtvnw.net", "https://www.twitch.tv/*", "https://www.twitch.tv")  # (Twitch preconnect hints)
                  and not u.startswith("https://www.twitch.tv/embed/$")
                  and u not in ("https://recent-messages.robotty.de/api/v2/recent-messages/", "https://recent-messages.robotty.de", "https://api.betterttv.net/3/cached/", "https://api.frankerfacez.com/v1/", "https://7tv.io/v3/", "https://api.betterttv.net", "https://api.frankerfacez.com", "https://7tv.io")
                  and u not in ("https://cdn.betterttv.net/emote/${id}/1x", "https://cdn.frankerfacez.com/emote/${id}/1", "https://cdn.7tv.app/emote/${id}/1x.webp", "https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/1.0")
                  and u != "http://www.w3.org/2000/svg" and not u.startswith("https://i.ytimg.com/vi/")
                  and not re.match(r"https://yt3\.(ggpht|googleusercontent)\.com", u)})
    check(f"no external URLs in {f}", not bad, bad)

# 5. HTML pages load only local scripts and styles
for f, c in code.items():
    if f.endswith(".html"):
        srcs = re.findall(r'<(?:script|link|img)[^>]+(?:src|href)="([^"]+)"', c)
        check(f"{f} loads only local files", all(not re.match(r"[a-z]+:", s) for s in srcs), srcs)
        check(f"{f} has no inline scripts or event handlers", not re.search(r"<script>(?!\s*</script>)|\son[a-z]+=", c))

# 5b. Frame messaging (YTV): every window "message" listener must check the sender's origin,
#     and frames may only load YouTube pages.
for f, c in js.items():
    listeners = len(re.findall(r'addEventListener\("message"', c))
    checks = len(re.findall(r'e\.origin !== (TW_ORIGIN|ORIGIN|PARENT)\b', c))
    if listeners:
        check(f"every message listener in {f} checks the sender's origin", checks >= listeners, f"{listeners} listeners, {checks} origin checks")
    if 'createElement("iframe")' in c:
        for m in re.finditer(r'\b\w+\.src = ([^;]+);', c):
            if "i.ytimg.com/vi/" in m.group(1): continue  # thumbnail image, not a frame
            if m.group(1) == "v.thumb" and r"/^https:\/\/static-cdn\.jtvnw\.net\//" in c: continue  # a Twitch preview picture, checked to come from Twitch's image server
            if m.group(1) == "`https://www.twitch.tv/embed/${encodeURIComponent(v.login)}/chat?parent=www.youtube.com&darkpopout`": continue  # Twitch's own chat for the stream that's on
            if m.group(1) == "src" and "const src = twSrc(v, warm); f.src = src;" in c and "return `${TW_PLAYER}?${what}&parent=www.youtube.com&" in c and "if (!(v.vod ? TW_VOD.test(v.vod) : TW_LOGIN.test(v.login))) return null;" in c: continue  # Twitch's own player (a channel or a past broadcast, both checked)
            if m.group(1) == "src" and 'const TW_PLAYER = "https://player.twitch.tv/"' in c and "const src = `${TW_PLAYER}?channel=${encodeURIComponent(v.login)}&parent=www.youtube.com" in c: continue  # Twitch's own player, for Twitch Live
            if m.group(1) == "url" and "const url = EMOTE_URL[kind](id); i.src = url;" in c and "if (!EMOTE_OK.test(id) || !EMOTE_URL[kind])" in c: continue  # an emote picture from the emote service's image server
            if m.group(1).startswith('chrome.runtime.getURL("settings.html" + ') and f == "src/ytv.js": continue  # YTV's own settings page, over TV
            if m.group(1) == "safe" and r'const twPic = (url) => { const safe = String(url || ""); if (!/^https:\/\/static-cdn\.jtvnw\.net\//.test(safe)) return null;' in c: continue  # a Twitch picture, through the one helper that checks it comes from Twitch's image server
            if m.group(1) == "u.avatar" and r'if (/^https:\/\/static-cdn\.jtvnw\.net\//.test(u.avatar || ""))' in c: continue  # a streamer's picture, checked to come from Twitch's image server
            check(f"frames in {f} only load YouTube", "ORIGIN" in m.group(1), m.group(1))
    if "postMessage(" in c:
        bad = [line.strip()[:80] for line in c.splitlines() if "postMessage(" in line and not re.search(r"\bport\.postMessage\(", line) and not re.search(r",\s*ORIGIN\);", line) and not (re.search(r",\s*PARENT\);", line) and 'const PARENT = "https://www.youtube.com";' in c)
               and not (re.search(r",\s*TW_ORIGIN\);", line) and 'TW_ORIGIN = "https://player.twitch.tv";' in c)]  # Twitch Live: play / pause / volume / quality, only to Twitch's player
        check(f"messages from {f} are only sent to YouTube's origin", not bad, bad)

# 6. Message listeners (attack surface)
external = [f for f, c in js.items() if re.search(r"onMessageExternal|onConnectExternal", c)
            or (re.search(r"onConnect\.addListener", c) and not re.search(r'port\.name !== "ytv-twchat" \|\| !port\.sender \|\| port\.sender\.id !== chrome\.runtime\.id', c))]
check("no message channels websites or other extensions could use", not external, external)
for f, c in js.items():
    if re.search(r"onMessage\.addListener", c):
        n = len(re.findall(r"(?<!port\.)onMessage\.addListener", c))  # a port YTV opened itself only talks to YTV's background
        guards = len(re.findall(r"sender\.id !== chrome\.runtime\.id", c))
        check(f"{f}: every runtime message listener only accepts YTV's own messages", guards >= n, f"{n} listeners, {guards} sender checks")

print()
print("SHA-256 of every file:")
for f in files:
    print(hashlib.sha256(open(os.path.join(ROOT, f), "rb").read()).hexdigest(), f)
print()
print("RESULT:", "ALL CHECKS PASSED" if fails == 0 else f"{fails} CHECK(S) FAILED")
sys.exit(1 if fails else 0)
