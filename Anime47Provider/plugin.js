(function () {
    /**
     * Anime47 plugin for SkyStream.
     *
     * Logic reference: ported (rewritten, not copy-pasted) from an existing
     * CloudStream3 Kotlin provider for the same site. The site exposes a JSON
     * API under {API_BASE}/api rather than server-rendered HTML, so this
     * plugin talks to that API directly instead of scraping HTML.
     *
     * Multi-server playback:
     *   - Most servers on Anime47 return a direct .m3u8 URL -> played as-is.
     *   - The "HY" server (Hydrax / Abyss.to) does NOT return a playable URL.
     *     It returns an embed page containing an AES-CTR encrypted blob. That
     *     blob is decrypted server-side via the community "enc-dec.app"
     *     helper API (same approach used by other SkyStream anime plugins for
     *     Abyss/Hydrax embeds), which returns the real source list.
     */

    const MAIN_URL = (typeof manifest !== "undefined" && manifest.baseUrl) || "https://anime47.best";
    // Anime47's JSON API historically lives on a sibling domain. If the API
    // ever moves to the same host as baseUrl, change API_BASE to MAIN_URL.
    const API_BASE = "https://anime47.love/api";

    const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

    const HEADERS = {
        "User-Agent": UA,
        "Origin": MAIN_URL,
        "Referer": MAIN_URL + "/"
    };

    // ===================== hardcoded account (private use only) =====================
    // WARNING: plain-text credentials baked into the plugin. Do not publish this
    // file/repo publicly unless you're fine with the account being exposed.
    const ACCOUNT_EMAIL = "sumaymanlon@gmail.com";
    const ACCOUNT_PASSWORD = "Kobe1234@";

    let cachedToken = null;
    let tokenPromise = null;

    async function login() {
        const body = { login: ACCOUNT_EMAIL, password: ACCOUNT_PASSWORD };
        const res = await postJson(API_BASE + "/auth/login", {
            "Content-Type": "application/json",
            "Origin": MAIN_URL,
            "Referer": MAIN_URL + "/"
        }, body);
        if (!res || !res.access_token) throw new Error("Đăng nhập Anime47 thất bại.");
        return res.access_token;
    }

    // Ensures we have a valid token, logging in at most once concurrently.
    async function ensureToken() {
        if (cachedToken) return cachedToken;
        if (!tokenPromise) {
            tokenPromise = login()
                .then(function (token) {
                    cachedToken = token;
                    tokenPromise = null;
                    return token;
                })
                .catch(function (e) {
                    tokenPromise = null;
                    throw e;
                });
        }
        return tokenPromise;
    }

    async function authHeaders() {
        try {
            const token = await ensureToken();
            return { "Authorization": "Bearer " + token };
        } catch (e) {
            return {};
        }
    }

    // ===================== small helpers =====================

    function safeParse(data) {
        if (!data) return null;
        if (typeof data === "object") return data;
        try {
            return JSON.parse(data);
        } catch (e) {
            return null;
        }
    }

    function fixUrl(raw) {
        if (!raw) return "";
        const url = String(raw).trim();
        if (!url || url.startsWith("data:")) return "";
        if (/via\.placeholder\.com/i.test(url)) return "";
        if (url.startsWith("//")) return "https:" + url;
        if (/^https?:\/\//i.test(url)) return url;
        try {
            return new URL(url, MAIN_URL).href;
        } catch (e) {
            return "";
        }
    }

    function digitsOnly(value) {
        const match = String(value || "").match(/\d+/);
        return match ? parseInt(match[0], 10) : undefined;
    }

    function getHost(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, "");
        } catch (e) {
            return "";
        }
    }

    async function fetchJsonWithAuth(url, extraHeaders) {
        const auth = await authHeaders();
        const headers = Object.assign({}, HEADERS, extraHeaders || {}, auth);
        const res = await http_get(url, headers);
        return (res && res.body) || "";
    }

    // GETs `url` as JSON, automatically attaching the cached auth token.
    // If the response is gated by PRIVATE_MODE, forces a fresh login once
    // and retries (covers the case where a cached token has expired).
    async function getJson(url, headers) {
        let body = await fetchJsonWithAuth(url, headers);

        if (body.indexOf('"PRIVATE_MODE"') !== -1) {
            cachedToken = null;
            body = await fetchJsonWithAuth(url, headers);
        }

        if (body.indexOf('"PRIVATE_MODE"') !== -1) {
            throw new Error("Trang yêu cầu đăng nhập (PRIVATE_MODE) và đăng nhập tài khoản cấu hình sẵn thất bại.");
        }

        const data = safeParse(body);
        if (!data) throw new Error("Không parse được JSON từ: " + url);
        return data;
    }

    async function postJson(url, headers, bodyObj) {
        const res = await http_post(url, headers, JSON.stringify(bodyObj));
        const body = res && res.body ? res.body : "";
        return safeParse(body);
    }

    // ===================== mapping helpers =====================

    function mediaItemFromPost(post) {
        const link = fixUrl(post.link);
        if (!link || !post.title) return null;
        const epLabel = post.current_episode || post.episodes;
        const item = new MultimediaItem({
            title: post.title,
            url: link,
            posterUrl: fixUrl(post.poster || post.image),
            type: "anime",
            year: post.year ? digitsOnly(post.year) : undefined
        });
        if (epLabel) item.description = "Tập hiện tại: " + epLabel;
        return item;
    }

    // ===================== 1. getHome =====================

    const HOME_SECTIONS = [
        { path: "/anime/filter?lang=vi&sort=latest", name: "Anime Mới Cập Nhật" },
        { path: "/anime/filter?lang=vi&sort=rating", name: "Top Đánh Giá" },
        { path: "/anime/filter?lang=vi&type=tv", name: "Anime TV" },
        { path: "/anime/filter?lang=vi&type=movie", name: "Anime Movie" }
    ];

    async function getHome(cb) {
        try {
            const home = {};
            for (const section of HOME_SECTIONS) {
                try {
                    const data = await getJson(API_BASE + section.path + "&page=1");
                    const posts = data && data.data && data.data.posts ? data.data.posts : [];
                    const items = posts.map(mediaItemFromPost).filter(Boolean);
                    if (items.length) home[section.name] = items;
                } catch (e) {
                    // one section failing shouldn't break the whole dashboard
                }
            }
            if (!Object.keys(home).length) {
                return cb({ success: false, errorCode: "SITE_OFFLINE", message: "Không tải được trang chủ Anime47." });
            }
            cb({ success: true, data: home });
        } catch (e) {
            cb({ success: false, errorCode: "SITE_OFFLINE", message: e.message || String(e) });
        }
    }

    // ===================== 2. search =====================

    async function search(query, cb) {
        try {
            const url = API_BASE + "/search/full/?lang=vi&keyword=" + encodeURIComponent(query) + "&page=1";
            const data = await getJson(url);
            const results = (data && data.results) || [];
            const items = results.map(function (item) {
                return mediaItemFromPost({
                    title: item.title,
                    link: item.link,
                    poster: item.image,
                    year: null,
                    current_episode: item.current_episode,
                    episodes: item.episodes
                });
            }).filter(Boolean);
            cb({ success: true, data: items });
        } catch (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message || String(e) });
        }
    }

    // ===================== 3. load =====================

    function extractAnimeId(url) {
        const match = String(url || "").replace(/\/$/, "").match(/(\d+)(?:\.html)?$/);
        return match ? match[1] : null;
    }

    async function load(url, cb) {
        try {
            const animeId = extractAnimeId(url);
            if (!animeId) throw new Error("Không lấy được ID anime từ URL: " + url);

            const [infoRes, episodesRes, recsRes] = await Promise.all([
                getJson(API_BASE + "/anime/info/" + animeId + "?lang=vi").catch(function () { return null; }),
                getJson(API_BASE + "/anime/" + animeId + "/episodes?lang=vi").catch(function () { return null; }),
                getJson(API_BASE + "/anime/info/" + animeId + "/recommendations?lang=vi").catch(function () { return null; })
            ]);

            const detail = infoRes && infoRes.data;
            if (!detail) throw new Error("Không tải được thông tin phim.");

            // Flatten teams -> groups -> episodes, then dedupe/group by episode number.
            const allEpisodes = [];
            if (episodesRes && Array.isArray(episodesRes.teams)) {
                episodesRes.teams.forEach(function (team) {
                    (team.groups || []).forEach(function (group) {
                        (group.episodes || []).forEach(function (ep) {
                            if (ep && ep.number != null) allEpisodes.push(ep);
                        });
                    });
                });
            }

            const byNumber = {};
            allEpisodes.forEach(function (ep) {
                const num = ep.number;
                if (!byNumber[num]) byNumber[num] = [];
                if (byNumber[num].indexOf(ep.id) === -1) byNumber[num].push(ep.id);
            });

            const episodeNumbers = Object.keys(byNumber).map(Number).sort(function (a, b) { return a - b; });

            const episodes = episodeNumbers.map(function (num) {
                // data payload = JSON list of episode ids sharing this number
                // (different fansub "teams" often re-upload the same episode
                // number under different ids; loadStreams tries them all).
                return new Episode({
                    name: "Tập " + num,
                    url: JSON.stringify(byNumber[num]),
                    season: 1,
                    episode: num
                });
            });

            const posterUrl = fixUrl(detail.poster);
            const genres = (detail.genres || []).map(function (g) { return g.name; }).filter(Boolean);
            const cast = (detail.characters || []).map(function (c) {
                if (!c.name) return null;
                return new Actor({ name: c.name, role: c.role || "", image: fixUrl(c.image_url) });
            }).filter(Boolean);

            const recommendations = ((recsRes && recsRes.data) || []).map(mediaItemFromPost).filter(Boolean);

            const item = new MultimediaItem({
                title: detail.title || "Unknown Title",
                url: url,
                posterUrl: posterUrl,
                type: "anime",
                year: detail.year ? digitsOnly(detail.year) : undefined,
                score: detail.score ? Number(detail.score) : undefined,
                description: detail.description || "",
                cast: cast,
                recommendations: recommendations
            });
            item.tags = genres;
            item.episodes = episodes;

            cb({ success: true, data: item });
        } catch (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message || String(e) });
        }
    }

    // ===================== 4. loadStreams =====================

    const HY_HOSTS = ["abysscdn.com", "playhydrax.com", "zplayer.io", "short.ink", "abyssplayer.com", "short.icu"];

    function isHydraxUrl(url) {
        const host = getHost(url);
        return HY_HOSTS.some(function (h) { return host.indexOf(h) !== -1; });
    }

    // Cloudflare Worker (worker.js) that fully resolves HY/Hydrax playback
    // (decrypts the embed's `datas` blob itself, then relays segments with
    // fresh AES-CTR tokens per Range request) and also patches the FE
    // server's MPEG-TS byte-offset bug via /proxy. Deploy worker.js and put
    // its base URL here — without this, HY won't play and FE may glitch.
    const WORKER_BASE = "https://YOUR-WORKER-SUBDOMAIN.workers.dev";

    function getHydraxVideoId(url) {
        try {
            const u = new URL(url);
            if (u.hostname.indexOf("short.ink") !== -1) {
                const parts = u.pathname.split("/").filter(Boolean);
                return parts[parts.length - 1] || null;
            }
            return u.searchParams.get("v");
        } catch (e) {
            return null;
        }
    }

    // Resolves an Abyss/Hydrax "HY" embed URL into a playable source by
    // handing the raw video id off to the Worker's /hydrax endpoint, which
    // does the full decrypt-and-relay itself (see worker.js). The Worker
    // picks the highest-quality source by default; pass ?res=<index> on the
    // relay URL to pin a specific one if ever needed.
    async function extractHydrax(embedUrl) {
        const streams = [];
        const videoId = getHydraxVideoId(embedUrl);
        if (!videoId) return streams;

        const relayUrl = WORKER_BASE + "/hydrax?v=" + encodeURIComponent(videoId);
        streams.push(new StreamResult({
            url: relayUrl,
            quality: "HY",
            headers: { "User-Agent": UA }
        }));
        return streams;
    }

    async function getText(url, headers) {
        const res = await http_get(url, headers || HEADERS);
        return res && res.body ? res.body : "";
    }

    function mapSubtitleLang(label) {
        const l = String(label || "").toLowerCase();
        if (l.indexOf("việt") !== -1 || l.indexOf("viet") !== -1 || l === "vi") return "vi";
        if (l.indexOf("anh") !== -1 || l.indexOf("eng") !== -1 || l === "en") return "en";
        return "vi";
    }

    async function loadStreamsForEpisodeId(episodeId, referer) {
        const streams = [];
        const subtitles = [];

        const watch = await getJson(API_BASE + "/anime/watch/episode/" + episodeId + "?lang=vi");
        const streamList = (watch && watch.streams) || [];

        for (const s of streamList) {
            if (!s.url) continue;

            if (isHydraxUrl(s.url)) {
                const hyStreams = await extractHydrax(s.url);
                streams.push.apply(streams, hyStreams);
            } else {
                // Direct m3u8/TS server (FE, or any other server name). Route
                // through the Worker's /proxy so the MPEG-TS byte-offset bug
                // (nonprofit.asia CDN prepending junk bytes before the TS
                // sync byte) gets patched, matching the original Kotlin
                // provider's getVideoInterceptor() behavior.
                const proxied = WORKER_BASE + "/proxy?u=" + encodeURIComponent(s.url);
                streams.push(new StreamResult({
                    url: proxied,
                    quality: s.server_name || "Auto",
                    headers: { "User-Agent": UA }
                }));
            }

            (s.subtitles || []).forEach(function (sub) {
                if (!sub.file) return;
                subtitles.push({
                    url: sub.file,
                    label: sub.label || "Vietnamese",
                    lang: mapSubtitleLang(sub.label)
                });
            });
        }

        return { streams, subtitles };
    }

    async function loadStreams(url, cb) {
        try {
            // `url` here is the Episode.url we built in load(): a JSON array
            // of episode ids, or (fallback) a single numeric id string.
            let episodeIds;
            try {
                episodeIds = url.trim().startsWith("[") ? JSON.parse(url) : [parseInt(url, 10)];
            } catch (e) {
                episodeIds = [parseInt(url, 10)];
            }
            episodeIds = episodeIds.filter(function (n) { return Number.isFinite(n); });
            if (!episodeIds.length) {
                return cb({ success: false, errorCode: "PARSE_ERROR", message: "Episode id không hợp lệ." });
            }

            const referer = MAIN_URL + "/";
            const allStreams = [];
            const allSubs = [];
            const seen = {};

            for (const id of episodeIds) {
                try {
                    const result = await loadStreamsForEpisodeId(id, referer);
                    result.streams.forEach(function (st) {
                        const key = st.url;
                        if (seen[key]) return;
                        seen[key] = true;
                        allStreams.push(st);
                    });
                    allSubs.push.apply(allSubs, result.subtitles);
                } catch (e) {
                    // ignore this team's episode id, try the next
                }
            }

            if (!allStreams.length) {
                return cb({ success: false, errorCode: "NOT_FOUND", message: "Không tìm thấy link phát nào." });
            }

            if (allSubs.length && allStreams[0]) {
                allStreams[0].subtitles = allSubs;
            }

            cb({ success: true, data: allStreams });
        } catch (e) {
            cb({ success: false, errorCode: "PARSE_ERROR", message: e.message || String(e) });
        }
    }

    // Export to SkyStream
    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();
