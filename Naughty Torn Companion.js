// ==UserScript==
// @name         Naughty Torn Companion
// @namespace    https://github.com/xf4k31tx/Naughty-Torn-Companion
// @version      5.12.0
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
// @match        https://www.torn.com/jobs.php*
// @match        https://torn.com/jobs.php*
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
        isMinimized: false,
        apiKey: "",
        widgetPosition: null,
        dashboard: null,
        lastRefresh: null,
        autoRefreshTimer: null,
        chainCountdownTimer: null,
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
        isMinimized: state.isMinimized
    });
    const setStoredDashboardState = (payload) => {
        if (payload && payload.currentTab) state.currentTab = payload.currentTab;
        if (payload && payload.settingsSubTab) state.settingsSubTab = payload.settingsSubTab;
        if (payload && typeof payload.isMinimized === "boolean") state.isMinimized = payload.isMinimized;
        void gmSetValue(APP_STORAGE.dashboard, getStoredDashboardState());
    };

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

        const dashboardState = await gmGetValue(APP_STORAGE.dashboard, { currentTab: "overview" });
        state.currentTab = dashboardState.currentTab || "overview";
        state.settingsSubTab = dashboardState.settingsSubTab || state.settingsSubTab;
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
                fetchJson(withKey(`${BASE_URL}user/cooldowns`, apiKey)).catch(() => null),
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
                cooldowns: cooldownsResponse?.cooldowns || cooldownsResponse || {},
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
    function buildAwardSummary(catalogResponseRaw, earnedResponseRaw, itemLabel) {
        const catalogRaw = catalogResponseRaw || [];
        const catalog = {};
        (Array.isArray(catalogRaw) ? catalogRaw : []).forEach((entry) => {
            catalog[entry.id] = entry;
        });

        const earnedRaw = earnedResponseRaw || [];
        const earned = (Array.isArray(earnedRaw) ? earnedRaw : [])
            .map((entry) => {
                const info = catalog[entry.id] || {};
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
            totalAvailable: Array.isArray(catalogRaw) ? catalogRaw.length : 0,
            recent: earned.slice(0, 5),
            rarityBreakdown
        };
    }

    const AWARD_PROGRESS_TRACKS = [
        ...[10, 100, 1000, 10000, 100000].map((target, index) => ({ id: 380 + index, type: "medal", path: ["attacking", "attacks", "won"], target })),
        ...["theft", "counterfeiting", "vandalism", "fraud", "illicit_services", "cybercrime"].flatMap((crime, groupIndex) =>
            [10, 100, 500, 2000, 5000, 10000].map((target, index) => ({ id: 800 + (groupIndex * 6) + index, type: "medal", path: ["crimes", "offenses", crime], target }))
        ),
        ...[50, 250, 500, 1000].map((target, index) => ({ id: 52 + index, type: "honor", path: ["drugs", "xanax"], target })),
        ...[50, 250, 500, 1000, 2000].map((target, index) => ({ id: 12 + index, type: "honor", path: ["jail", "busts", "success"], target })),
        ...[10, 50, 250, 1000, 5000].map((target, index) => ({ id: 210 + index, type: "medal", path: ["hospital", "reviving", "revives"], target })),
        ...[10, 50, 250, 1000].map((target, index) => ({ id: 440 + index, type: "medal", path: ["missions", "missions"], target }))
    ];

    function getNestedNumber(value, path) {
        const result = path.reduce((current, key) => current && current[key], value);
        return Number(result || 0);
    }

    function buildAwardProgress(personalstats, medalsCatalogRaw, honorsCatalogRaw, userMedalsRaw, userHonorsRaw) {
        const medalCatalog = new Map((Array.isArray(medalsCatalogRaw) ? medalsCatalogRaw : []).map((item) => [Number(item.id), item]));
        const honorCatalog = new Map((Array.isArray(honorsCatalogRaw) ? honorsCatalogRaw : []).map((item) => [Number(item.id), item]));
        const earnedMedals = new Set((Array.isArray(userMedalsRaw) ? userMedalsRaw : []).map((item) => Number(item.id)));
        const earnedHonors = new Set((Array.isArray(userHonorsRaw) ? userHonorsRaw : []).map((item) => Number(item.id)));

        return AWARD_PROGRESS_TRACKS
            .filter((track) => !(track.type === "medal" ? earnedMedals : earnedHonors).has(track.id))
            .map((track) => {
                const catalog = track.type === "medal" ? medalCatalog : honorCatalog;
                const award = catalog.get(track.id);
                const current = getNestedNumber(personalstats, track.path);
                return {
                    name: award?.name || `${track.type === "medal" ? "Medal" : "Honor"} #${track.id}`,
                    type: track.type,
                    rarity: award?.rarity || "Unknown",
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
            const [profileResponse, skillsResponse, educationResponse, workstatsResponse, battlestatsResponse, perksResponse, jobResponse, moneyResponse, jobpointsResponse, medalsCatalogResponse, userMedalsResponse, honorsCatalogResponse, userHonorsResponse, personalstatsResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/profile`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/skills`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/education`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/workstats`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/battlestats`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/perks`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/job`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/money`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/jobpoints`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}torn/medals`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/medals`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}torn/honors`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/honors`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/personalstats`, apiKey)).catch(() => null)
            ]);

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
            const personalstats = personalstatsResponse?.personalstats || personalstatsResponse || {};
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

    // Reconstructs Torn's Chaining 2.0 respect formula so milestone chain hits (which
    // receive a hardcoded flat bonus on top of the normal formula) can be identified —
    // the API returns each attack's actual applied multipliers under `modifiers`, so no
    // guessing is needed there; only Base Respect (from target level) is derived.
    function computeBaseRespect(targetLevel) {
        const level = Number(targetLevel || 0);
        if (level <= 0) return 0;
        const raw = (Math.log(level) + 1.0) / 4.0;
        return Math.round(raw * 100) / 100;
    }

    function computeEstimatedRespect(attack) {
        const baseRespect = computeBaseRespect(attack.defender?.level);
        const mods = attack.modifiers || {};
        const multiplier = ["fair_fight", "war", "retaliation", "group", "overseas", "chain", "warlord"]
            .reduce((acc, key) => acc * Number(mods[key] ?? 1), 1);
        return baseRespect * multiplier;
    }

    function computeMilestoneBonus(attack) {
        const actual = Number(attack.respect_gain || 0);
        const estimated = computeEstimatedRespect(attack);
        const bonus = actual - estimated;
        // Filter out floating-point/rounding noise so only genuine flat bonuses count.
        return Math.abs(bonus) > 0.05 ? bonus : 0;
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
                fetchJson(withKey(`${BASE_URL}faction/chain`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/wars`, apiKey)).catch(() => null)
            ]);

            const userFactionData = userFactionResponse?.faction || userFactionResponse || {};
            const factionBasicData = factionBasicResponse?.basic || factionBasicResponse || {};
            const ownFactionId = Number(factionBasicData.id || userFactionData.id || userFactionData.faction_id || 0);

            const chainRaw = factionChainResponse?.chain || factionChainResponse || {};
            const chain = {
                current: Number(chainRaw.current || 0),
                max: Number(chainRaw.max || 0),
                timeout: Number(chainRaw.timeout || 0),
                cooldown: Number(chainRaw.cooldown || 0),
                modifier: Number(chainRaw.modifier || 0),
                start: Number(chainRaw.start || 0),
                end: Number(chainRaw.end || 0),
                fetchedAt: Date.now()
            };

            const warsData = factionWarsResponse?.wars || factionWarsResponse || {};
            const rankedWar = warsData.ranked || null;
            const rankedFactions = Array.isArray(rankedWar?.factions) ? rankedWar.factions : [];
            let war = null;
            if (rankedFactions.length >= 2) {
                const ownEntry = rankedFactions.find((entry) => Number(entry.id) === ownFactionId) || rankedFactions[0];
                const oppEntry = rankedFactions.find((entry) => Number(entry.id) !== ownFactionId) || rankedFactions[1];
                war = {
                    warId: Number(rankedWar.war_id || 0),
                    ownScore: Number(ownEntry.score || 0),
                    oppScore: Number(oppEntry.score || 0),
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
                            personalContribution.bonusScore += computeMilestoneBonus(atk);
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
            const result = {
                companyProfile: companyProfileResponse?.profile || companyProfileResponse || {},
                companyEmployees: companyEmployeesResponse?.employees || companyEmployeesResponse || [],
                companyNews: companyNewsResponse?.news || companyNewsResponse || [],
                companyStock: companyStockResponse?.stock || companyStockResponse || [],
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
            const [notificationsResponse, userLogResponse, eventsResponse, tradesResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/notifications`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/log`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/events`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/trades`, apiKey, { cat: "ongoing" })).catch(() => null)
            ]);
            const result = {
                notifications: notificationsResponse?.notifications || notificationsResponse || {},
                userLog: userLogResponse?.log || userLogResponse || {},
                events: eventsResponse?.events || eventsResponse || {},
                trades: tradesResponse?.trades || tradesResponse || []
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
                <div style="color: #aaa; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;">${escapeHtml(title)}</div>
                <div style="color: ${color}; font-size: 22px; font-weight: 700; line-height: 1.1;">${escapeHtml(displayValue)}</div>
                <div style="color: #8a8a8a; font-size: 10px; margin-top: 6px;">${escapeHtml(subtext)}</div>
            </div>
        `;
    }

    function renderCooldownsRow(cooldowns) {
        const drug = Number(cooldowns.drug || 0);
        const medical = Number(cooldowns.medical || 0);
        const booster = Number(cooldowns.booster || 0);

        if (!drug && !medical && !booster) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; color: #888; font-size: 11px;">No active cooldowns.</div>`;
        }

        const cell = (label, seconds, color) => `
            <div style="flex: 1; text-align: center;">
                <div style="color: #888; font-size: 10px; margin-bottom: 2px;">${label}</div>
                <div style="color: ${seconds > 0 ? color : "#555"}; font-size: 13px; font-weight: 700;">${seconds > 0 ? formatDuration(seconds) : "Ready"}</div>
            </div>
        `;

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; display: flex; gap: 6px;">
                ${cell("Drug", drug, "#e0a25e")}
                ${cell("Medical", medical, "#9dd8ff")}
                ${cell("Booster", booster, "#c9a0ff")}
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
        const energyCurrent = Number(bars.energy?.current ?? bars.energy ?? bars.current ?? 0);
        const energyMax = Number(bars.energy?.maximum ?? bars.max_energy ?? bars.maximum ?? 0);
        const nerveCurrent = Number(bars.nerve?.current ?? bars.nerve ?? 0);
        const nerveMax = Number(bars.nerve?.maximum ?? bars.max_nerve ?? 0);

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
            buildStatCard("Bars", `${energyCurrent}/${energyMax} energy`, `${nerveCurrent}/${nerveMax} nerve`),
            buildStatCard("Chain", chainDisplay, chainSubtext)
        ].join("");

        return `
            ${renderSectionMeta("overview", "Overview")}
            ${renderTravelCard(basic, travel)}
            ${renderCooldownsRow(cooldowns)}
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
                <span style="color: #999; font-size: 11px;">${escapeHtml(row.label)}</span>
                <span style="color: ${row.color || "#ddd"}; font-size: 11px; font-weight: 600;">${escapeHtml(String(row.value))}</span>
            </div>
        `).join("");
        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 6px;">${escapeHtml(title)}</div>
                ${rowsHtml}
            </div>
        `;
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
                <span style="color: #999; font-size: 11px; text-transform: capitalize;">${escapeHtml(String(skill.name || skill.slug || "Unknown").replace(/_/g, " "))}</span>
                <span style="color: #9dd8ff; font-size: 11px; font-weight: 600;">${Number(skill.level || 0).toFixed(2)}</span>
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

        const wealthBox = renderInfoBox("Wealth", [
            { label: "Wallet", value: formatMoney(wallet), color: "#7fe18d" },
            { label: "City Bank", value: formatMoney(cityBank), color: "#7fe18d" },
            { label: "Vault", value: formatMoney(vault), color: "#7fe18d" },
            { label: "Points", value: formatInteger(points), color: "#9dd8ff" }
        ]);

        const battleBox = renderInfoBox("Battle Stats", [
            { label: "Strength", value: formatInteger(battleStats.strength) },
            { label: "Defense", value: formatInteger(battleStats.defense) },
            { label: "Speed", value: formatInteger(battleStats.speed) },
            { label: "Dexterity", value: formatInteger(battleStats.dexterity) },
            { label: "Total", value: formatInteger(battleTotal), color: "#7fe18d" }
        ]);

        const workBox = renderInfoBox("Work Stats", [
            { label: "Manual Labor", value: formatInteger(workStats.manualLabor) },
            { label: "Endurance", value: formatInteger(workStats.endurance) },
            { label: "Intelligence", value: formatInteger(workStats.intelligence) },
            { label: "Total", value: formatInteger(workStats.total), color: "#7fe18d" }
        ]);

        return `
            ${renderSectionMeta("personal", "Personal")}
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px;">
                ${topCards}
            </div>
            ${wealthBox}
            ${battleBox}
            ${workBox}
            ${renderSkillsBox(skills)}
            ${renderEducationLine(education, currentCourseName)}
            ${renderPerksBox(perks)}
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; align-items: start;">
                ${renderAchievementsBox(personal.medals, personal.honors)}
                ${renderAwardProgressBox(personal.awardProgress)}
            </div>
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

        const scoreColor = war.ownScore >= war.oppScore ? "#7fe18d" : "#e05959";
        const targetPct = war.target > 0 ? Math.min(100, Math.round((Math.max(war.ownScore, war.oppScore) / war.target) * 100)) : 0;
        const targetBlock = war.target > 0 ? `
                <div style="width: 100%; height: 8px; background: #222; border-radius: 4px; overflow: hidden; margin-bottom: 4px;">
                    <div style="width: ${targetPct}%; height: 100%; background: ${scoreColor};"></div>
                </div>
                <div style="color: #888; font-size: 10px;">Target: ${formatInteger(war.target)}</div>
        ` : "";

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Ranked War vs ${escapeHtml(war.oppName)}</div>
                <div style="color: ${scoreColor}; font-size: 18px; font-weight: 700; margin-bottom: 6px;">${formatInteger(war.ownScore)} - ${formatInteger(war.oppScore)}</div>
                ${targetBlock}
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
                value: `${formatInteger(item.in_stock ?? item.quantity ?? 0)} in stock · ${formatMoney(Number(item.price || 0))}`
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

    function renderActivityPanel() {
        const activity = state.caches.activity || {};
        const notifications = activity.notifications || {};
        const log = activity.userLog || {};
        const events = activity.events || {};
        const trades = Array.isArray(activity.trades) ? activity.trades : [];

        const notificationLabels = {
            messages: "new messages",
            events: "new events",
            awards: "new awards",
            competition: "competition updates"
        };
        const notificationList = Object.entries(notificationLabels)
            .map(([key, label]) => ({ text: `${formatInteger(notifications[key])} ${label}` }))
            .filter((item) => !item.text.startsWith("0 "));

        const logList = Array.isArray(log) ? log.slice(0, 4).map((item) => ({
            text: item?.details?.title || item?.data?.text || item?.event || "Log update",
            timestamp: item?.timestamp,
            detail: item?.details?.category || ""
        })) : (Array.isArray(log.log) ? log.log.slice(0, 4).map((item) => ({
            text: item?.details?.title || item?.data?.text || item?.event || "Log update",
            timestamp: item?.timestamp,
            detail: item?.details?.category || ""
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

        if (state.currentTab === "faction") {
            startChainCountdownTimer();
        } else {
            stopChainCountdownTimer();
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
        state.chainCountdownTimer = setInterval(() => {
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
        }, 1000);
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
            <div id="widget-drag-handle" style="background-color: #2c2c2c; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; cursor: move; border-bottom: 1px solid #444; user-select: none;">
                <span id="widget-title" style="color: #fff; font-size: 12px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">🧭 Naughty Torn Companion</span>
                <button id="widget-toggle-view-btn" style="background-color: #444; color: #fff; border: none; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 11px;">_</button>
            </div>

            <div id="widget-main-body" style="padding: 10px;">
                <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px;">${navHtml}</div>
                <div id="torn-companion-content" style="display: grid; gap: 8px; color: #fff; font-size: 11px;"></div>
            </div>
        `;

        document.body.appendChild(dashboard);
        state.dashboard = dashboard;
        applyWidgetView();

        const savedPos = getStoredPosition();
        if (savedPos && typeof savedPos.left === "number" && typeof savedPos.top === "number") {
            const maxLeft = Math.max(0, window.innerWidth - dashboard.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - dashboard.offsetHeight);
            const clampedLeft = Math.min(Math.max(savedPos.left, 0), maxLeft);
            const clampedTop = Math.min(Math.max(savedPos.top, 0), maxTop);
            dashboard.style.bottom = "auto";
            dashboard.style.right = "auto";
            dashboard.style.left = `${clampedLeft}px`;
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
        let offsetX, offsetY;

        dragHandle.addEventListener("mousedown", (e) => {
            if (e.target === toggleBtn) return;
            isDragging = true;
            didDrag = false;
            offsetX = e.clientX - dashboard.getBoundingClientRect().left;
            offsetY = e.clientY - dashboard.getBoundingClientRect().top;
            dashboard.style.bottom = "auto";
            dashboard.style.right = "auto";
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            didDrag = true;
            dashboard.style.left = `${e.clientX - offsetX}px`;
            dashboard.style.top = `${e.clientY - offsetY}px`;
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                const rect = dashboard.getBoundingClientRect();
                setStoredPosition({ left: rect.left, top: rect.top });
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
