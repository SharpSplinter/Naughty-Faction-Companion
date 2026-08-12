// ==UserScript==
// @name         Naughty Torn Companion
// @namespace    https://github.com/xf4k31tx/Naughty-Torn-Companion
// @version      5.14.6
// @description  One-stop Torn dashboard for personal, faction, company, inventory, and activity tracking.
// @author       sharpsplinter [315311]
// @match        https://www.torn.com/index.php*
// @match        https://torn.com/index.php*
// @match        https://www.torn.com/item.php*
// @match        https://torn.com/item.php*
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @match        https://www.torn.com/companies.php*
// @match        https://torn.com/companies.php*
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @match        https://torn.com/page.php?sid=ItemMarket*
// @source       https://raw.githubusercontent.com/xf4k31tx/Naughty-Torn-Companion/refs/heads/main/Naughty%20Torn%20Companion.js
// @updateURL    https://raw.githubusercontent.com/xf4k31tx/Naughty-Torn-Companion/refs/heads/main/Naughty%20Torn%20Companion.js
// @downloadURL  https://raw.githubusercontent.com/xf4k31tx/Naughty-Torn-Companion/refs/heads/main/Naughty%20Torn%20Companion.js
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      api.torn.com
// ==/UserScript==

(function() {
    'use strict';

    const BASE_URL = "https://api.torn.com/v2/";
    const INVENTORY_CATEGORIES = [
        "medical", "drug", "booster", "alcohol",
        "candy", "enhancer", "jewelry", "plushie",
        "flower", "temporary", "clothing", "car",
        "artifact", "book", "special", "other", "melee",
        "primary", "secondary", "tool", "defensive",
        "material", "collectible"
    ];

    const LOANABLE_CATEGORIES = new Set([
        "temporary", "melee", "primary", "secondary", "defensive"
    ]);

    // Legacy localStorage keys — read once during migration, then never touched again.
    const LEGACY_STORAGE = {
        key: "TORN_V2_USER_KEY",
        inventory: "TORN_V2_INVENTORY_DATA",
        position: "TORN_V2_WIDGET_POS",
        dashboard: "TORN_V2_DASHBOARD_STATE"
    };

    // GM-storage keys (Tampermonkey GM.getValue/GM.setValue — shared across all matched
    // domains/pages, unlike localStorage which is scoped per-origin).
    const APP_STORAGE = {
        key: "TORN_V2_USER_KEY",
        position: "TORN_V2_WIDGET_POS",
        dashboard: "TORN_V2_DASHBOARD_STATE",
        companyStockHistory: "TORN_V2_COMPANY_STOCK_HISTORY",
        migrated: "TORN_V2_GM_MIGRATED_V1",
        sections: {
            overview: "TORN_V2_CACHE_OVERVIEW",
            personal: "TORN_V2_CACHE_PERSONAL",
            faction: "TORN_V2_CACHE_FACTION",
            company: "TORN_V2_CACHE_COMPANY",
            inventory: "TORN_V2_CACHE_INVENTORY",
            activity: "TORN_V2_CACHE_ACTIVITY"
        }
    };

    const AUTO_REFRESH_MS = 15 * 60 * 1000;
    const QUICK_REFRESH_MS = 5 * 60 * 1000;
    const LOG_REFRESH_MS = 2 * 60 * 1000;

    // Staleness thresholds checked ONLY when restoring a section's cache at dashboard
    // init (i.e. "is this cached data too old to show without refreshing first?").
    // This is separate from the ongoing periodic auto-refresh cadence above.
    // "company" is intentionally absent — its staleness uses day-boundary logic via
    // isCompanyUpdateDue() instead of a rolling duration.
    const SECTION_STALENESS_MS = {
        overview: QUICK_REFRESH_MS,   // 5 min
        personal: QUICK_REFRESH_MS,   // 5 min
        faction: QUICK_REFRESH_MS,    // 5 min
        inventory: QUICK_REFRESH_MS,  // 5 min
        activity: 30 * 1000           // 30 sec
    };

    const state = {
        sortState: { key: "value", direction: "desc" },
        expandedCategories: new Set(),
        currentTab: "overview",
        settingsSubTab: "controls",
        personalSubTab: "info",
        theme: "dark",
        isMinimized: false,
        companyStockHistory: {},
        apiKey: "",
        widgetPosition: null,
        dashboard: null,
        lastRefresh: null,
        autoRefreshTimer: null,
        chainCountdownTimer: null,
        cooldownCountdownTimer: null,
        lastRefreshBySection: {
            overview: 0,
            personal: 0,
            faction: 0,
            company: 0,
            inventory: 0,
            activity: 0,
            logs: 0,
            all: 0
        },
        sectionStatus: {
            overview: "Not loaded",
            personal: "Not loaded",
            faction: "Not loaded",
            company: "Not loaded",
            inventory: "Not loaded",
            activity: "Not loaded",
            settings: "Ready"
        },
        caches: {
            overview: null,
            personal: null,
            faction: null,
            company: null,
            inventory: null,
            activity: null
        }
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const formatMoney = (num) => num ? '$' + Number(num).toLocaleString() : '$0';
    const formatInteger = (num) => {
        const value = Number(num ?? 0);
        if (!Number.isFinite(value)) return "0";
        return Math.round(value).toLocaleString();
    };
    const formatDuration = (totalSeconds) => {
        const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
        if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
        return `${s}s`;
    };
    const formatDate = (unixSeconds) => {
        const seconds = Number(unixSeconds || 0);
        if (!seconds) return "";
        return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    };
    const formatRelativeTime = (unixSeconds) => {
        const seconds = Number(unixSeconds || 0);
        if (!seconds) return "";
        const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
        if (elapsed < 60) return "just now";
        if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
        if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h ago`;
        return `${Math.floor(elapsed / 86400)}d ago`;
    };
    const formatTimeUntil = (unixSeconds) => {
        const seconds = Number(unixSeconds || 0);
        if (!seconds) return "";
        const remaining = Math.max(0, seconds - Math.floor(Date.now() / 1000));
        if (remaining < 60) return "expires now";
        if (remaining < 3600) return `expires in ${Math.floor(remaining / 60)}m`;
        if (remaining < 86400) return `expires in ${Math.floor(remaining / 3600)}h`;
        return `expires in ${Math.floor(remaining / 86400)}d`;
    };
    const getUtcDateKey = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);
    const getCompanyStockDayKey = (time = Date.now()) => getUtcDateKey(time - ((18 * 60 + 8) * 60 * 1000));
    const debugLog = (...args) => {
        if (typeof console !== "undefined" && console.log) {
            console.log("[Torn Companion]", ...args);
        }
    };
    const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));

    // --- GM-backed persistent storage ---
    // Design: writes are fire-and-forget async (GM.setValue), but every write ALSO
    // updates an in-memory mirror (state.*) synchronously first. Reads are therefore
    // synchronous throughout the rest of the file — render functions etc. don't need
    // to become async. The only genuinely async step is the one-time bootstrap load.
    const gmGetValue = async (key, fallback) => {
        try {
            return await GM.getValue(key, fallback);
        } catch (e) {
            debugLog("GM.getValue failed", key, e);
            return fallback;
        }
    };
    const gmSetValue = async (key, value) => {
        try {
            await GM.setValue(key, value);
        } catch (e) {
            debugLog("GM.setValue failed", key, e);
        }
    };

    const getStoredKey = () => state.apiKey || "";
    const setStoredKey = (key) => {
        state.apiKey = String(key || "").trim();
        void gmSetValue(APP_STORAGE.key, state.apiKey);
    };

    const getStoredPosition = () => state.widgetPosition || null;
    const setStoredPosition = (pos) => {
        state.widgetPosition = pos;
        void gmSetValue(APP_STORAGE.position, pos);
    };

    const getStoredDashboardState = () => ({
        currentTab: state.currentTab,
        settingsSubTab: state.settingsSubTab,
        personalSubTab: state.personalSubTab,
        theme: state.theme,
        isMinimized: state.isMinimized
    });
    const setStoredDashboardState = (payload) => {
        if (payload && payload.currentTab) state.currentTab = payload.currentTab;
        if (payload && payload.settingsSubTab) state.settingsSubTab = payload.settingsSubTab;
        if (payload && payload.personalSubTab) state.personalSubTab = payload.personalSubTab;
        if (payload && ["light", "dark"].includes(payload.theme)) state.theme = payload.theme;
        if (payload && typeof payload.isMinimized === "boolean") state.isMinimized = payload.isMinimized;
        void gmSetValue(APP_STORAGE.dashboard, getStoredDashboardState());
    };

    function updateCompanyStockHistory(companyId, stock) {
        if (!companyId || !Array.isArray(stock)) return {};
        const today = getCompanyStockDayKey();
        const counts = Object.fromEntries(stock.map((item) => [String(item.id), Number(item.in_stock ?? item.quantity ?? 0)]));
        const previousEntry = state.companyStockHistory[String(companyId)] || {};
        const entry = previousEntry.date === today
            ? { ...previousEntry, counts }
            : { date: today, counts, previous: previousEntry.date ? { date: previousEntry.date, counts: previousEntry.counts || {} } : null };
        state.companyStockHistory[String(companyId)] = entry;
        void gmSetValue(APP_STORAGE.companyStockHistory, state.companyStockHistory);
        const yesterday = getCompanyStockDayKey(Date.now() - 24 * 60 * 60 * 1000);
        if (entry.previous?.date !== yesterday) return {};
        return Object.fromEntries(Object.entries(counts).map(([id, count]) => [id, count - Number(entry.previous.counts?.[id] || 0)]));
    }

    // Generic per-section cache writer: updates the in-memory cache, stamps the
    // refresh time, and persists a {data, lastRefresh, status} bundle for that section.
    function setSectionCache(name, data) {
        state.caches[name] = data;
        state.lastRefreshBySection[name] = Date.now();
        const sectionKey = APP_STORAGE.sections[name];
        if (!sectionKey) return;
        void gmSetValue(sectionKey, {
            data,
            lastRefresh: state.lastRefreshBySection[name],
            status: state.sectionStatus[name]
        });
    }

    const getStoredInventory = () => state.caches.inventory;
    const setStoredInventory = (payload) => setSectionCache("inventory", payload);

    // Is this section's restored cache too old to trust without a background refresh?
    // "company" uses day-boundary logic (isCompanyUpdateDue, defined later in this
    // file — safe to call here due to function-declaration hoisting).
    function isSectionStale(name, now = Date.now()) {
        if (name === "company") return isCompanyUpdateDue(now);
        const threshold = SECTION_STALENESS_MS[name];
        if (!threshold) return false;
        const last = state.lastRefreshBySection[name] || 0;
        return now - last >= threshold;
    }

    // One-time migration from the old localStorage keys into GM storage, then loads
    // everything (api key, position, dashboard state, all six section caches) into
    // the in-memory state before the dashboard renders for the first time.
    async function loadPersistedState() {
        try {
            const alreadyMigrated = await gmGetValue(APP_STORAGE.migrated, false);
            if (!alreadyMigrated) {
                let legacyKey = null, legacyInventory = null, legacyPosition = null, legacyDashboard = null;
                try { legacyKey = localStorage.getItem(LEGACY_STORAGE.key); } catch (e) { /* ignore */ }
                try {
                    const raw = localStorage.getItem(LEGACY_STORAGE.inventory);
                    legacyInventory = raw ? JSON.parse(raw) : null;
                } catch (e) { /* ignore */ }
                try {
                    const raw = localStorage.getItem(LEGACY_STORAGE.position);
                    legacyPosition = raw ? JSON.parse(raw) : null;
                } catch (e) { /* ignore */ }
                try {
                    const raw = localStorage.getItem(LEGACY_STORAGE.dashboard);
                    legacyDashboard = raw ? JSON.parse(raw) : null;
                } catch (e) { /* ignore */ }

                if (legacyKey) await gmSetValue(APP_STORAGE.key, legacyKey);
                if (legacyPosition) await gmSetValue(APP_STORAGE.position, legacyPosition);
                if (legacyDashboard) await gmSetValue(APP_STORAGE.dashboard, legacyDashboard);
                if (legacyInventory) {
                    await gmSetValue(APP_STORAGE.sections.inventory, {
                        data: legacyInventory,
                        lastRefresh: Date.now(),
                        status: "Migrated from legacy storage"
                    });
                }
                await gmSetValue(APP_STORAGE.migrated, true);
                debugLog("Legacy localStorage migrated to GM storage", {
                    hadKey: !!legacyKey, hadInventory: !!legacyInventory,
                    hadPosition: !!legacyPosition, hadDashboard: !!legacyDashboard
                });
            }
        } catch (e) {
            debugLog("Legacy migration check failed", e);
        }

        state.apiKey = (await gmGetValue(APP_STORAGE.key, "")) || "";
        state.widgetPosition = await gmGetValue(APP_STORAGE.position, null);
        state.companyStockHistory = await gmGetValue(APP_STORAGE.companyStockHistory, {}) || {};

        const dashboardState = await gmGetValue(APP_STORAGE.dashboard, { currentTab: "overview" });
        state.currentTab = dashboardState.currentTab || "overview";
        state.settingsSubTab = dashboardState.settingsSubTab || state.settingsSubTab;
        state.personalSubTab = dashboardState.personalSubTab || state.personalSubTab;
        state.theme = ["light", "dark"].includes(dashboardState.theme) ? dashboardState.theme : state.theme;
        state.isMinimized = dashboardState.isMinimized === true;

        const sectionNames = Object.keys(APP_STORAGE.sections);
        await Promise.all(sectionNames.map(async (name) => {
            const bundle = await gmGetValue(APP_STORAGE.sections[name], null);
            if (bundle && bundle.data) {
                state.caches[name] = bundle.data;
                state.lastRefreshBySection[name] = bundle.lastRefresh || 0;
                if (bundle.status) state.sectionStatus[name] = bundle.status;
            }
        }));

        debugLog("Persisted state restored", {
            hasKey: !!state.apiKey,
            restoredSections: sectionNames.filter((n) => !!state.caches[n])
        });
    }

    function secureCustomFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: { Accept: "application/json" },
                onload: function(response) {
                    if (response.status >= 200 && response.status < 300) {
                        try {
                            resolve(JSON.parse(response.responseText));
                        } catch (e) {
                            reject(new Error("Failed to parse JSON"));
                        }
                    } else {
                        reject(new Error(`HTTP Status ${response.status}`));
                    }
                },
                onerror: (err) => reject(err)
            });
        });
    }

    function withKey(url, apiKey, extraParams = {}) {
        try {
            const finalUrl = new URL(url, window.location.origin);
            finalUrl.searchParams.set("key", apiKey);
            finalUrl.searchParams.set("striptags", "true");
            Object.entries(extraParams).forEach(([name, value]) => {
                if (value !== undefined && value !== null) {
                    finalUrl.searchParams.set(name, String(value));
                }
            });
            return finalUrl.toString();
        } catch (error) {
            const queryPrefix = url.includes("?") ? "&" : "?";
            const extra = new URLSearchParams();
            extra.set("key", apiKey);
            extra.set("striptags", "true");
            Object.entries(extraParams).forEach(([name, value]) => {
                if (value !== undefined && value !== null) extra.set(name, String(value));
            });
            return `${url}${queryPrefix}${extra.toString()}`;
        }
    }

    async function fetchJson(url) {
        const data = await secureCustomFetch(url);
        if (data && data.error) {
            throw new Error(data.error.error || `API error ${data.error.code || "unknown"}`);
        }
        return data;
    }

    async function fetchItemCatalog(apiKey, statusEl) {
        if (statusEl) statusEl.innerText = "Fetching item catalog...";
        const url = withKey(`${BASE_URL}torn/items?cat=All`, apiKey);
        const priceMap = {};

        try {
            const data = await fetchJson(url);
            const catalogItems = (data.items && Array.isArray(data.items)) ? data.items : (Array.isArray(data) ? data : []);

            catalogItems.forEach((entry) => {
                const id = entry.id;
                const value = parseInt((entry.value && entry.value.market_price) || entry.market_value || entry.value || 0, 10);
                if (id !== undefined) priceMap[id] = value;
            });
        } catch (error) {
            if (statusEl) {
                statusEl.innerText = `Catalog fetch warning: ${error.message}`;
            }
            console.warn("Catalog fetch failed:", error);
        }

        return priceMap;
    }

    function buildRacingNameMap(response, collectionKey, nameKeys) {
        const rawEntries = response?.[collectionKey] || response || [];
        const entries = Array.isArray(rawEntries) ? rawEntries : Object.values(rawEntries);
        return Object.fromEntries(entries
            .filter((entry) => entry?.id !== undefined)
            .map((entry) => [String(entry.id), nameKeys.map((key) => entry?.[key]).find(Boolean) || ""]));
    }

    function isRelevantBonusItemType(typeName) {
        const normalized = String(typeName || "").toLowerCase();
        return ["weapon", "armor", "melee", "primary", "secondary", "defensive"].some((token) => normalized.includes(token));
    }

    function normalizeBonusText(mods) {
        if (!Array.isArray(mods) || mods.length === 0) return "";

        const formatted = mods
            .map((mod) => {
                if (!mod) return "";
                if (typeof mod === "string") return mod.trim();
                const name = String(mod.name || mod.title || "").trim();
                const rawValue = mod.value ?? mod.amount ?? mod.percent ?? mod.bonus ?? mod.percentage;
                if (!name) return "";
                if (rawValue === undefined || rawValue === null || rawValue === "") return name;
                const numericValue = Number(rawValue);
                const suffix = Number.isFinite(numericValue) && !String(name).includes("%") ? ` +${numericValue}%` : String(rawValue).trim();
                return `${name}${suffix}`;
            })
            .filter(Boolean);

        const uniqueMods = [...new Set(formatted.map((mod) => String(mod).trim()))].filter(Boolean);
        if (uniqueMods.length === 0) return "";
        return uniqueMods.slice(0, 4).join(", ") + (uniqueMods.length > 4 ? ", ..." : "");
    }

    function normalizeModsText(mods) {
        if (!Array.isArray(mods) || mods.length === 0) return "";

        const formatted = mods
            .map((mod) => {
                if (!mod) return "";
                if (typeof mod === "string") return mod.trim();
                const name = String(mod.name || mod.title || "").trim();
                return name;
            })
            .filter(Boolean);

        const uniqueMods = [...new Set(formatted.map((mod) => String(mod).trim()))].filter(Boolean);
        if (uniqueMods.length === 0) return "";
        return uniqueMods.slice(0, 4).join(", ") + (uniqueMods.length > 4 ? ", ..." : "");
    }

    async function fetchEquipmentBonusMap(apiKey) {
        try {
            const equipmentData = await fetchJson(withKey(`${BASE_URL}user/equipment`, apiKey)).catch(() => ({ equipment: [], clothing: [] }));
            const equipmentItems = Array.isArray(equipmentData.equipment) ? equipmentData.equipment : [];
            const bonusMap = {};
            const modsMap = {};

            equipmentItems.forEach((item) => {
                const itemUid = item && item.uid;
                const itemType = item && item.type;
                if (!itemUid || !isRelevantBonusItemType(itemType)) return;

                const bonuses = Array.isArray(item.bonuses) ? item.bonuses : [];
                if (bonuses.length > 0) {
                    bonusMap[itemUid] = bonuses;
                }

                const mods = Array.isArray(item.mods) ? item.mods : [];
                if (mods.length > 0) {
                    modsMap[itemUid] = mods;
                }
            });

            return { bonusMap, modsMap };
        } catch (error) {
            console.warn("Equipment bonus lookup failed:", error);
            return { bonusMap: {}, modsMap: {} };
        }
    }

    function renderInventoryTable(tableBodyEl, rows) {
        tableBodyEl.innerHTML = "";

        if (!rows || rows.length === 0) {
            tableBodyEl.innerHTML = `<tr><td colspan="7" style="padding: 20px; text-align: center; color: #555; font-size: 11px;">No local synced data.</td></tr>`;
            return;
        }

        const groups = {};
        rows.forEach((row) => {
            if (!groups[row.category]) {
                groups[row.category] = { category: row.category, items: [], quantity: 0, value: 0 };
            }
            const group = groups[row.category];
            group.items.push(row);
            group.quantity += row.quantity;
            group.value += row.total;
        });

        let categoryList = Object.values(groups);
        const { key, direction } = state.sortState;
        const sortKey = (key === "name") ? "category" : key;

        categoryList.sort((a, b) => {
            let av = a[sortKey], bv = b[sortKey];
            if (typeof av === "string") av = av.toLowerCase();
            if (typeof bv === "string") bv = bv.toLowerCase();
            if (av < bv) return direction === "asc" ? -1 : 1;
            if (av > bv) return direction === "asc" ? 1 : -1;
            return 0;
        });

        categoryList.forEach((group) => {
            const isExpanded = state.expandedCategories.has(group.category);
            const isLoanable = LOANABLE_CATEGORIES.has(group.category);
            const loanedCount = isLoanable ? group.items.filter((item) => item.factionOwned).length : 0;

            const catRow = document.createElement("tr");
            catRow.style.borderBottom = "1px solid #222";
            catRow.style.cursor = "pointer";
            catRow.style.backgroundColor = "#202020";
            catRow.innerHTML = `
                <td style="padding: 4px; color: #fff; font-weight: bold; text-transform: capitalize; font-size: 11px;">
                    <span style="display: inline-block; width: 12px;">${isExpanded ? "▼" : "▶"}</span>${escapeHtml(group.category)}
                </td>
                <td style="padding: 4px; color: #888; font-size: 10px; font-style: italic;">${group.items.length} item${group.items.length === 1 ? "" : "s"}</td>
                <td style="padding: 4px; text-align: center; color: #ccc; font-size: 11px; font-weight: bold;">${group.quantity.toLocaleString()}</td>
                <td style="padding: 4px; text-align: right; color: #85bb65; font-size: 11px; font-weight: bold;">${formatMoney(group.value)}</td>
                <td style="padding: 4px; text-align: center; color: #444; font-size: 10px;"></td>
                <td style="padding: 4px; text-align: center; color: #444; font-size: 10px;"></td>
                <td style="padding: 4px; text-align: center; color: #888; font-size: 10px;">${isLoanable ? (loanedCount > 0 ? String(loanedCount) : "—") : "—"}</td>
            `;
            catRow.addEventListener("click", () => {
                if (state.expandedCategories.has(group.category)) {
                    state.expandedCategories.delete(group.category);
                } else {
                    state.expandedCategories.add(group.category);
                }
                renderInventoryTable(tableBodyEl, rows);
            });
            tableBodyEl.appendChild(catRow);

            if (!isExpanded) return;

            const items = [...group.items].sort((a, b) => b.total - a.total);
            items.forEach((item) => {
                const itemRow = document.createElement("tr");
                itemRow.style.borderBottom = "1px solid #1a1a1a";
                itemRow.style.backgroundColor = "#161616";
                const loanedCell = isLoanable
                    ? `<span style="color: ${item.factionOwned ? "#e0a25e" : "#6fa356"}; font-size: 10px;">${item.factionOwned ? "Loaned" : "Owned"}</span>`
                    : `<span style="color: #444; font-size: 11px;">—</span>`;
                const bonusText = item.bonusText || "";
                const modsText = item.modsText || "";
                itemRow.innerHTML = `
                    <td style="padding: 4px 4px 4px 22px; color: #666; font-size: 10px;">↳</td>
                    <td style="padding: 4px; color: #ddd; font-size: 11px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.name)}</td>
                    <td style="padding: 4px; text-align: center; color: #999; font-size: 11px;">${item.quantity.toLocaleString()}</td>
                    <td style="padding: 4px; text-align: right; color: #6fa356; font-size: 11px;">${formatMoney(item.price)}</td>
                    <td style="padding: 4px; text-align: center; color: #9dd8ff; font-size: 10px;">${bonusText ? escapeHtml(bonusText) : "—"}</td>
                    <td style="padding: 4px; text-align: center; color: #c9a0ff; font-size: 10px;">${modsText ? escapeHtml(modsText) : "—"}</td>
                    <td style="padding: 4px; text-align: center;">${loanedCell}</td>
                `;
                tableBodyEl.appendChild(itemRow);
            });
        });
    }

    function updateSortIndicators(theadEl) {
        if (!theadEl) return;
        theadEl.querySelectorAll("th[data-sort-key]").forEach((th) => {
            const k = th.getAttribute("data-sort-key");
            const base = th.getAttribute("data-label");
            th.innerText = (k === state.sortState.key)
                ? `${base} ${state.sortState.direction === "asc" ? "▲" : "▼"}`
                : base;
        });
    }

    async function fetchInventoryData(apiKey, statusEl) {
        setSectionStatus("inventory", "Refreshing...");
        const REQUEST_DELAY_MS = 650;
        const collectedRows = [];

        try {
            const priceMap = await fetchItemCatalog(apiKey, statusEl);
            const { bonusMap: itemBonusMap, modsMap: itemModsMap } = await fetchEquipmentBonusMap(apiKey);
            await sleep(REQUEST_DELAY_MS);

            let totalValueOverall = 0;
            let totalCountOverall = 0;

            for (let i = 0; i < INVENTORY_CATEGORIES.length; i++) {
                const category = INVENTORY_CATEGORIES[i];
                if (statusEl) statusEl.innerText = `Fetching ${category} (${i + 1}/${INVENTORY_CATEGORIES.length})...`;

                try {
                    const url = withKey(`${BASE_URL}user/inventory?cat=${category}`, apiKey);
                    const data = await fetchJson(url);
                    const itemsList = (data.inventory && Array.isArray(data.inventory.items)) ? data.inventory.items : [];

                    itemsList.forEach((item) => {
                        const name = item.name || "Unknown Item";
                        const quantity = parseInt(item.amount || item.quantity || item.qty || item.count || 0, 10);
                        const marketValue = parseInt(priceMap[item.id] || 0, 10);
                        const total = quantity * marketValue;
                        const factionOwned = !!item.faction_owned;
                        const uid = item.uid;
                        const equipped = !!item.equipped;
                        const bonusText = equipped ? normalizeBonusText(itemBonusMap[uid]) : "";
                        const modsText = equipped ? normalizeModsText(itemModsMap[uid]) : "";
                        totalCountOverall += quantity;
                        totalValueOverall += total;
                        collectedRows.push({ category, name, quantity, price: marketValue, total, factionOwned, uid, equipped, bonusText, modsText });
                    });
                } catch (error) {
                    console.warn(`Inventory fetch failed for ${category}:`, error);
                }

                if (i < INVENTORY_CATEGORIES.length - 1) {
                    await sleep(REQUEST_DELAY_MS);
                }
            }

            const result = {
                rows: collectedRows,
                totalCount: totalCountOverall,
                totalValue: totalValueOverall,
                syncedAt: Date.now()
            };

            setStoredInventory(result);
            state.caches.inventory = result;
            setSectionStatus("inventory", "Updated");
            markSectionRefreshed("inventory");
            if (statusEl) statusEl.innerText = `Inventory updated. Items: ${totalCountOverall.toLocaleString()} | Value: ${formatMoney(totalValueOverall)}`;
            return result;
        } catch (error) {
            setSectionStatus("inventory", `Failed: ${error.message}`);
            if (statusEl) statusEl.innerText = `Inventory refresh failed: ${error.message}`;
            return state.caches.inventory || getStoredInventory() || { rows: [], totalCount: 0, totalValue: 0 };
        }
    }

    function setSectionStatus(section, text) {
        if (section && state.sectionStatus) {
            state.sectionStatus[section] = text;
        }
    }

    function markSectionRefreshed(section) {
        state.lastRefreshBySection[section] = Date.now();
    }

    function isLogRefreshDue(now = Date.now()) {
        const last = state.lastRefreshBySection.logs || 0;
        return now - last >= LOG_REFRESH_MS;
    }

    async function fetchOverviewData(apiKey) {
        setSectionStatus("overview", "Refreshing...");
        debugLog("Fetching overview data");
        try {
            const [basicResponse, moneyResponse, networthResponse, barsResponse, cooldownsResponse, travelResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/basic`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/money`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/networth`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/bars`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/cooldowns`, apiKey))
                    .then((data) => ({ data, fetchedAt: Date.now() }))
                    .catch(() => ({ data: null, fetchedAt: Date.now() })),
                fetchJson(withKey(`${BASE_URL}user/travel`, apiKey)).catch(() => null)
            ]);

            const profileResponse = await fetchJson(withKey(`${BASE_URL}user/profile`, apiKey)).catch(() => null);
            const factionResponse = await fetchJson(withKey(`${BASE_URL}user/faction`, apiKey)).catch(() => null);
            const companyResponse = await fetchJson(withKey(`${BASE_URL}company/profile`, apiKey)).catch(() => null);

            const result = {
                basic: basicResponse?.profile || basicResponse || {},
                money: moneyResponse?.money || moneyResponse || {},
                networth: networthResponse?.networth || networthResponse || 0,
                bars: barsResponse?.energy !== undefined ? barsResponse : (barsResponse?.bars || barsResponse || {}),
                profile: profileResponse?.profile || profileResponse || {},
                faction: factionResponse?.faction || factionResponse || {},
                company: companyResponse?.profile || companyResponse || {},
                cooldowns: cooldownsResponse?.data?.cooldowns || cooldownsResponse?.data || {},
                cooldownsFetchedAt: cooldownsResponse?.fetchedAt || Date.now(),
                travel: travelResponse?.travel || travelResponse || {}
            };

            // user/bars embeds a live chain snapshot directly (bars.chain), so the
            // Overview chain indicator no longer has to wait on the Faction tab
            // having loaded first — use it as the primary source, falling back to
            // the Faction tab's own cache (see renderOverviewPanel) if this is empty.
            const embeddedChain = result.bars.chain || null;
            if (embeddedChain) {
                result.chain = {
                    current: Number(embeddedChain.current || 0),
                    max: Number(embeddedChain.max || 0),
                    timeout: Number(embeddedChain.timeout || 0),
                    cooldown: Number(embeddedChain.cooldown || 0),
                    modifier: Number(embeddedChain.modifier || 0),
                    start: Number(embeddedChain.start || 0),
                    end: Number(embeddedChain.end || 0),
                    fetchedAt: Date.now()
                };
            }

            setSectionStatus("overview", "Updated");
            markSectionRefreshed("overview");
            debugLog("Overview data refreshed", { keys: Object.keys(result) });
            return result;
        } catch (error) {
            setSectionStatus("overview", `Failed: ${error.message}`);
            debugLog("Overview data refresh failed", { error: error.message });
            return null;
        }
    }

    async function resolveEducationCourseName(apiKey, courseId) {
        // torn/education/{id} may return either a single course object or (if the
        // API ignores the path id) the full nested catalog — { education: [{ id, name,
        // courses: [{ id, name, ... }] }] }. Handle both shapes defensively.
        const response = await fetchJson(withKey(`${BASE_URL}torn/education/${courseId}`, apiKey)).catch(() => null);
        if (!response) return "";
        const education = response.education;

        if (education && !Array.isArray(education) && education.name) {
            return education.name;
        }

        const categories = Array.isArray(education) ? education : (Array.isArray(response) ? response : []);
        for (const category of categories) {
            const courses = Array.isArray(category.courses) ? category.courses : [];
            const match = courses.find((course) => Number(course.id) === Number(courseId));
            if (match) return match.name || "";
        }

        return "";
    }

    // Cross-references an earned-items list (id + timestamp only, as returned by
    // user/medals or user/honors) against a full catalog (id -> name/description/
    // rarity, as returned by torn/medals or torn/honors) to build a display-ready
    // summary: total earned/available, rarity breakdown, and most recently earned.
    function normalizeAwardCatalog(catalogResponseRaw) {
        if (Array.isArray(catalogResponseRaw)) return catalogResponseRaw;
        return Object.entries(catalogResponseRaw || {}).map(([id, entry]) => ({
            ...(entry || {}),
            id: entry?.id ?? Number(id)
        }));
    }

    function getAwardCatalogById(catalogResponseRaw) {
        return new Map(normalizeAwardCatalog(catalogResponseRaw)
            .map((entry) => [Number(entry.id), entry]));
    }

    function buildAwardSummary(catalogResponseRaw, earnedResponseRaw, itemLabel) {
        const catalogRaw = normalizeAwardCatalog(catalogResponseRaw);
        const catalog = getAwardCatalogById(catalogRaw);

        const earnedRaw = earnedResponseRaw || [];
        const earned = (Array.isArray(earnedRaw) ? earnedRaw : [])
            .map((entry) => {
                const info = catalog.get(Number(entry.id)) || {};
                return {
                    id: entry.id,
                    timestamp: Number(entry.timestamp || 0),
                    name: info.name || `${itemLabel} #${entry.id}`,
                    rarity: info.rarity || "Unknown",
                    description: info.description || ""
                };
            })
            .sort((a, b) => b.timestamp - a.timestamp);

        const rarityBreakdown = {};
        earned.forEach((item) => {
            rarityBreakdown[item.rarity] = (rarityBreakdown[item.rarity] || 0) + 1;
        });

        return {
            totalEarned: earned.length,
            totalAvailable: catalogRaw.length,
            recent: earned.slice(0, 5),
            rarityBreakdown
        };
    }

    const CRIME_PROGRESS_PATHS = {
        vandalism: ["crimes", "offenses", "vandalism"],
        theft: ["crimes", "offenses", "theft"],
        counterfeiting: ["crimes", "offenses", "counterfeiting"],
        fraud: ["crimes", "offenses", "fraud"],
        "illicit service": ["crimes", "offenses", "illicit_services"],
        cybercrime: ["crimes", "offenses", "cybercrime"],
        extortion: ["crimes", "offenses", "extortion"],
        "illegal production": ["crimes", "offenses", "illegal_production"]
    };

    function getNestedNumber(value, path) {
        const result = path.reduce((current, key) => current && current[key], value);
        return Number(result || 0);
    }

    function buildCatalogProgressTracks(catalogRaw, type) {
        return normalizeAwardCatalog(catalogRaw).flatMap((award) => {
            const description = String(award.description || "");
            let match = description.match(/^Win ([\d,]+) attacks$/i);
            if (type === "medal" && match) {
                return [{ id: Number(award.id), type, path: ["attacking", "attacks", "won"], target: Number(match[1].replace(/,/g, "")), award }];
            }

            match = description.match(/^Commit ([\d,]+) (.+?) offenses$/i);
            const crime = match && match[2].toLowerCase();
            if (type === "medal" && crime && CRIME_PROGRESS_PATHS[crime]) {
                return [{ id: Number(award.id), type, path: CRIME_PROGRESS_PATHS[crime], target: Number(match[1].replace(/,/g, "")), award }];
            }

            match = description.match(/^Use ([\d,]+) Xanax$/i);
            if (type === "honor" && match) {
                return [{ id: Number(award.id), type, path: ["drugs", "xanax"], target: Number(match[1].replace(/,/g, "")), award }];
            }

            match = description.match(/^Bust ([\d,]+) people from the Torn City jail$/i);
            if (type === "honor" && match) {
                return [{ id: Number(award.id), type, path: ["jail", "busts", "success"], target: Number(match[1].replace(/,/g, "")), award }];
            }

            match = description.match(/^Revive ([\d,]+) people$/i);
            if (type === "honor" && match) {
                return [{ id: Number(award.id), type, path: ["hospital", "reviving", "revives"], target: Number(match[1].replace(/,/g, "")), award }];
            }

            return [];
        });
    }

    function buildAwardProgress(personalstats, medalsCatalogRaw, honorsCatalogRaw, userMedalsRaw, userHonorsRaw) {
        const earnedMedals = new Set((Array.isArray(userMedalsRaw) ? userMedalsRaw : []).map((item) => Number(item.id)));
        const earnedHonors = new Set((Array.isArray(userHonorsRaw) ? userHonorsRaw : []).map((item) => Number(item.id)));

        return [
            ...buildCatalogProgressTracks(medalsCatalogRaw, "medal"),
            ...buildCatalogProgressTracks(honorsCatalogRaw, "honor")
        ]
            .filter((track) => !(track.type === "medal" ? earnedMedals : earnedHonors).has(track.id))
            .map((track) => {
                const current = getNestedNumber(personalstats, track.path);
                return {
                    name: track.award.name,
                    type: track.type,
                    rarity: track.award.rarity || "Unknown",
                    current,
                    target: track.target,
                    percent: Math.min(100, (current / track.target) * 100)
                };
            })
            .filter((track) => track.current < track.target)
            .sort((a, b) => b.percent - a.percent || a.target - b.target)
            .slice(0, 5);
    }

    async function fetchPersonalData(apiKey) {
        setSectionStatus("personal", "Refreshing...");
        debugLog("Fetching personal data");
        try {
            const [profileResponse, skillsResponse, educationResponse, workstatsResponse, battlestatsResponse, perksResponse, jobResponse, moneyResponse, networthResponse, jobpointsResponse, medalsCatalogResponse, userMedalsResponse, honorsCatalogResponse, userHonorsResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/profile`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/skills`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/education`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/workstats`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/battlestats`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/perks`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/job`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/money`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/networth`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/jobpoints`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}torn/medals`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/medals`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}torn/honors`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/honors`, apiKey)).catch(() => null)
            ]);
            const personalstatResponses = await Promise.all(
                ["attacking", "crimes", "drugs", "jail", "hospital"].map((cat) =>
                    fetchJson(withKey(`${BASE_URL}user/personalstats`, apiKey, { cat })).catch(() => null)
                )
            );

            const education = educationResponse?.education || educationResponse || {};
            let currentCourseName = "";
            if (education.current && education.current.id) {
                currentCourseName = await resolveEducationCourseName(apiKey, education.current.id);
            }

            // Resolve job points for the CURRENT job only, from the separate
            // user/jobpoints endpoint (user/job itself has no points field).
            const job = jobResponse?.job || jobResponse || {};
            const jobpoints = jobpointsResponse?.jobpoints || jobpointsResponse || {};
            let currentJobPoints = null;
            if (job.type === "company" && job.id) {
                const companies = Array.isArray(jobpoints.companies) ? jobpoints.companies : [];
                const match = companies.find((entry) => Number(entry.company?.id) === Number(job.id));
                if (match) currentJobPoints = Number(match.points || 0);
            } else if (job.type === "job" && job.name) {
                const jobsMap = jobpoints.jobs || {};
                const key = String(job.name).toLowerCase();
                if (jobsMap[key] !== undefined) currentJobPoints = Number(jobsMap[key]);
            }

            const medals = buildAwardSummary(
                medalsCatalogResponse?.medals || medalsCatalogResponse,
                userMedalsResponse?.medals || userMedalsResponse,
                "Medal"
            );
            const honors = buildAwardSummary(
                honorsCatalogResponse?.honors || honorsCatalogResponse,
                userHonorsResponse?.honors || userHonorsResponse,
                "Honor"
            );
            const personalstats = Object.assign({}, ...personalstatResponses.map((response) => response?.personalstats || response || {}));
            const awardProgress = buildAwardProgress(
                personalstats,
                medalsCatalogResponse?.medals || medalsCatalogResponse,
                honorsCatalogResponse?.honors || honorsCatalogResponse,
                userMedalsResponse?.medals || userMedalsResponse,
                userHonorsResponse?.honors || userHonorsResponse
            );

            const result = {
                profile: profileResponse?.profile || profileResponse || {},
                skills: skillsResponse?.skills || skillsResponse || {},
                education,
                currentCourseName,
                workstats: workstatsResponse?.workstats || workstatsResponse || {},
                battlestats: battlestatsResponse?.battlestats || battlestatsResponse || {},
                perks: perksResponse?.perks || perksResponse || {},
                job,
                money: moneyResponse?.money || moneyResponse || {},
                networth: networthResponse?.networth || networthResponse || {},
                currentJobPoints,
                medals,
                honors,
                awardProgress
            };
            setSectionStatus("personal", "Updated");
            markSectionRefreshed("personal");
            debugLog("Personal data refreshed", { keys: Object.keys(result) });
            return result;
        } catch (error) {
            setSectionStatus("personal", `Failed: ${error.message}`);
            debugLog("Personal data refresh failed", { error: error.message });
            return null;
        }
    }

    // Official fixed chain-bonus values. Bonus hits do not receive other respect
    // modifiers, so reading the attack's chain number is exact and avoids inference.
    const CHAIN_BONUS_RESPECT = {
        10: 10, 25: 20, 50: 40, 100: 80, 250: 160, 500: 320,
        1000: 640, 2500: 1280, 5000: 2560, 10000: 5120,
        25000: 10240, 50000: 20480, 100000: 40960
    };

    function getChainBonusRespect(attack) {
        return CHAIN_BONUS_RESPECT[Number(attack?.chain || 0)] || 0;
    }

    async function fetchFactionData(apiKey) {
        setSectionStatus("faction", "Refreshing...");
        debugLog("Fetching faction data");
        try {
            const [userFactionResponse, factionBasicResponse, factionStatsResponse, factionMembersResponse, factionNewsResponse, factionChainResponse, factionWarsResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/faction`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/basic`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/stats`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/members`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/news`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/chain`, apiKey))
                    .then((data) => ({ data, fetchedAt: Date.now() }))
                    .catch(() => ({ data: null, fetchedAt: Date.now() })),
                fetchJson(withKey(`${BASE_URL}faction/wars`, apiKey)).catch(() => null)
            ]);

            const userFactionData = userFactionResponse?.faction || userFactionResponse || {};
            const factionBasicData = factionBasicResponse?.basic || factionBasicResponse || {};
            const ownFactionId = Number(factionBasicData.id || userFactionData.id || userFactionData.faction_id || 0);

            const chainRaw = factionChainResponse?.data?.chain || factionChainResponse?.data || {};
            const chain = {
                current: Number(chainRaw.current || 0),
                max: Number(chainRaw.max || 0),
                timeout: Number(chainRaw.timeout || 0),
                cooldown: Number(chainRaw.cooldown || 0),
                modifier: Number(chainRaw.modifier || 0),
                start: Number(chainRaw.start || 0),
                end: Number(chainRaw.end || 0),
                fetchedAt: factionChainResponse?.fetchedAt || Date.now()
            };

            const warsData = factionWarsResponse?.wars || factionWarsResponse || {};
            const rankedWar = warsData.ranked || null;
            const rankedFactions = Array.isArray(rankedWar?.factions) ? rankedWar.factions : [];
            let war = null;
            if (rankedFactions.length >= 2) {
                const ownEntry = rankedFactions.find((entry) => Number(entry.id) === ownFactionId) || rankedFactions[0];
                const oppEntry = rankedFactions.find((entry) => Number(entry.id) !== ownFactionId) || rankedFactions[1];
                const opponentBasicResponse = await fetchJson(withKey(`${BASE_URL}faction/${oppEntry.id}/basic`, apiKey)).catch(() => null);
                const opponentBasic = opponentBasicResponse?.basic || opponentBasicResponse || {};
                war = {
                    warId: Number(rankedWar.war_id || 0),
                    ownScore: Number(ownEntry.score || 0),
                    oppScore: Number(oppEntry.score || 0),
                    ownTag: factionBasicData.tag || ownEntry.name || "My Faction",
                    oppTag: opponentBasic.tag || oppEntry.name || "Enemy Faction",
                    oppName: oppEntry.name || "Unknown",
                    target: Number(rankedWar.target || 0),
                    start: Number(rankedWar.start || 0),
                    end: rankedWar.end ? Number(rankedWar.end) : 0
                };
            }

            // Personal chain/war contribution has no direct API field — approximated
            // client-side by pulling own attacks since the earlier of chain/war start
            // and tallying hits + respect_gain within each window. See project notes.
            const personalContribution = { chainHits: 0, chainRespect: 0, warHits: 0, warRespect: 0, bonusScore: 0 };
            try {
                const chainStart = chain.start;
                const chainEnd = chain.end || Math.floor(Date.now() / 1000);
                const warStart = war ? war.start : 0;
                const candidateStarts = [chainStart, warStart].filter((value) => value > 0);
                const earliestStart = candidateStarts.length ? Math.min(...candidateStarts) : 0;

                if (earliestStart) {
                    const attacksResponse = await fetchJson(withKey(`${BASE_URL}user/attacks`, apiKey, { from: earliestStart, sort: "ASC" })).catch(() => null);
                    const attacks = Array.isArray(attacksResponse?.attacks) ? attacksResponse.attacks
                        : (Array.isArray(attacksResponse) ? attacksResponse : []);

                    attacks.forEach((atk) => {
                        const started = Number(atk.started || atk.timestamp_started || 0);
                        const respectGain = Number(atk.respect_gain || 0);

                        if (atk.is_ranked_war && warStart && started >= warStart) {
                            personalContribution.warHits += 1;
                            personalContribution.warRespect += respectGain;
                        }

                        if (chainStart && started >= chainStart && started <= chainEnd) {
                            personalContribution.chainHits += 1;
                            personalContribution.chainRespect += respectGain;
                            personalContribution.bonusScore += getChainBonusRespect(atk);
                        }
                    });
                }
            } catch (contributionError) {
                console.warn("Personal contribution calculation failed:", contributionError);
            }

            const result = {
                userFaction: userFactionData,
                factionBasic: factionBasicData,
                factionStats: factionStatsResponse?.stats || factionStatsResponse || [],
                factionMembers: factionMembersResponse?.members || factionMembersResponse || [],
                factionNews: factionNewsResponse?.news || factionNewsResponse || [],
                chain,
                war,
                personalContribution
            };
            setSectionStatus("faction", "Updated");
            markSectionRefreshed("faction");
            debugLog("Faction data refreshed", { keys: Object.keys(result) });
            return result;
        } catch (error) {
            setSectionStatus("faction", `Failed: ${error.message}`);
            debugLog("Faction data refresh failed", { error: error.message });
            return null;
        }
    }

    async function fetchCompanyData(apiKey) {
        setSectionStatus("company", "Refreshing...");
        debugLog("Fetching company data");
        try {
            const [companyProfileResponse, companyEmployeesResponse, companyNewsResponse, companyStockResponse, companyApplicationsResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}company/profile`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}company/employees`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}company/news`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}company/stock`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}company/applications`, apiKey)).catch(() => null)
            ]);
            const companyProfile = companyProfileResponse?.profile || companyProfileResponse || {};
            const companyStock = companyStockResponse ? (companyStockResponse?.stock || companyStockResponse || []) : [];
            const stockChanges = companyStockResponse ? updateCompanyStockHistory(companyProfile.id, companyStock) : {};
            const result = {
                companyProfile,
                companyEmployees: companyEmployeesResponse?.employees || companyEmployeesResponse || [],
                companyNews: companyNewsResponse?.news || companyNewsResponse || [],
                companyStock,
                stockChanges,
                companyApplications: companyApplicationsResponse ? (companyApplicationsResponse?.applications || companyApplicationsResponse || []) : null
            };
            setSectionStatus("company", "Updated");
            markSectionRefreshed("company");
            debugLog("Company data refreshed", { keys: Object.keys(result) });
            return result;
        } catch (error) {
            setSectionStatus("company", `Failed: ${error.message}`);
            debugLog("Company data refresh failed", { error: error.message });
            return null;
        }
    }

    async function fetchActivityData(apiKey) {
        setSectionStatus("activity", "Refreshing...");
        debugLog("Fetching activity data");
        try {
            const [notificationsResponse, userLogResponse, eventsResponse, tradesResponse, racingCarsResponse, racingTracksResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/notifications`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/log`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/events`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/trades`, apiKey, { cat: "ongoing" })).catch(() => null),
                fetchJson(withKey(`${BASE_URL}racing/cars`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}racing/tracks`, apiKey)).catch(() => null)
            ]);
            const result = {
                notifications: notificationsResponse?.notifications || notificationsResponse || {},
                userLog: userLogResponse?.log || userLogResponse || {},
                events: eventsResponse?.events || eventsResponse || {},
                trades: tradesResponse?.trades || tradesResponse || [],
                carNames: buildRacingNameMap(racingCarsResponse, "cars", ["name", "title"]),
                trackNames: buildRacingNameMap(racingTracksResponse, "tracks", ["title", "name"])
            };
            setSectionStatus("activity", "Updated");
            markSectionRefreshed("activity");
            markSectionRefreshed("logs");
            debugLog("Activity data refreshed", { keys: Object.keys(result) });
            return result;
        } catch (error) {
            setSectionStatus("activity", `Failed: ${error.message}`);
            debugLog("Activity data refresh failed", { error: error.message });
            return null;
        }
    }

    function buildStatCard(title, value, subtext, color = "#8ec7ff") {
        const displayValue = typeof value === "number" ? formatInteger(value) : String(value ?? "0");
        return `
            <div style="background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)); border: 1px solid #333; border-radius: 8px; padding: 10px; min-height: 90px; box-sizing: border-box;">
                <div style="color: #d4d4d4; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;">${escapeHtml(title)}</div>
                <div style="color: ${color}; font-size: 22px; font-weight: 700; line-height: 1.1;">${escapeHtml(displayValue)}</div>
                <div style="color: #d0d0d0; font-size: 12px; font-weight: 600; line-height: 1.35; margin-top: 7px;">${escapeHtml(subtext)}</div>
            </div>
        `;
    }

    function renderBarsPanel(bars) {
        const barDefinitions = [
            { key: "energy", label: "Energy", color: "#7fe18d" },
            { key: "nerve", label: "Nerve", color: "#e05959" },
            { key: "life", label: "Life", color: "#5ba7f7" },
            { key: "happy", label: "Happiness", color: "#f0d34f" }
        ];
        const rows = barDefinitions.map(({ key, label, color }) => {
            const value = bars[key] || {};
            const current = Number(value.current ?? value ?? 0);
            const maximum = Number(value.maximum ?? value.max ?? 0);
            const percent = maximum > 0 ? Math.min(100, Math.max(0, (current / maximum) * 100)) : 0;
            return `
                <div style="display: grid; grid-template-columns: 58px 1fr auto; align-items: center; gap: 8px;">
                    <span style="color: #e0e0e0; font-size: 12px; font-weight: 700;">${label}</span>
                    <div style="height: 12px; border-radius: 6px; overflow: hidden; background: #202020; border: 1px solid #3a3a3a;">
                        <div style="width: ${percent}%; height: 100%; background: ${color}; transition: width 0.3s;"></div>
                    </div>
                    <span style="color: #fff; font-size: 12px; font-weight: 700; min-width: 68px; text-align: right;">${formatInteger(current)} / ${formatInteger(maximum)}</span>
                </div>
            `;
        }).join("");
        return `
            <div style="border: 1px solid #3a3a3a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.85); margin-bottom: 10px; display: grid; gap: 8px;">
                <div style="color: #fff; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;">Bars</div>
                ${rows}
            </div>
        `;
    }

    function renderCooldownsRow(cooldowns, fetchedAt) {
        const drug = Number(cooldowns.drug || 0);
        const medical = Number(cooldowns.medical || 0);
        const booster = Number(cooldowns.booster || 0);

        if (!drug && !medical && !booster) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; color: #888; font-size: 11px;">No active cooldowns.</div>`;
        }

        const cell = (key, label, seconds, color) => `
            <div style="flex: 1; text-align: center;">
                <div style="color: #e0e0e0; font-size: 12px; font-weight: 800; margin-bottom: 3px;">${label}</div>
                <div id="cooldown-${key}" data-seconds="${seconds}" data-fetched-at="${Number(fetchedAt || Date.now())}" data-active-color="${color}" style="color: ${seconds > 0 ? color : "#7fe18d"}; font-size: 13px; font-weight: 800;">${seconds > 0 ? formatDuration(seconds) : "Ready"}</div>
            </div>
        `;

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; display: flex; gap: 6px;">
                ${cell("drug", "Drug", drug, "#e0a25e")}
                ${cell("medical", "Medical", medical, "#9dd8ff")}
                ${cell("booster", "Booster", booster, "#c9a0ff")}
            </div>
        `;
    }

    function renderTravelCard(basic, travel) {
        const status = basic.status || {};
        const stateText = String(status.state || "").toLowerCase();
        const isTraveling = stateText.includes("travel");
        if (!isTraveling) return "";

        const destination = travel.destination || status.description || "Unknown destination";
        const method = travel.method || "";
        const timeLeft = Number(travel.time_left || 0);

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 4px;">✈️ Traveling</div>
                <div style="color: #9dd8ff; font-size: 13px; margin-bottom: 2px;">${escapeHtml(String(destination))}${method ? ` · ${escapeHtml(String(method))}` : ""}</div>
                <div style="color: #888; font-size: 10px;">${timeLeft > 0 ? `Arriving in ${formatDuration(timeLeft)}` : "Arriving soon"}</div>
            </div>
        `;
    }

    function renderOverviewPanel() {
        const overview = state.caches.overview || {};
        const basic = overview.basic || {};
        const money = overview.money || {};
        const networthValue = typeof overview.networth === "object"
            ? (overview.networth.networth ?? overview.networth.total ?? overview.networth.daily_networth ?? 0)
            : Number(overview.networth || 0);
        const bars = overview.bars || {};
        const faction = overview.faction || {};
        const company = overview.company || {};
        const cooldowns = overview.cooldowns || {};
        const travel = overview.travel || {};

        const playerName = basic.name || basic.player_name || "Unknown player";
        const level = basic.level || "-";
        const factionName = faction.name || faction.faction_name || "No faction";
        const companyName = company.name || company.company_name || "No company";
        const cash = Number(money.wallet ?? money.cash ?? money.money ?? 0);
        const net = Number(networthValue || 0);

        // Chain mini-indicator: prefers the chain snapshot embedded in this tab's own
        // user/bars fetch (overview.chain), falling back to the Faction tab's cached
        // /faction/chain data if that hasn't loaded yet — either way, no wasted fetch.
        const chain = overview.chain || (state.caches.faction || {}).chain || {};
        const chainDisplay = chain.max ? `${formatInteger(chain.current)} / ${formatInteger(chain.max)}` : "No data";
        const chainSubtext = chain.max ? `Breaks in ${formatDuration(chain.timeout)}` : "Visit Faction tab to load";

        const summaryCards = [
            buildStatCard("Player", playerName, `Level ${level}`),
            buildStatCard("Cash", formatMoney(cash), "Current money"),
            buildStatCard("Net Worth", formatMoney(net), "Estimated total"),
            buildStatCard("Faction", factionName, "Current faction"),
            buildStatCard("Company", companyName, "Current company"),
            buildStatCard("Chain", chainDisplay, chainSubtext)
        ].join("");

        return `
            ${renderSectionMeta("overview", "Overview")}
            ${renderBarsPanel(bars)}
            ${renderCooldownsRow(cooldowns, overview.cooldownsFetchedAt)}
            ${renderTravelCard(basic, travel)}
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
                ${summaryCards}
            </div>
        `;
    }

    function getArrayLength(value) {
        if (Array.isArray(value)) return value.length;
        if (value && typeof value === "object") return Object.keys(value).length;
        return 0;
    }

    function getStatValue(statsArray, statName) {
        if (!Array.isArray(statsArray)) return 0;
        const match = statsArray.find((entry) => String(entry && entry.name).toLowerCase() === String(statName).toLowerCase());
        return Number(match && match.value !== undefined ? match.value : 0) || 0;
    }

    function renderInfoBox(title, rows) {
        if (!rows.length) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; color: #888; font-size: 11px;">No ${escapeHtml(title.toLowerCase())} data.</div>`;
        }
        const rowsHtml = rows.map((row) => `
            <div style="display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #222;">
                <span style="color: #d0d0d0; font-size: 12px; font-weight: 600;">${escapeHtml(row.label)}</span>
                <span style="color: ${row.color || "#fff"}; font-size: 12px; font-weight: 700;">${escapeHtml(String(row.value))}</span>
            </div>
        `).join("");
        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 6px;">${escapeHtml(title)}</div>
                ${rowsHtml}
            </div>
        `;
    }

    function getBattleStatBonuses(perks) {
        const texts = Object.values(perks || {})
            .flatMap((items) => Array.isArray(items) ? items : [])
            .map((item) => String(item || ""));
        const bonuses = { strength: 0, defense: 0, speed: 0, dexterity: 0 };
        Object.keys(bonuses).forEach((stat) => {
            texts.forEach((text) => {
                const normalized = text.toLowerCase();
                if (!normalized.includes(stat) || /(gain|training|train|gym|experience)/.test(normalized)) return;
                const match = normalized.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
                if (match) bonuses[stat] += Number(match[1]) || 0;
            });
        });
        return bonuses;
    }

    function renderEffectiveBattleStatsBox(stats, bonuses, total) {
        const labels = { strength: "Strength", defense: "Defense", speed: "Speed", dexterity: "Dexterity" };
        const entries = Object.keys(labels).map((key) => {
            const base = Number(stats[key] || 0);
            const bonus = Number(bonuses[key] || 0);
            return { label: labels[key], base, bonus, effective: base * (1 + bonus / 100) };
        });
        const rows = entries.map((entry) =>
            '<div style="display: grid; grid-template-columns: minmax(78px, 1fr) minmax(100px, 1.2fr) minmax(62px, 0.7fr) minmax(100px, 1.2fr); gap: 6px; align-items: center; padding: 4px 0; border-bottom: 1px solid #222;">'
            + '<span style="color: #d0d0d0; font-size: 12px; font-weight: 600;">' + entry.label + '</span>'
            + '<span style="color: #fff; font-size: 12px; font-weight: 700; text-align: right;">' + formatInteger(entry.base) + '</span>'
            + '<span style="color: #9dd8ff; font-size: 12px; font-weight: 700; text-align: center;">' + (entry.bonus ? '+' + entry.bonus + '%' : '—') + '</span>'
            + '<span style="color: #7fe18d; font-size: 12px; font-weight: 700; text-align: right;">' + formatInteger(entry.effective) + '</span>'
            + '</div>'
        ).join("");
        const effectiveTotal = entries.reduce((sum, entry) => sum + entry.effective, 0);
        return '<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">'
            + '<div style="color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Battle Stats</div>'
            + '<div style="display: grid; grid-template-columns: minmax(78px, 1fr) minmax(100px, 1.2fr) minmax(62px, 0.7fr) minmax(100px, 1.2fr); gap: 6px; padding-bottom: 4px; color: #888; font-size: 10px; font-weight: 700;">'
            + '<span>Stat</span><span style="text-align: right;">Battle Stat</span><span style="text-align: center;">Perk</span><span style="text-align: right;">Effective</span></div>'
            + rows
            + '<div style="display: grid; grid-template-columns: minmax(78px, 1fr) minmax(100px, 1.2fr) minmax(62px, 0.7fr) minmax(100px, 1.2fr); gap: 6px; padding-top: 5px;">'
            + '<span style="color: #d0d0d0; font-size: 12px; font-weight: 700;">Total</span>'
            + '<span style="color: #fff; font-size: 12px; font-weight: 700; text-align: right;">' + formatInteger(total) + '</span>'
            + '<span style="color: #9dd8ff; font-size: 12px; font-weight: 700; text-align: center;">—</span>'
            + '<span style="color: #7fe18d; font-size: 12px; font-weight: 700; text-align: right;">' + formatInteger(effectiveTotal) + '</span>'
            + '</div></div>';
    }

    function normalizeSkillsList(skills) {
        if (Array.isArray(skills)) return skills;
        if (skills && typeof skills === "object") {
            return Object.entries(skills).map(([slug, value]) => {
                if (value && typeof value === "object") {
                    return { slug, name: value.name || slug, level: value.level ?? value.value ?? 0 };
                }
                return { slug, name: slug, level: value };
            });
        }
        return [];
    }

    function renderSkillsBox(skills) {
        const list = normalizeSkillsList(skills);
        if (!list.length) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; color: #888; font-size: 11px;">No skills data.</div>`;
        }
        const rowsHtml = list.map((skill) => `
            <div style="display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #222;">
                <span style="color: #d0d0d0; font-size: 12px; font-weight: 600; text-transform: capitalize;">${escapeHtml(String(skill.name || skill.slug || "Unknown").replace(/_/g, " "))}</span>
                <span style="color: #9dd8ff; font-size: 12px; font-weight: 700;">${Number(skill.level || 0).toFixed(2)}</span>
            </div>
        `).join("");
        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Skills</div>
                ${rowsHtml}
            </div>
        `;
    }

    function renderEducationLine(education, currentCourseName) {
        const completedCount = Array.isArray(education.complete) ? education.complete.length : 0;
        const current = education.current || null;
        const inProgressText = current
            ? `${currentCourseName ? escapeHtml(currentCourseName) : `Course #${current.id}`}${current.until ? ` (${formatDuration(Math.max(0, Number(current.until) - Math.floor(Date.now() / 1000)))} left)` : ""}`
            : "None";
        const total = completedCount + (current ? 1 : 0);
        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; font-size: 11px; color: #ccc;">
                <span style="color: #fff; font-weight: 700;">Education —</span> In Progress: ${inProgressText} · Completed: ${completedCount} · Total: ${total}
            </div>
        `;
    }

    const PERK_SOURCE_LABELS = {
        faction: "Faction",
        job: "Job",
        property: "Property",
        education: "Education",
        enhancer: "Enhancer",
        book: "Book",
        stock: "Stock",
        merit: "Merit"
    };

    function renderPerksBox(perks) {
        const sections = Object.keys(PERK_SOURCE_LABELS)
            .map((key) => ({ key, label: PERK_SOURCE_LABELS[key], items: Array.isArray(perks[key]) ? perks[key] : [] }))
            .filter((section) => section.items.length > 0);

        if (!sections.length) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; color: #888; font-size: 11px;">No perks data.</div>`;
        }

        const sectionsHtml = sections.map((section) => `
            <div style="margin-bottom: 8px;">
                <div style="color: #9dd8ff; font-size: 11px; font-weight: 700; margin-bottom: 3px;">${escapeHtml(section.label)}</div>
                ${section.items.map((text) => `<div style="color: #ccc; font-size: 10px; padding: 2px 0 2px 8px; border-left: 2px solid #333;">${escapeHtml(String(text))}</div>`).join("")}
            </div>
        `).join("");

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Perks</div>
                ${sectionsHtml}
            </div>
        `;
    }

    const MEDAL_RARITY_COLORS = {
        "Common": "#999",
        "Very Common": "#888",
        "Limited": "#e0a25e",
        "Uncommon": "#7fe18d",
        "Rare": "#9dd8ff",
        "Very Rare": "#e0a25e",
        "Extremely Rare": "#c9a0ff",
        "Ultra Rare": "#e05959"
    };

    function renderAwardSection(title, summary) {
        if (!summary || !summary.totalAvailable) {
            return `<div style="margin-bottom: 8px;"><span style="color: #fff; font-size: 12px; font-weight: 700;">${escapeHtml(title)}</span> <span style="color: #888; font-size: 11px;">— no data.</span></div>`;
        }

        const breakdownEntries = Object.entries(summary.rarityBreakdown || {});
        const breakdownHtml = breakdownEntries.length ? `
            <div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px;">
                ${breakdownEntries.map(([rarity, count]) => `
                    <span style="font-size: 10px; color: ${MEDAL_RARITY_COLORS[rarity] || "#ccc"}; border: 1px solid #333; border-radius: 4px; padding: 2px 6px;">${escapeHtml(rarity)}: ${count}</span>
                `).join("")}
            </div>
        ` : "";

        const recentHtml = (summary.recent || []).map((item) => `
            <div style="display: flex; justify-content: space-between; padding: 3px 0; border-bottom: 1px solid #222;">
                <span style="color: ${MEDAL_RARITY_COLORS[item.rarity] || "#ccc"}; font-size: 11px;">${escapeHtml(item.name)}</span>
                <span style="color: #888; font-size: 10px;">${formatDate(item.timestamp)}</span>
            </div>
        `).join("");

        return `
            <div style="margin-bottom: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <span style="color: #fff; font-size: 12px; font-weight: 700;">${escapeHtml(title)}</span>
                    <span style="color: #9dd8ff; font-size: 11px;">${formatInteger(summary.totalEarned)} / ${formatInteger(summary.totalAvailable)}</span>
                </div>
                ${breakdownHtml}
                ${recentHtml || `<div style="color: #888; font-size: 10px;">None earned yet.</div>`}
            </div>
        `;
    }

    function renderAchievementsBox(medals, honors) {
        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                ${renderAwardSection("Medals", medals)}
                ${renderAwardSection("Honors", honors)}
            </div>
        `;
    }

    function renderAwardProgressBox(progress) {
        const rows = (Array.isArray(progress) ? progress : []).map((item) => `
            <div style="padding: 7px 0; border-bottom: 1px solid #222;">
                <div style="display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px;">
                    <span style="color: ${MEDAL_RARITY_COLORS[item.rarity] || "#ccc"}; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.name)}</span>
                    <span style="color: #9dd8ff; font-size: 10px; white-space: nowrap;">${item.percent.toFixed(1)}%</span>
                </div>
                <div style="height: 6px; border-radius: 3px; overflow: hidden; background: #222;">
                    <div style="width: ${item.percent}%; height: 100%; background: #7fe18d;"></div>
                </div>
                <div style="color: #888; font-size: 10px; margin-top: 3px;">${formatInteger(item.current)} / ${formatInteger(item.target)} · ${escapeHtml(item.type)}</div>
            </div>
        `).join("");

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Closest to Completion</div>
                ${rows || `<div style="color: #888; font-size: 10px;">No configured award progress is available.</div>`}
            </div>
        `;
    }

    function renderPersonalPanel() {
        const personal = state.caches.personal || {};
        const profile = personal.profile || {};
        const skills = personal.skills || {};
        const education = personal.education || {};
        const currentCourseName = personal.currentCourseName || "";
        const workstats = personal.workstats || {};
        const battlestats = personal.battlestats || {};
        const perks = personal.perks || {};
        const job = personal.job || {};
        const money = personal.money || {};
        const networth = personal.networth || {};
        const networthMoney = networth.money || {};
        const networthItems = networth.items || {};
        const networthAssets = networth.assets || {};

        const battleTotal = Number(battlestats.total ?? 0);
        const battleStats = {
            strength: Number(battlestats.strength?.value ?? battlestats.strength ?? 0),
            defense: Number(battlestats.defense?.value ?? battlestats.defense ?? 0),
            speed: Number(battlestats.speed?.value ?? battlestats.speed ?? 0),
            dexterity: Number(battlestats.dexterity?.value ?? battlestats.dexterity ?? 0)
        };
        const workStats = {
            manualLabor: Number(workstats.manual_labor ?? 0),
            endurance: Number(workstats.endurance ?? 0),
            intelligence: Number(workstats.intelligence ?? 0),
            total: Number(workstats.total ?? 0)
        };
        const battleBonuses = getBattleStatBonuses(perks);

        const playerId = profile.player_id ?? profile.id ?? "-";
        const jobName = job.name || "Unemployed";
        const jobPosition = job.position || "";
        const jobRating = job.type === "company" && job.rating !== undefined ? `${job.rating}★` : "";
        const jobDays = job.days_in_company !== undefined ? `${formatInteger(job.days_in_company)}d` : "";
        const jobPointsText = personal.currentJobPoints !== null && personal.currentJobPoints !== undefined ? `${formatInteger(personal.currentJobPoints)} pts` : "";
        const jobSubtext = [jobPosition, jobRating, jobDays, jobPointsText].filter(Boolean).join(" · ") || "No job";
        const wallet = Number(money.wallet ?? 0);
        const cityBank = Number(money.city_bank?.amount ?? 0);
        const vault = Number(money.vault ?? 0);
        const points = Number(money.points ?? 0);

        const topCards = [
            buildStatCard("Player", profile.name || "Unknown", `Player ID ${playerId}`),
            buildStatCard("Level", profile.level || "-", "Current level", "#7fe18d"),
            buildStatCard("Job", jobName, jobSubtext)
        ].join("");

        const wealthBox = `
            ${renderInfoBox("Wealth Summary", [
                { label: "Total Net Worth", value: formatMoney(networth.total ?? 0), color: "#7fe18d" },
                { label: "Points Held", value: formatInteger(points), color: "#9dd8ff" },
                { label: "Points Value", value: formatMoney(networth.points ?? 0), color: "#9dd8ff" }
            ])}
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(215px, 1fr)); gap: 8px;">
                ${renderInfoBox("Money", [
                    { label: "Pending", value: formatMoney(networthMoney.pending ?? 0) },
                    { label: "Wallet", value: formatMoney(networthMoney.wallet ?? wallet), color: "#7fe18d" },
                    { label: "Vault", value: formatMoney(networthMoney.vault ?? vault), color: "#7fe18d" },
                    { label: "Bookie", value: formatMoney(networthMoney.bookie ?? 0) },
                    { label: "City Bank", value: formatMoney(networthMoney.city_bank ?? cityBank), color: "#7fe18d" },
                    { label: "Cayman Bank", value: formatMoney(networthMoney.cayman_bank ?? 0) },
                    { label: "Piggy Bank", value: formatMoney(networthMoney.piggy_bank ?? 0) },
                    { label: "Loans", value: formatMoney(networthMoney.loans ?? 0), color: "#e05959" },
                    { label: "Unpaid Fees", value: formatMoney(networthMoney.unpaid_fees ?? 0), color: "#e05959" }
                ])}
                ${renderInfoBox("Items", [
                    { label: "Inventory", value: formatMoney(networthItems.inventory ?? 0) },
                    { label: "Display Case", value: formatMoney(networthItems.display_case ?? 0) },
                    { label: "Bazaar", value: formatMoney(networthItems.bazaar ?? 0) },
                    { label: "Trades", value: formatMoney(networthItems.trades ?? 0) },
                    { label: "Item Market", value: formatMoney(networthItems.item_market ?? 0) },
                    { label: "Auction House", value: formatMoney(networthItems.auction_house ?? 0) },
                    { label: "Enlisted Cars", value: formatMoney(networthItems.enlisted_cars ?? 0) }
                ])}
                ${renderInfoBox("Assets", [
                    { label: "Property", value: formatMoney(networthAssets.property ?? 0) },
                    { label: "Stock Market", value: formatMoney(networthAssets.stock_market ?? 0) },
                    { label: "Company", value: formatMoney(networthAssets.company ?? 0) }
                ])}
            </div>
        `;

        const battleBox = renderEffectiveBattleStatsBox(battleStats, battleBonuses, battleTotal);

        const workBox = renderInfoBox("Work Stats", [
            { label: "Manual Labor", value: formatInteger(workStats.manualLabor) },
            { label: "Endurance", value: formatInteger(workStats.endurance) },
            { label: "Intelligence", value: formatInteger(workStats.intelligence) },
            { label: "Total", value: formatInteger(workStats.total), color: "#7fe18d" }
        ]);

        const subTabs = [
            { id: "info", label: "Info" },
            { id: "skills-education", label: "Skills/Education" },
            { id: "perks", label: "Perks" },
            { id: "awards", label: "Awards" }
        ];
        const activeSubTab = subTabs.some((tab) => tab.id === state.personalSubTab) ? state.personalSubTab : "info";
        const subTabButtons = subTabs.map((tab) => `
            <button data-personal-subtab="${tab.id}" style="background: ${activeSubTab === tab.id ? "#3b5998" : "#2a2a2a"}; border: 1px solid #3d3d3d; color: #fff; border-radius: 4px; padding: 6px 8px; font-size: 11px; cursor: pointer; ${activeSubTab === tab.id ? "font-weight: 700;" : ""}">${tab.label}</button>
        `).join("");
        const subTabContent = activeSubTab === "skills-education" ? `
            ${renderSkillsBox(skills)}
            ${renderEducationLine(education, currentCourseName)}
        ` : activeSubTab === "perks" ? `
            ${renderPerksBox(perks)}
        ` : activeSubTab === "awards" ? `
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; align-items: start;">
                ${renderAchievementsBox(personal.medals, personal.honors)}
                ${renderAwardProgressBox(personal.awardProgress)}
            </div>
        ` : `
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px;">
                ${topCards}
            </div>
            ${wealthBox}
            ${battleBox}
            ${workBox}
        `;

        return `
            ${renderSectionMeta("personal", "Personal")}
            <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px;">${subTabButtons}</div>
            ${subTabContent}
        `;
    }

    function renderChainBar(chain) {
        const current = Number(chain.current || 0);
        const max = Number(chain.max || 0);
        const pct = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
        const barColor = pct >= 90 ? "#e05959" : pct >= 60 ? "#e0a25e" : "#7fe18d";

        if (!max && !current && !chain.timeout) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; color: #888; font-size: 11px;">No active chain.</div>`;
        }

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <span style="color: #fff; font-size: 12px; font-weight: 700;">Chain</span>
                    <span style="color: #9dd8ff; font-size: 11px;">${formatInteger(current)} / ${formatInteger(max)} hits</span>
                </div>
                <div style="width: 100%; height: 10px; background: #222; border-radius: 5px; overflow: hidden; margin-bottom: 6px;">
                    <div style="width: ${pct}%; height: 100%; background: ${barColor}; transition: width 0.3s;"></div>
                </div>
                <div style="display: flex; justify-content: space-between; color: #888; font-size: 10px;">
                    <span>Breaks in <span id="faction-chain-countdown" style="color: #ccc; font-weight: 700;">${formatDuration(chain.timeout)}</span></span>
                    <span>Cooldown: ${formatDuration(chain.cooldown)}</span>
                </div>
            </div>
        `;
    }

    function renderWarCard(war) {
        if (!war) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; color: #888; font-size: 11px;">No active ranked war.</div>`;
        }

        const scoreLimit = Math.max(1, Number(war.target || 0), Math.abs(war.ownScore - war.oppScore));
        const scoreDifference = war.ownScore - war.oppScore;
        const markerPosition = Math.min(100, Math.max(0, 50 - ((scoreDifference / scoreLimit) * 50)));
        const markerColor = "#4fb86a";
        const targetText = war.target > 0 ? `Lead target: ${formatInteger(war.target)}` : "Live score";

        return `
            <div style="border: 1px solid #3a3a3a; border-radius: 8px; padding: 12px; background: rgba(20,20,20,0.82); margin-bottom: 10px; text-align: center;">
                <div style="color: #fff; font-size: 14px; font-weight: 700; margin-bottom: 4px;">Ranked War</div>
                <div style="color: #d8d8d8; font-size: 12px; font-weight: 700; margin-bottom: 5px;">${escapeHtml(war.ownTag)} <span style="color: #888; padding: 0 5px;">vs</span> ${escapeHtml(war.oppTag)}</div>
                <div style="color: #fff; font-size: 22px; font-weight: 800; margin-bottom: 9px;">${formatInteger(war.ownScore)} - ${formatInteger(war.oppScore)}</div>
                <div style="position: relative; width: 100%; height: 14px; border-radius: 7px; overflow: hidden; background: linear-gradient(90deg, rgba(79,184,106,0.14), #252525 50%, rgba(79,184,106,0.14)); border: 1px solid #454545;">
                    <div style="position: absolute; left: calc(50% - 1px); top: 0; width: 2px; height: 100%; background: #fff; opacity: 0.65;"></div>
                    <div style="position: absolute; left: calc(${markerPosition}% - 6px); top: 1px; width: 10px; height: 10px; border-radius: 50%; background: ${markerColor}; border: 1px solid #fff; box-shadow: 0 0 7px ${markerColor}; transition: left 0.3s, background 0.3s;"></div>
                </div>
                <div style="display: flex; justify-content: space-between; color: #cfcfcf; font-size: 11px; font-weight: 700; margin-top: 5px;">
                    <span>${escapeHtml(war.ownTag)}: ${formatInteger(war.ownScore)}</span>
                    <span>${escapeHtml(war.oppTag)}: ${formatInteger(war.oppScore)}</span>
                </div>
                <div style="color: #aaa; font-size: 11px; margin-top: 5px;">${targetText} · Center = tied</div>
            </div>
        `;
    }

    function renderFactionPanel() {
        const faction = state.caches.faction || {};
        const userFaction = faction.userFaction || faction.faction || {};
        const factionBasic = faction.factionBasic || {};
        const factionStats = Array.isArray(faction.factionStats) ? faction.factionStats : [];
        const members = Array.isArray(faction.factionMembers) ? faction.factionMembers : [];
        const rawNews = Array.isArray(faction.factionNews) ? faction.factionNews : (
            faction.factionNews && Array.isArray(faction.factionNews.news) ? faction.factionNews.news : []
        );

        const membersCount = Number(factionBasic.members ?? members.length ?? 0);
        const respect = Number(factionBasic.respect ?? getStatValue(factionStats, "respect") ?? 0);
        const cards = [
            buildStatCard("Faction", factionBasic.name || userFaction.name || userFaction.faction_name || "Unknown", `ID ${factionBasic.id || userFaction.id || userFaction.faction_id || "-"}`),
            buildStatCard("Members", membersCount, "Current member count"),
            buildStatCard("Respect", respect, "Faction respect"),
            buildStatCard("News", rawNews.length, "Recent news entries")
        ].join("");

        const chain = faction.chain || {};
        const war = faction.war || null;
        const contribution = faction.personalContribution || { chainHits: 0, chainRespect: 0, warHits: 0, warRespect: 0, bonusScore: 0 };
        const contributionCards = [
            buildStatCard("Chain Hits", contribution.chainHits, "Your hits this chain (approx)", "#9dd8ff"),
            buildStatCard("Chain Respect", contribution.chainRespect, "Respect earned this chain (approx)", "#7fe18d"),
            buildStatCard("War Hits", contribution.warHits, "Your hits this war (approx)", "#9dd8ff"),
            buildStatCard("War Respect", contribution.warRespect, "Respect earned this war (approx)", "#7fe18d"),
            buildStatCard("Bonus Score", (contribution.bonusScore || 0).toFixed(2), "Respect from bonus hits only — excludes chain & war score", "#c9a0ff")
        ].join("");

        return `
            ${renderSectionMeta("faction", "Faction")}
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px;">
                ${cards}
            </div>
            ${renderChainBar(chain)}
            ${renderWarCard(war)}
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
                ${contributionCards}
            </div>
        `;
    }

    function renderCompanyPanel() {
        const company = state.caches.company || {};
        const profile = company.companyProfile || company.profile || {};
        const employees = Array.isArray(company.companyEmployees) ? company.companyEmployees : [];
        const rawNews = Array.isArray(company.companyNews) ? company.companyNews : (
            company.companyNews && Array.isArray(company.companyNews.news) ? company.companyNews.news : []
        );
        const stock = Array.isArray(company.companyStock) ? company.companyStock : [];
        const stockChanges = company.stockChanges || {};
        const applications = Array.isArray(company.companyApplications) ? company.companyApplications : null;
        const companyEmployees = profile.employees || {};

        const currentRoster = Number(companyEmployees.hired ?? employees.length ?? 0);
        const maxRoster = Number(companyEmployees.capacity ?? 0);
        const stockTotal = stock.reduce((sum, item) => sum + Number(item.in_stock ?? item.quantity ?? 0), 0);
        const pendingApplications = applications ? applications.filter((item) => item?.status === "active").length : null;
        const companyType = profile.type?.name || profile.type || "Unknown";
        const rating = Number(profile.rating || 0);
        const income = profile.income || {};
        const adsBudget = profile.advertisement_budget;
        const hasWages = employees.length === currentRoster && employees.every((employee) => employee?.wage !== undefined && employee?.wage !== null);
        const canShowProfit = adsBudget !== undefined && adsBudget !== null && hasWages;
        const totalWages = canShowProfit ? employees.reduce((sum, employee) => sum + Number(employee.wage || 0), 0) : 0;
        const dailyIncome = Number(income.daily || 0);
        const weeklyIncome = Number(income.weekly || 0);
        const financialNote = "Estimated using current ads budget and wages — actual profit may differ if these were changed during the week.";
        const cards = [
            buildStatCard("Company", profile.name || "Unknown", `ID ${profile.id || "-"}`),
            buildStatCard("Type & Rating", companyType, rating ? `${rating}★ rating` : "No rating available"),
            buildStatCard("Employees", `${formatInteger(currentRoster)} / ${formatInteger(maxRoster)}`, "Current roster / max roster"),
            buildStatCard("Stock", stockTotal, "Total stock quantity"),
            buildStatCard("Applications", pendingApplications === null ? "—" : pendingApplications, pendingApplications === null ? "Requires manager access" : "Pending applications"),
            buildStatCard("News", rawNews.length, "Recent news entries")
        ].join("");

        const financialRows = canShowProfit ? [
            { label: "Daily Income", value: formatMoney(dailyIncome), color: "#7fe18d" },
            { label: "Weekly Income", value: formatMoney(weeklyIncome), color: "#7fe18d" },
            { label: "Ads Budget", value: formatMoney(Number(adsBudget)), color: "#e0a25e" },
            { label: "Total Wages", value: formatMoney(totalWages), color: "#e0a25e" },
            { label: "Daily Profit", value: formatMoney(dailyIncome - Number(adsBudget) - totalWages), color: "#9dd8ff" },
            { label: "Weekly Profit", value: formatMoney(weeklyIncome - (Number(adsBudget) * 7) - (totalWages * 7)), color: "#9dd8ff" }
        ] : [
            { label: "Daily Income", value: formatMoney(dailyIncome), color: "#7fe18d" },
            { label: "Weekly Income", value: formatMoney(weeklyIncome), color: "#7fe18d" },
            { label: "Profit", value: "Unavailable", color: "#e0a25e" }
        ];
        const topEmployees = [...employees]
            .sort((a, b) => Number(b?.effectiveness?.total ?? -Infinity) - Number(a?.effectiveness?.total ?? -Infinity))
            .slice(0, 5)
            .map((employee) => ({
                label: employee.name || "Unknown employee",
                value: `${employee.position?.name || employee.position || "Unknown role"}${employee.effectiveness?.total !== undefined ? ` · ${formatInteger(employee.effectiveness.total)}% effectiveness` : ""}`
            }));
        const topStock = [...stock]
            .sort((a, b) => Number(b?.in_stock ?? b?.quantity ?? 0) - Number(a?.in_stock ?? a?.quantity ?? 0))
            .slice(0, 5)
            .map((item) => ({
                label: item.name || "Unknown item",
                value: `${formatInteger(item.in_stock ?? item.quantity ?? 0)} in stock${stockChanges[String(item.id)] === undefined ? " · No yesterday baseline" : ` · ${Number(stockChanges[String(item.id)]) >= 0 ? "+" : ""}${formatInteger(stockChanges[String(item.id)])} vs yesterday`} · ${formatMoney(Number(item.price || 0))}`
            }));

        return `
            ${renderSectionMeta("company", "Company")}
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
                ${cards}
            </div>
            <div style="margin-top: 10px;" title="${escapeHtml(financialNote)}">
                ${renderInfoBox("Finances", financialRows)}
                ${canShowProfit ? `<div style="color: #888; font-size: 10px; margin: -5px 0 10px;">ⓘ ${escapeHtml(financialNote)}</div>` : `<div style="color: #e0a25e; font-size: 10px; margin: -5px 0 10px;">ⓘ Profit unavailable — requires company manager access.</div>`}
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 8px;">
                ${renderInfoBox("Top Employees", topEmployees)}
                ${renderInfoBox("Top Stock", topStock)}
            </div>
        `;
    }

    function humanizeActivityKey(key) {
        return String(key || "")
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/[_-]+/g, " ")
            .replace(/\b\w/g, (letter) => letter.toUpperCase());
    }

    function isCurrencyLogField(key, context = {}) {
        const normalizedKey = String(key || "").toLowerCase().replace(/[^a-z]/g, "");
        const contextText = [
            context?.details?.category,
            context?.details?.title,
            context?.event,
            context?.data?.text
        ].join(" ").toLowerCase();
        const directCurrencyFields = new Set([
            "amount", "balance", "deposited", "withdrawn", "deposit", "withdrawal",
            "money", "cash", "wallet", "vault", "bank", "price", "profit", "fee",
            "payment", "refund", "winnings", "salary", "income", "interest"
        ]);
        return directCurrencyFields.has(normalizedKey)
            || /(vault|bank|money|cash|casino|lottery|bazaar|market|stock|property)/.test(contextText)
                && /(amount|balance|cost|price|value|profit|fee|payment|reward|income|wage|salary)/.test(normalizedKey);
    }

    function summarizeLogPayload(payload, context, carNames = {}, trackNames = {}) {
        if (!payload || typeof payload !== "object") return "";
        const values = Object.entries(payload)
            .filter(([, value]) => value !== null && value !== undefined && value !== "" && typeof value !== "object")
            .slice(0, 3)
            .map(([key, value]) => {
                const number = Number(value);
                const isRacing = /racing/.test(`${context?.details?.category || ""} ${context?.details?.title || ""}`.toLowerCase());
                const normalizedKey = String(key).toLowerCase();
                const racingName = isRacing && normalizedKey === "car"
                    ? carNames[String(value)]
                    : isRacing && normalizedKey === "track"
                        ? trackNames[String(value)]
                        : "";
                const formattedValue = racingName
                    ? racingName
                    : Number.isFinite(number)
                    ? (isCurrencyLogField(key, context) ? formatMoney(number) : formatInteger(number))
                    : value;
                return `${humanizeActivityKey(key)}: ${formattedValue}`;
            });
        return values.join(" · ");
    }

    function renderActivityPanel() {
        const activity = state.caches.activity || {};
        const notifications = activity.notifications || {};
        const log = activity.userLog || {};
        const events = activity.events || {};
        const trades = Array.isArray(activity.trades) ? activity.trades : [];
        const carNames = activity.carNames || {};
        const trackNames = activity.trackNames || {};

        const notificationLabels = {
            messages: { icon: "✉", label: "Messages", detail: "Unread messages waiting for you" },
            events: { icon: "⚡", label: "Events", detail: "New events in your activity feed" },
            awards: { icon: "★", label: "Awards", detail: "New medals or honors earned" },
            competition: { icon: "🏁", label: "Competition", detail: "Competition updates need your attention" }
        };
        const notificationList = Object.entries(notificationLabels)
            .map(([key, config]) => {
                const count = Number(notifications[key] || 0);
                return {
                    text: `${config.icon} ${formatInteger(count)} ${config.label}${count === 1 ? "" : ""}`,
                    detail: config.detail
                };
            })
            .filter((item) => !item.text.includes(" 0 "));

        const logList = Array.isArray(log) ? log.slice(0, 4).map((item) => ({
            text: `${humanizeActivityKey(item?.details?.category || "Activity")} · ${item?.details?.title || item?.data?.text || item?.event || "Log update"}`,
            timestamp: item?.timestamp,
            detail: summarizeLogPayload(item?.data, item, carNames, trackNames) || summarizeLogPayload(item?.params, item, carNames, trackNames) || "Recorded in your personal activity log"
        })) : (Array.isArray(log.log) ? log.log.slice(0, 4).map((item) => ({
            text: `${humanizeActivityKey(item?.details?.category || "Activity")} · ${item?.details?.title || item?.data?.text || item?.event || "Log update"}`,
            timestamp: item?.timestamp,
            detail: summarizeLogPayload(item?.data, item, carNames, trackNames) || summarizeLogPayload(item?.params, item, carNames, trackNames) || "Recorded in your personal activity log"
        })) : []);

        const eventList = Array.isArray(events) ? events.slice(0, 4).map((item) => ({
            text: item?.event || item?.text || item?.title || "Event update",
            timestamp: item?.timestamp
        })) : (Array.isArray(events.events) ? events.events.slice(0, 4).map((item) => ({
            text: item?.event || item?.text || item?.title || "Event update",
            timestamp: item?.timestamp
        })) : []);
        const tradeList = trades.slice(0, 4).map((trade) => ({
            text: `Trade #${trade.id || "—"} with ${trade.trader?.name || trade.user?.name || "Unknown player"}`,
            timestamp: trade.modified_at || trade.expires_at,
            detail: trade.expires_at ? formatTimeUntil(trade.expires_at) : "Ongoing"
        }));

        const lists = [
            renderStreamList("Notifications", notificationList),
            renderStreamList("Recent Log", logList),
            renderStreamList("Events", eventList),
            renderStreamList("Ongoing Trades", tradeList)
        ].join("");

        return `${renderSectionMeta("activity", "Activity")}<div style="display: grid; gap: 8px;">${lists}</div>`;
    }

    function renderStreamList(title, items) {
        const safeItems = Array.isArray(items) ? items : [];
        const rows = safeItems.length ? safeItems.map((item) => {
            const text = item?.text || item?.message || item?.event || item?.title || item?.details?.title || "Unknown update";
            const timestamp = formatRelativeTime(item?.timestamp);
            const detail = item?.detail ? `<div style="color: #888; font-size: 10px; margin-top: 3px;">${escapeHtml(item.detail)}</div>` : "";
            return `<div style="padding: 8px 10px; border: 1px solid #2d2d2d; border-radius: 6px; background: rgba(255,255,255,0.02); color: #ddd; font-size: 11px;"><div style="display: flex; justify-content: space-between; gap: 8px;"><span>${escapeHtml(text)}</span>${timestamp ? `<span style="color: #888; font-size: 10px; white-space: nowrap;">${timestamp}</span>` : ""}</div>${detail}</div>`;
        }).join("") : `<div style="padding: 8px 10px; border: 1px solid #2d2d2d; border-radius: 6px; background: rgba(255,255,255,0.02); color: #888; font-size: 11px;">No ${title.toLowerCase()} available.</div>`;

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 8px; background: rgba(20,20,20,0.7);">
                <div style="color: #fff; font-size: 12px; margin-bottom: 6px; font-weight: 700;">${escapeHtml(title)}</div>
                <div style="display: grid; gap: 6px;">${rows}</div>
            </div>
        `;
    }

    function toCsvString(data) {
        const rows = [];

        function flatten(value, parentKey = "") {
            if (value === null || value === undefined) {
                rows.push([parentKey || "value", ""]);
                return;
            }

            if (Array.isArray(value)) {
                if (value.length === 0) {
                    rows.push([parentKey || "value", ""]);
                    return;
                }

                value.forEach((entry, index) => {
                    const key = parentKey ? `${parentKey}[${index}]` : `[${index}]`;
                    flatten(entry, key);
                });
                return;
            }

            if (typeof value === "object") {
                Object.entries(value).forEach(([key, nestedValue]) => {
                    const nextKey = parentKey ? `${parentKey}.${key}` : key;
                    flatten(nestedValue, nextKey);
                });
                return;
            }

            rows.push([parentKey || "value", value]);
        }

        flatten(data);
        const csvRows = rows.map(([key, value]) => {
            const safeKey = String(key ?? "").replace(/"/g, '""');
            const safeValue = String(value ?? "").replace(/"/g, '""');
            return `"${safeKey}","${safeValue}"`;
        });

        return `field,value\n${csvRows.join("\n")}`;
    }

    function downloadSectionCsv(sectionName) {
        const source = state.caches[sectionName] || getStoredInventory();
        debugLog("CSV export triggered", { sectionName, hasData: !!source, keys: source ? Object.keys(source) : [] });
        if (!source || typeof source !== "object") {
            const status = document.getElementById("fetch-status-bar");
            if (status) status.innerText = `${sectionName} snapshot is empty.`;
            return;
        }

        const cleanName = sectionName.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "snapshot";
        const csv = toCsvString(source);
        const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${cleanName}-snapshot.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);

        const status = document.getElementById("fetch-status-bar");
        if (status) status.innerText = `${sectionName} snapshot downloaded.`;
    }

    async function refreshSectionByKey(sectionKey, statusEl) {
        const apiKey = getStoredKey();
        debugLog("Manual section refresh requested", { sectionKey, apiKeyPresent: !!apiKey });
        if (!apiKey) {
            if (statusEl) statusEl.innerText = "⚠️ Enter a Torn API key first.";
            return false;
        }

        if (statusEl) statusEl.innerText = `Refreshing ${sectionKey}...`;

        try {
            switch (sectionKey) {
                case "overview":
                    setSectionCache("overview", (await fetchOverviewData(apiKey)) || state.caches.overview);
                    break;
                case "personal":
                    setSectionCache("personal", (await fetchPersonalData(apiKey)) || state.caches.personal);
                    break;
                case "faction":
                    setSectionCache("faction", (await fetchFactionData(apiKey)) || state.caches.faction);
                    break;
                case "company":
                    setSectionCache("company", (await fetchCompanyData(apiKey)) || state.caches.company);
                    break;
                case "inventory":
                    setSectionCache("inventory", (await fetchInventoryData(apiKey, statusEl)) || state.caches.inventory);
                    break;
                case "activity":
                    setSectionCache("activity", (await fetchActivityData(apiKey)) || state.caches.activity);
                    break;
                default:
                    return false;
            }

            renderTabContent();
            if (statusEl) statusEl.innerText = `${sectionKey.charAt(0).toUpperCase() + sectionKey.slice(1)} refreshed.`;
            debugLog("Manual section refresh complete", { sectionKey });
            return true;
        } catch (error) {
            if (statusEl) statusEl.innerText = `Refresh failed: ${error.message}`;
            debugLog("Manual section refresh failed", { sectionKey, error: error.message });
            return false;
        }
    }

    function renderSettingsPanel() {
        const snapshotButtons = [
            { key: "overview", label: "Overview" },
            { key: "personal", label: "Personal" },
            { key: "faction", label: "Faction" },
            { key: "company", label: "Company" },
            { key: "inventory", label: "Inventory" },
            { key: "activity", label: "Activity" }
        ];

        const currentSubTab = state.settingsSubTab || "controls";
        const exportMarkup = snapshotButtons.map(({ key, label }) => `
            <button data-export-section="${key}" style="background: #2f5d3d; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Download ${label} to .csv</button>
        `).join("");

        const refreshMarkup = snapshotButtons.map(({ key, label }) => `
            <button data-refresh-section="${key}" style="background: #6058b8; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Refresh ${label}</button>
        `).join("");

        const subTabButtons = [
            { id: "controls", label: "Controls" },
            { id: "export", label: "Exports" }
        ].map(({ id, label }) => `
            <button data-settings-subtab="${id}" style="background: ${currentSubTab === id ? '#3b5998' : '#2a2a2a'}; border: 1px solid #3d3d3d; color: #fff; border-radius: 4px; padding: 6px 8px; font-size: 10px; cursor: pointer;">${label}</button>
        `).join("");

        const content = currentSubTab === "controls"
            ? `
                <div style="display: grid; gap: 10px;">
                    <div style="border: 1px solid #3d3d3d; border-radius: 6px; padding: 10px; display: grid; gap: 7px;">
                        <div style="color: #fff; font-weight: 700; font-size: 12px;">Appearance</div>
                        <div style="color: #aaa; font-size: 11px;">Current mode: ${state.theme === "light" ? "Light" : "Dark"}</div>
                        <button id="theme-toggle-btn" style="background: #3b5998; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Switch to ${state.theme === "light" ? "Dark" : "Light"} Mode</button>
                    </div>
                    <div style="color: #fff; font-weight: 700; font-size: 12px;">API Key</div>
                    <div style="display: flex; gap: 8px;">
                        <input type="password" id="torn-api-key-input" value="${escapeHtml(getStoredKey())}" style="background: #111; border: 1px solid #444; border-radius: 6px; color: #fff; padding: 8px; flex: 1; font-size: 11px;" placeholder="Enter Torn API key" />
                        <button id="save-api-key-btn" style="background: #3b5998; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Save</button>
                    </div>
                    <button id="full-refresh-btn" style="background: #a13b3b; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Refresh all sections</button>
                    <div style="display: grid; gap: 6px;">${refreshMarkup}</div>
                </div>
            `
            : `
                <div style="display: grid; gap: 6px;">
                    ${exportMarkup}
                </div>
            `;

        return `
            ${renderSectionMeta("settings", "Settings")}
            <div style="display: grid; gap: 10px;">
                <div style="display: flex; gap: 6px; flex-wrap: wrap;">${subTabButtons}</div>
                ${content}
                <div id="fetch-status-bar" style="color: #aaa; font-size: 11px; min-height: 30px; line-height: 1.4;">${escapeHtml(state.sectionStatus.settings || "Ready.")}</div>
            </div>
        `;
    }

    function renderInventorySection() {
        const inventory = state.caches.inventory || getStoredInventory() || { rows: [], totalCount: 0, totalValue: 0 };

        return `
            ${renderSectionMeta("inventory", "Inventory")}
            <div style="display: grid; gap: 8px;">
                <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
                    ${buildStatCard("Inventory Items", inventory.totalCount || 0, "Tracked item count", "#7fe18d")}
                    ${buildStatCard("Inventory Value", formatMoney(inventory.totalValue || 0), "Estimated market value", "#85bb65")}
                </div>
                <div style="max-height: 260px; overflow-y: auto; border: 1px solid #222; background-color: #151515; border-radius: 3px;">
                    <table style="width: 100%; border-collapse: collapse; text-align: left;">
                        <thead style="position: sticky; top: 0; background-color: #252525; z-index: 10; border-bottom: 1px solid #333;">
                            <tr style="color: #fff; font-size: 11px; font-weight: bold;">
                                <th data-sort-key="category" data-label="Category" style="padding: 4px; cursor: pointer; user-select: none;">Category</th>
                                <th style="padding: 4px;">Items</th>
                                <th data-sort-key="quantity" data-label="Qty" style="padding: 4px; text-align: center; cursor: pointer; user-select: none;">Qty</th>
                                <th data-sort-key="value" data-label="Value" style="padding: 4px; text-align: right; cursor: pointer; user-select: none;">Value</th>
                                <th style="padding: 4px; text-align: center;">Bonus/Perks</th>
                                <th style="padding: 4px; text-align: center;">Mods</th>
                                <th style="padding: 4px; text-align: center;">Loaned</th>
                            </tr>
                        </thead>
                        <tbody id="inventory-table-body" style="color: #ccc;">
                            <tr><td colspan="7" style="padding: 20px; text-align: center; color: #555; font-size: 11px;">No local synced data.</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }

    function renderSectionMeta(section, label) {
        const status = state.sectionStatus[section] || "Not loaded";
        return `
            <div style="border: 1px solid #2c2c2c; border-radius: 6px; background: rgba(255,255,255,0.02); padding: 7px 9px; margin-bottom: 8px; color: #d7d7d7; font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase;">
                <span style="color: #9dd8ff; font-weight: 700;">${escapeHtml(label)}</span>
                <span style="color: #bdbdbd; margin-left: 8px;">${escapeHtml(status)}</span>
            </div>
        `;
    }

    function bindInventoryTableControls() {
        const contentEl = document.getElementById("torn-companion-content");
        if (!contentEl || state.currentTab !== "inventory") return;

        const theadEl = contentEl.querySelector("thead");
        const tableBodyEl = contentEl.querySelector("#inventory-table-body");
        if (!theadEl || !tableBodyEl) return;

        updateSortIndicators(theadEl);
        if (inventoryRowsExist()) {
            renderInventoryTable(tableBodyEl, state.caches.inventory?.rows || getStoredInventory()?.rows || []);
        }

        theadEl.querySelectorAll("th[data-sort-key]").forEach((th) => {
            th.onclick = () => {
                const key = th.getAttribute("data-sort-key");
                if (state.sortState.key === key) {
                    state.sortState.direction = state.sortState.direction === "asc" ? "desc" : "asc";
                } else {
                    state.sortState.key = key;
                    state.sortState.direction = "asc";
                }
                updateSortIndicators(theadEl);
                const cachedRows = state.caches.inventory?.rows || getStoredInventory()?.rows || [];
                renderInventoryTable(tableBodyEl, cachedRows);
            };
        });
    }

    function bindSettingsControls() {
        const contentEl = document.getElementById("torn-companion-content");
        if (!contentEl || state.currentTab !== "settings") return;

        const saveButton = document.getElementById("save-api-key-btn");
        const fullRefreshButton = document.getElementById("full-refresh-btn");
        const themeToggleButton = document.getElementById("theme-toggle-btn");
        const apiKeyInput = document.getElementById("torn-api-key-input");
        const status = document.getElementById("fetch-status-bar");
        const exportButtons = contentEl.querySelectorAll("[data-export-section]");
        const refreshSectionButtons = contentEl.querySelectorAll("[data-refresh-section]");
        const subTabButtons = contentEl.querySelectorAll("[data-settings-subtab]");

        if (saveButton && !saveButton.dataset.bound) {
            saveButton.dataset.bound = "true";
            saveButton.onclick = () => {
                const apiKey = apiKeyInput ? apiKeyInput.value : getStoredKey();
                setStoredKey(apiKey);
                debugLog("API key saved", { length: String(apiKey || "").length });
                if (status) status.innerText = "🔑 API key saved locally.";
            };
        }

        if (fullRefreshButton && !fullRefreshButton.dataset.bound) {
            fullRefreshButton.dataset.bound = "true";
            fullRefreshButton.onclick = async () => {
                debugLog("Full section refresh button clicked");
                if (status) status.innerText = "Refreshing all sections...";
                await refreshAllSections();
            };
        }

        if (themeToggleButton && !themeToggleButton.dataset.bound) {
            themeToggleButton.dataset.bound = "true";
            themeToggleButton.onclick = () => {
                const theme = state.theme === "dark" ? "light" : "dark";
                setStoredDashboardState({ theme });
                applyDashboardTheme();
                renderTabContent();
            };
        }

        subTabButtons.forEach((button) => {
            if (button.dataset.bound === "true") return;
            button.dataset.bound = "true";
            button.onclick = () => {
                const tabKey = button.getAttribute("data-settings-subtab");
                if (tabKey) {
                    state.settingsSubTab = tabKey;
                    setStoredDashboardState({ settingsSubTab: tabKey });
                    debugLog("Settings subtab changed", { tabKey });
                    renderTabContent();
                }
            };
        });

        refreshSectionButtons.forEach((button) => {
            if (button.dataset.bound === "true") return;
            button.dataset.bound = "true";
            button.onclick = async () => {
                const key = button.getAttribute("data-refresh-section");
                if (!key) return;
                debugLog("Section refresh button clicked", { key });
                await refreshSectionByKey(key, status);
            };
        });

        exportButtons.forEach((button) => {
            if (button.dataset.bound === "true") return;
            button.dataset.bound = "true";
            button.onclick = () => {
                const key = button.getAttribute("data-export-section");
                if (!key) return;
                debugLog("CSV export button clicked", { key });
                downloadSectionCsv(key);
            };
        });
    }

    function bindPersonalControls() {
        const contentEl = document.getElementById("torn-companion-content");
        if (!contentEl || state.currentTab !== "personal") return;
        contentEl.querySelectorAll("[data-personal-subtab]").forEach((button) => {
            button.onclick = () => {
                const subTab = button.getAttribute("data-personal-subtab");
                if (!subTab || subTab === state.personalSubTab) return;
                state.personalSubTab = subTab;
                setStoredDashboardState({ personalSubTab: subTab });
                renderTabContent();
            };
        });
    }

    function renderTabContent() {
        const contentEl = document.getElementById("torn-companion-content");
        if (!contentEl) return;

        let innerHtml = "";
        const previousTab = state.currentTab;
        switch (state.currentTab) {
            case "personal":
                innerHtml = renderPersonalPanel();
                break;
            case "faction":
                innerHtml = renderFactionPanel();
                break;
            case "company":
                innerHtml = renderCompanyPanel();
                break;
            case "inventory":
                innerHtml = renderInventorySection();
                break;
            case "activity":
                innerHtml = renderActivityPanel();
                break;
            case "settings":
                innerHtml = renderSettingsPanel();
                break;
            case "overview":
            default:
                innerHtml = renderOverviewPanel();
                break;
        }

        debugLog("Tab render", { previousTab, activeTab: state.currentTab, sectionStatus: state.sectionStatus });
        contentEl.innerHTML = innerHtml;
        bindInventoryTableControls();
        bindSettingsControls();
        bindPersonalControls();

        if (state.currentTab === "faction") {
            startChainCountdownTimer();
        } else {
            stopChainCountdownTimer();
        }
        if (state.currentTab === "overview") {
            startCooldownCountdownTimer();
        } else {
            stopCooldownCountdownTimer();
        }
    }

    function stopChainCountdownTimer() {
        if (state.chainCountdownTimer) {
            clearInterval(state.chainCountdownTimer);
            state.chainCountdownTimer = null;
        }
    }

    function startChainCountdownTimer() {
        stopChainCountdownTimer();
        const updateCountdown = () => {
            const el = document.getElementById("faction-chain-countdown");
            if (!el || state.currentTab !== "faction") {
                stopChainCountdownTimer();
                return;
            }
            const chain = (state.caches.faction || {}).chain || {};
            if (!chain.fetchedAt || !Number.isFinite(chain.timeout)) return;
            const elapsedSeconds = Math.floor((Date.now() - chain.fetchedAt) / 1000);
            const remaining = Math.max(0, Number(chain.timeout) - elapsedSeconds);
            el.textContent = formatDuration(remaining);
            el.style.color = remaining <= 0 ? "#e05959" : "#ccc";
        };
        updateCountdown();
        state.chainCountdownTimer = setInterval(updateCountdown, 250);
    }

    function stopCooldownCountdownTimer() {
        if (state.cooldownCountdownTimer) {
            clearInterval(state.cooldownCountdownTimer);
            state.cooldownCountdownTimer = null;
        }
    }

    function startCooldownCountdownTimer() {
        stopCooldownCountdownTimer();
        const updateCountdown = () => {
            if (state.currentTab !== "overview") {
                stopCooldownCountdownTimer();
                return;
            }
            const elements = document.querySelectorAll("[id^='cooldown-'][data-seconds]");
            if (!elements.length) return;
            elements.forEach((el) => {
                const seconds = Number(el.dataset.seconds || 0);
                const fetchedAt = Number(el.dataset.fetchedAt || Date.now());
                const remaining = Math.max(0, seconds - ((Date.now() - fetchedAt) / 1000));
                el.textContent = remaining > 0 ? formatDuration(Math.ceil(remaining)) : "Ready";
                el.style.color = remaining > 0 ? (el.dataset.activeColor || "#fff") : "#7fe18d";
            });
        };
        updateCountdown();
        state.cooldownCountdownTimer = setInterval(updateCountdown, 500);
    }

    function inventoryRowsExist() {
        const inventory = state.caches.inventory || getStoredInventory();
        return inventory && Array.isArray(inventory.rows) && inventory.rows.length > 0;
    }

    async function refreshAllSections(options = {}) {
        const { includeCompany = true, silent = false } = options;
        const apiKey = getStoredKey();
        debugLog("Full refresh initiated", { includeCompany, silent, apiKeyPresent: !!apiKey });
        if (!apiKey) {
            const status = document.getElementById("fetch-status-bar");
            if (status && !silent) status.innerText = "⚠️ Enter a Torn API key before refreshing.";
            return false;
        }

        const status = document.getElementById("fetch-status-bar");
        try {
            state.lastRefresh = Date.now();
            const [overview, personal, faction, activity] = await Promise.all([
                fetchOverviewData(apiKey),
                fetchPersonalData(apiKey),
                fetchFactionData(apiKey),
                fetchActivityData(apiKey)
            ]);

            setSectionCache("overview", overview || state.caches.overview);
            setSectionCache("personal", personal || state.caches.personal);
            setSectionCache("faction", faction || state.caches.faction);
            setSectionCache("activity", activity || state.caches.activity);

            if (includeCompany) {
                const company = await fetchCompanyData(apiKey);
                setSectionCache("company", company || state.caches.company);
            }

            const inventoryData = await fetchInventoryData(apiKey, status);
            setSectionCache("inventory", inventoryData || state.caches.inventory);
            state.lastRefreshBySection.all = Date.now();
            renderTabContent();

            if (!silent && status) {
                const activeStatus = state.sectionStatus.settings || "Ready";
                status.innerText = `Refresh complete. ${activeStatus}`;
            }
            debugLog("Full refresh complete", { sections: Object.keys(state.caches) });
            return true;
        } catch (error) {
            if (!silent && status) status.innerText = `Refresh failed: ${error.message}`;
            debugLog("Full refresh failed", { error: error.message });
            console.error("Refresh failed:", error);
            return false;
        }
    }

    function isCompanyUpdateDue(now = Date.now()) {
        const date = new Date(now);
        const isTargetTime = date.getUTCHours() === 18 && date.getUTCMinutes() === 8;
        if (!isTargetTime) return false;

        const lastUpdate = state.lastRefreshBySection.company || 0;
        const lastDate = new Date(lastUpdate);
        return !(lastUpdate && lastDate.getUTCFullYear() === date.getUTCFullYear() && lastDate.getUTCMonth() === date.getUTCMonth() && lastDate.getUTCDate() === date.getUTCDate());
    }

    function performAutoRefreshCycle() {
        const apiKey = getStoredKey();
        if (!apiKey) {
            debugLog("Auto refresh skipped: no API key");
            state.autoRefreshTimer = setTimeout(performAutoRefreshCycle, 60 * 1000);
            return;
        }

        const now = Date.now();
        const quickRefreshDue = ["overview", "personal", "faction", "inventory"].some((section) => {
            const last = state.lastRefreshBySection[section] || 0;
            return now - last >= QUICK_REFRESH_MS;
        });
        const logRefreshDue = isLogRefreshDue(now);
        const fullRefreshDue = now - (state.lastRefreshBySection.all || 0) >= AUTO_REFRESH_MS;
        const companyRefreshDue = isCompanyUpdateDue(now);

        debugLog("Auto refresh cycle", {
            quickRefreshDue,
            logRefreshDue,
            fullRefreshDue,
            companyRefreshDue,
            lastRefreshBySection: state.lastRefreshBySection
        });

        const tasks = [];

        if (companyRefreshDue) {
            tasks.push(
                fetchCompanyData(apiKey)
                    .then((company) => {
                        setSectionCache("company", company || state.caches.company);
                        renderTabContent();
                    })
                    .catch((error) => {
                        console.warn("Daily company refresh failed:", error);
                    })
            );
        }

        if (logRefreshDue) {
            tasks.push(
                fetchActivityData(apiKey)
                    .then((activity) => {
                        setSectionCache("activity", activity || state.caches.activity);
                        renderTabContent();
                    })
                    .catch((error) => {
                        console.warn("Log refresh failed:", error);
                    })
            );
        }

        if (fullRefreshDue || quickRefreshDue) {
            tasks.push(refreshAllSections({ includeCompany: false, silent: true }));
        }

        Promise.allSettled(tasks).finally(() => {
            state.autoRefreshTimer = setTimeout(performAutoRefreshCycle, 60 * 1000);
        });
    }

    function scheduleAutoRefresh() {
        if (state.autoRefreshTimer) {
            clearTimeout(state.autoRefreshTimer);
        }

        state.autoRefreshTimer = setTimeout(performAutoRefreshCycle, 60 * 1000);
    }

    function applyDashboardTheme() {
        const dashboard = state.dashboard;
        if (!dashboard) return;
        const isLight = state.theme === "light";
        dashboard.dataset.theme = isLight ? "light" : "dark";
        dashboard.style.backgroundColor = isLight ? "#f8fafc" : "rgba(24, 24, 24, 0.97)";
        dashboard.style.borderColor = isLight ? "#cbd5e1" : "#3b3b3b";
        dashboard.style.boxShadow = isLight ? "0 6px 22px rgba(15,23,42,0.18)" : "0 6px 22px rgba(0,0,0,0.6)";
    }

    function applyWidgetView() {
        const dashboard = state.dashboard;
        if (!dashboard) return;
        const widgetBody = dashboard.querySelector("#widget-main-body");
        const dragHandle = dashboard.querySelector("#widget-drag-handle");
        const title = dashboard.querySelector("#widget-title");
        const toggleBtn = dashboard.querySelector("#widget-toggle-view-btn");
        if (!widgetBody || !dragHandle || !title || !toggleBtn) return;

        if (state.isMinimized) {
            widgetBody.style.display = "none";
            dashboard.style.width = "48px";
            dashboard.style.maxHeight = "36px";
            dragHandle.style.padding = "0";
            dragHandle.style.height = "36px";
            dragHandle.style.justifyContent = "center";
            dragHandle.style.cursor = "move";
            title.textContent = "NTC";
            title.style.fontSize = "11px";
            title.style.letterSpacing = "0.06em";
            toggleBtn.style.display = "none";
            dashboard.title = "Naughty Torn Companion — click to restore";
        } else {
            widgetBody.style.display = "block";
            widgetBody.style.maxHeight = "calc(80vh - 37px)";
            widgetBody.style.overflowY = "auto";
            dashboard.style.width = "480px";
            dashboard.style.maxHeight = "80vh";
            dragHandle.style.padding = "8px 10px";
            dragHandle.style.height = "auto";
            dragHandle.style.justifyContent = "space-between";
            title.textContent = "🧭 Naughty Torn Companion";
            title.style.fontSize = "12px";
            title.style.letterSpacing = "normal";
            toggleBtn.style.display = "block";
            toggleBtn.innerText = "_";
            dashboard.title = "";
        }
    }

    function initializeDOMDashboard() {
        if (document.getElementById("torn-v2-inventory-wrapper")) return;

        debugLog("Initializing Torn Companion dashboard");
        const storedDashboardState = getStoredDashboardState();
        state.currentTab = storedDashboardState.currentTab || "overview";

        const dashboard = document.createElement("div");
        dashboard.id = "torn-v2-inventory-wrapper";
        dashboard.style.position = "fixed";
        dashboard.style.bottom = "20px";
        dashboard.style.right = "20px";
        dashboard.style.width = "480px";
        dashboard.style.maxHeight = "80vh";
        dashboard.style.backgroundColor = "rgba(24, 24, 24, 0.97)";
        dashboard.style.border = "1px solid #3b3b3b";
        dashboard.style.borderRadius = "8px";
        dashboard.style.zIndex = "999999";
        dashboard.style.boxShadow = "0 6px 22px rgba(0,0,0,0.6)";
        dashboard.style.fontFamily = "Arial, sans-serif";
        dashboard.style.overflow = "hidden";
        dashboard.style.display = "flex";
        dashboard.style.flexDirection = "column";

        const tabs = [
            { id: "overview", label: "Overview" },
            { id: "personal", label: "Personal" },
            { id: "faction", label: "Faction" },
            { id: "company", label: "Company" },
            { id: "inventory", label: "Inventory" },
            { id: "activity", label: "Activity" },
            { id: "settings", label: "Settings" }
        ];

        const navHtml = tabs.map((tab) => `
            <button data-tab="${tab.id}" class="torn-companion-tab" style="padding: 6px 8px; font-size: 10px; background: ${state.currentTab === tab.id ? '#3b5998' : '#2a2a2a'}; border: 1px solid #3d3d3d; color: #fff; border-radius: 4px; cursor: pointer; ${state.currentTab === tab.id ? 'font-weight: 700;' : ''};">${tab.label}</button>
        `).join("");

        dashboard.innerHTML = `
            <style>
                #torn-v2-inventory-wrapper[data-theme="light"] #widget-drag-handle {
                    background-color: #e2e8f0 !important;
                    border-bottom-color: #cbd5e1 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] #widget-main-body,
                #torn-v2-inventory-wrapper[data-theme="light"] #torn-companion-content {
                    color: #172033 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="rgba(20,20,20"],
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="rgba(255,255,255,0.02)"],
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="linear-gradient(180deg"] {
                    background: #ffffff !important;
                    border-color: #cbd5e1 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="background-color: #151515"],
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="background: #111"] {
                    background-color: #ffffff !important;
                    border-color: #cbd5e1 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="background-color: #252525"],
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="background-color: #2c2c2c"],
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="background: #2a2a2a"] {
                    background-color: #e2e8f0 !important;
                    border-color: #cbd5e1 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] .torn-companion-tab {
                    background: #e2e8f0 !important;
                    border-color: #cbd5e1 !important;
                    color: #172033 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] .torn-companion-tab[style*="#3b5998"] {
                    background: #3b5998 !important;
                    color: #ffffff !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] :not(button)[style*="color: #fff"],
                #torn-v2-inventory-wrapper[data-theme="light"] :not(button)[style*="color:#fff"] {
                    color: #172033 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="color: #aaa"],
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="color: #999"],
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="color: #888"],
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="color: #ccc"],
                #torn-v2-inventory-wrapper[data-theme="light"] [style*="color: #ddd"] {
                    color: #475569 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] input {
                    background: #ffffff !important;
                    border-color: #94a3b8 !important;
                    color: #172033 !important;
                }
            </style>
            <div id="widget-drag-handle" style="background-color: #2c2c2c; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; cursor: move; border-bottom: 1px solid #444; user-select: none;">
                <span id="widget-title" style="color: #fff; font-size: 12px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">🧭 Naughty Torn Companion</span>
                <button id="widget-toggle-view-btn" style="background-color: #444; color: #fff; border: none; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 11px;">_</button>
            </div>

            <div id="widget-main-body" style="padding: 10px; box-sizing: border-box; max-height: calc(80vh - 37px); overflow-y: auto; overflow-x: hidden;">
                <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px;">${navHtml}</div>
                <div id="torn-companion-content" style="display: grid; gap: 8px; color: #fff; font-size: 11px;"></div>
            </div>
        `;

        document.body.appendChild(dashboard);
        state.dashboard = dashboard;
        applyDashboardTheme();
        applyWidgetView();

        const savedPos = getStoredPosition();
        if (savedPos && typeof savedPos.top === "number") {
            const maxTop = Math.max(0, window.innerHeight - dashboard.offsetHeight);
            const clampedTop = Math.min(Math.max(savedPos.top, 0), maxTop);
            dashboard.style.bottom = "auto";
            dashboard.style.right = "20px";
            dashboard.style.left = "auto";
            dashboard.style.top = `${clampedTop}px`;
        }

        const toggleBtn = document.getElementById("widget-toggle-view-btn");
        toggleBtn.addEventListener("click", () => {
            state.isMinimized = !state.isMinimized;
            setStoredDashboardState({ isMinimized: state.isMinimized });
            applyWidgetView();
        });

        const dragHandle = document.getElementById("widget-drag-handle");
        let isDragging = false;
        let didDrag = false;
        let offsetY;

        dragHandle.addEventListener("mousedown", (e) => {
            if (e.target === toggleBtn) return;
            isDragging = true;
            didDrag = false;
            const rect = dashboard.getBoundingClientRect();
            offsetY = e.clientY - rect.top;
            dashboard.style.bottom = "auto";
            dashboard.style.right = "20px";
            dashboard.style.left = "auto";
            dashboard.style.top = `${rect.top}px`;
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            didDrag = true;
            const maxTop = Math.max(0, window.innerHeight - dashboard.offsetHeight);
            const top = Math.min(Math.max(e.clientY - offsetY, 0), maxTop);
            dashboard.style.top = `${top}px`;
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                const rect = dashboard.getBoundingClientRect();
                setStoredPosition({ top: rect.top });
            }
            isDragging = false;
        });

        dragHandle.addEventListener("click", () => {
            if (!state.isMinimized || didDrag) return;
            state.isMinimized = false;
            setStoredDashboardState({ isMinimized: false });
            applyWidgetView();
        });

        dashboard.querySelectorAll(".torn-companion-tab").forEach((button) => {
            button.addEventListener("click", () => {
                state.currentTab = button.getAttribute("data-tab");
                setStoredDashboardState({ currentTab: state.currentTab });
                renderTabContent();
                dashboard.querySelectorAll(".torn-companion-tab").forEach((tabButton) => {
                    const selected = tabButton.getAttribute("data-tab") === state.currentTab;
                    tabButton.style.background = selected ? '#3b5998' : '#2a2a2a';
                    tabButton.style.fontWeight = selected ? '700' : '400';
                });
            });
        });

        state.sectionStatus.settings = "Auto refresh: 5 min quick / 15 min full";
        renderTabContent();

        if (state.apiKey) {
            const hasAnyCache = Object.values(state.caches).some((cache) => cache !== null);
            if (!hasAnyCache) {
                // Fresh install / nothing restored from storage — do a full refresh.
                void refreshAllSections({ includeCompany: true, silent: true });
            } else {
                // Returning session — restored data is already showing; only refresh
                // whichever sections are actually stale per their own threshold.
                const staleSections = Object.keys(APP_STORAGE.sections).filter((name) => isSectionStale(name));
                debugLog("Startup staleness check", { staleSections });
                staleSections.forEach((name) => {
                    void refreshSectionByKey(name, null);
                });
            }
        }

        scheduleAutoRefresh();
    }

    async function bootstrap() {
        await loadPersistedState();
        initializeDOMDashboard();
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        void bootstrap();
    } else {
        window.addEventListener("DOMContentLoaded", () => { void bootstrap(); });
    }
})();
