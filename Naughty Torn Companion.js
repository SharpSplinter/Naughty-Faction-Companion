// ==UserScript==
// @name         Naughty Torn Companion
// @namespace    https://github.com/xf4k31tx/Naughty-Torn-Companion
// @version      5.0.2
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
// @match        https://www.torn.com/bazaar.php*
// @match        https://torn.com/bazaar.php*
// @match        https://www.torn.com/forums.php*
// @match        https://torn.com/forums.php*
// @source       https://raw.githubusercontent.com/xf4k31tx/Naughty-Torn-Companion/refs/heads/main/Naughty%20Torn%20Companion.js
// @updateURL    https://raw.githubusercontent.com/xf4k31tx/Naughty-Torn-Companion/refs/heads/main/Naughty%20Torn%20Companion.js
// @downloadURL  https://raw.githubusercontent.com/xf4k31tx/Naughty-Torn-Companion/refs/heads/main/Naughty%20Torn%20Companion.js
// @grant        GM_xmlhttpRequest
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

    const APP_STORAGE = {
        key: "TORN_V2_USER_KEY",
        inventory: "TORN_V2_INVENTORY_DATA",
        position: "TORN_V2_WIDGET_POS",
        dashboard: "TORN_V2_DASHBOARD_STATE"
    };

    const AUTO_REFRESH_MS = 15 * 60 * 1000;
    const QUICK_REFRESH_MS = 5 * 60 * 1000;
    const LOG_REFRESH_MS = 2 * 60 * 1000;

    const state = {
        sortState: { key: "value", direction: "desc" },
        expandedCategories: new Set(),
        currentTab: "overview",
        settingsSubTab: "controls",
        dashboard: null,
        lastRefresh: null,
        autoRefreshTimer: null,
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

    const getStoredKey = () => localStorage.getItem(APP_STORAGE.key) || "";
    const setStoredKey = (key) => localStorage.setItem(APP_STORAGE.key, String(key || "").trim());

    const getStoredInventory = () => {
        try {
            const raw = localStorage.getItem(APP_STORAGE.inventory);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    };

    const setStoredInventory = (payload) => {
        localStorage.setItem(APP_STORAGE.inventory, JSON.stringify(payload));
    };

    const getStoredPosition = () => {
        try {
            const raw = localStorage.getItem(APP_STORAGE.position);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    };

    const setStoredPosition = (pos) => {
        localStorage.setItem(APP_STORAGE.position, JSON.stringify(pos));
    };

    const getStoredDashboardState = () => {
        try {
            const raw = localStorage.getItem(APP_STORAGE.dashboard);
            return raw ? JSON.parse(raw) : { currentTab: "overview" };
        } catch (e) { return { currentTab: "overview" }; }
    };

    const setStoredDashboardState = (payload) => {
        localStorage.setItem(APP_STORAGE.dashboard, JSON.stringify(payload));
    };

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

    async function fetchEquipmentBonusMap(apiKey) {
        try {
            const equipmentData = await fetchJson(withKey(`${BASE_URL}user/equipment`, apiKey)).catch(() => ({ equipment: [], clothing: [] }));
            const equipmentItems = Array.isArray(equipmentData.equipment) ? equipmentData.equipment : [];
            const bonusMap = {};

            equipmentItems.forEach((item) => {
                const itemId = item && item.id;
                const itemType = item && item.type;
                if (!itemId || !isRelevantBonusItemType(itemType)) return;

                const mods = Array.isArray(item.mods) ? item.mods : [];
                const modEntries = mods.map((mod) => {
                    if (typeof mod === "string") return mod;
                    if (mod && typeof mod === "object") {
                        const name = mod.name || mod.title;
                        const rawValue = mod.value ?? mod.amount ?? mod.percent ?? mod.bonus ?? mod.percentage;
                        if (!name) return "";
                        if (rawValue === undefined || rawValue === null || rawValue === "") return name;
                        const numericValue = Number(rawValue);
                        if (Number.isFinite(numericValue) && !String(name).includes("%")) {
                            return `${name} +${numericValue}%`;
                        }
                        return `${name} ${rawValue}`;
                    }
                    return "";
                }).filter(Boolean);

                if (modEntries.length > 0) {
                    bonusMap[itemId] = modEntries;
                }
            });

            return bonusMap;
        } catch (error) {
            console.warn("Equipment bonus lookup failed:", error);
            return {};
        }
    }

    function renderInventoryTable(tableBodyEl, rows) {
        tableBodyEl.innerHTML = "";

        if (!rows || rows.length === 0) {
            tableBodyEl.innerHTML = `<tr><td colspan="6" style="padding: 20px; text-align: center; color: #555; font-size: 11px;">No local synced data.</td></tr>`;
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
                <td style="padding: 4px; text-align: center; color: #9dd8ff; font-size: 10px;">${isLoanable ? (loanedCount > 0 ? `${loanedCount} 🔒` : "") : "—"}</td>
                <td style="padding: 4px; text-align: center; color: #888; font-size: 10px;">${isLoanable ? (loanedCount > 0 ? "Locked" : "Open") : "—"}</td>
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
                    ? `<input type="checkbox" disabled ${item.factionOwned ? "checked" : ""} style="accent-color: #4CAF50; cursor: default;" />`
                    : `<span style="color: #444; font-size: 11px;">—</span>`;
                const bonusText = item.bonusText || "";
                itemRow.innerHTML = `
                    <td style="padding: 4px 4px 4px 22px; color: #666; font-size: 10px;">↳</td>
                    <td style="padding: 4px; color: #ddd; font-size: 11px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(item.name)}</td>
                    <td style="padding: 4px; text-align: center; color: #999; font-size: 11px;">${item.quantity.toLocaleString()}</td>
                    <td style="padding: 4px; text-align: right; color: #6fa356; font-size: 11px;">${formatMoney(item.price)}</td>
                    <td style="padding: 4px; text-align: center; color: #9dd8ff; font-size: 10px;">${bonusText ? escapeHtml(bonusText) : "—"}</td>
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
            const itemBonusMap = await fetchEquipmentBonusMap(apiKey);
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
                        const bonusText = normalizeBonusText(itemBonusMap[item.id]);
                        totalCountOverall += quantity;
                        totalValueOverall += total;
                        collectedRows.push({ category, name, quantity, price: marketValue, total, factionOwned, bonusText });
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
            const [basicResponse, moneyResponse, networthResponse, barsResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/basic`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/money`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/networth`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/bars`, apiKey)).catch(() => null)
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
                company: companyResponse?.profile || companyResponse || {}
            };
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

    async function fetchPersonalData(apiKey) {
        setSectionStatus("personal", "Refreshing...");
        debugLog("Fetching personal data");
        try {
            const [profileResponse, skillsResponse, educationResponse, workstatsResponse, battlestatsResponse, perksResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/profile`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/skills`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/education`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/workstats`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/battlestats`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/perks`, apiKey)).catch(() => null)
            ]);
            const result = {
                profile: profileResponse?.profile || profileResponse || {},
                skills: skillsResponse?.skills || skillsResponse || {},
                education: educationResponse?.education || educationResponse || {},
                workstats: workstatsResponse?.workstats || workstatsResponse || {},
                battlestats: battlestatsResponse?.battlestats || battlestatsResponse || {},
                perks: perksResponse?.perks || perksResponse || {}
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

    async function fetchFactionData(apiKey) {
        setSectionStatus("faction", "Refreshing...");
        debugLog("Fetching faction data");
        try {
            const [userFactionResponse, factionBasicResponse, factionStatsResponse, factionMembersResponse, factionNewsResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/faction`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/basic`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/stats`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/members`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/news`, apiKey)).catch(() => null)
            ]);
            const result = {
                userFaction: userFactionResponse?.faction || userFactionResponse || {},
                factionBasic: factionBasicResponse?.basic || factionBasicResponse || {},
                factionStats: factionStatsResponse?.stats || factionStatsResponse || [],
                factionMembers: factionMembersResponse?.members || factionMembersResponse || [],
                factionNews: factionNewsResponse?.news || factionNewsResponse || []
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
            const [companyProfileResponse, companyEmployeesResponse, companyNewsResponse, companyStockResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}company/profile`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}company/employees`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}company/news`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}company/stock`, apiKey)).catch(() => null)
            ]);
            const result = {
                companyProfile: companyProfileResponse?.profile || companyProfileResponse || {},
                companyEmployees: companyEmployeesResponse?.employees || companyEmployeesResponse || [],
                companyNews: companyNewsResponse?.news || companyNewsResponse || [],
                companyStock: companyStockResponse?.stock || companyStockResponse || []
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
            const [notificationsResponse, userLogResponse, eventsResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/notifications`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/log`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/events`, apiKey)).catch(() => null)
            ]);
            const result = {
                notifications: notificationsResponse?.notifications || notificationsResponse || {},
                userLog: userLogResponse?.log || userLogResponse || {},
                events: eventsResponse?.events || eventsResponse || {}
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

        const summaryCards = [
            buildStatCard("Player", playerName, `Level ${level}`),
            buildStatCard("Cash", formatMoney(cash), "Current money"),
            buildStatCard("Net Worth", formatMoney(net), "Estimated total"),
            buildStatCard("Faction", factionName, "Current faction"),
            buildStatCard("Company", companyName, "Current company"),
            buildStatCard("Bars", `${energyCurrent}/${energyMax} energy`, `${nerveCurrent}/${nerveMax} nerve`)
        ].join("");

        return `
            ${renderSectionMeta("overview", "Overview")}
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

    function renderPersonalPanel() {
        const personal = state.caches.personal || {};
        const profile = personal.profile || {};
        const skills = personal.skills || {};
        const education = personal.education || {};
        const workstats = personal.workstats || {};
        const battlestats = personal.battlestats || {};
        const perks = personal.perks || {};

        const battleTotal = Number(battlestats.total ?? 0);
        const battleStats = {
            strength: Number(battlestats.strength?.value ?? battlestats.strength ?? 0),
            defense: Number(battlestats.defense?.value ?? battlestats.defense ?? 0),
            speed: Number(battlestats.speed?.value ?? battlestats.speed ?? 0),
            dexterity: Number(battlestats.dexterity?.value ?? battlestats.dexterity ?? 0)
        };
        const educationTotal = (Array.isArray(education.complete) ? education.complete.length : 0) + (education.current ? 1 : 0);
        const workStats = {
            manualLabor: Number(workstats.manual_labor ?? 0),
            endurance: Number(workstats.endurance ?? 0),
            intelligence: Number(workstats.intelligence ?? 0),
            total: Number(workstats.total ?? 0)
        };

        const cards = [
            buildStatCard("Player", profile.name || "Unknown", `Level ${profile.level || "-"}`),
            buildStatCard("Strength", battleStats.strength, "Strength battle stat"),
            buildStatCard("Speed", battleStats.speed, "Speed battle stat"),
            buildStatCard("Defense", battleStats.defense, "Defense battle stat"),
            buildStatCard("Dexterity", battleStats.dexterity, "Dexterity battle stat"),
            buildStatCard("Total Battle Stats", battleTotal, "Overall battle stat total"),
            buildStatCard("Skills", Object.keys(skills || {}).length || 0, "Tracked skill entries"),
            buildStatCard("Education", educationTotal, "Completed + active educations"),
            buildStatCard("Manual Labor", workStats.manualLabor, "Manual labor"),
            buildStatCard("Endurance", workStats.endurance, "Endurance"),
            buildStatCard("Intelligence", workStats.intelligence, "Intelligence"),
            buildStatCard("Total Work Stats", workStats.total, "Overall work stats"),
            buildStatCard("Perks", Object.keys(perks || {}).length || 0, "Perk entries")
        ].join("");

        return `
            ${renderSectionMeta("personal", "Personal")}
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
                ${cards}
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

        return `
            ${renderSectionMeta("faction", "Faction")}
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px;">
                ${cards}
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
        const companyEmployees = profile.employees || {};

        const currentRoster = Number(companyEmployees.hired ?? employees.length ?? 0);
        const maxRoster = Number(companyEmployees.capacity ?? 0);
        const stockTotal = stock.reduce((sum, item) => sum + Number(item.in_stock ?? item.quantity ?? 0), 0);
        const cards = [
            buildStatCard("Company", profile.name || "Unknown", `ID ${profile.id || "-"}`),
            buildStatCard("Employees", `${formatInteger(currentRoster)} / ${formatInteger(maxRoster)}`, "Current roster / max roster"),
            buildStatCard("Stock", stockTotal, "Total stock quantity"),
            buildStatCard("News", rawNews.length, "Recent news entries")
        ].join("");

        return `
            ${renderSectionMeta("company", "Company")}
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
                ${cards}
            </div>
        `;
    }

    function renderActivityPanel() {
        const activity = state.caches.activity || {};
        const notifications = activity.notifications || {};
        const log = activity.userLog || {};
        const events = activity.events || {};

        const notificationCounts = notifications && typeof notifications === "object" ? notifications : {};
        const notificationList = Object.entries(notificationCounts)
            .filter(([key, value]) => key !== "_metadata" && value !== undefined && value !== null)
            .slice(0, 4)
            .map(([key, value]) => ({ title: key, text: `${key}: ${value}` }));

        const logList = Array.isArray(log) ? log.slice(0, 4).map((item) => ({
            text: item?.details?.title || item?.data?.text || item?.event || "Log update"
        })) : (Array.isArray(log.log) ? log.log.slice(0, 4).map((item) => ({
            text: item?.details?.title || item?.data?.text || item?.event || "Log update"
        })) : []);

        const eventList = Array.isArray(events) ? events.slice(0, 4).map((item) => ({
            text: item?.event || item?.text || item?.title || "Event update"
        })) : (Array.isArray(events.events) ? events.events.slice(0, 4).map((item) => ({
            text: item?.event || item?.text || item?.title || "Event update"
        })) : []);

        const lists = [
            renderStreamList("Notifications", notificationList),
            renderStreamList("Recent Log", logList),
            renderStreamList("Events", eventList)
        ].join("");

        return `${renderSectionMeta("activity", "Activity")}<div style="display: grid; gap: 8px;">${lists}</div>`;
    }

    function renderStreamList(title, items) {
        const safeItems = Array.isArray(items) ? items : [];
        const rows = safeItems.length ? safeItems.map((item) => {
            const text = item?.text || item?.message || item?.event || item?.title || item?.details?.title || "Unknown update";
            return `<div style="padding: 8px 10px; border: 1px solid #2d2d2d; border-radius: 6px; background: rgba(255,255,255,0.02); color: #ddd; font-size: 11px;">${escapeHtml(text)}</div>`;
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
                    state.caches.overview = await fetchOverviewData(apiKey) || state.caches.overview;
                    break;
                case "personal":
                    state.caches.personal = await fetchPersonalData(apiKey) || state.caches.personal;
                    break;
                case "faction":
                    state.caches.faction = await fetchFactionData(apiKey) || state.caches.faction;
                    break;
                case "company":
                    state.caches.company = await fetchCompanyData(apiKey) || state.caches.company;
                    break;
                case "inventory":
                    state.caches.inventory = await fetchInventoryData(apiKey, statusEl) || state.caches.inventory;
                    break;
                case "activity":
                    state.caches.activity = await fetchActivityData(apiKey) || state.caches.activity;
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
                                <th style="padding: 4px; text-align: center;">Loaned</th>
                            </tr>
                        </thead>
                        <tbody id="inventory-table-body" style="color: #ccc;">
                            <tr><td colspan="6" style="padding: 20px; text-align: center; color: #555; font-size: 11px;">No local synced data.</td></tr>
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

            state.caches.overview = overview || state.caches.overview;
            state.caches.personal = personal || state.caches.personal;
            state.caches.faction = faction || state.caches.faction;
            state.caches.activity = activity || state.caches.activity;

            if (includeCompany) {
                const company = await fetchCompanyData(apiKey);
                state.caches.company = company || state.caches.company;
            }

            const inventoryData = await fetchInventoryData(apiKey, status);
            state.caches.inventory = inventoryData || state.caches.inventory;
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
                        state.caches.company = company || state.caches.company;
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
                        state.caches.activity = activity || state.caches.activity;
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
                <span style="color: #fff; font-size: 12px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">🧭 Naughty Torn Companion</span>
                <button id="widget-toggle-view-btn" style="background-color: #444; color: #fff; border: none; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 11px;">_</button>
            </div>

            <div id="widget-main-body" style="padding: 10px;">
                <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px;">${navHtml}</div>
                <div id="torn-companion-content" style="display: grid; gap: 8px; color: #fff; font-size: 11px;"></div>
            </div>
        `;

        document.body.appendChild(dashboard);

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

        const widgetBody = document.getElementById("widget-main-body");
        const toggleBtn = document.getElementById("widget-toggle-view-btn");
        toggleBtn.addEventListener("click", () => {
            if (widgetBody.style.display === "none") {
                widgetBody.style.display = "block";
                toggleBtn.innerText = "_";
                dashboard.style.width = "480px";
            } else {
                widgetBody.style.display = "none";
                toggleBtn.innerText = "▢";
                dashboard.style.width = "160px";
            }
        });

        const dragHandle = document.getElementById("widget-drag-handle");
        let isDragging = false;
        let offsetX, offsetY;

        dragHandle.addEventListener("mousedown", (e) => {
            if (e.target === toggleBtn) return;
            isDragging = true;
            offsetX = e.clientX - dashboard.getBoundingClientRect().left;
            offsetY = e.clientY - dashboard.getBoundingClientRect().top;
            dashboard.style.bottom = "auto";
            dashboard.style.right = "auto";
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
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

        const storedInventory = getStoredInventory();
        if (storedInventory && Array.isArray(storedInventory.rows) && storedInventory.rows.length > 0) {
            state.caches.inventory = storedInventory;
        }

        state.sectionStatus.settings = "Auto refresh: 5 min quick / 15 min full";
        renderTabContent();

        if (getStoredKey()) {
            void refreshAllSections({ includeCompany: true, silent: true });
        }

        scheduleAutoRefresh();
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        initializeDOMDashboard();
    } else {
        window.addEventListener("DOMContentLoaded", initializeDOMDashboard);
    }
})();