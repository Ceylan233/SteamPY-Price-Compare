// ==UserScript==
// @name         SteamPY 价格显示 V8.1.1
// @version      8.1.0
// @description  Steam 商店/购物车/愿望单/搜索页显示 SteamPY 价格；未收录或挂单为0按 Steam 当前价88折估算；购物车统计总价；去除 。
// @author       Jiuyue
// @match        https://store.steampowered.com/*
// @match        https://steampy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      steampy.com
// @connect      store.steampowered.com
// @run-at       document-end
// @icon         https://steampy.com/m_logo.ico
// ==/UserScript==

(function () {
    "use strict";

    const STEAMPY_BASE_URL = "https://steampy.com/";
    const STEAM_BASE_URL = "https://store.steampowered.com/";

    const DONE = "data-steampy-v81-done";
    const CACHE_PREFIX = "steampy_v81_";
    const CACHE_TIME = 6 * 60 * 60 * 1000;
    const DEBUG = false;

    const API = {
        gameInfo: (subId, appId, type) =>
            `${STEAMPY_BASE_URL}xboot/common/plugIn/getGame?subId=${encodeURIComponent(subId)}&appId=${encodeURIComponent(appId)}&type=${encodeURIComponent(type)}`,
        gameDetail: (gameId) =>
            `${STEAMPY_BASE_URL}xboot/steamGame/getOne?gameId=${encodeURIComponent(gameId)}`,
        listSale: (gameId) =>
            `${STEAMPY_BASE_URL}xboot/steamKeySale/listSale?pageNumber=1&pageSize=1&sort=keyPrice&order=asc&startDate=&endDate=&gameId=${encodeURIComponent(gameId)}`,
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
            `${STEAM_BASE_URL}bundle/${encodeURIComponent(bundleId)}/`
    };

    registerMenu();

    if (location.hostname === "steampy.com") {
        syncTokenFromSteamPY();
        return;
    }

    addStyle();
    ensureTokenHintOnce();
    hookHistory();
    observeDom();
    runScans();

    function log(...args) {
        if (DEBUG) console.log("[SteamPY V8.1]", ...args);
    }

    function registerMenu() {
        if (typeof GM_registerMenuCommand !== "function") return;

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
    }

    function syncTokenFromSteamPY() {
        try {
            const token =
                localStorage.getItem("accessToken") ||
                localStorage.getItem("bbsToken") ||
                document.cookie.match(/bbsToken=([^;]+)/)?.[1] ||
                "";

            if (token) {
                GM_setValue("steampy_token", token.trim());
                console.log("[SteamPY V8.1] 已自动同步 Token，回 Steam 页面刷新即可。");
            } else {
                console.log("[SteamPY V8.1] 当前 SteamPY 页面未检测到 Token。请确认已登录。");
            }
        } catch (e) {
            console.warn("[SteamPY V8.1] Token 同步失败：", e);
        }
    }

    function ensureTokenHintOnce() {
        const token = getToken();
        if (token) return;

        const asked = sessionStorage.getItem("steampy_v81_token_hint");
        if (asked) return;
        sessionStorage.setItem("steampy_v81_token_hint", "1");

        setTimeout(() => {
            console.info("[SteamPY V8.1] 未设置 SteamPY Token：脚本会显示公开统计价；如需实时最低挂单，请登录 steampy.com 后刷新一次，或在油猴菜单手动设置 Token。");
        }, 1000);
    }

    function getToken() {
        try {
            return String(GM_getValue("steampy_token", "") || "").trim();
        } catch {
            return "";
        }
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

    function cacheGet(key) {
        try {
            const raw = localStorage.getItem(CACHE_PREFIX + key);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            if (Date.now() - obj.time > CACHE_TIME) return null;
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

    async function querySteamPY(id, appId, type) {
        const token = getToken();
        const cacheKey = `py_${type}_${id}_${appId}_${token ? "token" : "public"}`;
        const cached = cacheGet(cacheKey);
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

            try {
                const one = await requestJSON(API.gameDetail(game.id));
                if (one?.success && one?.result) detail = one.result;
            } catch (e) {
                log("getOne failed", e);
            }

            let realtimePrice = null;
            let stock = null;
            let sold = null;
            let saleSource = "public";
            let saleMessage = "公开统计";

            if (token) {
                try {
                    const sale = await requestJSON(API.listSale(game.id), {
                        accessToken: token,
                        APP_TOKEN: "",
                        Accept: "application/json, text/plain, */*"
                    });

                    log("listSale", game.id, sale);

                    if (sale?.success && Array.isArray(sale?.result?.content) && sale.result.content.length > 0) {
                        const first = sale.result.content[0];
                        realtimePrice = Number(first.keyPrice);
                        stock = first.stock ?? null;
                        sold = first.sold ?? null;
                        saleSource = "listSale";
                        saleMessage = "实时";
                    } else if (sale?.code === 401) {
                        saleMessage = "Token失效";
                    }
                } catch (e) {
                    saleMessage = "实时失败";
                    log("listSale failed", e);
                }
            }

            const result = {
                success: true,
                result: {
                    ...game,
                    ...detail,
                    realKeyPrice: realtimePrice ?? Number(detail.keyPrice ?? game.keyPrice),
                    fixedHisPrice: detail.hisPrice ?? detail.gamePrice ?? game.hisPrice ?? game.gamePrice ?? null,
                    keyTxAmt: detail.keyTxAmt ?? game.keyTxAmt ?? null,
                    keyAveAmt: detail.keyAveAmt ?? game.keyAveAmt ?? null,
                    saleStock: stock,
                    saleSold: sold,
                    saleSource,
                    saleMessage
                }
            };

            cacheSet(cacheKey, result);
            return result;
        } catch (e) {
            console.error("[SteamPY V8.1] 请求失败", e);
            return { success: false, message: "SteamPY请求失败" };
        }
    }

    function createPlaceholder(parent) {
        const box = document.createElement("div");
        box.className = "price-box";
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

    function computeEstimatedPrice(steamPrice) {
        const n = Number(steamPrice);
        if (!n || Number.isNaN(n)) return null;
        return Number((n * 0.88).toFixed(2));
    }

    function normalizePositivePrice(v) {
        const n = Number(v);
        return n > 0 && !Number.isNaN(n) ? n : null;
    }

    function displayPrices(pyRes, placeholder, subId, steamPrice) {
        let content = "";

        let finalKeyPrice = null;
        let finalSource = "";
        let canCount = false;

        if (pyRes?.success && pyRes.result) {
            const r = pyRes.result;

            const gameId = r.id;
            const realtimeOrPublicPrice = normalizePositivePrice(r.realKeyPrice ?? r.keyPrice);
            const estimatedPrice = computeEstimatedPrice(steamPrice);

            if (realtimeOrPublicPrice) {
                finalKeyPrice = realtimeOrPublicPrice;
                finalSource = r.saleSource === "listSale" ? "实时挂单" : "公开统计";
            } else if (estimatedPrice) {
                finalKeyPrice = estimatedPrice;
                finalSource = "88折估算";
            }

            canCount = !!(steamPrice && finalKeyPrice);

            const marketPrice = r.marketPrice ?? null;
            const daiPrice = r.daiPrice ?? null;
            const publicKeyPrice = r.keyPrice ?? null;

            let saveText = "";
            if (steamPrice && finalKeyPrice) {
                const diff = Number(steamPrice) - Number(finalKeyPrice);
                saveText = diff > 0
                    ? `<span class="good-text">省 ${money(diff)} / ${Math.round(diff / Number(steamPrice) * 100)}%</span>`
                    : `<span class="warn-text">CDK暂不划算</span>`;
            }

            const sourceText =
                finalSource === "实时挂单"
                    ? `<span class="good-text">实时</span>`
                    : finalSource === "公开统计"
                        ? `<span class="weak-text">${r.saleMessage || "公开统计"}</span>`
                        : ``;

            const stockText = r.saleStock !== null && r.saleStock !== undefined
                ? `<span class="price-link">库存：${r.saleStock}</span>`
                : "";

            const soldText = r.saleSold !== null && r.saleSold !== undefined
                ? `<span class="price-link">销量：${r.saleSold}</span>`
                : "";

            const title = finalSource === "88折估算" ? "倒余额预计价格" : "PY最低挂单";

            content += `
                <a href="${API.cdkDetail(gameId)}" target="_blank" class="price-link">${title}：${money(finalKeyPrice)}</a>
                ${sourceText}
                <a href="${API.balanceBuyDetail(gameId)}" target="_blank" class="price-link">PY余额购：${money(marketPrice)}</a>
                <a href="${API.hotGameDetail(gameId)}" target="_blank" class="price-link">PY代购：${money(daiPrice)}</a>
                ${stockText}
                ${soldText}
                <span class="price-link">${saveText}</span>
            `;

            if (
                publicKeyPrice &&
                finalKeyPrice &&
                Math.abs(Number(publicKeyPrice) - Number(finalKeyPrice)) > 0.01
            ) {
                content += `<span class="weak-text">公开价：${money(publicKeyPrice)}</span>`;
            }

        } else {
            const estimatedPrice = computeEstimatedPrice(steamPrice);
            finalKeyPrice = estimatedPrice;
            finalSource = "88折估算";
            canCount = !!(steamPrice && finalKeyPrice);

            const msg = pyRes?.message || "SteamPY未收录";
            content += `
                <span class="price-link warn-text">倒余额预计价格：${money(finalKeyPrice)}</span>
                <span class="weak-text">${msg}</span>
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

    async function attachPrice(card, id, appId, type) {
        if (!card || !id || !appId || !type || card.hasAttribute(DONE)) return;
        card.setAttribute(DONE, "1");

        let target;

        if (/\/app\/\d+/.test(location.pathname)) {
            // 详情页 / DLC 独立页：整块购买区域作为定位基准。
            target = card;
        } else if (location.href.includes("/wishlist")) {
            // 愿望单：不要插进 Steam 的价格小块，否则会压到标题。
            target =
                card.querySelector("[class*='content']") ||
                card.querySelector("[class*='Content']") ||
                card.querySelector("[class*='right']") ||
                card.querySelector("[class*='Right']") ||
                card;
        } else {
            target =
                card.querySelector(".ysGS-IPPWEkwN-O5rr-0V") ||
                card.querySelector("[class*='price']") ||
                card.querySelector("[class*='Price']") ||
                card;
        }

        const placeholder = createPlaceholder(target);
        const steamPrice = parseSteamPrice(card);

        const pyRes = await querySteamPY(id, appId, type);
        displayPrices(pyRes, placeholder, id, steamPrice);
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

    if (location.href.includes("/wishlist")) {
        return (
            link.closest("[data-rfd-draggable-id]") ||
            link.closest(".Panel") ||
            link.closest("[class*='Panel']") ||
            link.parentElement
        );
    }

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

    async function scanWishlistAndSearch() {
        if (!location.href.includes("/wishlist") && !location.href.includes("/search")) return;
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
            timer = setTimeout(scan, 700);
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
