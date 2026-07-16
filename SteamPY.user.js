// ==UserScript==
// @name         SteamPY Price Compare
// @name:zh-CN   SteamPY 价格对比
// @namespace    https://github.com/Ceylan233/SteamPY-Price-Compare
// @version      8.3.6
// @description  Steam 商店/购物车/愿望单/搜索页显示 SteamPY 实时最低挂单、Steam 史低和价格对比。
// @author       Jiuyue
// @match        https://store.steampowered.com/*
// @match        https://steampy.com/*
// @match        https://www.steampy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @connect      steampy.com
// @connect      store.steampowered.com
// @connect      api.augmentedsteam.com
// @connect      api.xiaoheihe.cn
// @run-at       document-end
// @icon         https://steampy.com/m_logo.ico
// ==/UserScript==

(function () {
    "use strict";

    const CURRENT_VERSION = "8.3.6";
    const INSTANCE_ATTR = "data-steampy-price-compare-active";
    const activeVersion = document.documentElement.getAttribute(INSTANCE_ATTR);

    if (activeVersion && compareVersions(activeVersion, CURRENT_VERSION) >= 0) return;
    document.documentElement.setAttribute(INSTANCE_ATTR, CURRENT_VERSION);

    document.querySelectorAll(".price-box").forEach(box => {
        if (box.dataset.steampyVersion !== CURRENT_VERSION) box.remove();
    });

    if (activeVersion) {
        document.querySelector("#steampy-cart-summary")?.remove();
    }

    const STEAMPY_BASE_URL = "https://steampy.com/";
    const STEAM_BASE_URL = "https://store.steampowered.com/";

    const DONE = "data-steampy-v836-done";
    const CACHE_PREFIX = "steampy_v82_";
    const CACHE_TIME = 6 * 60 * 60 * 1000;
    const REALTIME_CACHE_TIME = 2 * 60 * 1000;
    const HISTORY_CACHE_TIME = 24 * 60 * 60 * 1000;
    const DEBUG = false;
    const historyQueue = new Map();
    let historyQueueTimer = null;

    function compareVersions(left, right) {
        const a = String(left).split(".").map(Number);
        const b = String(right).split(".").map(Number);
        const length = Math.max(a.length, b.length);

        for (let i = 0; i < length; i++) {
            const diff = (a[i] || 0) - (b[i] || 0);
            if (diff) return diff;
        }
        return 0;
    }

    const API = {
        gameInfo: (subId, appId, type) =>
            `${STEAMPY_BASE_URL}xboot/common/plugIn/getGame?subId=${encodeURIComponent(subId)}&appId=${encodeURIComponent(appId)}&type=${encodeURIComponent(type)}`,
        gameDetail: (gameId) =>
            `${STEAMPY_BASE_URL}xboot/steamGame/getOne?gameId=${encodeURIComponent(gameId)}`,
        listSale: (gameId) =>
            `${STEAMPY_BASE_URL}xboot/steamKeySale/listSale?pageNumber=1&pageSize=20&sort=keyPrice&order=asc&startDate=&endDate=&gameId=${encodeURIComponent(gameId)}`,
        cdkDetail: (gameId) =>
            `${STEAMPY_BASE_URL}cdkDetail?name=cn&gameId=${encodeURIComponent(gameId)}`,
        balanceBuyDetail: (gameId) =>
            `${STEAMPY_BASE_URL}balanceBuyDetail?data=cn&gameId=${encodeURIComponent(gameId)}`,
        hotGameDetail: (gameId) =>
            `${STEAMPY_BASE_URL}hotGameDetail?gameId=${encodeURIComponent(gameId)}`,
        appDetails: (appId) =>
            `${STEAM_BASE_URL}api/appdetails?appids=${encodeURIComponent(appId)}&cc=cn&l=schinese`,
        packageDetails: (packageId) =>
            `${STEAM_BASE_URL}api/packagedetails?packageids=${encodeURIComponent(packageId)}&cc=cn&l=schinese`,
        bundlePage: (bundleId) =>
            `${STEAM_BASE_URL}bundle/${encodeURIComponent(bundleId)}/`,
        augmentedSteamPrices: () =>
            "https://api.augmentedsteam.com/prices/v2",
        heyboxHistory: (appId) =>
            `https://api.xiaoheihe.cn/game/get_game_prices/history/v2?appid=${encodeURIComponent(appId)}&platf=steam&cc=cn&days=9999`,
        heyboxGame: (appId) =>
            `https://www.xiaoheihe.cn/app/topic/game/pc/${encodeURIComponent(appId)}`
    };

    registerMenu();

    if (location.hostname === "steampy.com" || location.hostname.endsWith(".steampy.com")) {
        startSteamPYTokenSync();
        return;
    }

    addStyle();
    ensureTokenHintOnce();
    hookHistory();
    observeDom();
    runScans();

    function log(...args) {
        if (DEBUG) console.log("[SteamPY V8.2]", ...args);
    }

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== "function") return;

        GM_registerMenuCommand(`当前版本：${CURRENT_VERSION}`, () => {
            alert(`SteamPY 价格对比 ${CURRENT_VERSION}`);
        });

        GM_registerMenuCommand("设置 SteamPY Token", () => {
            const oldToken = getToken();
            const token = prompt("粘贴 SteamPY 的 localStorage.accessToken：", oldToken);
            if (token !== null) {
                GM_setValue("steampy_token", token.trim());
                clearCache();
                alert("Token 已保存，刷新 Steam 页面生效。");
            }
        });

        GM_registerMenuCommand("清空 SteamPY Token", () => {
            GM_setValue("steampy_token", "");
            clearCache();
            alert("Token 已清空。");
        });

        GM_registerMenuCommand("清空价格缓存", () => {
            clearCache();
            alert("缓存已清空，刷新页面生效。");
        });

        GM_registerMenuCommand("登录 SteamPY 并同步 Token", () => {
            if (typeof GM_openInTab === "function") {
                GM_openInTab(`${STEAMPY_BASE_URL}login`, { active: true, insert: true });
            } else {
                window.open(`${STEAMPY_BASE_URL}login`, "_blank");
            }
        });
    }

    function readSteamPYToken() {
        try {
            return String(
                localStorage.getItem("accessToken") ||
                localStorage.getItem("bbsToken") ||
                document.cookie.match(/bbsToken=([^;]+)/)?.[1] ||
                ""
            ).trim();
        } catch {
            return "";
        }
    }

    function syncTokenFromSteamPY() {
        try {
            const token = readSteamPYToken();
            const savedToken = getToken();

            if (token && token !== savedToken) {
                GM_setValue("steampy_token", token);
                clearCache();
                console.info("[SteamPY V8.2] 已同步登录状态，回 Steam 页面刷新即可。");
            } else if (!token && savedToken) {
                GM_setValue("steampy_token", "");
                clearCache();
                console.info("[SteamPY V8.2] 已同步退出登录状态。");
            }

            return token;
        } catch (e) {
            console.warn("[SteamPY V8.2] Token 同步失败：", e);
            return "";
        }
    }

    function startSteamPYTokenSync() {
        let lastToken = syncTokenFromSteamPY();

        // SteamPY 登录是 SPA 跳转，登录成功后页面通常不会重新加载。
        const timer = setInterval(() => {
            const token = readSteamPYToken();
            if (token !== lastToken) {
                lastToken = syncTokenFromSteamPY();
            }
        }, 1500);

        window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
    }

    function ensureTokenHintOnce() {
        const token = getToken();
        if (token) return;

        const asked = sessionStorage.getItem("steampy_v82_token_hint");
        if (asked) return;
        sessionStorage.setItem("steampy_v82_token_hint", "1");

        setTimeout(() => {
            console.info("[SteamPY V8.2] 实时最低挂单需要登录 SteamPY。请使用油猴菜单打开登录页，登录成功后回 Steam 页面刷新。");
        }, 1000);
    }

    function getToken() {
        try {
            return String(GM_getValue("steampy_token", "") || "").trim();
        } catch {
            return "";
        }
    }

    function steamPYHeaders(token = getToken()) {
        return {
            accessToken: token,
            APP_TOKEN: "",
            Accept: "application/json, text/plain, */*"
        };
    }

    function clearCache() {
        Object.keys(localStorage)
            .filter(k => k.startsWith(CACHE_PREFIX))
            .forEach(k => localStorage.removeItem(k));
    }

    function requestText(url, headers = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url,
                timeout: 15000,
                anonymous: false,
                headers,
                onload: res => resolve(res.responseText),
                onerror: reject,
                ontimeout: reject
            });
        });
    }

    function requestJSON(url, headers = {}) {
        return requestText(url, headers).then(text => JSON.parse(text));
    }

    function requestJSONPost(url, data, headers = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "POST",
                url,
                timeout: 20000,
                data: JSON.stringify(data),
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    ...headers
                },
                onload: res => {
                    try {
                        resolve(JSON.parse(res.responseText));
                    } catch (error) {
                        reject(error);
                    }
                },
                onerror: reject,
                ontimeout: reject
            });
        });
    }

    function cacheGet(key, maxAge = CACHE_TIME) {
        try {
            const raw = localStorage.getItem(CACHE_PREFIX + key);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (Date.now() - obj.time > maxAge) return null;
            return obj.data;
        } catch {
            return null;
        }
    }

    function cacheSet(key, data) {
        try {
            localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ time: Date.now(), data }));
        } catch {}
    }

    function money(v) {
        if (v === null || v === undefined || v === "") return "未知";
        const n = Number(v);
        if (Number.isNaN(n)) return "未知";
        return "￥" + n.toFixed(2).replace(".00", "");
    }

    function appIdFromUrl(url) {
        const m = String(url || "").match(/\/app\/(\d+)/);
        return m ? m[1] : null;
    }

    function bundleIdFromUrl(url) {
        const m = String(url || "").match(/\/bundle\/(\d+)/);
        return m ? m[1] : null;
    }

    function packageIdFromUrl(url) {
        const m = String(url || "").match(/\/sub\/(\d+)/);
        return m ? m[1] : null;
    }

    function parseSteamPrice(el) {
        const text = el?.innerText || "";
        const arr = [...text.matchAll(/¥\s*([0-9]+(?:\.[0-9]+)?)/g)]
            .map(x => Number(x[1]))
            .filter(x => !Number.isNaN(x));
        return arr.length ? arr[arr.length - 1] : null;
    }

    function calculateDaysAgo(dateString) {
        if (!dateString) return "";
        try {
            const target = new Date(dateString);
            const diff = Math.floor((Date.now() - target.getTime()) / 86400000);
            if (diff === 0) return "今天";
            if (diff === 1) return "1天前";
            return `${diff}天前`;
        } catch {
            return "";
        }
    }

    async function appToPackage(appId) {
        const key = `pkg_${appId}`;
        const cached = cacheGet(key);
        if (cached) return cached;

        try {
            const json = await requestJSON(API.appDetails(appId));
            const groups = json?.[appId]?.data?.package_groups || [];
            let packageId = null;

            for (const group of groups) {
                for (const sub of group.subs || []) {
                    if (!sub.packageid) continue;
                    packageId = String(sub.packageid);
                    if (sub.is_free_license === false) break;
                }
                if (packageId) break;
            }

            if (packageId) cacheSet(key, packageId);
            return packageId;
        } catch {
            return null;
        }
    }

    async function packageToApp(packageId) {
        const key = `pkg_app_${packageId}`;
        const cached = cacheGet(key);
        if (cached) return cached;

        try {
            const json = await requestJSON(API.packageDetails(packageId));
            const appId = json?.[packageId]?.data?.apps?.[0]?.id || json?.[packageId]?.data?.apps?.[0]?.appid;
            if (appId) {
                cacheSet(key, String(appId));
                return String(appId);
            }
        } catch {}

        return null;
    }

    async function bundleToFirstApp(bundleId) {
        const key = `bundle_app_${bundleId}`;
        const cached = cacheGet(key);
        if (cached) return cached;

        try {
            const html = await requestText(API.bundlePage(bundleId));
            const m = html.match(/\/app\/(\d+)/);
            if (m) {
                cacheSet(key, m[1]);
                return m[1];
            }
        } catch {}

        return null;
    }

    function historyEntity(id, appId, type, purchaseKind) {
        if (purchaseKind === "game") {
            const fallbackType = type === "subid" ? "sub" : "app";
            const fallbackId = type === "subid" ? String(id) : String(appId);
            return {
                provider: "heybox",
                type: "app",
                id: String(appId),
                entityKey: `app/${appId}`,
                fallbackType,
                fallbackId,
                fallbackEntityKey: `${fallbackType}/${fallbackId}`
            };
        }

        const entityType = type === "bundleid" ? "bundle" : type === "subid" ? "sub" : "app";
        const entityId = entityType === "app" ? String(appId) : String(id);
        return {
            provider: "augmented",
            type: entityType,
            id: entityId,
            entityKey: `${entityType}/${entityId}`
        };
    }

    function querySteamHistory(id, appId, type, purchaseKind) {
        const entity = historyEntity(id, appId, type, purchaseKind);
        const queueKey = `${entity.provider}:${entity.entityKey}`;
        const cacheKey = `history_${queueKey}`;
        const cached = cacheGet(cacheKey, HISTORY_CACHE_TIME);

        if (cached?.checked) return Promise.resolve(cached.data || null);

        return new Promise(resolve => {
            const pending = historyQueue.get(queueKey);
            if (pending) {
                pending.resolvers.push(resolve);
            } else {
                historyQueue.set(queueKey, { ...entity, queueKey, cacheKey, resolvers: [resolve] });
            }

            clearTimeout(historyQueueTimer);
            historyQueueTimer = setTimeout(flushSteamHistoryQueue, 80);
        });
    }

    function resolveHistoryItem(item, data, cacheResult = true) {
        if (cacheResult) cacheSet(item.cacheKey, { checked: true, data });
        item.resolvers.forEach(resolve => resolve(data));
    }

    async function fetchHeyboxHistory(item) {
        try {
            const response = await requestJSON(API.heyboxHistory(item.id), {
                Referer: API.heyboxGame(item.id),
                Accept: "application/json"
            });
            const result = response?.status === "ok" ? response.result : null;
            const amount = normalizePositivePrice(result?.lowest_info?.price);
            if (!amount) return null;

            return {
                price: amount,
                cut: Number(result?.lowest_info?.discount) || null,
                timestamp: result?.lowest_info?.date || null,
                url: API.heyboxGame(item.id),
                source: "小黑盒"
            };
        } catch (error) {
            log("Heybox history failed", item.id, error);
            return null;
        }
    }

    async function mapWithConcurrency(items, limit, worker) {
        const results = new Array(items.length);
        let nextIndex = 0;

        async function runWorker() {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await worker(items[index]);
            }
        }

        const workers = Array.from(
            { length: Math.min(limit, items.length) },
            () => runWorker()
        );
        await Promise.all(workers);
        return results;
    }

    async function fetchAugmentedHistories(items) {
        if (!items.length) return new Map();

        const body = {
            country: "CN",
            apps: [...new Set(items.filter(item => item.type === "app").map(item => Number(item.id)))],
            subs: [...new Set(items.filter(item => item.type === "sub").map(item => Number(item.id)))],
            bundles: [...new Set(items.filter(item => item.type === "bundle").map(item => Number(item.id)))],
            voucher: false,
            shops: [61]
        };
        const response = await requestJSONPost(API.augmentedSteamPrices(), body);
        const results = new Map();

        items.forEach(item => {
            const entityKey = item.augmentedEntityKey || item.entityKey;
            const priceData = response?.prices?.[entityKey];
            const amount = normalizePositivePrice(priceData?.lowest?.price?.amount);
            results.set(item.queueKey, amount
                ? {
                    price: amount,
                    cut: Number(priceData?.lowest?.cut) || null,
                    timestamp: priceData?.lowest?.timestamp || null,
                    url: priceData?.urls?.history || null,
                    source: "Augmented Steam / ITAD"
                }
                : null);
        });

        return results;
    }

    async function flushSteamHistoryQueue() {
        const batch = [...historyQueue.values()];
        historyQueue.clear();
        historyQueueTimer = null;
        if (!batch.length) return;

        const heyboxItems = batch.filter(item => item.provider === "heybox");
        const augmentedItems = batch.filter(item => item.provider === "augmented");

        const heyboxResults = await mapWithConcurrency(heyboxItems, 4, fetchHeyboxHistory);
        heyboxItems.forEach((item, index) => {
            const data = heyboxResults[index];
            if (data) {
                resolveHistoryItem(item, data);
            } else {
                augmentedItems.push({
                    ...item,
                    type: item.fallbackType,
                    id: item.fallbackId,
                    augmentedEntityKey: item.fallbackEntityKey
                });
            }
        });

        try {
            const results = await fetchAugmentedHistories(augmentedItems);
            augmentedItems.forEach(item => {
                resolveHistoryItem(item, results.get(item.queueKey) || null);
            });
        } catch (error) {
            log("Augmented Steam history failed", error);
            augmentedItems.forEach(item => resolveHistoryItem(item, null, false));
        }
    }

    async function querySteamPY(id, appId, type) {
        const token = getToken();
        const cacheKey = `py_${type}_${id}_${appId}_${token ? "token" : "public"}`;
        const cached = cacheGet(cacheKey, token ? REALTIME_CACHE_TIME : CACHE_TIME);
        if (cached) return cached;

        try {
            const gameRes = await requestJSON(API.gameInfo(id, appId, type));

            if (!gameRes?.success || !gameRes?.result) {
                const fail = { success: false, message: gameRes?.message || "SteamPY未收录" };
                cacheSet(cacheKey, fail);
                return fail;
            }

            const game = gameRes.result;
            let detail = game;

            if (token) {
                try {
                    const one = await requestJSON(API.gameDetail(game.id), steamPYHeaders(token));
                    if (one?.success && one?.result) detail = one.result;
                } catch (e) {
                    log("getOne failed", e);
                }
            }

            let realtimePrice = null;
            let stock = null;
            let sold = null;
            let saleSource = "none";
            let saleStatus = token ? "empty" : "login_required";
            let saleMessage = token ? "暂无在售挂单" : "登录 SteamPY 后显示";

            if (token) {
                try {
                    const sale = await requestJSON(API.listSale(game.id), steamPYHeaders(token));

                    log("listSale", game.id, sale);

                    if (sale?.success && Array.isArray(sale?.result?.content) && sale.result.content.length > 0) {
                        const available = sale.result.content
                            .filter(item => normalizePositivePrice(item?.keyPrice) && Number(item?.stock ?? 1) > 0)
                            .sort((a, b) => Number(a.keyPrice) - Number(b.keyPrice));
                        const lowest = available[0];

                        if (lowest) {
                            realtimePrice = Number(lowest.keyPrice);
                            stock = lowest.stock ?? null;
                            sold = lowest.sold ?? null;
                            saleSource = "listSale";
                            saleStatus = "ok";
                            saleMessage = "实时挂单";
                        }
                    } else if (Number(sale?.code) === 401) {
                        saleStatus = "unauthorized";
                        saleMessage = "登录已失效，请重新登录";
                        GM_setValue("steampy_token", "");
                        clearCache();
                    } else if (!sale?.success) {
                        saleStatus = "error";
                        saleMessage = sale?.message || "实时挂单获取失败";
                    }
                } catch (e) {
                    saleStatus = "error";
                    saleMessage = "实时挂单获取失败";
                    log("listSale failed", e);
                }
            }

            const result = {
                success: true,
                result: {
                    ...game,
                    ...detail,
                    realKeyPrice: realtimePrice,
                    fixedHisPrice:
                        detail.hisPrice ??
                        detail.historyPrice ??
                        detail.lowestPrice ??
                        game.hisPrice ??
                        game.historyPrice ??
                        game.lowestPrice ??
                        null,
                    keyTxAmt: detail.keyTxAmt ?? game.keyTxAmt ?? null,
                    keyAveAmt: detail.keyAveAmt ?? game.keyAveAmt ?? null,
                    saleStock: stock,
                    saleSold: sold,
                    saleSource,
                    saleStatus,
                    saleMessage
                }
            };

            cacheSet(cacheKey, result);
            return result;
        } catch (e) {
            console.error("[SteamPY V8.2] 请求失败", e);
            return { success: false, message: "SteamPY请求失败" };
        }
    }

    function createPlaceholder(parent) {
        const box = document.createElement("div");
        box.className = "price-box";
        box.dataset.steampyVersion = CURRENT_VERSION;
        box.title = `SteamPY 价格对比 ${CURRENT_VERSION}`;
        box.innerHTML = `<span class="loading-text">SteamPY 加载中...</span>`;

        // 愿望单：不要塞进价格/标题的小节点，统一追加到整张卡片底部，避免遮挡标题。
if (location.href.includes("/wishlist")) {

    box.classList.add("steampy-wishlist-box");

    // 关键：不要 appendChild 到 React 管理的愿望单卡片里
    parent.insertAdjacentElement("afterend", box);

    return box;
}

        // 商品详情页 / DLC 独立页：保留 Steam 原购买按钮区域，把 SteamPY 信息放在购买按钮区域后方。
        if (/\/app\/\d+/.test(location.pathname)) {
            box.classList.add("steampy-app-box");

            const action =
                parent.querySelector(".game_purchase_action") ||
                parent.querySelector(".game_purchase_action_bg");

            if (action) {
                action.insertAdjacentElement("afterend", box);
            } else {
                parent.appendChild(box);
            }

            return box;
        }

        // 购物车、搜索页等列表页
        parent.appendChild(box);
        return box;
    }

    function updatePlaceholder(box, html) {
        box.innerHTML = html;
    }

    function removeLegacyPriceBoxes() {
        document.querySelectorAll(".price-box").forEach(box => {
            if (box.dataset.steampyVersion !== CURRENT_VERSION) box.remove();
        });
    }

    function computeEstimatedPrice(steamPrice) {
        const n = Number(steamPrice);
        if (!n || Number.isNaN(n)) return null;
        return Number((n * 0.88).toFixed(2));
    }

    function normalizePositivePrice(v) {
        const raw = typeof v === "string"
            ? v.replace(/,/g, "").match(/[0-9]+(?:\.[0-9]+)?/)?.[0]
            : v;
        const n = Number(raw);
        return n > 0 && !Number.isNaN(n) ? n : null;
    }

    function parseSteamDiscount(card) {
        const text = card?.querySelector(".discount_pct, .bundle_discount")?.textContent || "";
        const value = text.match(/\d+(?:\.\d+)?/)?.[0];
        return value ? `-${value}%` : "";
    }

    function getPurchaseKind(card, type) {
        if (type === "bundleid") return "bundle";

        const appIds = new Set(
            [...(card?.querySelectorAll("[data-ds-appid]") || [])]
                .map(el => el.getAttribute("data-ds-appid"))
                .filter(Boolean)
        );
        const text = card?.innerText || "";

        return type === "subid" && (appIds.size > 1 || /包含\s*\d+\s*(?:件|个)/.test(text))
            ? "package"
            : "game";
    }

    function buildHistoryText({ purchaseKind, history, fallbackPrice, steamPrice, steamDiscount }) {
        const historyPrice = normalizePositivePrice(history?.price ?? fallbackPrice);
        const url = /^https:\/\//.test(history?.url || "") ? history.url : "";

        if (historyPrice) {
            let compare = "";
            if (steamPrice) {
                const historyGap = Number(steamPrice) - historyPrice;
                if (historyGap <= 0.01) {
                    compare = ` <span class="good-text">当前已达史低</span>`;
                }
            }

            const label = purchaseKind === "bundle"
                ? "组合包史低"
                : purchaseKind === "package"
                    ? "套餐史低"
                    : "Steam史低";
            const discount = history?.cut
                ? ` <span class="good-text">-${Math.abs(Number(history.cut))}%</span>`
                : "";
            const priceText = `${label}：${money(historyPrice)}${discount}`;
            const priceElement = url
                ? `<a href="${url}" target="_blank" class="price-link">${priceText}</a>`
                : `<span class="price-link">${priceText}</span>`;
            const sourceText = history?.source === "小黑盒"
                ? ` <span class="weak-text">来源：小黑盒</span>`
                : history?.source
                    ? ` <span class="weak-text">来源：ITAD</span>`
                    : "";
            return `${priceElement}${sourceText}${compare}`;
        }

        if (purchaseKind === "bundle") {
            const current = steamDiscount ? `，当前 ${steamDiscount}` : "";
            return `<span class="weak-text">组合包史低：暂未收录${current}</span>`;
        }

        if (purchaseKind === "package") {
            return `<span class="weak-text">套餐史低：暂未收录</span>`;
        }

        return `<span class="weak-text">Steam史低：暂无数据</span>`;
    }

    function displayPrices(pyRes, history, placeholder, id, appId, type, purchaseKind, steamPrice, steamDiscount) {
        let content = "";
        const fallbackHistoryText = buildHistoryText({
            purchaseKind,
            history,
            fallbackPrice: null,
            steamPrice,
            steamDiscount
        });

        let finalKeyPrice = null;
        let finalSource = "";
        let canCount = false;

        if (pyRes?.success && pyRes.result) {
            const r = pyRes.result;

            const gameId = r.id;
            const realtimePrice = normalizePositivePrice(r.realKeyPrice);
            const estimatedPrice = computeEstimatedPrice(steamPrice);
            const steamHistoryPrice = normalizePositivePrice(history?.price ?? r.fixedHisPrice);

            if (realtimePrice) {
                finalKeyPrice = realtimePrice;
                finalSource = "实时挂单";
            } else if (estimatedPrice) {
                finalKeyPrice = estimatedPrice;
                finalSource = "88折估算";
            }

            canCount = !!(steamPrice && finalKeyPrice);

            const marketPrice = r.marketPrice ?? null;
            const daiPrice = r.daiPrice ?? null;

            let saveText = "";
            if (steamPrice && finalKeyPrice) {
                const diff = Number(steamPrice) - Number(finalKeyPrice);
                saveText = diff > 0
                    ? `<span class="good-text">省 ${money(diff)} / ${Math.round(diff / Number(steamPrice) * 100)}%</span>`
                    : `<span class="warn-text">CDK暂不划算</span>`;
            }

            const stockText = r.saleStock !== null && r.saleStock !== undefined
                ? `<span class="price-link">库存：${r.saleStock}</span>`
                : "";

            const soldText = r.saleSold !== null && r.saleSold !== undefined
                ? `<span class="price-link">销量：${r.saleSold}</span>`
                : "";

            const realtimeText = realtimePrice
                ? `<a href="${API.cdkDetail(gameId)}" target="_blank" class="price-link">PY实时最低：${money(realtimePrice)}</a> <span class="good-text">实时</span>`
                : `<a href="${API.cdkDetail(gameId)}" target="_blank" class="price-link warn-text">PY实时最低：${r.saleMessage || "暂不可用"}</a>`;

            const historyText = steamHistoryPrice
                ? buildHistoryText({
                    purchaseKind,
                    history,
                    fallbackPrice: steamHistoryPrice,
                    steamPrice,
                    steamDiscount
                })
                : fallbackHistoryText;

            content += `
                ${realtimeText}
                ${historyText}
                <a href="${API.balanceBuyDetail(gameId)}" target="_blank" class="price-link">PY余额购：${money(marketPrice)}</a>
                <a href="${API.hotGameDetail(gameId)}" target="_blank" class="price-link">PY代购：${money(daiPrice)}</a>
                ${!realtimePrice && estimatedPrice ? `<span class="price-link warn-text">倒余额预计：${money(estimatedPrice)}</span>` : ""}
                ${stockText}
                ${soldText}
                <span class="price-link">${saveText}</span>
            `;

        } else {
            const estimatedPrice = computeEstimatedPrice(steamPrice);
            finalKeyPrice = estimatedPrice;
            finalSource = "88折估算";
            canCount = !!(steamPrice && finalKeyPrice);

            const msg = pyRes?.message || "SteamPY未收录";
            content += `
                <span class="price-link warn-text">PY实时最低：${msg}</span>
                ${fallbackHistoryText}
                <span class="price-link warn-text">倒余额预计价格：${money(finalKeyPrice)}</span>
            `;
        }

        if (canCount) {
            placeholder.dataset.steamPrice = String(Number(steamPrice));
            placeholder.dataset.pyPrice = String(Number(finalKeyPrice));
            placeholder.dataset.priceSource = finalSource;
        } else {
            delete placeholder.dataset.steamPrice;
            delete placeholder.dataset.pyPrice;
            delete placeholder.dataset.priceSource;
        }

        updatePlaceholder(placeholder, content);
        updateCartSummary();
    }

    function updateCartSummary() {
        if (!location.href.includes("/cart")) return;

        let steamTotal = 0;
        let pyTotal = 0;
        let count = 0;
        let estimateCount = 0;
        let realtimeCount = 0;

        document.querySelectorAll(".price-box[data-steam-price][data-py-price]").forEach(box => {
            const steamPrice = Number(box.dataset.steamPrice);
            const pyPrice = Number(box.dataset.pyPrice);

            if (!steamPrice || !pyPrice || Number.isNaN(steamPrice) || Number.isNaN(pyPrice)) return;

            steamTotal += steamPrice;
            pyTotal += pyPrice;
            count += 1;

            if (box.dataset.priceSource === "88折估算") estimateCount += 1;
            if (box.dataset.priceSource === "实时挂单") realtimeCount += 1;
        });

        let card = document.querySelector("#steampy-cart-summary");

        if (!count) {
            if (card) card.remove();
            return;
        }

        if (!card) {

            card = document.createElement("div");
            card.id = "steampy-cart-summary";

            card.style.cssText = `
        margin-bottom:20px;
        padding:12px 16px;
        background:#16202d;
        border:1px solid #2b4a63;
        border-radius:8px;
        color:#c7d5e0;
    `;

            // 找商品列表
            const list = document.querySelector("[data-featuretarget='react-root']");

            if (list) {

                // 插到商品列表最前面
                list.insertBefore(card, list.firstChild);

            } else {

                document.body.prepend(card);

            }
        }

        const save = steamTotal - pyTotal;
        const percent = steamTotal ? Math.round(save / steamTotal * 100) : 0;

        card.innerHTML = `
            <div class="steampy-summary-title">SteamPY 购物车估算</div>
            <div class="steampy-summary-row"><span>Steam总价</span><b>${money(steamTotal)}</b></div>
            <div class="steampy-summary-row"><span>CDKey预计总价</span><b>${money(pyTotal)}</b></div>
            <div class="steampy-summary-row good-text"><span>预计节省</span><b>${money(save)} (${percent}%)</b></div>
            <div class="steampy-summary-note">已统计 ${count} 个商品；实时 ${realtimeCount} 个，预计 ${estimateCount} 个。</div>
        `;
    }

    function priceBoxKey(id, appId, type) {
        return `${type}:${id}:${appId}`;
    }

    function findPriceBoxes(key) {
        return [...document.querySelectorAll(".price-box")]
            .filter(box => box.dataset.steampyKey === key);
    }

    async function attachPrice(card, id, appId, type) {
        if (!card || !id || !appId || !type) return;

        const key = priceBoxKey(id, appId, type);
        const existingBoxes = findPriceBoxes(key);
        const existingBox = existingBoxes[0];

        if (existingBox) {
            existingBoxes.slice(1).forEach(box => box.remove());
            card.setAttribute(DONE, "1");

            if (location.href.includes("/wishlist") && existingBox.previousElementSibling !== card) {
                card.insertAdjacentElement("afterend", existingBox);
            }
            return;
        }

        card.setAttribute(DONE, "1");

        let target;

        if (/\/app\/\d+/.test(location.pathname)) {
            // 详情页 / DLC 独立页：整块购买区域作为定位基准。
            target = card;
        } else if (location.href.includes("/wishlist")) {
            // 愿望单价格框固定跟在整张卡片后面。
            target = card;
        } else {
            target =
                card.querySelector(".ysGS-IPPWEkwN-O5rr-0V") ||
                card.querySelector("[class*='price']") ||
                card.querySelector("[class*='Price']") ||
                card;
        }

        const placeholder = createPlaceholder(target);
        placeholder.dataset.steampyKey = key;
        const steamPrice = parseSteamPrice(card);
        const steamDiscount = parseSteamDiscount(card);
        const purchaseKind = getPurchaseKind(card, type);

        const [pyRes, history] = await Promise.all([
            querySteamPY(id, appId, type),
            querySteamHistory(id, appId, type, purchaseKind)
        ]);
        displayPrices(
            pyRes,
            history,
            placeholder,
            id,
            appId,
            type,
            purchaseKind,
            steamPrice,
            steamDiscount
        );
    }

    function getStoreAppId() {
        const el = document.querySelector(".game_page_background.game[data-miniprofile-appid]");
        return el?.getAttribute("data-miniprofile-appid") || appIdFromUrl(location.href);
    }

    function scanStorePage() {
        if (!location.href.includes("/app/")) return;
        const appId = getStoreAppId();
        if (!appId) return;

        const wrappers = [...document.querySelectorAll(".game_area_purchase_game_wrapper")]
            .filter(wrapper => !wrapper.closest(".game_area_dlc_section, .game_area_dlc_row, .gameDlcBlocks, #game_area_dlc, [class*=DLC]") || wrapper.closest(".game_area_purchase_game"));
        wrappers.forEach(wrapper => {
            if (wrapper.hasAttribute(DONE)) return;
            const input = wrapper.querySelector('input[name="subid"], input[name="bundleid"]');
            if (!input) return;
            attachPrice(wrapper, input.value, appId, input.name);
        });
    }

    function getCartCards() {
        const root = document.querySelector("[class*=Cart]") || document.body;
        const direct = [...root.querySelectorAll(".XjPmFc2t_i1DAuEXEbIX")];
        if (direct.length) return direct;

        const links = [...root.querySelectorAll('a[href*="/app/"], a[href*="/bundle/"], a[href*="/sub/"]')];
        const cards = [];

        for (const link of links) {
            let el = link;
            for (let i = 0; i < 10; i++) {
                if (!el?.parentElement) break;
                const p = el.parentElement;
                const text = p.innerText || "";
                if (text.includes("¥") && text.length > 10 && text.length < 4000) {
                    if (!cards.includes(p)) cards.push(p);
                    break;
                }
                el = p;
            }
        }
        return cards;
    }

    async function scanCartPage() {
        if (!location.href.includes("/cart")) return;
        const cards = getCartCards();

        for (const card of cards) {
            if (!card || card.hasAttribute(DONE)) continue;

            const bundleLink = card.querySelector('a[href*="/bundle/"]');
            const subLink = card.querySelector('a[href*="/sub/"]');
            const appLink = card.querySelector('a[href*="/app/"]');

            if (bundleLink) {
                const bundleId = bundleIdFromUrl(bundleLink.href);
                if (!bundleId) continue;
                const appId = appIdFromUrl(appLink?.href) || await bundleToFirstApp(bundleId);
                if (!appId) continue;
                attachPrice(card, bundleId, appId, "bundleid");
                continue;
            }

            if (subLink) {
                const subId = packageIdFromUrl(subLink.href);
                const appId = appIdFromUrl(appLink?.href) || await packageToApp(subId);
                if (!subId || !appId) continue;
                attachPrice(card, subId, appId, "subid");
                continue;
            }

            if (appLink) {
                const appId = appIdFromUrl(appLink.href);
                if (!appId) continue;
                const subId = await appToPackage(appId);
                if (!subId) continue;
                attachPrice(card, subId, appId, "subid");
            }
        }
    }

    function findListCard(link) {
        let el = link;

        for (let i = 0; i < 10; i++) {
            if (!el?.parentElement) break;

            const p = el.parentElement;
            const text = p.innerText || "";

            if (text.length > 10 && text.length < 4000 && text.includes("¥")) {
                return p;
            }

            el = p;
        }

        return link.parentElement;
    }

    function findWishlistCard(link) {
        let el = link;

        for (let i = 0; i < 12; i++) {
            if (!el?.parentElement) break;
            el = el.parentElement;

            const text = el.innerText || "";
            const hasCardAction = /添加(?:至|到)购物车|加入购物车|移除|发行日期|Add to Cart|Remove|Release Date/i.test(text);
            if (
                hasCardAction &&
                text.length > 10 &&
                text.length < 5000 &&
                el.querySelector('a[href*="/app/"]')
            ) {
                return el;
            }
        }

        return null;
    }

    function getWishlistCards() {
        const exactCards = [...new Set([
            ...document.querySelectorAll(".wishlist_row"),
            ...document.querySelectorAll("[data-rfd-draggable-id]"),
            ...[...document.querySelectorAll('[id^="game_"]')]
                .filter(card => /^game_\d+$/.test(card.id) && card.querySelector('a[href*="/app/"]'))
        ])].filter(card => wishlistAppId(card));
        if (exactCards.length) return exactCards;

        const root =
            document.querySelector("#wishlist_ctn") ||
            document.querySelector("#wishlist_items") ||
            document.querySelector("[class*='WishlistPage']") ||
            document.querySelector("[data-featuretarget='react-root']") ||
            document.querySelector("main") ||
            document.body;
        if (!root) return [];

        const cardsByApp = new Map();
        root.querySelectorAll('a[href*="/app/"]').forEach(link => {
            const appId = appIdFromUrl(link.href);
            if (!appId || cardsByApp.has(appId)) return;

            const card = findWishlistCard(link);
            if (card) cardsByApp.set(appId, card);
        });

        return [...cardsByApp.values()];
    }

    function wishlistAppId(card) {
        const direct =
            card.getAttribute("data-app-id") ||
            card.getAttribute("data-appid") ||
            card.dataset?.appid ||
            card.id?.match(/(?:game|app)[_-](\d+)/)?.[1];

        if (direct && /^\d+$/.test(String(direct))) return String(direct);

        const link = card.querySelector('a[href*="/app/"]');
        return appIdFromUrl(link?.href);
    }

    async function attachWishlistPrice(card, appId) {
        if (!card || !appId) return;

        const key = `wishlist:${appId}`;
        const existingBoxes = findPriceBoxes(key);
        const existingBox = existingBoxes[0];

        if (existingBox) {
            existingBoxes.slice(1).forEach(box => box.remove());
            card.setAttribute(DONE, "1");
            if (existingBox.previousElementSibling !== card) {
                card.insertAdjacentElement("afterend", existingBox);
            }
            return;
        }

        // 先显示结果区。Steam 的 appdetails 可能限流，不能让套餐映射阻塞史低显示。
        card.setAttribute(DONE, "1");
        const placeholder = createPlaceholder(card);
        placeholder.dataset.steampyKey = key;

        const steamPrice = parseSteamPrice(card);
        const steamDiscount = parseSteamDiscount(card);
        const historyPromise = querySteamHistory(appId, appId, "appid", "game");
        const packagePromise = appToPackage(appId);
        const history = await historyPromise;

        if (!placeholder.isConnected) return;
        displayPrices(
            { success: false, message: "SteamPY价格匹配中" },
            history,
            placeholder,
            appId,
            appId,
            "appid",
            "game",
            steamPrice,
            steamDiscount
        );

        const subId = await packagePromise;
        const type = subId ? "subid" : "appid";
        const id = subId || appId;
        const pyRes = await (subId
            ? querySteamPY(subId, appId, type)
            : Promise.resolve({ success: false, message: "SteamPY套餐匹配失败" }));

        if (!placeholder.isConnected) return;
        displayPrices(
            pyRes,
            history,
            placeholder,
            id,
            appId,
            type,
            "game",
            steamPrice,
            steamDiscount
        );
    }

    function cleanupWishlistPriceBoxes(cards) {
        const validCards = new Set(cards);
        const usedCards = new Set();
        const usedKeys = new Set();

        document.querySelectorAll(".price-box").forEach(box => {
            const card = box.previousElementSibling;
            const key = box.dataset.steampyKey;
            const valid =
                key &&
                validCards.has(card) &&
                !usedCards.has(card) &&
                !usedKeys.has(key);

            if (!valid) {
                box.remove();
                return;
            }

            usedCards.add(card);
            usedKeys.add(key);
        });

        cards.forEach(card => {
            const box = card.nextElementSibling;
            if (!box?.classList.contains("price-box") || !box.dataset.steampyKey) {
                card.removeAttribute(DONE);
            }
        });
    }

    async function scanWishlist() {
        const cards = getWishlistCards();
        cleanupWishlistPriceBoxes(cards);

        for (const card of cards) {
            if (!card || card.hasAttribute(DONE)) continue;

            const appId = wishlistAppId(card);
            if (!appId) continue;

            attachWishlistPrice(card, appId);
        }

        cleanupWishlistPriceBoxes(cards);
    }

    async function scanWishlistAndSearch() {
        if (!location.href.includes("/wishlist") && !location.href.includes("/search")) return;

        if (location.href.includes("/wishlist")) {
            await scanWishlist();
            return;
        }

        const links = [...document.querySelectorAll('a[href*="/app/"]')];
        const seen = new Set();

        for (const link of links) {
            const appId = appIdFromUrl(link.href);
            if (!appId) continue;
            const card = findListCard(link);
            if (!card || seen.has(card) || card.hasAttribute(DONE)) continue;
            seen.add(card);

            const subId = await appToPackage(appId);
            if (!subId) continue;
            attachPrice(card, subId, appId, "subid");
        }
    }

    function scan() {
        scanStorePage();
        scanCartPage();
        scanWishlistAndSearch();
    }

    function runScans() {
        setTimeout(scan, 500);
        setTimeout(scan, 1500);
        setTimeout(scan, 3000);
        setTimeout(updateCartSummary, 3500);
        setTimeout(updateCartSummary, 6000);
    }

    function hookHistory() {
        const oldPush = history.pushState;
        history.pushState = function () {
            const ret = oldPush.apply(this, arguments);
            setTimeout(scan, 800);
            return ret;
        };

        const oldReplace = history.replaceState;
        history.replaceState = function () {
            const ret = oldReplace.apply(this, arguments);
            setTimeout(scan, 800);
            return ret;
        };

        window.addEventListener("popstate", () => setTimeout(scan, 800));
    }

    function observeDom() {
        let timer = null;
        const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                removeLegacyPriceBoxes();
                scan();
            }, 700);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function addStyle() {
        const style = document.createElement("style");
        style.innerHTML = `
.price-box{
                margin-top:8px;
                padding:8px 10px;
                border:1px solid #3c5870;
                border-radius:3px;
                background:#1b2838;
                color:#c7d5e0;
                width:calc(100% - 20px);
                box-sizing:border-box;
                overflow:hidden;
                white-space:normal;
                line-height:1.65;
                display:flex;
                flex-wrap:wrap;
                align-items:center;
                gap:3px 8px;
            }
            .steampy-app-box {
                margin:8px 0 10px 0;
                max-width:calc(100% - 20px);
            }
.steampy-wishlist-box{
    margin:8px 0 14px;
    width:100%;
    box-sizing:border-box;
    display:block;
}
            .price-link {
                color: #ffffff;
                text-decoration: none;
                font-size: 13px;
                white-space: nowrap;
            }
            .price-link:hover { color: #66c0f4; }
            .error-text { color: #ff6666; font-size: 12px; }
            .loading-text { color: #cccccc; font-size: 12px; }
            .good-text { color: #a4d007; font-weight: bold; }
            .warn-text { color: #ffb000; font-weight: bold; }
            .weak-text { color: #8f98a0; font-size: 12px; }
            #steampy-cart-summary {
                margin-top: 12px;
                padding: 12px;
                border-radius: 8px;
                background: rgba(0, 0, 0, 0.35);
                border: 1px solid rgba(102, 192, 244, 0.45);
                color: #ffffff;
                font-size: 14px;
                line-height: 1.8;
            }
            .steampy-summary-title {
                font-weight: bold;
                margin-bottom: 6px;
                color: #66c0f4;
            }
            .steampy-summary-row {
                display: flex;
                justify-content: space-between;
                gap: 12px;
            }
            .steampy-summary-note {
                margin-top: 6px;
                font-size: 12px;
                color: #8f98a0;
            }
            @media screen and (max-width: 767px) {
                .price-box { flex-direction: column; gap: 4px; }
            }
        `;
        document.head.appendChild(style);
    }
})();
