// ==UserScript==
// @name         Naughty Torn Companion
// @namespace    https://github.com/xf4k31tx/Naughty-Torn-Companion
// @version      5.22.15
// @description  One-stop Torn dashboard for personal, faction, company, and inventory tracking.
// @author       sharpsplinter [315311]
// @match        https://www.torn.com/*
// @source       https://raw.githubusercontent.com/xf4k31tx/Naughty-Torn-Companion/refs/heads/main/Naughty%20Torn%20Companion.user.js
// @updateURL    https://raw.githubusercontent.com/xf4k31tx/Naughty-Torn-Companion/refs/heads/main/Naughty%20Torn%20Companion.user.js
// @downloadURL  https://raw.githubusercontent.com/xf4k31tx/Naughty-Torn-Companion/refs/heads/main/Naughty%20Torn%20Companion.user.js
// @grant        GM_xmlhttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// @connect      api.torn.com
// @connect      ffscouter.com
// ==/UserScript==

(function() {
    'use strict';

    // Kept in sync with the @version header above on every bump — displayed in the
    // widget title bar so a screenshot alone can confirm which build is actually
    // running on a device, without relying on console access.
    const SCRIPT_VERSION = "5.22.15";

    const BASE_URL = "https://api.torn.com/v2/";
    const TORN_V1_BASE_URL = "https://api.torn.com/";
    const FFSCOUTER_BASE_URL = "https://ffscouter.com/api/v1";
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

    // --- Device / environment detection ---
    // IS_TORN_PDA: the Torn PDA app injects window.flutter_inappwebview as the bridge
    // to its native GM/HTTP shims (see GMforPDA.user.js) — its presence is a reliable
    // PDA signal regardless of viewport size (PDA also runs on tablets).
    const IS_TORN_PDA = typeof window.flutter_inappwebview !== "undefined";
    const IS_TOUCH_DEVICE = ("ontouchstart" in window) || (Number(navigator.maxTouchPoints) > 0);
    const MOBILE_VIEWPORT_BREAKPOINT = 700;
    function isMobileViewport() {
        return window.innerWidth <= MOBILE_VIEWPORT_BREAKPOINT;
    }
    // Used only to pick sensible FIRST-RUN defaults (minimized + corner snap).
    // Deliberately narrower than the responsive-layout check below: a desktop user
    // who just has a narrow browser window shouldn't get treated as "on mobile".
    function isMobileEnvironment() {
        return IS_TORN_PDA || (IS_TOUCH_DEVICE && isMobileViewport());
    }
    // Estimated height of Torn's own top icon row (search/scouter/clock/messages/avatar)
    // plus any browser chrome above it, so the widget doesn't open overlapping it. This is
    // an estimate, not a measurement — Torn's page doesn't have a script-accessible stable
    // selector we can measure reliably, so if it doesn't clear the icon row cleanly on a
    // given device/zoom level, adjust this constant.
    const MOBILE_TOP_OFFSET_PX = 60;

    // Logged on every boot — useful for confirming which environment was detected
    // when live-testing inside Torn PDA or a mobile browser.
    // Check the browser/userscript console (or Torn PDA's in-app log) for this line.
    const _envDebug = () => debugLog("[NTC] Environment detection", {
        IS_TORN_PDA,
        IS_TOUCH_DEVICE,
        viewportWidth: window.innerWidth,
        isMobileViewport: isMobileViewport(),
        isMobileEnvironment: isMobileEnvironment(),
        userAgent: navigator.userAgent
    });
    // debugLog is defined further down the script — defer so it's available at call time.
    setTimeout(_envDebug, 0);

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
        ffscouterKey: "TORN_V2_FFSCOUTER_KEY",
        position: "TORN_V2_WIDGET_POS",
        dashboard: "TORN_V2_DASHBOARD_STATE",
        companyStockHistory: "TORN_V2_COMPANY_STOCK_HISTORY",
        networthTracking: "TORN_V2_NETWORTH_TRACKING",
        migrated: "TORN_V2_GM_MIGRATED_V1",
        sections: {
            overview: "TORN_V2_CACHE_OVERVIEW",
            personal: "TORN_V2_CACHE_PERSONAL",
            faction: "TORN_V2_CACHE_FACTION",
            company: "TORN_V2_CACHE_COMPANY",
            inventory: "TORN_V2_CACHE_INVENTORY"
        }
    };

    const AUTO_REFRESH_MS = 15 * 60 * 1000;
    const QUICK_REFRESH_MS = 5 * 60 * 1000;

    // Staleness thresholds checked ONLY when restoring a section's cache at dashboard
    // init (i.e. "is this cached data too old to show without refreshing first?").
    // This is separate from the ongoing periodic auto-refresh cadence above.
    // Auto-refreshable tabs are Overview, Personal (Info sub-tab only), and Faction.
    // "company" is intentionally absent — it updates once daily at a fixed UTC time
    // instead (see isCompanyUpdateDue), not a rolling staleness duration. "inventory"
    // is manual-refresh-only; a player knows when their own inventory changes, so it
    // never needs a background/staleness-triggered fetch. The Activity tab has been
    // removed entirely (redundant with Torn's own built-in notifications).
    const SECTION_STALENESS_MS = {
        overview: QUICK_REFRESH_MS,   // 5 min
        personal: QUICK_REFRESH_MS,   // 5 min
        faction: QUICK_REFRESH_MS     // 5 min
    };

    const WAR_TARGET_FILTER_DEFAULTS = {
        okay: true,
        hospitalized: true,
        traveling: true,
        online: true,
        idle: true,
        offline: true
    };

    const state = {
        sortState: { key: "value", direction: "desc" },
        warTargetSort: { key: "status", direction: "asc" },
        warTargetFilters: { ...WAR_TARGET_FILTER_DEFAULTS },
        warTargetFFRange: { min: "", max: "" },
        warTargetColumnOrder: ["player", "online", "status", "stats", "ff", "attack"],
        warTargetColumnWidths: { player: 112, online: 64, status: 150, stats: 82, ff: 44, attack: 62 },
        warTargetColumnLayoutVersion: 2,
        expandedCategories: new Set(),
        currentTab: "overview",
        overviewSubTab: "general",
        factionSubTab: "general",
        settingsSubTab: "controls",
        personalSubTab: "info",
        theme: "dark",
        isMinimized: false,
        windowSizes: {},
        companyStockHistory: {},
        networthTracking: { official: null, history: [] },
        apiKey: "",
        ffscouterKey: "",
        ffscouterStatus: "Not configured",
        widgetPosition: null,
        dashboard: null,
        lastRefresh: null,
        autoRefreshTimer: null,
        chainCountdownTimer: null,
        cooldownCountdownTimer: null,
        factionLiveRefreshTimer: null,
        warTargetsRefreshTimer: null,
        warTargetsRefreshInFlight: false,
        lastRefreshBySection: {
            overview: 0,
            personal: 0,
            faction: 0,
            company: 0,
            inventory: 0,
            all: 0
        },
        sectionStatus: {
            overview: "Not loaded",
            personal: "Not loaded",
            faction: "Not loaded",
            company: "Not loaded",
            inventory: "Not loaded",
            settings: "Ready"
        },
        caches: {
            overview: null,
            personal: null,
            faction: null,
            company: null,
            inventory: null
        }
    };

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const formatMoney = (num) => num ? '$' + Number(num).toLocaleString() : '$0';
    const formatSignedMoney = (num) => {
        const value = Number(num || 0);
        const sign = value > 0 ? "+" : value < 0 ? "−" : "";
        return `${sign}$${Math.abs(value).toLocaleString()}`;
    };
    const formatInteger = (num) => {
        const value = Number(num ?? 0);
        if (!Number.isFinite(value)) return "0";
        return Math.round(value).toLocaleString();
    };
    const formatDuration = (totalSeconds) => {
        const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
        if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
        if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
        return `${s}s`;
    };
    const formatDate = (unixSeconds) => {
        const seconds = Number(unixSeconds || 0);
        if (!seconds) return "";
        return new Date(seconds * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    };
    const formatUtcDateTime = (unixSeconds) => {
        const seconds = Number(unixSeconds || 0);
        if (!Number.isFinite(seconds) || seconds <= 0) return "Unknown UTC time";
        return `${new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000Z", "")} UTC`;
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

    const getStoredFFScouterKey = () => state.ffscouterKey || "";
    const setStoredFFScouterKey = (key) => {
        state.ffscouterKey = String(key || "").trim();
        state.ffscouterStatus = state.ffscouterKey ? "Saved · Not verified" : "Not configured";
        void gmSetValue(APP_STORAGE.ffscouterKey, state.ffscouterKey);
    };

    const getStoredPosition = () => state.widgetPosition || null;
    const setStoredPosition = (pos) => {
        state.widgetPosition = pos;
        void gmSetValue(APP_STORAGE.position, pos);
    };

    const getStoredDashboardState = () => ({
        currentTab: state.currentTab,
        overviewSubTab: state.overviewSubTab,
        factionSubTab: state.factionSubTab,
        settingsSubTab: state.settingsSubTab,
        personalSubTab: state.personalSubTab,
        theme: state.theme,
        isMinimized: state.isMinimized,
        windowSizes: state.windowSizes,
        warTargetColumnOrder: state.warTargetColumnOrder,
        warTargetColumnWidths: state.warTargetColumnWidths,
        warTargetColumnLayoutVersion: state.warTargetColumnLayoutVersion,
        warTargetFilters: state.warTargetFilters,
        warTargetFFRange: state.warTargetFFRange,
        warTargetSort: state.warTargetSort
    });
    const setStoredDashboardState = (payload) => {
        if (payload && payload.currentTab) state.currentTab = payload.currentTab;
        if (payload && payload.overviewSubTab) state.overviewSubTab = payload.overviewSubTab;
        if (payload && payload.factionSubTab) state.factionSubTab = payload.factionSubTab;
        if (payload && payload.settingsSubTab) state.settingsSubTab = payload.settingsSubTab;
        if (payload && payload.personalSubTab) state.personalSubTab = payload.personalSubTab;
        if (payload && ["light", "dark"].includes(payload.theme)) state.theme = payload.theme;
        if (payload && typeof payload.isMinimized === "boolean") state.isMinimized = payload.isMinimized;
        if (payload && payload.windowSizes && typeof payload.windowSizes === "object") state.windowSizes = payload.windowSizes;
        if (payload && Array.isArray(payload.warTargetColumnOrder)) state.warTargetColumnOrder = payload.warTargetColumnOrder;
        if (payload && payload.warTargetColumnWidths && typeof payload.warTargetColumnWidths === "object") state.warTargetColumnWidths = payload.warTargetColumnWidths;
        if (payload && payload.warTargetFilters && typeof payload.warTargetFilters === "object") {
            state.warTargetFilters = Object.fromEntries(Object.keys(WAR_TARGET_FILTER_DEFAULTS).map((key) => [
                key,
                typeof payload.warTargetFilters[key] === "boolean" ? payload.warTargetFilters[key] : true
            ]));
        }
        if (payload && payload.warTargetFFRange && typeof payload.warTargetFFRange === "object") {
            state.warTargetFFRange = {
                min: String(payload.warTargetFFRange.min ?? ""),
                max: String(payload.warTargetFFRange.max ?? "")
            };
        }
        if (payload && payload.warTargetSort && typeof payload.warTargetSort === "object") {
            const allowedSortKeys = ["player", "online", "status", "stats", "ff", "attack"];
            state.warTargetSort = {
                key: allowedSortKeys.includes(payload.warTargetSort.key) ? payload.warTargetSort.key : "status",
                direction: payload.warTargetSort.direction === "desc" ? "desc" : "asc"
            };
        }
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

    function readOfficialTornNetworth() {
        const root = document.querySelector('li[aria-label^="Networth:"]');
        if (!root || root.closest("#torn-v2-inventory-wrapper")) return 0;
        const source = root.getAttribute("aria-label") || root.textContent || "";
        const match = source.match(/Networth:\s*\$?([\d,]+)/i);
        return match ? Number(match[1].replace(/,/g, "")) : 0;
    }

    function createNetworthSnapshot(networth) {
        const money = networth?.money || {};
        const items = networth?.items || {};
        const assets = networth?.assets || {};
        const values = {
            "Cash (Wallet and Vault)": Number(money.wallet || 0) + Number(money.vault || 0),
            "Pending": Number(money.pending || 0),
            "City Bank": Number(money.city_bank || 0),
            "Cayman Bank": Number(money.cayman_bank || 0),
            "Bookie": Number(money.bookie || 0),
            "Piggy Bank": Number(money.piggy_bank || 0),
            "Loans": Number(money.loans || 0),
            "Unpaid Fees": Number(money.unpaid_fees || 0),
            "Items": Number(items.inventory || 0),
            "Display Case": Number(items.display_case || 0),
            "Bazaar": Number(items.bazaar || 0),
            "Trades": Number(items.trades || 0),
            "Item Market": Number(items.item_market || 0),
            "Auction House": Number(items.auction_house || 0),
            "Enlisted Cars": Number(items.enlisted_cars || 0),
            "Property": Number(assets.property || 0),
            "Stock Market": Number(assets.stock_market || 0),
            "Company": Number(assets.company || 0),
            "Points": Number(networth?.points || 0)
        };
        return {
            total: Number(networth?.total || 0),
            timestamp: Number(networth?.timestamp || 0),
            capturedAt: Math.floor(Date.now() / 1000),
            values
        };
    }

    function updateNetworthTracking(networth, dailyNetworth = 0) {
        const live = createNetworthSnapshot(networth);
        if (!live.total) return null;

        const now = Math.floor(Date.now() / 1000);
        const tracking = state.networthTracking && typeof state.networthTracking === "object"
            ? state.networthTracking
            : { official: null, history: [] };
        const history = Array.isArray(tracking.history) ? tracking.history.slice(-575) : [];
        const latest = history[history.length - 1];
        const valuesChanged = !latest || JSON.stringify(latest.values || {}) !== JSON.stringify(live.values);
        if (!latest || latest.total !== live.total || valuesChanged) history.push(live);

        const officialTotal = Number(dailyNetworth || 0) || readOfficialTornNetworth();
        let official = tracking.official || null;
        if (officialTotal > 0) {
            if (!official || Number(official.total) !== officialTotal) {
                official = { total: officialTotal, observedAt: now, snapshot: null };
            }
            if (!official.snapshot) {
                official.snapshot = [...history].reverse().find((snapshot) => Number(snapshot.total) === officialTotal) || null;
            }
        }

        state.networthTracking = { official, history };
        void gmSetValue(APP_STORAGE.networthTracking, state.networthTracking);

        const baselineValues = official?.snapshot?.values || null;
        const changes = baselineValues
            ? Object.fromEntries(Object.entries(live.values).map(([label, value]) => [label, value - Number(baselineValues[label] || 0)]))
            : null;
        return {
            live,
            official,
            totalChange: official ? live.total - Number(official.total || 0) : null,
            changes
        };
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
    // "company" uses its own day-boundary logic (isCompanyUpdateDue, fires once daily
    // at 18:10 UTC via the periodic auto-refresh cycle) rather than a rolling
    // staleness duration, so it's excluded here to avoid double-triggering.
    // "inventory" is manual-only — see SECTION_STALENESS_MS.
    function isSectionStale(name, now = Date.now()) {
        if (name === "company") return false;
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
        state.ffscouterKey = (await gmGetValue(APP_STORAGE.ffscouterKey, "")) || "";
        state.ffscouterStatus = state.ffscouterKey ? "Saved · Not verified" : "Not configured";
        state.widgetPosition = await gmGetValue(APP_STORAGE.position, null);
        state.companyStockHistory = await gmGetValue(APP_STORAGE.companyStockHistory, {}) || {};
        state.networthTracking = await gmGetValue(APP_STORAGE.networthTracking, { official: null, history: [] }) || { official: null, history: [] };

        const dashboardState = await gmGetValue(APP_STORAGE.dashboard, { currentTab: "overview" });
        state.currentTab = dashboardState.currentTab || "overview";
        state.overviewSubTab = dashboardState.overviewSubTab || state.overviewSubTab;
        state.factionSubTab = dashboardState.factionSubTab || state.factionSubTab;
        state.settingsSubTab = dashboardState.settingsSubTab || state.settingsSubTab;
        state.personalSubTab = dashboardState.personalSubTab || state.personalSubTab;
        state.theme = ["light", "dark"].includes(dashboardState.theme) ? dashboardState.theme : state.theme;
        state.isMinimized = dashboardState.isMinimized === true;
        state.windowSizes = dashboardState.windowSizes && typeof dashboardState.windowSizes === "object"
            ? dashboardState.windowSizes
            : {};

        // First-run default for mobile/Torn PDA: start minimized and snapped to the
        // top-right corner, rather than opening full-size over the page content.
        // Only applies when nothing has ever been saved before (a genuine first run) —
        // once a user has moved/resized/expanded the widget, their choice is respected
        // on every later load regardless of device.
        const isFirstEverRun = state.widgetPosition === null && dashboardState.isMinimized === undefined;
        if (isFirstEverRun && isMobileEnvironment()) {
            state.isMinimized = true;
            // edge:"right" + y:MOBILE_TOP_OFFSET_PX pins the widget to the top-right,
            // just below Torn's own top icon row — applyWidgetPosition() sets
            // style.right="0" and style.top=`${MOBILE_TOP_OFFSET_PX}px` for this combo.
            // Combined with normalizeWidgetSize()'s mobile-default full width, this also
            // makes the widget span (near) edge-to-edge once expanded, not just the
            // collapsed pill.
            state.widgetPosition = { edge: "right", x: null, y: MOBILE_TOP_OFFSET_PX };
        }

        const warTargetColumns = ["player", "online", "status", "stats", "ff", "attack"];
        const savedWarTargetOrder = Array.isArray(dashboardState.warTargetColumnOrder)
            ? [...new Set(dashboardState.warTargetColumnOrder.map((key) => key === "health" ? "status" : key).filter((key) => key !== "location"))]
            : [];
        state.warTargetColumnOrder = savedWarTargetOrder.length === warTargetColumns.length
            && warTargetColumns.every((key) => savedWarTargetOrder.includes(key))
            ? savedWarTargetOrder
            : warTargetColumns;
        state.warTargetColumnWidths = dashboardState.warTargetColumnLayoutVersion === state.warTargetColumnLayoutVersion
            && dashboardState.warTargetColumnWidths && typeof dashboardState.warTargetColumnWidths === "object"
            ? { ...state.warTargetColumnWidths, ...dashboardState.warTargetColumnWidths }
            : state.warTargetColumnWidths;
        state.warTargetFilters = Object.fromEntries(Object.keys(WAR_TARGET_FILTER_DEFAULTS).map((key) => [
            key,
            typeof dashboardState.warTargetFilters?.[key] === "boolean" ? dashboardState.warTargetFilters[key] : true
        ]));
        state.warTargetFFRange = {
            min: String(dashboardState.warTargetFFRange?.min ?? ""),
            max: String(dashboardState.warTargetFFRange?.max ?? "")
        };
        const savedWarTargetSort = dashboardState.warTargetSort || {};
        state.warTargetSort = {
            key: warTargetColumns.includes(savedWarTargetSort.key) ? savedWarTargetSort.key : "status",
            direction: savedWarTargetSort.direction === "desc" ? "desc" : "asc"
        };

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
            hasFFScouterKey: !!state.ffscouterKey,
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

    function parseFFScouterRateLimits(rawHeaders) {
        const headers = new Map();
        String(rawHeaders || "").split(/\r?\n/).forEach((line) => {
            const separator = line.indexOf(":");
            if (separator > 0) headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
        });
        const limit = Number(headers.get("x-ratelimit-limit"));
        const remaining = Number(headers.get("x-ratelimit-remaining"));
        const resetAt = Number(headers.get("x-ratelimit-reset-timestamp"));
        return Number.isFinite(limit) && Number.isFinite(remaining) && Number.isFinite(resetAt)
            ? { limit, remaining, resetAt }
            : null;
    }

    function requestFFScouter(endpoint, params = {}) {
        const url = new URL(`${FFSCOUTER_BASE_URL}/${endpoint}`);
        Object.entries(params).forEach(([name, value]) => {
            if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
        });
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url.toString(),
                headers: { Accept: "application/json" },
                timeout: 30000,
                onload: (response) => {
                    let data;
                    try {
                        data = JSON.parse(response.responseText);
                    } catch (error) {
                        reject(new Error(`FFScouter returned invalid JSON (HTTP ${response.status}).`));
                        return;
                    }
                    if (response.status < 200 || response.status >= 300 || data?.code !== undefined) {
                        reject(new Error(data?.error || `FFScouter request failed (HTTP ${response.status}).`));
                        return;
                    }
                    resolve({ data, limits: parseFFScouterRateLimits(response.responseHeaders) });
                },
                onerror: () => reject(new Error("Unable to connect to FFScouter.")),
                ontimeout: () => reject(new Error("FFScouter request timed out."))
            });
        });
    }

    function validateFFScouterKey(key) {
        const value = String(key || "").trim();
        if (!/^[A-Za-z0-9]{16}$/.test(value)) throw new Error("FFScouter requires a 16-character alphanumeric registered Torn API key.");
        return value;
    }

    async function verifyFFScouterKey(key) {
        const value = validateFFScouterKey(key);
        const response = await requestFFScouter("check-key", { key: value });
        return { ...response, key: value };
    }

    function formatFFScouterTimestamp(timestamp, emptyText) {
        const value = Number(timestamp || 0);
        return value > 0 ? new Date(value * 1000).toLocaleString() : emptyText;
    }

    function getFFScouterVerificationDetails(data) {
        const now = Math.floor(Date.now() / 1000);
        if (!data?.is_registered) {
            return {
                title: "FFScouter Key Unregistered",
                summary: "The key format is valid, but FFScouter does not have this key registered.",
                color: "#e0a25e",
                rows: [
                    ["Registration", "Unregistered"],
                    ["Premium", "Inactive"],
                    ["Last successful use", "Never used"]
                ]
            };
        }

        const personalExpiry = Number(data.premium_expires_at || 0);
        const factionExpiry = Number(data.faction_premium_expires_at || 0);
        const latestPremiumExpiry = Math.max(personalExpiry, factionExpiry);
        const source = String(data.premium_entitlement_source || "none").replaceAll("_", " ");
        const premiumState = data.is_premium
            ? `Active · ${source}`
            : (latestPremiumExpiry > 0 && latestPremiumExpiry <= now ? "Expired" : "Inactive");
        const policyState = data.policy_update_required
            ? `Update required · Current policy v${data.policy_version ?? "—"}`
            : `Accepted · Policy v${data.policy_version ?? "—"}`;
        return {
            title: data.policy_update_required ? "FFScouter Key Verified · Action Required" : "FFScouter Key Verified",
            summary: data.policy_update_required
                ? "The key is registered, but FFScouter requires the current data policy to be accepted."
                : "The key is registered and active for FFScouter API requests.",
            color: data.policy_update_required ? "#e0a25e" : "#7fe18d",
            rows: [
                ["Registration", "Verified · Registered"],
                ["Registered", formatFFScouterTimestamp(data.registered_at, "Unknown")],
                ["Last successful use", formatFFScouterTimestamp(data.last_used, "Never used")],
                ["Data policy", policyState],
                ["Premium", premiumState],
                ["Personal premium expiry", formatFFScouterTimestamp(data.premium_expires_at, "None")],
                ["Faction ID", data.faction_id ?? "None"],
                ["Faction premium expiry", formatFFScouterTimestamp(data.faction_premium_expires_at, "None")]
            ]
        };
    }

    async function queryFFScouterStats(playerIds, key = getStoredFFScouterKey()) {
        const value = validateFFScouterKey(key);
        const targets = [...new Set((Array.isArray(playerIds) ? playerIds : [playerIds])
            .map((id) => Number(id))
            .filter((id) => Number.isInteger(id) && id > 0))];
        if (!targets.length) throw new Error("At least one valid Torn player ID is required.");
        const response = await requestFFScouter("get-stats", { key: value, targets: targets.join(",") });
        return { results: Array.isArray(response.data) ? response.data : [], limits: response.limits };
    }

    function chunkArray(values, size) {
        const chunks = [];
        for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
        return chunks;
    }

    function normalizeTornBatchProfiles(payload, requestedIds) {
        const requested = new Set(requestedIds.map(Number));
        const profiles = new Map();
        const add = (candidate, fallbackId) => {
            const profile = candidate?.profile || candidate;
            const id = Number(profile?.id || profile?.player_id || fallbackId || 0);
            if (id > 0 && requested.has(id) && profile && typeof profile === "object") profiles.set(id, profile);
        };
        if (Array.isArray(payload)) payload.forEach((entry) => add(entry));
        const collection = payload?.profiles || payload?.users || payload?.players;
        if (Array.isArray(collection)) collection.forEach((entry) => add(entry));
        else if (collection && typeof collection === "object") Object.entries(collection).forEach(([id, entry]) => add(entry, id));
        if (payload && typeof payload === "object") {
            Object.entries(payload).forEach(([id, entry]) => {
                if (/^\d+$/.test(id)) add(entry, id);
            });
            add(payload);
        }
        return profiles;
    }

    async function fetchTornWarProfiles(playerIds, apiKey) {
        const ids = [...new Set(playerIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
        const profiles = new Map();
        for (const batch of chunkArray(ids, 10)) {
            const url = new URL(`${TORN_V1_BASE_URL}user/${batch.join(",")}`);
            url.searchParams.set("selections", "profile");
            url.searchParams.set("key", apiKey);
            url.searchParams.set("comment", "NaughtyTornCompanion-WarTargets");
            const response = await secureCustomFetch(url.toString());
            const parsed = normalizeTornBatchProfiles(response, batch);
            parsed.forEach((profile, id) => profiles.set(id, profile));
            if (parsed.size === 0) throw new Error("Torn batch profile response did not contain player profiles.");
            if (ids.length > 10) await sleep(150);
        }
        return profiles;
    }

    function buildWarTargets(roster, ffResults, liveProfiles, liveSource = "Torn profile batches") {
        const ffById = new Map((Array.isArray(ffResults) ? ffResults : []).map((entry) => [Number(entry?.player_id || 0), entry]));
        return roster.map((member) => {
            const id = Number(member?.id || member?.player_id || 0);
            const ff = ffById.get(id) || {};
            const profile = liveProfiles.get(id) || member;
            return {
                id,
                name: profile?.name || member?.name || `Player ${id}`,
                level: Number(profile?.level || member?.level || 0),
                fairFight: Number(ff?.fair_fight || 0),
                battleStats: Number(ff?.bs_estimate || 0),
                battleStatsHuman: ff?.bs_estimate_human || "",
                estimateSource: ff?.source || "",
                estimateUpdatedAt: Number(ff?.last_updated || 0),
                noEstimate: ff?.no_data === true || !ff?.player_id,
                lastAction: profile?.last_action || member?.last_action || {},
                status: profile?.status || member?.status || {},
                life: profile?.life || null,
                liveSource
            };
        });
    }

    async function fetchWarTargetData(apiKey, war, fallbackRoster = [], options = {}) {
        const { includeStats = true, existingStats = [] } = options;
        if (!war?.oppId) throw new Error("No active enemy faction was found.");
        const rosterResponse = await fetchJson(withKey(`${BASE_URL}faction/${war.oppId}/members`, apiKey));
        const roster = Array.isArray(rosterResponse?.members) ? rosterResponse.members : (Array.isArray(rosterResponse) ? rosterResponse : fallbackRoster);
        const playerIds = roster.map((member) => Number(member?.id || 0)).filter(Boolean);
        if (!playerIds.length) throw new Error("Enemy faction roster is empty.");

        let ffResults = existingStats;
        let ffLimits = null;
        let statsError = "";
        if (includeStats) {
            try {
                const ffResponse = await queryFFScouterStats(playerIds);
                ffResults = ffResponse.results;
                ffLimits = ffResponse.limits;
            } catch (error) {
                statsError = error.message;
            }
        }

        let liveProfiles;
        let liveSource = "Torn profile batches";
        let liveError = "";
        try {
            liveProfiles = await fetchTornWarProfiles(playerIds, apiKey);
        } catch (error) {
            liveProfiles = new Map(roster.map((member) => [Number(member.id), member]));
            liveSource = "Torn faction members fallback";
            liveError = error.message;
        }

        return {
            enemyFactionId: war.oppId,
            enemyFactionName: war.oppName,
            targets: buildWarTargets(roster, ffResults, liveProfiles, liveSource),
            ffResults,
            ffLimits,
            statsError,
            liveError,
            liveSource,
            statsFetchedAt: includeStats ? Date.now() : Number(options.statsFetchedAt || 0),
            liveFetchedAt: Date.now()
        };
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

    async function fetchOverviewData(apiKey) {
        setSectionStatus("overview", "Refreshing...");
        debugLog("Fetching overview data");
        try {
            const overviewRequestedAt = Date.now();
            const [basicResponse, moneyResponse, networthResponse, barsResponse, cooldownsResponse, travelResponse, iconsResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/basic`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/money`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/networth`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/bars`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}user/cooldowns`, apiKey))
                    .then((data) => ({ data, fetchedAt: overviewRequestedAt }))
                    .catch(() => ({ data: null, fetchedAt: overviewRequestedAt })),
                fetchJson(withKey(`${BASE_URL}user/travel`, apiKey)).catch(() => null),
                // KNOWN TORN BUG (confirmed by Torn staff): user/icons is documented as
                // returning the full icon report to Custom-tier keys as well as Limited/Full,
                // but Custom keys are actually denied the full report in practice — only
                // Limited and Full keys currently receive it. Not something we can work
                // around client-side; flagged here so it isn't mistaken for our own bug.
                fetchJson(withKey(`${BASE_URL}user/icons`, apiKey)).catch(() => null)
            ]);

            const profileResponse = await fetchJson(withKey(`${BASE_URL}user/profile`, apiKey)).catch(() => null);
            const factionResponse = await fetchJson(withKey(`${BASE_URL}user/faction`, apiKey)).catch(() => null);
            const companyResponse = await fetchJson(withKey(`${BASE_URL}company/profile`, apiKey)).catch(() => null);
            const money = moneyResponse?.money || moneyResponse || {};
            const networth = networthResponse?.networth || networthResponse || {};
            const icons = iconsResponse?.icons || iconsResponse || [];

            const result = {
                basic: basicResponse?.profile || basicResponse || {},
                money,
                networth,
                networthComparison: updateNetworthTracking(networth, money.daily_networth),
                bars: barsResponse?.energy !== undefined ? barsResponse : (barsResponse?.bars || barsResponse || {}),
                barsFetchedAt: overviewRequestedAt,
                profile: profileResponse?.profile || profileResponse || {},
                faction: factionResponse?.faction || factionResponse || {},
                company: companyResponse?.profile || companyResponse || {},
                cooldowns: cooldownsResponse?.data?.cooldowns || cooldownsResponse?.data || {},
                cooldownsFetchedAt: cooldownsResponse?.fetchedAt || overviewRequestedAt,
                cooldownDeadlines: getCooldownDeadlines(icons),
                travel: travelResponse?.travel || travelResponse || {},
                travelFetchedAt: overviewRequestedAt,
                icons
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
                    fetchedAt: overviewRequestedAt
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
                    description: track.award.description || "",
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
            const [profileResponse, skillsResponse, educationResponse, workstatsResponse, battlestatsResponse, perksResponse, jobResponse, moneyResponse, networthResponse, jobpointsResponse, medalsCatalogResponse, userMedalsResponse, honorsCatalogResponse, userHonorsResponse, iconsResponse] = await Promise.all([
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
                fetchJson(withKey(`${BASE_URL}user/honors`, apiKey)).catch(() => null),
                // KNOWN TORN BUG (confirmed by Torn staff) — see matching note in
                // fetchOverviewData: Custom-tier keys are documented to receive the full
                // user/icons report but don't in practice; only Limited/Full do.
                fetchJson(withKey(`${BASE_URL}user/icons`, apiKey)).catch(() => null)
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
            const icons = iconsResponse?.icons || iconsResponse || [];
            const money = moneyResponse?.money || moneyResponse || {};
            const networth = networthResponse?.networth || networthResponse || {};
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
                money,
                networth,
                networthComparison: updateNetworthTracking(networth, money.daily_networth),
                currentJobPoints,
                medals,
                honors,
                awardProgress,
                xanaxDebuffActive: isActiveXanaxIcon(icons),
                drugAddictionDebuffPercent: getDrugAddictionDebuffPercent(icons)
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
            const previousFaction = state.caches.faction || {};
            const factionRequestedAt = Date.now();
            const [userFactionResponse, factionBasicResponse, factionStatsResponse, factionMembersResponse, factionNewsResponse, factionChainResponse, factionWarsResponse] = await Promise.all([
                fetchJson(withKey(`${BASE_URL}user/faction`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/basic`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/stats`, apiKey)).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/members`, apiKey)).catch(() => null),
                // NOTE: `cat` is a REQUIRED param on faction/news (no default) — without it every
                // request fails with error 21 "Incorrect category" at ALL key tiers, including Full.
                // We request the 9 categories available at Minimal access (main / armoryDeposit /
                // armoryAction / territoryWar / rankedWar / territoryGain / chain / crime / membership)
                // and deliberately omit attack / depositFunds / giveFunds, which Torn gates to
                // Limited+ keys — including them would break this call for anyone on a Minimal key.
                // Torn allows up to 10 comma-separated categories per request.
                fetchJson(withKey(`${BASE_URL}faction/news`, apiKey, {
                    cat: "main,armoryDeposit,armoryAction,territoryWar,rankedWar,territoryGain,chain,crime,membership"
                })).catch(() => null),
                fetchJson(withKey(`${BASE_URL}faction/chain`, apiKey))
                    .then((data) => ({ data, fetchedAt: factionRequestedAt }))
                    .catch(() => ({ data: null, fetchedAt: factionRequestedAt })),
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
                fetchedAt: factionChainResponse?.fetchedAt || factionRequestedAt
            };

            const warsRequestFailed = factionWarsResponse === null;
            const warsData = factionWarsResponse?.wars || factionWarsResponse || {};
            const rankedWar = warsData.ranked || null;
            const rankedFactions = Array.isArray(rankedWar?.factions) ? rankedWar.factions : [];
            let war = warsRequestFailed ? (previousFaction.war || null) : null;
            if (rankedFactions.length >= 2) {
                const ownEntry = rankedFactions.find((entry) => Number(entry.id) === ownFactionId) || rankedFactions[0];
                const oppEntry = rankedFactions.find((entry) => Number(entry.id) !== ownFactionId) || rankedFactions[1];
                const opponentBasicResponse = await fetchJson(withKey(`${BASE_URL}faction/${oppEntry.id}/basic`, apiKey)).catch(() => null);
                const opponentBasic = opponentBasicResponse?.basic || opponentBasicResponse || {};
                war = {
                    warId: Number(rankedWar.war_id || 0),
                    oppId: Number(oppEntry.id || 0),
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
                        // Only count SUCCESSFUL "Attacked" results — Torn's own war/chain
                        // report breaks Attacks out separately from Mugged, Hospitalized,
                        // Assist, Lost, Escape, Stalemate, etc. (result enum values). We were
                        // previously counting every log entry in the time window regardless
                        // of result, which inflated both hit counts and respect totals by
                        // including mugs, hospitalizations, assists, retaliations, losses,
                        // and other non-"Attacked" outcomes that Torn doesn't count toward
                        // this figure.
                        const isSuccessfulAttack = atk.result === "Attacked";

                        if (isSuccessfulAttack && atk.is_ranked_war && warStart && started >= warStart) {
                            personalContribution.warHits += 1;
                            personalContribution.warRespect += respectGain;
                        }

                        if (isSuccessfulAttack && chainStart && started >= chainStart && started <= chainEnd) {
                            personalContribution.chainHits += 1;
                            personalContribution.chainRespect += respectGain;
                            personalContribution.bonusScore += getChainBonusRespect(atk);
                        }
                    });
                }
            } catch (contributionError) {
                console.warn("Personal contribution calculation failed:", contributionError);
            }

            const previousWarTargets = war && Number(previousFaction.war?.warId || 0) === Number(war.warId || 0)
                ? previousFaction.warTargets
                : null;
            let warTargets = previousWarTargets || null;
            if (war && getStoredFFScouterKey()) {
                try {
                    warTargets = await fetchWarTargetData(apiKey, war);
                } catch (targetError) {
                    warTargets = {
                        ...(previousWarTargets || {}),
                        enemyFactionId: war.oppId,
                        enemyFactionName: war.oppName,
                        targets: Array.isArray(previousWarTargets?.targets) ? previousWarTargets.targets : [],
                        error: targetError.message
                    };
                }
            }
            if (warTargets && war) warTargets = { ...warTargets, war: { ...war } };

            const result = {
                userFaction: userFactionData,
                factionBasic: factionBasicData,
                factionStats: factionStatsResponse?.stats || factionStatsResponse || [],
                factionMembers: factionMembersResponse?.members || factionMembersResponse || [],
                factionNews: factionNewsResponse?.news || factionNewsResponse || [],
                chain,
                war,
                warTargets,
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

    function getBarRecoveryDefaults(key, maximum) {
        if (key === "energy") return { increment: 5, interval: maximum >= 150 ? 600 : 900 };
        if (key === "nerve") return { increment: 1, interval: 300 };
        if (key === "happy") return { increment: 5, interval: 900 };
        return { increment: Math.max(1, Math.ceil(maximum * 0.05)), interval: 300 };
    }

    function getBarTimerConfig(key, value, fetchedAt) {
        const currentValue = Number(value.current ?? (typeof value === "number" ? value : 0));
        const maximumValue = Number(value.maximum ?? value.max ?? 0);
        const current = Number.isFinite(currentValue) ? currentValue : 0;
        const maximum = Number.isFinite(maximumValue) ? maximumValue : 0;
        const defaults = getBarRecoveryDefaults(key, maximum);
        const increment = Number(value.increment || 0) > 0 ? Number(value.increment) : defaults.increment;
        const interval = Number(value.interval || 0) > 0 ? Number(value.interval) : defaults.interval;
        const isFull = maximum <= 0 || current >= maximum;
        const tickSeconds = isFull ? 0 : Math.max(0, Number(value.tick_time ?? interval));
        const ticksNeeded = increment > 0 ? Math.ceil(Math.max(0, maximum - current) / increment) : 0;
        const calculatedFullSeconds = ticksNeeded > 0 ? tickSeconds + (Math.max(0, ticksNeeded - 1) * interval) : 0;
        const apiFullSeconds = Number(value.full_time || 0);
        const fullSeconds = isFull ? 0 : (apiFullSeconds > 0 ? apiFullSeconds : calculatedFullSeconds);
        return { key, current, maximum, increment, interval, tickSeconds, fullSeconds, fetchedAt: Number(fetchedAt || Date.now()) };
    }

    function getBarTimerState(config, now = Date.now()) {
        const elapsed = Math.max(0, (now - config.fetchedAt) / 1000);
        if (config.maximum <= 0) {
            return { current: config.current, percent: 0, nextTick: 0, fullRemaining: 0, isFull: false, unavailable: true };
        }
        if (config.current >= config.maximum || config.fullSeconds <= elapsed) {
            return { current: Math.max(config.current, config.maximum), percent: 100, nextTick: 0, fullRemaining: 0, isFull: true };
        }
        const ticks = elapsed < config.tickSeconds
            ? 0
            : 1 + Math.floor((elapsed - config.tickSeconds) / config.interval);
        const current = Math.min(config.maximum, config.current + (ticks * config.increment));
        const nextTick = ticks === 0
            ? config.tickSeconds - elapsed
            : config.interval - ((elapsed - config.tickSeconds) % config.interval);
        const fullRemaining = Math.max(0, config.fullSeconds - elapsed);
        const isFull = current >= config.maximum || fullRemaining <= 0;
        return {
            current: isFull ? config.maximum : current,
            percent: config.maximum > 0 ? Math.min(100, Math.max(0, ((isFull ? config.maximum : current) / config.maximum) * 100)) : 0,
            nextTick: isFull ? 0 : nextTick,
            fullRemaining: isFull ? 0 : fullRemaining,
            isFull
        };
    }

    function updateBarTimers(now = Date.now()) {
        document.querySelectorAll("[data-bar-timer]").forEach((row) => {
            const config = {
                current: Number(row.dataset.current || 0) || 0,
                maximum: Number(row.dataset.maximum || 0) || 0,
                increment: Number(row.dataset.increment || 0) || 0,
                interval: Number(row.dataset.interval || 0) || 1,
                tickSeconds: Number(row.dataset.tickSeconds || 0) || 0,
                fullSeconds: Number(row.dataset.fullSeconds || 0) || 0,
                fetchedAt: Number(row.dataset.fetchedAt || now) || now
            };
            const timer = getBarTimerState(config, now);
            const valueEl = row.querySelector("[data-bar-value]");
            const fillEl = row.querySelector("[data-bar-fill]");
            const nextEl = row.querySelector("[data-bar-next]");
            const fullEl = row.querySelector("[data-bar-full]");
            if (valueEl) valueEl.textContent = `${formatInteger(timer.current)} / ${formatInteger(config.maximum)}`;
            if (fillEl) fillEl.style.width = `${timer.percent}%`;
            if (nextEl) nextEl.textContent = timer.unavailable ? "Timing unavailable" : (timer.isFull ? "Full" : `+${formatInteger(config.increment)} in ${formatDuration(Math.ceil(timer.nextTick))}`);
            if (fullEl) fullEl.textContent = timer.unavailable ? "No bar data" : (timer.isFull ? "Fully replenished" : `Full in ${formatDuration(Math.ceil(timer.fullRemaining))}`);
        });
    }

    function renderBarsPanel(bars, fetchedAt) {
        const barDefinitions = [
            { key: "energy", label: "Energy", color: "#7fe18d" },
            { key: "nerve", label: "Nerve", color: "#e05959" },
            { key: "life", label: "Life", color: "#5ba7f7" },
            { key: "happy", label: "Happiness", color: "#f0d34f" }
        ];
        const rows = barDefinitions.map(({ key, label, color }) => {
            const value = bars[key] || {};
            const config = getBarTimerConfig(key, value, fetchedAt);
            const timer = getBarTimerState(config);
            return `
                <div data-bar-timer data-current="${config.current}" data-maximum="${config.maximum}" data-increment="${config.increment}" data-interval="${config.interval}" data-tick-seconds="${config.tickSeconds}" data-full-seconds="${config.fullSeconds}" data-fetched-at="${config.fetchedAt}">
                    <div style="display: grid; grid-template-columns: 58px 1fr auto; align-items: center; gap: 8px;">
                        <span style="color: #e0e0e0; font-size: 12px; font-weight: 700;">${label}</span>
                        <div style="height: 12px; border-radius: 6px; overflow: hidden; background: #202020; border: 1px solid #3a3a3a;">
                            <div data-bar-fill style="width: ${timer.percent}%; height: 100%; background: ${color}; transition: width 0.3s;"></div>
                        </div>
                        <span data-bar-value style="color: #fff; font-size: 12px; font-weight: 700; min-width: 68px; text-align: right;">${formatInteger(timer.current)} / ${formatInteger(config.maximum)}</span>
                    </div>
                    <div style="margin: 3px 0 0 66px; color: #aeb7c2; font-size: 10px; line-height: 1.3;">
                        <span data-bar-next>${timer.unavailable ? "Timing unavailable" : (timer.isFull ? "Full" : `+${formatInteger(config.increment)} in ${formatDuration(Math.ceil(timer.nextTick))}`)}</span>
                        <span style="color: #666; padding: 0 4px;">·</span>
                        <span data-bar-full>${timer.unavailable ? "No bar data" : (timer.isFull ? "Fully replenished" : `Full in ${formatDuration(Math.ceil(timer.fullRemaining))}`)}</span>
                    </div>
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

    function getCooldownDeadlines(icons) {
        const deadlines = { drug: 0, medical: 0, booster: 0 };
        normalizeIcons(icons).forEach((icon) => {
            const title = String(icon?.title || "").toLowerCase();
            const untilMs = Number(icon?.until || 0) * 1000;
            if (!untilMs) return;
            if (title.includes("drug cooldown")) deadlines.drug = untilMs;
            if (title.includes("medical cooldown")) deadlines.medical = untilMs;
            if (title.includes("booster cooldown")) deadlines.booster = untilMs;
        });
        return deadlines;
    }

    function getCountdownRemaining(seconds, fetchedAt, untilMs, now = Date.now()) {
        if (Number(untilMs || 0) > 0) return Math.max(0, (Number(untilMs) - now) / 1000);
        return Math.max(0, Number(seconds || 0) - ((now - Number(fetchedAt || now)) / 1000));
    }

    function buildCountdownStatCard(title, value, label, seconds, fetchedAt, color = "#8ec7ff") {
        const remaining = getCountdownRemaining(seconds, fetchedAt, 0);
        return `
            <div style="background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01)); border: 1px solid #333; border-radius: 8px; padding: 10px; min-height: 90px; box-sizing: border-box;">
                <div style="color: #d4d4d4; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 8px;">${escapeHtml(title)}</div>
                <div style="color: ${color}; font-size: 22px; font-weight: 700; line-height: 1.1;">${escapeHtml(String(value ?? "0"))}</div>
                <div style="color: #d0d0d0; font-size: 12px; font-weight: 600; line-height: 1.35; margin-top: 7px;">${escapeHtml(label)} <span data-countdown-type="duration" data-seconds="${Number(seconds || 0)}" data-fetched-at="${Number(fetchedAt || Date.now())}">${formatDuration(Math.ceil(remaining))}</span></div>
            </div>
        `;
    }

    function renderCooldownsRow(cooldowns, fetchedAt, deadlines = {}) {
        const drug = Number(cooldowns.drug || 0);
        const medical = Number(cooldowns.medical || 0);
        const booster = Number(cooldowns.booster || 0);
        const hasActiveCooldown = [
            getCountdownRemaining(drug, fetchedAt, deadlines.drug),
            getCountdownRemaining(medical, fetchedAt, deadlines.medical),
            getCountdownRemaining(booster, fetchedAt, deadlines.booster)
        ].some((remaining) => remaining > 0);

        if (!hasActiveCooldown) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; color: #888; font-size: 11px;">No active cooldowns.</div>`;
        }

        const cell = (key, label, seconds, color) => {
            const remaining = getCountdownRemaining(seconds, fetchedAt, deadlines[key]);
            return `
            <div style="flex: 1; text-align: center;">
                <div style="color: #e0e0e0; font-size: 12px; font-weight: 800; margin-bottom: 3px;">${label}</div>
                <div id="cooldown-${key}" data-seconds="${seconds}" data-fetched-at="${Number(fetchedAt || Date.now())}" data-until-ms="${Number(deadlines[key] || 0)}" data-active-color="${color}" style="color: ${remaining > 0 ? color : "#7fe18d"}; font-size: 13px; font-weight: 800;">${remaining > 0 ? formatDuration(Math.ceil(remaining)) : "Ready"}</div>
            </div>
        `;
        };

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; display: flex; gap: 6px;">
                ${cell("drug", "Drug", drug, "#e0a25e")}
                ${cell("medical", "Medical", medical, "#9dd8ff")}
                ${cell("booster", "Booster", booster, "#c9a0ff")}
            </div>
        `;
    }

    function renderTravelCard(basic, travel, fetchedAt) {
        const status = basic.status || {};
        const stateText = String(status.state || "").toLowerCase();
        const isTraveling = stateText.includes("travel");
        if (!isTraveling) return "";

        const destination = travel.destination || status.description || "Unknown destination";
        const method = travel.method || "";
        const timeLeft = Number(travel.time_left || 0);
        const arrivalUntilMs = Number(travel.arrival_at || 0) * 1000;
        const remaining = getCountdownRemaining(timeLeft, fetchedAt, arrivalUntilMs);

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 4px;">✈️ Traveling</div>
                <div style="color: #9dd8ff; font-size: 13px; margin-bottom: 2px;">${escapeHtml(String(destination))}${method ? ` · ${escapeHtml(String(method))}` : ""}</div>
                <div data-countdown-type="travel" data-seconds="${timeLeft}" data-fetched-at="${Number(fetchedAt || Date.now())}" data-until-ms="${arrivalUntilMs}" style="color: #888; font-size: 10px;">${remaining > 0 ? `Arriving in ${formatDuration(Math.ceil(remaining))}` : "Arriving soon"}</div>
            </div>
        `;
    }

    function formatStatusIconDescription(description) {
        if (description === null || description === undefined || description === "") return "No description provided.";
        return escapeHtml(String(description))
            .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
            .replace(/&lt;b&gt;/gi, "<strong>")
            .replace(/&lt;\/b&gt;/gi, "</strong>");
    }

    function renderStatusIcons(icons) {
        const entries = normalizeIcons(icons).filter((icon) => Number(icon?.id) !== 6);
        if (!entries.length) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 12px; background: rgba(20,20,20,0.7); color: #888; font-size: 11px;">No status icons are currently active.</div>`;
        }

        const now = Math.floor(Date.now() / 1000);
        const rows = entries.map((icon) => {
            const until = icon?.until;
            const timestamp = Number(until || 0);
            let expiry = "No expiry";
            let expiryColor = "#9aa4b2";
            if (until !== null && until !== undefined && until !== "") {
                const utcDate = formatUtcDateTime(timestamp);
                if (timestamp > now) {
                    expiry = `${escapeHtml(utcDate)} · <span data-countdown-type="status" data-until-ms="${timestamp * 1000}">${formatDuration(timestamp - now)} remaining</span>`;
                    expiryColor = "#7fe18d";
                } else {
                    expiry = `${escapeHtml(utcDate)} · Expired`;
                    expiryColor = "#e05959";
                }
            }
            return `
                <div style="border: 1px solid #2f3540; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7);">
                    <div style="display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; margin-bottom: 5px;">
                        <div style="color: #fff; font-size: 12px; line-height: 1.3; font-weight: 800; overflow-wrap: anywhere;">${escapeHtml(String(icon?.title || "Untitled Status"))}</div>
                        <div style="color: #9dd8ff; border: 1px solid #35445a; border-radius: 999px; padding: 2px 6px; font-size: 9px; font-weight: 800; white-space: nowrap;">ID ${escapeHtml(String(icon?.id ?? "—"))}</div>
                    </div>
                    <div style="color: #d0d0d0; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; white-space: normal;">${formatStatusIconDescription(icon?.description)}</div>
                    <div style="color: ${expiryColor}; font-size: 9px; line-height: 1.35; margin-top: 7px; overflow-wrap: anywhere;">${expiry}</div>
                </div>
            `;
        }).join("");

        return `
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: 8px;">
                <div style="color: #fff; font-size: 12px; font-weight: 800;">Active Statuses</div>
                <div style="color: #9dd8ff; font-size: 10px; font-weight: 700;">${entries.length} total</div>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 8px;">${rows}</div>
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
        const icons = overview.icons || [];
        const networthComparison = overview.networthComparison || null;

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
        const networthChange = networthComparison?.totalChange;
        const networthSubtext = networthChange === null || networthChange === undefined
            ? "Live total"
            : `${formatSignedMoney(networthChange)} vs Torn daily`;

        const summaryCards = [
            buildStatCard("Player", playerName, `Level ${level}`),
            buildStatCard("Cash", formatMoney(cash), "Current money"),
            buildStatCard("Total Net Worth", formatMoney(net), networthSubtext, networthChange < 0 ? "#e05959" : "#7fe18d"),
            buildStatCard("Faction", factionName, "Current faction"),
            buildStatCard("Company", companyName, "Current company"),
            chain.max
                ? buildCountdownStatCard("Chain", chainDisplay, "Breaks in", chain.timeout, chain.fetchedAt)
                : buildStatCard("Chain", chainDisplay, "Visit Faction tab to load")
        ].join("");

        const subTabs = [
            { id: "general", label: "General" },
            { id: "status", label: "Status" }
        ];
        const activeSubTab = subTabs.some((tab) => tab.id === state.overviewSubTab) ? state.overviewSubTab : "general";
        const subTabButtons = subTabs.map((tab) => `
            <button data-overview-subtab="${tab.id}" style="background: ${activeSubTab === tab.id ? "#3b5998" : "#2a2a2a"}; border: 1px solid #3d3d3d; color: #fff; border-radius: 4px; padding: 6px 8px; font-size: 11px; cursor: pointer; ${activeSubTab === tab.id ? "font-weight: 700;" : ""}">${tab.label}</button>
        `).join("");
        const generalContent = `
            ${renderBarsPanel(bars, overview.barsFetchedAt)}
            ${renderCooldownsRow(cooldowns, overview.cooldownsFetchedAt, overview.cooldownDeadlines)}
            ${renderTravelCard(basic, travel, overview.travelFetchedAt)}
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
                ${summaryCards}
            </div>
        `;

        return `
            ${renderSectionMeta("overview", "Overview")}
            <div style="display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px;">${subTabButtons}</div>
            ${activeSubTab === "status" ? renderStatusIcons(icons) : generalContent}
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

    function renderNetworthComparisonBox(comparison) {
        if (!comparison?.live) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; color: #888; font-size: 11px;">Refresh Personal data to load the live and Torn daily Net Worth values.</div>`;
        }

        const live = comparison.live;
        const official = comparison.official;
        const totalChange = comparison.totalChange;
        const changeColor = totalChange > 0 ? "#7fe18d" : totalChange < 0 ? "#e05959" : "#d0d0d0";
        const detailRows = comparison.changes
            ? Object.entries(comparison.changes)
                .filter(([, change]) => Number(change) !== 0)
                .sort((a, b) => Math.abs(Number(b[1])) - Math.abs(Number(a[1])))
                .map(([label, change]) => `
                    <div style="display: grid; grid-template-columns: minmax(105px, 1.25fr) minmax(90px, 1fr) minmax(84px, 0.9fr); gap: 6px; padding: 4px 0; border-bottom: 1px solid #222; align-items: center;">
                        <span style="color: #d0d0d0; font-size: 10px; font-weight: 600; overflow-wrap: anywhere;">${escapeHtml(label)}</span>
                        <span style="color: #fff; font-size: 10px; font-weight: 700; text-align: right;">${formatMoney(live.values[label] || 0)}</span>
                        <span style="color: ${Number(change) > 0 ? "#7fe18d" : "#e05959"}; font-size: 10px; font-weight: 800; text-align: right;">${formatSignedMoney(change)}</span>
                    </div>
                `).join("")
            : "";

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="color: #fff; font-size: 12px; font-weight: 800; margin-bottom: 8px;">Net Worth Comparison</div>
                <div style="display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-bottom: 9px;">
                    <div style="border: 1px solid #303030; border-radius: 6px; padding: 7px;">
                        <div style="color: #aaa; font-size: 9px; font-weight: 700;">Torn Net Worth</div>
                        <div style="color: #fff; font-size: 11px; font-weight: 800; margin-top: 3px; overflow-wrap: anywhere;">${official ? formatMoney(official.total) : "Not captured"}</div>
                    </div>
                    <div style="border: 1px solid #303030; border-radius: 6px; padding: 7px;">
                        <div style="color: #aaa; font-size: 9px; font-weight: 700;">Live Net Worth</div>
                        <div style="color: #9dd8ff; font-size: 11px; font-weight: 800; margin-top: 3px; overflow-wrap: anywhere;">${formatMoney(live.total)}</div>
                    </div>
                    <div style="border: 1px solid #303030; border-radius: 6px; padding: 7px;">
                        <div style="color: #aaa; font-size: 9px; font-weight: 700;">Change</div>
                        <div style="color: ${changeColor}; font-size: 11px; font-weight: 800; margin-top: 3px; overflow-wrap: anywhere;">${totalChange === null ? "—" : formatSignedMoney(totalChange)}</div>
                    </div>
                </div>
                ${detailRows ? `
                    <div style="display: grid; grid-template-columns: minmax(105px, 1.25fr) minmax(90px, 1fr) minmax(84px, 0.9fr); gap: 6px; padding-bottom: 4px; color: #888; font-size: 9px; font-weight: 800;">
                        <span>Type</span><span style="text-align: right;">Live Value</span><span style="text-align: right;">Change</span>
                    </div>
                    ${detailRows}
                ` : comparison.changes ? `<div style="color: #aaa; font-size: 10px; line-height: 1.4;">No category changes since Torn's last daily Net Worth calculation.</div>` : official ? `<div style="color: #aaa; font-size: 10px; line-height: 1.4;">Exact category changes will appear after NTC captures a live snapshot matching Torn's next official Net Worth recalculation.</div>` : ""}
                <div style="color: #888; font-size: 9px; line-height: 1.4; margin-top: 8px;">
                    Live data updated ${formatRelativeTime(live.timestamp || live.capturedAt)}${official ? ` · Torn baseline observed ${formatRelativeTime(official.observedAt)}` : " · Torn baseline not yet observed"}
                </div>
            </div>
        `;
    }

    function getBattleStatBonuses(perks) {
        const texts = Object.values(perks || {})
            .flatMap((items) => Array.isArray(items) ? items : [])
            .map((item) => String(item || ""));
        const bonuses = { strength: 0, defense: 0, speed: 0, dexterity: 0 };
        texts.forEach((text) => {
            const match = text.trim().toLowerCase().match(/^\+?\s*([+-]?\d+(?:\.\d+)?)\s*%\s+passive\s+(strength|defense|speed|dexterity)\s*$/);
            if (!match) return;
            bonuses[match[2]] += Number(match[1]) || 0;
        });
        return bonuses;
    }

    function normalizeIcons(icons) {
        if (Array.isArray(icons)) return icons;
        if (!icons || typeof icons !== "object") return [];
        return Object.entries(icons).map(([id, icon]) => ({
            ...(icon || {}),
            id: icon?.id ?? Number(id)
        }));
    }

    function isActiveXanaxIcon(icons, now = Math.floor(Date.now() / 1000)) {
        return normalizeIcons(icons).some((icon) => {
            const isDrugCooldown = Number(icon?.id) === 52 || /drug cooldown/i.test(String(icon?.title || ""));
            const isXanax = /under the influence of xanax/i.test(String(icon?.description || ""));
            return isDrugCooldown && isXanax && Number(icon?.until || 0) > now;
        });
    }

    function getDrugAddictionDebuffPercent(icons, now = Math.floor(Date.now() / 1000)) {
        return normalizeIcons(icons).reduce((largest, icon) => {
            const isDrugAddiction = Number(icon?.id) === 57 || /drug addiction/i.test(String(icon?.title || ""));
            const until = icon?.until;
            const isActive = until === null || until === undefined || until === "" || Number(until) > now;
            if (!isDrugAddiction || !isActive) return largest;
            const match = String(icon?.description || "").match(/(-?\d+(?:\.\d+)?)%/);
            const percent = match ? Math.abs(Number(match[1])) : 0;
            return Math.max(largest, percent);
        }, 0);
    }

    function renderEffectiveBattleStatsBox(stats, bonuses, total, debuffPercent = 0) {
        const labels = { strength: "Strength", defense: "Defense", speed: "Speed", dexterity: "Dexterity" };
        const entries = Object.keys(labels).map((key) => {
            const base = Number(stats[key] || 0);
            const bonus = Number(bonuses[key] || 0);
            const modifier = bonus - Number(debuffPercent || 0);
            return { label: labels[key], base, modifier, effective: base * (1 + modifier / 100) };
        });
        const rows = entries.map((entry) =>
            '<div class="ntc-battle-stats-grid" style="display: grid; grid-template-columns: minmax(78px, 1fr) minmax(100px, 1.2fr) minmax(62px, 0.7fr) minmax(100px, 1.2fr); gap: 6px; align-items: center; padding: 4px 0; border-bottom: 1px solid #222;">'
            + '<span style="color: #d0d0d0; font-size: 12px; font-weight: 600;">' + entry.label + '</span>'
            + '<span style="color: #fff; font-size: 12px; font-weight: 700; text-align: right;">' + formatInteger(entry.base) + '</span>'
            + '<span style="color: ' + (entry.modifier < 0 ? '#e05959' : '#9dd8ff') + '; font-size: 12px; font-weight: 700; text-align: center;">' + (entry.modifier ? (entry.modifier > 0 ? '+' : '') + entry.modifier + '%' : '—') + '</span>'
            + '<span style="color: #7fe18d; font-size: 12px; font-weight: 700; text-align: right;">' + formatInteger(entry.effective) + '</span>'
            + '</div>'
        ).join("");
        const effectiveTotal = entries.reduce((sum, entry) => sum + entry.effective, 0);
        return '<div class="ntc-battle-stats-card" style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">'
            + '<div style="color: #fff; font-size: 12px; font-weight: 700; margin-bottom: 6px;">Battle Stats</div>'
            + '<div class="ntc-battle-stats-grid" style="display: grid; grid-template-columns: minmax(78px, 1fr) minmax(100px, 1.2fr) minmax(62px, 0.7fr) minmax(100px, 1.2fr); gap: 6px; padding-bottom: 4px; color: #888; font-size: 10px; font-weight: 700;">'
            + '<span>Stat</span><span style="text-align: right;">Battle Stat</span><span style="text-align: center;">Perk</span><span style="text-align: right;">Effective</span></div>'
            + rows
            + '<div class="ntc-battle-stats-grid" style="display: grid; grid-template-columns: minmax(78px, 1fr) minmax(100px, 1.2fr) minmax(62px, 0.7fr) minmax(100px, 1.2fr); gap: 6px; padding-top: 5px;">'
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
        const courseLabel = current ? (currentCourseName ? escapeHtml(currentCourseName) : `Course #${escapeHtml(current.id)}`) : "";
        const courseUntilMs = Number(current?.until || 0) * 1000;
        const courseRemaining = getCountdownRemaining(0, 0, courseUntilMs);
        const inProgressText = current
            ? `${courseLabel}${courseUntilMs ? ` (<span data-countdown-type="education" data-until-ms="${courseUntilMs}">${formatDuration(Math.ceil(courseRemaining))} left</span>)` : ""}`
            : "None";
        const total = completedCount + (current ? 1 : 0);
        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; font-size: 11px; color: #ccc;">
                <span style="color: #fff; font-weight: 700;">Education —</span> In Progress: ${inProgressText} · Completed: ${completedCount} · Total: ${total}
            </div>
        `;
    }

    const PERK_SOURCE_META = {
        faction: { label: "Faction", icon: "⚔", color: "#9dd8ff" },
        job: { label: "Job", icon: "▣", color: "#7fe18d" },
        property: { label: "Property", icon: "⌂", color: "#e0a25e" },
        education: { label: "Education", icon: "◆", color: "#c9a0ff" },
        enhancer: { label: "Enhancer", icon: "✦", color: "#f28b82" },
        book: { label: "Book", icon: "▤", color: "#f7c873" },
        stock: { label: "Stock", icon: "↗", color: "#72d4b4" },
        merit: { label: "Merit", icon: "★", color: "#85b7ff" }
    };

    function renderPerksBox(perks) {
        const sections = Object.entries(PERK_SOURCE_META)
            .map(([key, meta]) => ({ key, ...meta, items: Array.isArray(perks[key]) ? perks[key] : [] }))
            .filter((section) => section.items.length > 0);

        if (!sections.length) {
            return `<div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px; color: #888; font-size: 11px;">No perks data.</div>`;
        }

        const sectionsHtml = sections.map((section) => `
            <div class="ntc-perk-section" style="border:1px solid #303640;border-left:3px solid ${section.color};border-radius:7px;padding:9px;background:linear-gradient(135deg,${section.color}12,rgba(20,20,20,.72));">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:7px;">
                    <div style="display:flex;align-items:center;gap:6px;color:${section.color};font-size:12px;font-weight:800;"><span style="font-size:14px;">${section.icon}</span>${escapeHtml(section.label)}</div>
                    <span style="border:1px solid ${section.color}55;border-radius:10px;padding:1px 6px;color:${section.color};font-size:9px;font-weight:800;white-space:nowrap;">${formatInteger(section.items.length)} perks</span>
                </div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(205px,100%),1fr));gap:5px;">
                    ${section.items.map((text) => {
                        const value = String(text || "").trim();
                        const match = value.match(/^([+−-]\s*\d+(?:\.\d+)?%?)\s+(.+)$/);
                        const badge = match ? match[1].replace(/\s+/g, "") : "✓";
                        const label = match ? match[2] : value;
                        return `<div class="ntc-perk-item" style="display:flex;align-items:flex-start;gap:6px;min-height:30px;padding:6px 7px;border:1px solid #2b3139;border-radius:5px;background:rgba(255,255,255,.025);"><span style="flex:0 0 auto;min-width:26px;color:${section.color};font-size:10px;font-weight:900;white-space:nowrap;">${escapeHtml(badge)}</span><span style="color:#d4dae2;font-size:10px;font-weight:600;line-height:1.35;">${escapeHtml(label)}</span></div>`;
                    }).join("")}
                </div>
            </div>
        `).join("");

        return `
            <div style="border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px; background: rgba(20,20,20,0.7); margin-bottom: 10px;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:9px;"><div style="color:#fff;font-size:13px;font-weight:800;">Active Perks</div><div style="color:#8d98a6;font-size:10px;">${formatInteger(sections.reduce((sum, section) => sum + section.items.length, 0))} total</div></div>
                <div style="display:grid;gap:8px;">${sectionsHtml}</div>
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
            <div style="display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px solid #222;">
                <div style="min-width: 0; flex: 1;">
                    <div style="color: ${MEDAL_RARITY_COLORS[item.rarity] || "#ccc"}; font-size: 11px; font-weight: 700; overflow-wrap: anywhere;">${escapeHtml(item.name)}</div>
                    ${item.description ? `<div style="color: #aaa; font-size: 10px; line-height: 1.35; margin-top: 2px; overflow-wrap: anywhere; white-space: normal;">${escapeHtml(item.description)}</div>` : ""}
                </div>
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
                    <div style="min-width: 0; flex: 1;">
                        <div style="color: ${MEDAL_RARITY_COLORS[item.rarity] || "#ccc"}; font-size: 11px; font-weight: 700; overflow-wrap: anywhere;">${escapeHtml(item.name)}</div>
                        ${item.description ? `<div style="color: #aaa; font-size: 10px; line-height: 1.35; margin-top: 2px; overflow-wrap: anywhere; white-space: normal;">${escapeHtml(item.description)}</div>` : ""}
                    </div>
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
        const networthComparison = personal.networthComparison || null;
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
        const battleStatDebuffPercent = (personal.xanaxDebuffActive === true ? 25 : 0)
            + Number(personal.drugAddictionDebuffPercent || 0);

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
            ${renderNetworthComparisonBox(networthComparison)}
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
                ${renderInfoBox("Points Summary", [
                    { label: "Points Held", value: formatInteger(points), color: "#9dd8ff" },
                    { label: "Points Value", value: formatMoney(networth.points ?? 0), color: "#9dd8ff" }
                ])}
            </div>
        `;

        const battleBox = renderEffectiveBattleStatsBox(battleStats, battleBonuses, battleTotal, battleStatDebuffPercent);

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
            <div class="ntc-personal-stats-pair" style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; align-items: stretch;">
                ${battleBox}
                ${workBox}
            </div>
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
        const fetchedAt = Number(chain.fetchedAt || Date.now());
        const timeoutRemaining = getCountdownRemaining(chain.timeout, fetchedAt, 0);
        const cooldownRemaining = getCountdownRemaining(chain.cooldown, fetchedAt, 0);
        const pct = max > 0 ? Math.min(100, Math.round((current / max) * 100)) : 0;
        const barColor = pct >= 90 ? "#e05959" : pct >= 60 ? "#e0a25e" : "#7fe18d";

        if (!max && !current && !chain.timeout && !chain.cooldown) {
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
                    <span>Breaks in <span id="faction-chain-countdown" data-chain-seconds="${Number(chain.timeout || 0)}" data-fetched-at="${fetchedAt}" data-expired-text="0s" data-active-color="#ccc" data-expired-color="#e05959" style="color: ${timeoutRemaining > 0 ? "#ccc" : "#e05959"}; font-weight: 700;">${formatDuration(Math.ceil(timeoutRemaining))}</span></span>
                    <span>Cooldown: <span id="faction-chain-cooldown" data-chain-seconds="${Number(chain.cooldown || 0)}" data-fetched-at="${fetchedAt}" data-expired-text="Ready" data-active-color="#ccc" data-expired-color="#7fe18d" style="color: ${cooldownRemaining > 0 ? "#ccc" : "#7fe18d"}; font-weight: 700;">${cooldownRemaining > 0 ? formatDuration(Math.ceil(cooldownRemaining)) : "Ready"}</span></span>
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

    function getWarTargetStatePriority(target) {
        const online = String(target?.lastAction?.status || "").toLowerCase();
        const health = String(target?.status?.state || "").toLowerCase();
        const hospitalUntil = Number(target?.status?.until || 0);
        const isHospitalized = health.includes("hospital") && hospitalUntil * 1000 > Date.now();
        const healthPriority = health === "okay" ? 0 : isHospitalized ? 1 : 2;
        const onlinePriority = online === "online" ? 0 : online === "idle" ? 1 : 2;
        return (healthPriority * 10) + onlinePriority;
    }

    function getWarTargetStatus(target) {
        const rawState = String(target?.status?.state || "");
        const description = String(target?.status?.description || target?.status?.details || "");
        const untilMs = Number(target?.status?.until || 0) * 1000;
        const isHospitalized = /hospital/i.test(rawState) || /hospital/i.test(description);
        const isTraveling = /(travel|abroad)/i.test(rawState) || /(travel|abroad)/i.test(description);
        const destinationMatch = description.match(/\bto\s+(.+?)(?:[.!]|$)/i);
        const abroadDestination = description.match(/\bin\s+(.+?)(?:[.!]|$)/i);
        const destination = isTraveling ? (destinationMatch?.[1] || abroadDestination?.[1] || "").trim() : "";
        return {
            kind: isHospitalized ? "hospital" : isTraveling ? "travel" : "okay",
            label: isHospitalized ? "Hospitalized" : /abroad/i.test(rawState) ? "Abroad" : isTraveling ? "Traveling" : "Okay",
            untilMs,
            destination
        };
    }

    function getWarTargetAvailability(target) {
        const status = getWarTargetStatus(target);
        return {
            status,
            priority: status.kind === "okay" ? 0 : status.kind === "hospital" ? 1 : 2,
            hospitalRelease: status.kind === "hospital" && status.untilMs > 0
                ? status.untilMs
                : Number.MAX_SAFE_INTEGER
        };
    }

    function getWarTargetFilterKeys(target) {
        const status = getWarTargetStatus(target);
        const onlineState = String(target?.lastAction?.status || "").toLowerCase();
        return {
            status: status.kind === "hospital" ? "hospitalized" : status.kind === "travel" ? "traveling" : "okay",
            online: onlineState === "online" ? "online" : onlineState === "idle" ? "idle" : "offline"
        };
    }

    function filterWarTargets(targets) {
        const minText = String(state.warTargetFFRange?.min ?? "").trim();
        const maxText = String(state.warTargetFFRange?.max ?? "").trim();
        const minFF = minText === "" ? null : Number(minText);
        const maxFF = maxText === "" ? null : Number(maxText);
        const hasMin = Number.isFinite(minFF);
        const hasMax = Number.isFinite(maxFF);
        return targets.filter((target) => {
            const keys = getWarTargetFilterKeys(target);
            if (state.warTargetFilters[keys.status] === false || state.warTargetFilters[keys.online] === false) return false;
            if (!hasMin && !hasMax) return true;
            const fairFight = Number(target?.fairFight);
            if (!Number.isFinite(fairFight) || fairFight <= 0) return false;
            return (!hasMin || fairFight >= minFF) && (!hasMax || fairFight <= maxFF);
        });
    }

    function getWarTargetSortValue(target, key) {
        const online = String(target?.lastAction?.status || "unknown").toLowerCase();
        const health = String(target?.status?.state || "unknown").toLowerCase();
        const until = Number(target?.status?.until || 0);
        const hospitalized = health.includes("hospital") && until * 1000 > Date.now();
        switch (key) {
            case "player": return String(target?.name || "").toLowerCase();
            case "online": return ({ online: 0, idle: 1, offline: 2 })[online] ?? 3;
            case "status": {
                const status = getWarTargetStatus(target);
                const priority = status.kind === "okay" ? 0 : status.kind === "hospital" ? 1 : 2;
                return priority === 0 ? 0 : (priority * 1_000_000_000_000_000) + (status.untilMs || 900_000_000_000_000);
            }
            case "stats": return Number(target?.battleStats || 0);
            case "ff": return Number(target?.fairFight || 0);
            case "attack": return getWarTargetStatePriority(target);
            case "availability":
            default: return health === "okay" ? 0 : (hospitalized ? until : Number.MAX_SAFE_INTEGER);
        }
    }

    function sortWarTargets(targets) {
        const { key, direction } = state.warTargetSort || { key: "status", direction: "asc" };
        const factor = direction === "desc" ? -1 : 1;
        return [...targets].sort((a, b) => {
            const aAvailability = getWarTargetAvailability(a);
            const bAvailability = getWarTargetAvailability(b);
            const availabilityComparison = aAvailability.priority - bAvailability.priority;
            if (availabilityComparison) return availabilityComparison;

            if (aAvailability.status.kind === "hospital") {
                const releaseComparison = aAvailability.hospitalRelease - bAvailability.hospitalRelease;
                if (releaseComparison) return releaseComparison;
            }

            const aValue = getWarTargetSortValue(a, key);
            const bValue = getWarTargetSortValue(b, key);
            const comparison = typeof aValue === "string"
                ? aValue.localeCompare(String(bValue))
                : Number(aValue) - Number(bValue);
            return (comparison * factor)
                || getWarTargetStatePriority(a) - getWarTargetStatePriority(b)
                || String(a.name || "").localeCompare(String(b.name || ""));
        });
    }

    const WAR_TARGET_COLUMNS = {
        player: { label: "Player", align: "left", minWidth: 88, hardFloor: 58 },
        online: { label: "Online", align: "left", minWidth: 54, hardFloor: 40 },
        status: { label: "Status", align: "left", minWidth: 96, hardFloor: 62 },
        stats: { label: "Est. Stats", align: "right", minWidth: 68, hardFloor: 46 },
        // ff/attack floors raised to match real content minimums (a "1.5x"-style badge and
        // an "Attack" button both need real room — the earlier 26/34 floors were tighter
        // than the content itself, which combined with .ntc-attack-button's
        // min-width:max-content !important could still overflow even once the column-fit
        // math was correct.
        ff: { label: "FF", align: "center", minWidth: 38, hardFloor: 32 },
        attack: { label: "Attack", align: "center", minWidth: 58, hardFloor: 52 }
    };

    // Fits all visible columns inside `availableWidth` with ZERO horizontal scrolling,
    // rather than letting the table render at its natural (often wider) width and
    // relying on overflow-x scroll — that's what was cutting columns off on narrow
    // mobile/PDA viewports (only Player/Online/Status fit before the cut-off point).
    //
    // - availableWidth null/unknown -> fall back to natural/stored widths (desktop, no
    //   measurement yet available).
    // - Room to spare -> use natural/stored widths and give any leftover space to the
    //   last column so the table still fills the container edge-to-edge.
    // - Not enough room -> shrink every column proportionally down toward its hardFloor
    //   (never below it) until the total exactly fits availableWidth.
    function computeResponsiveColumnWidths(columnOrder, availableWidth) {
        const cols = columnOrder.filter((key) => WAR_TARGET_COLUMNS[key]);
        const naturalWidths = cols.map((key) =>
            Math.max(WAR_TARGET_COLUMNS[key].minWidth, Number(state.warTargetColumnWidths[key]) || WAR_TARGET_COLUMNS[key].minWidth)
        );
        const naturalTotal = naturalWidths.reduce((sum, w) => sum + w, 0);

        if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
            return Object.fromEntries(cols.map((key, i) => [key, naturalWidths[i]]));
        }

        if (naturalTotal <= availableWidth) {
            // Distribute leftover space proportionally to each column's natural width,
            // rather than dumping it all into whichever column happens to be last —
            // that would let e.g. a narrow "FF" or "Attack" column balloon absurdly
            // wide on large desktop panels.
            const leftover = availableWidth - naturalTotal;
            if (leftover <= 0 || !cols.length) {
                return Object.fromEntries(cols.map((key, i) => [key, naturalWidths[i]]));
            }
            const widths = cols.map((key, i) => naturalWidths[i] + Math.floor(leftover * (naturalWidths[i] / naturalTotal)));
            const distributed = widths.reduce((sum, w) => sum + w, 0);
            widths[widths.length - 1] += availableWidth - distributed; // fold rounding remainder into the last column
            return Object.fromEntries(cols.map((key, i) => [key, widths[i]]));
        }

        const floors = cols.map((key) => Math.min(WAR_TARGET_COLUMNS[key].hardFloor ?? 24, naturalWidths[cols.indexOf(key)]));
        const floorTotal = floors.reduce((sum, w) => sum + w, 0);

        if (floorTotal >= availableWidth) {
            // Even hard floors don't fit (extremely narrow viewport) — scale floors down
            // proportionally as a last resort rather than forcing horizontal scroll.
            const scale = availableWidth / floorTotal;
            return Object.fromEntries(cols.map((key, i) => [key, Math.max(18, Math.floor(floors[i] * scale))]));
        }

        const shrinkable = naturalTotal - floorTotal;
        const extraToRemove = naturalTotal - availableWidth;
        const shrinkRatio = extraToRemove / shrinkable;
        return Object.fromEntries(cols.map((key, i) => {
            const reducible = naturalWidths[i] - floors[i];
            const width = Math.round(naturalWidths[i] - reducible * shrinkRatio);
            return [key, Math.max(floors[i], width)];
        }));
    }

    // Estimates the usable pixel width for the war-target table (widget width, minus
    // widget-body padding and the table-wrap border) so columns can be sized to fit
    // before the table is even in the DOM (colgroup widths are computed at render time).
    function getWarTargetTableAvailableWidth() {
        const widgetPadding = 20; // #widget-main-body has 10px padding on each side
        const wrapBorder = 2;     // .ntc-war-target-table-wrap has a 1px border on each side
        // state.dashboard is only assigned AFTER the widget element is appended to the page
        // (see initializeDOMDashboard). But if FFScouter is the tab restored from a previous
        // session, THIS function can run while the dashboard's very first innerHTML is still
        // being built — before state.dashboard exists. In that case state.dashboard.clientWidth
        // was silently returning null, which made computeResponsiveColumnWidths() fall back to
        // full natural column widths (~514px) instead of fitting the container — and since the
        // wrap div uses overflow-x:hidden (not the old scrollable overflow:auto), the overflow
        // columns (FF, Attack) were clipped invisibly rather than reachable via scroll.
        // Fix: fall back to getCurrentWidgetSize(), which reads the same stored/default width
        // the widget is about to actually open at — entirely from state, no DOM needed.
        const rawWidth = state.dashboard ? state.dashboard.clientWidth : getCurrentWidgetSize().width;
        const width = rawWidth - widgetPadding - wrapBorder;
        return Number.isFinite(width) && width > 0 ? width : null;
    }



    function renderWarTargetSortHeader(key) {
        const column = WAR_TARGET_COLUMNS[key];
        const active = state.warTargetSort?.key === key;
        const indicator = active ? (state.warTargetSort.direction === "asc" ? " ▲" : " ▼") : " ↕";
        return `<th data-war-target-sort="${key}" data-war-column-key="${key}" style="position:relative;padding:7px 15px 7px 7px;cursor:pointer;user-select:none;white-space:nowrap;text-align:${column.align};overflow:hidden;text-overflow:ellipsis;">
            <span data-war-column-drag="${key}" draggable="true" title="Drag to reorder" style="display:inline-block;margin-right:4px;color:#697582;cursor:grab;font-size:10px;">⠿</span>${escapeHtml(column.label)}<span style="color:${active ? "#9dd8ff" : "#697582"};font-size:9px;">${indicator}</span>
            <span data-war-column-resize="${key}" title="Drag to resize" style="position:absolute;right:0;top:0;width:8px;height:100%;cursor:col-resize;border-right:2px solid #46505d;"></span>
        </th>`;
    }

    function renderWarTargetCell(key, target, display) {
        switch (key) {
            case "player":
                return `<td style="padding:8px 7px;overflow:hidden;"><a href="https://www.torn.com/profiles.php?XID=${target.id}" target="_blank" rel="noopener noreferrer" style="color:#9dd8ff;font-weight:800;text-decoration:none;overflow-wrap:anywhere;">${escapeHtml(target.name)}</a><div style="color:#7f8996;font-size:9px;white-space:nowrap;">ID ${target.id} · Level ${formatInteger(target.level)}</div></td>`;
            case "online":
                return `<td style="padding:8px 7px;color:${display.onlineColor};font-weight:800;overflow:hidden;">${escapeHtml(display.online)}<div style="color:#7f8996;font-size:9px;font-weight:500;overflow-wrap:anywhere;">${escapeHtml(target.lastAction?.relative || "")}</div></td>`;
            case "status":
                return `<td style="padding:8px 7px;color:${display.statusColor};font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${display.statusDisplay}</td>`;
            case "stats":
                return `<td style="padding:8px 7px;text-align:right;color:#c9a0ff;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(display.estimate)}<div style="color:#7f8996;font-size:9px;font-weight:500;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(target.estimateSource || "")} ${escapeHtml(display.estimateAge)}</div></td>`;
            case "ff":
                return `<td style="padding:8px 7px;text-align:center;color:#7fe18d;font-size:13px;font-weight:900;white-space:nowrap;overflow:hidden;">${display.ff}</td>`;
            case "attack":
                return `<td style="padding:8px 7px;text-align:center;white-space:nowrap;overflow:hidden;"><a class="ntc-attack-button" href="https://www.torn.com/page.php?sid=attack&user2ID=${target.id}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#8f3434;color:#fff;border-radius:5px;padding:5px 8px;font-size:10px;font-weight:800;text-decoration:none;white-space:nowrap;overflow-wrap:normal;word-break:keep-all;">Attack</a></td>`;
            default:
                return "";
        }
    }

    function renderFFScouterWarTargets(faction) {
        const data = faction.warTargets || null;
        const war = faction.war || data?.war || null;
        if (!war) {
            return `<div style="border:1px solid #343a43;border-radius:8px;padding:12px;color:#aaa;background:rgba(20,20,20,.7);font-size:11px;">No active Ranked War enemy faction.</div>`;
        }
        if (!getStoredFFScouterKey()) {
            return `<div style="border:1px solid #654d2d;border-radius:8px;padding:12px;color:#e0a25e;background:rgba(55,38,18,.55);font-size:11px;line-height:1.5;">Add and verify your separate FFScouter-linked Torn API key under <strong>Settings → Integrations</strong> to load projected stats and Fair Fight values.</div>`;
        }

        const allTargets = Array.isArray(data?.targets) ? data.targets : [];
        const targets = sortWarTargets(filterWarTargets(allTargets));
        const onlineCount = targets.filter((target) => /^(online|idle)$/i.test(String(target.lastAction?.status || ""))).length;
        const okayCount = targets.filter((target) => getWarTargetStatus(target).kind === "okay").length;
        const refreshed = data?.liveFetchedAt ? new Date(data.liveFetchedAt).toLocaleTimeString() : "Not loaded";
        const notices = [data?.error, data?.statsError ? `FFScouter: ${data.statsError}` : "", data?.liveError ? `Live profile batches unavailable; using faction roster status. ${data.liveError}` : ""].filter(Boolean);
        const columnOrder = state.warTargetColumnOrder.filter((key) => WAR_TARGET_COLUMNS[key]);
        const responsiveColumnWidths = computeResponsiveColumnWidths(columnOrder, getWarTargetTableAvailableWidth());
        const activeSort = WAR_TARGET_COLUMNS[state.warTargetSort?.key] || WAR_TARGET_COLUMNS.status;
        const sortDirection = state.warTargetSort?.direction === "desc" ? "Descending" : "Ascending";
        const filterGroups = [
            { label: "Status", options: [["okay", "Okay"], ["hospitalized", "Hospitalized"], ["traveling", "Abroad / Traveling"]] },
            { label: "Activity", options: [["online", "Online"], ["idle", "Idle"], ["offline", "Offline"]] }
        ];
        const filterPanel = filterGroups.map((group) => `
            <div style="display:flex;align-items:center;gap:5px;flex:1 1 230px;min-width:0;flex-wrap:wrap;">
                <span class="ntc-war-filter-group-label" style="color:#929eac;font-size:9px;font-weight:850;text-transform:uppercase;letter-spacing:.45px;min-width:48px;">${group.label}</span>
                ${group.options.map(([key, label]) => `<label class="ntc-war-target-filter-option" style="display:inline-flex;align-items:center;gap:4px;border:1px solid #3a424d;border-radius:999px;padding:3px 6px;background:rgba(255,255,255,.035);color:#d7dde5;font-size:9px;font-weight:700;cursor:pointer;white-space:nowrap;"><input data-war-target-filter="${key}" type="checkbox" ${state.warTargetFilters[key] !== false ? "checked" : ""} style="width:12px;height:12px;margin:0;accent-color:#5ba7f7;cursor:pointer;">${label}</label>`).join("")}
            </div>
        `).join("");
        const ffRangeActive = String(state.warTargetFFRange.min).trim() !== "" || String(state.warTargetFFRange.max).trim() !== "";
        const ffRangePanel = `
            <div class="ntc-war-ff-range" style="display:flex;align-items:center;gap:5px;flex:1 1 205px;min-width:0;flex-wrap:wrap;">
                <span class="ntc-war-filter-group-label" style="color:#929eac;font-size:9px;font-weight:850;text-transform:uppercase;letter-spacing:.45px;min-width:48px;">FF Range</span>
                <input id="war-ff-min-input" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(state.warTargetFFRange.min)}" placeholder="Min" aria-label="Minimum Fair Fight score" style="width:58px;min-width:52px;background:#111820;border:1px solid #3a424d;border-radius:5px;color:#d7dde5;padding:4px 5px;font-size:9px;">
                <span style="color:#697582;font-size:9px;">to</span>
                <input id="war-ff-max-input" type="number" min="0" step="0.01" inputmode="decimal" value="${escapeHtml(state.warTargetFFRange.max)}" placeholder="Max" aria-label="Maximum Fair Fight score" style="width:58px;min-width:52px;background:#111820;border:1px solid #3a424d;border-radius:5px;color:#d7dde5;padding:4px 5px;font-size:9px;">
                <button id="clear-war-ff-range-btn" type="button" ${ffRangeActive ? "" : "disabled"} style="border:1px solid #3a424d;border-radius:5px;background:${ffRangeActive ? "#303944" : "#20262d"};color:${ffRangeActive ? "#d7dde5" : "#697582"};padding:4px 6px;font-size:9px;cursor:${ffRangeActive ? "pointer" : "default"};">${ffRangeActive ? "Clear" : "Off"}</button>
            </div>
        `;
        const rows = targets.map((target) => {
            const online = String(target.lastAction?.status || "Unknown");
            const onlineColor = online === "Online" ? "#7fe18d" : online === "Idle" ? "#e0a25e" : "#9aa4b2";
            const status = getWarTargetStatus(target);
            const statusRemaining = Math.max(0, (status.untilMs - Date.now()) / 1000);
            const statusSuffix = status.kind === "travel" && status.destination ? ` · ${status.destination}` : "";
            const statusColor = status.kind === "okay" ? "#7fe18d" : status.kind === "hospital" ? "#e05959" : "#e0a25e";
            const statusDisplay = status.kind !== "okay" && statusRemaining > 0
                ? `<span data-countdown-type="war-target-status" data-until-ms="${status.untilMs}" data-status-suffix="${escapeHtml(statusSuffix)}" data-status-fallback="${escapeHtml(status.label + statusSuffix)}">${formatDuration(Math.ceil(statusRemaining))}${escapeHtml(statusSuffix)}</span>`
                : escapeHtml(status.label + statusSuffix);
            const estimate = target.noEstimate || !target.battleStats
                ? "No estimate"
                : (target.battleStatsHuman || formatInteger(target.battleStats));
            const ff = target.fairFight > 0 ? Number(target.fairFight).toFixed(2) : "—";
            const estimateAge = target.estimateUpdatedAt ? formatRelativeTime(target.estimateUpdatedAt) : "—";
            const display = { online, onlineColor, statusColor, statusDisplay, estimate, ff, estimateAge };
            return `
                <tr style="border-bottom:1px solid #2c333c;">
                    ${columnOrder.map((key) => renderWarTargetCell(key, target, display)).join("")}
                </tr>
            `;
        }).join("");

        return `
            <div class="ntc-ffscouter-layout" style="display:flex;flex-direction:column;gap:9px;min-height:0;height:100%;">
                <div style="border:1px solid #343a43;border-radius:8px;padding:10px;background:rgba(20,20,20,.72);display:grid;gap:8px;">
                    <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;flex-wrap:wrap;">
                        <div><div style="color:#fff;font-size:13px;font-weight:850;">${escapeHtml(war.oppTag)} War Targets</div><div style="color:#929eac;font-size:10px;margin-top:2px;">${targets.length} shown / ${allTargets.length} members · Live updated ${escapeHtml(refreshed)} · ${escapeHtml(data?.liveSource || "Torn")}</div><div style="color:#697582;font-size:9px;margin-top:3px;">Availability: Okay → Hospital (soonest first) → Traveling/Abroad · click headers to sort within groups</div><div style="color:#697582;font-size:9px;margin-top:2px;">Drag ⠿ to reorder columns · drag a header's right edge to resize</div></div>
                        <div style="display:flex;gap:6px;flex-wrap:wrap;"><button id="refresh-war-live-btn" style="background:#3b5998;color:#fff;border:0;border-radius:5px;padding:6px 9px;font-size:10px;cursor:pointer;">Refresh Live Status</button><button id="refresh-war-all-btn" style="background:#2f6f50;color:#fff;border:0;border-radius:5px;padding:6px 9px;font-size:10px;cursor:pointer;">Refresh All Data</button></div>
                    </div>
                    <div class="ntc-war-target-filter-panel" style="display:flex;align-items:center;gap:7px 12px;flex-wrap:wrap;border:1px solid #343d48;border-radius:7px;padding:6px 8px;background:rgba(11,15,20,.72);">
                        <div style="display:grid;gap:1px;flex:0 0 auto;"><span class="ntc-war-filter-heading" style="color:#fff;font-size:10px;font-weight:900;">Sort &amp; View</span><span style="color:#697582;font-size:8px;white-space:nowrap;">${escapeHtml(activeSort.label)} · ${sortDirection}</span></div>
                        ${filterPanel}
                        ${ffRangePanel}
                    </div>
                    <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;">${buildStatCard("Online / Idle", onlineCount, "Live Torn status", "#7fe18d")}${buildStatCard("Healthy", okayCount, "Status: Okay", "#5ba7f7")}</div>
                    ${notices.map((notice) => `<div style="color:#e0a25e;font-size:10px;line-height:1.4;">⚠ ${escapeHtml(notice)}</div>`).join("")}
                </div>
                <div class="ntc-war-target-table-wrap" style="width:100%;min-width:0;min-height:160px;flex:1 1 auto;border:1px solid #343a43;border-radius:8px;overflow-y:auto;overflow-x:hidden;background:rgba(15,15,15,.78);">
                    <table class="ntc-war-target-table" style="width:100%;table-layout:fixed;border-collapse:collapse;font-size:10px;">
                        <colgroup>${columnOrder.map((key) => `<col data-war-column="${key}" style="width:${responsiveColumnWidths[key]}px;">`).join("")}</colgroup>
                        <thead style="position:sticky;top:0;z-index:2;background:#252b33;color:#dce2e9;text-align:left;"><tr>${columnOrder.map(renderWarTargetSortHeader).join("")}</tr></thead>
                        <tbody>${rows || `<tr><td colspan="${columnOrder.length}" style="padding:18px;text-align:center;color:#8f99a5;">${escapeHtml(data?.error || (allTargets.length ? "No targets match the current view filters." : "No targets loaded yet."))}</td></tr>`}</tbody>
                    </table>
                </div>
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

        const factionSubTabs = [
            { id: "general", label: "General" },
            { id: "ffscouter", label: "FFScouter" }
        ];
        const activeSubTab = factionSubTabs.some((tab) => tab.id === state.factionSubTab) ? state.factionSubTab : "general";
        const subTabButtons = factionSubTabs.map((tab) => `<button data-faction-subtab="${tab.id}" style="background:${activeSubTab === tab.id ? "#3b5998" : "#2a2a2a"};border:1px solid #3d3d3d;color:#fff;border-radius:4px;padding:6px 8px;font-size:11px;cursor:pointer;${activeSubTab === tab.id ? "font-weight:700;" : ""}">${tab.label}</button>`).join("");
        const generalContent = `
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin-bottom: 10px;">${cards}</div>
            ${renderChainBar(chain)}
            ${renderWarCard(war)}
            <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">${contributionCards}</div>
        `;
        return `
            ${renderSectionMeta("faction", "Faction")}
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">${subTabButtons}</div>
            ${activeSubTab === "ffscouter" ? renderFFScouterWarTargets(faction) : generalContent}
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
                value: `${employee.position?.name || employee.position || "Unknown role"}${employee.effectiveness?.total !== undefined ? ` · ${formatInteger(employee.effectiveness.total)} effectiveness` : ""}`
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
            { key: "inventory", label: "Inventory" }
        ];

        const currentSubTab = state.settingsSubTab || "controls";
        const dialogBackground = state.theme === "light" ? "#f7f9fc" : "#17191d";
        const dialogText = state.theme === "light" ? "#17202b" : "#f1f3f5";
        const dialogMuted = state.theme === "light" ? "#536170" : "#aeb7c2";
        const exportMarkup = snapshotButtons.map(({ key, label }) => `
            <button data-export-section="${key}" style="background: #2f5d3d; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Download ${label} to .csv</button>
        `).join("");

        const refreshMarkup = snapshotButtons.map(({ key, label }) => `
            <button data-refresh-section="${key}" style="background: #6058b8; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Refresh ${label}</button>
        `).join("");

        const subTabButtons = [
            { id: "controls", label: "Controls" },
            { id: "integrations", label: "Integrations" },
            { id: "export", label: "Exports" }
        ].map(({ id, label }) => `
            <button data-settings-subtab="${id}" style="background: ${currentSubTab === id ? '#3b5998' : '#2a2a2a'}; border: 1px solid #3d3d3d; color: #fff; border-radius: 4px; padding: 6px 8px; font-size: 10px; cursor: pointer;">${label}</button>
        `).join("");

        const controlsContent = `
                <div style="display: grid; gap: 10px;">
                    <div style="border: 1px solid #3d3d3d; border-radius: 6px; padding: 10px; display: grid; gap: 7px;">
                        <div style="color: #fff; font-weight: 700; font-size: 12px;">Appearance</div>
                        <div style="color: #aaa; font-size: 11px;">Current mode: ${state.theme === "light" ? "Light" : "Dark"}</div>
                        <button id="theme-toggle-btn" style="background: #3b5998; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Switch to ${state.theme === "light" ? "Dark" : "Light"} Mode</button>
                    </div>
                    <div style="border: 1px solid #3d3d3d; border-radius: 6px; padding: 10px; display: grid; gap: 7px;">
                        <div style="color: #fff; font-weight: 700; font-size: 12px;">Window</div>
                        <div style="color: #aaa; font-size: 11px; line-height: 1.4;">Clears every saved size and position for every tab, and re-applies the default layout for this device (full-width below the icon row on mobile/PDA, a floating panel on desktop).</div>
                        <button id="reset-window-size-btn" style="background: #a13b3b; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Reset Window Size &amp; Position</button>
                    </div>
                    <div style="color: #fff; font-weight: 700; font-size: 12px;">Naughty Torn Companion · Torn API Key</div>
                    <div style="display: flex; gap: 8px;">
                        <input type="password" id="torn-api-key-input" value="${escapeHtml(getStoredKey())}" style="background: #111; border: 1px solid #444; border-radius: 6px; color: #fff; padding: 8px; flex: 1; font-size: 11px;" placeholder="Enter Torn API key" />
                        <button id="save-api-key-btn" style="background: #3b5998; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Save</button>
                    </div>
                    <button id="full-refresh-btn" style="background: #a13b3b; color: white; border: none; border-radius: 6px; padding: 8px 12px; font-size: 11px; cursor: pointer;">Refresh all sections</button>
                    <div style="display: grid; gap: 6px;">${refreshMarkup}</div>
                </div>
            `;
        const integrationsContent = `
                <div style="border: 1px solid #3d3d3d; border-radius: 8px; padding: 11px; display: grid; gap: 9px; background: rgba(255,255,255,0.02);">
                    <div>
                        <div style="color: #fff; font-weight: 800; font-size: 13px;">FFScouter</div>
                        <div style="color: #aaa; font-size: 11px; line-height: 1.45; margin-top: 3px;">Enter the Torn API key registered with FFScouter. This credential is stored separately and is never substituted for the Naughty Torn Companion Torn API key.</div>
                    </div>
                    <div style="display: flex; gap: 7px; flex-wrap: wrap;">
                        <input type="password" id="ffscouter-api-key-input" value="${escapeHtml(getStoredFFScouterKey())}" maxlength="16" autocomplete="off" style="background: #111; border: 1px solid #444; border-radius: 6px; color: #fff; padding: 8px; flex: 1 1 190px; min-width: 0; font-size: 11px;" placeholder="16-character FFScouter-linked Torn key" />
                        <button id="save-ffscouter-key-btn" style="background: #3b5998; color: white; border: none; border-radius: 6px; padding: 8px 11px; font-size: 11px; cursor: pointer;">Save</button>
                        <button id="verify-ffscouter-key-btn" style="background: #2f6f50; color: white; border: none; border-radius: 6px; padding: 8px 11px; font-size: 11px; cursor: pointer;">Verify</button>
                        <button id="clear-ffscouter-key-btn" style="background: #7a3535; color: white; border: none; border-radius: 6px; padding: 8px 11px; font-size: 11px; cursor: pointer;">Clear</button>
                    </div>
                    <div id="ffscouter-key-status" style="color: ${state.ffscouterStatus.startsWith("Verified") ? "#7fe18d" : "#bfc7d1"}; font-size: 11px; line-height: 1.4;">${escapeHtml(state.ffscouterStatus)}</div>
                    <a href="https://ffscouter.com/api-docs" target="_blank" rel="noopener noreferrer" style="color: #70b7ff; font-size: 10px; text-decoration: underline; width: fit-content;">FFScouter API documentation</a>
                    <dialog id="ffscouter-verification-dialog" style="width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 40px); overflow-y: auto; border: 1px solid #4a5564; border-radius: 10px; padding: 0; background: ${dialogBackground}; color: ${dialogText}; box-shadow: 0 18px 60px rgba(0,0,0,0.55);">
                        <div style="padding: 16px; display: grid; gap: 12px;">
                            <div id="ffscouter-dialog-title" style="font-size: 15px; font-weight: 850; line-height: 1.3;">FFScouter Key Status</div>
                            <div id="ffscouter-dialog-summary" style="color: ${dialogMuted}; font-size: 11px; line-height: 1.5;"></div>
                            <div id="ffscouter-dialog-details" style="display: grid; gap: 6px;"></div>
                            <button id="close-ffscouter-dialog-btn" type="button" style="justify-self: end; background: #3b5998; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 11px; font-weight: 700; cursor: pointer;">Close</button>
                        </div>
                    </dialog>
                </div>
            `;
        const exportContent = `
                <div style="display: grid; gap: 6px;">
                    ${exportMarkup}
                </div>
            `;
        const content = currentSubTab === "integrations"
            ? integrationsContent
            : (currentSubTab === "export" ? exportContent : controlsContent);

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
            <div class="ntc-inventory-layout" style="display:grid;grid-template-rows:auto minmax(0,1fr);gap:8px;min-height:0;height:100%;">
                <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">
                    ${buildStatCard("Inventory Items", inventory.totalCount || 0, "Tracked item count", "#7fe18d")}
                    ${buildStatCard("Inventory Value", formatMoney(inventory.totalValue || 0), "Estimated market value", "#85bb65")}
                </div>
                <div class="ntc-inventory-table-wrap" style="min-height:160px;overflow:auto;border:1px solid #222;background-color:#151515;border-radius:3px;">
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
        const ffscouterKeyInput = document.getElementById("ffscouter-api-key-input");
        const saveFFScouterButton = document.getElementById("save-ffscouter-key-btn");
        const verifyFFScouterButton = document.getElementById("verify-ffscouter-key-btn");
        const clearFFScouterButton = document.getElementById("clear-ffscouter-key-btn");
        const ffscouterStatus = document.getElementById("ffscouter-key-status");
        const ffscouterDialog = document.getElementById("ffscouter-verification-dialog");
        const ffscouterDialogTitle = document.getElementById("ffscouter-dialog-title");
        const ffscouterDialogSummary = document.getElementById("ffscouter-dialog-summary");
        const ffscouterDialogDetails = document.getElementById("ffscouter-dialog-details");
        const closeFFScouterDialogButton = document.getElementById("close-ffscouter-dialog-btn");
        const status = document.getElementById("fetch-status-bar");
        const exportButtons = contentEl.querySelectorAll("[data-export-section]");
        const refreshSectionButtons = contentEl.querySelectorAll("[data-refresh-section]");
        const subTabButtons = contentEl.querySelectorAll("[data-settings-subtab]");

        const setFFScouterStatus = (message, color = "#bfc7d1") => {
            state.ffscouterStatus = message;
            if (ffscouterStatus) {
                ffscouterStatus.textContent = message;
                ffscouterStatus.style.color = color;
            }
        };

        const showFFScouterDialog = ({ title, summary, color, rows = [] }) => {
            if (ffscouterDialogTitle) {
                ffscouterDialogTitle.textContent = title;
                ffscouterDialogTitle.style.color = color || "#f1f3f5";
            }
            if (ffscouterDialogSummary) ffscouterDialogSummary.textContent = summary;
            if (ffscouterDialogDetails) {
                ffscouterDialogDetails.replaceChildren();
                rows.forEach(([label, value]) => {
                    const row = document.createElement("div");
                    row.style.cssText = "display:grid;grid-template-columns:minmax(115px,0.8fr) minmax(0,1.2fr);gap:10px;padding:7px 8px;border:1px solid #3d4652;border-radius:6px;font-size:10px;line-height:1.4;";
                    const labelEl = document.createElement("span");
                    labelEl.style.cssText = "color:#929eac;font-weight:750;";
                    labelEl.textContent = String(label);
                    const valueEl = document.createElement("span");
                    valueEl.style.cssText = "color:inherit;font-weight:650;overflow-wrap:anywhere;text-align:right;";
                    valueEl.textContent = String(value);
                    row.append(labelEl, valueEl);
                    ffscouterDialogDetails.appendChild(row);
                });
            }
            if (ffscouterDialog?.showModal && !ffscouterDialog.open) ffscouterDialog.showModal();
        };

        if (closeFFScouterDialogButton && !closeFFScouterDialogButton.dataset.bound) {
            closeFFScouterDialogButton.dataset.bound = "true";
            closeFFScouterDialogButton.onclick = () => ffscouterDialog?.close();
        }

        if (saveButton && !saveButton.dataset.bound) {
            saveButton.dataset.bound = "true";
            saveButton.onclick = () => {
                const apiKey = apiKeyInput ? apiKeyInput.value : getStoredKey();
                setStoredKey(apiKey);
                debugLog("API key saved", { length: String(apiKey || "").length });
                if (status) status.innerText = "🔑 API key saved locally.";
            };
        }

        if (saveFFScouterButton && !saveFFScouterButton.dataset.bound) {
            saveFFScouterButton.dataset.bound = "true";
            saveFFScouterButton.onclick = () => {
                try {
                    const key = validateFFScouterKey(ffscouterKeyInput?.value);
                    setStoredFFScouterKey(key);
                    setFFScouterStatus("Saved · Not verified");
                    if (status) status.textContent = "FFScouter key saved separately.";
                } catch (error) {
                    setFFScouterStatus(error.message, "#e05959");
                }
            };
        }

        if (verifyFFScouterButton && !verifyFFScouterButton.dataset.bound) {
            verifyFFScouterButton.dataset.bound = "true";
            verifyFFScouterButton.onclick = async () => {
                verifyFFScouterButton.disabled = true;
                setFFScouterStatus("Verifying with FFScouter...", "#9dd8ff");
                try {
                    const result = await verifyFFScouterKey(ffscouterKeyInput?.value);
                    const details = getFFScouterVerificationDetails(result.data);
                    showFFScouterDialog(details);
                    if (!result.data?.is_registered) {
                        setFFScouterStatus("Unregistered · FFScouter does not recognize this key", "#e0a25e");
                        if (status) status.textContent = "FFScouter key is not registered.";
                        return;
                    }
                    setStoredFFScouterKey(result.key);
                    const premium = result.data?.is_premium
                        ? ` · Premium (${String(result.data.premium_entitlement_source || "active").replaceAll("_", " ")})`
                        : (Number(result.data?.premium_expires_at || 0) > 0 ? " · Premium expired" : " · Premium inactive");
                    const policy = result.data?.policy_update_required ? " · Policy update required" : "";
                    const remaining = result.limits ? ` · ${result.limits.remaining}/${result.limits.limit} requests remaining` : "";
                    setFFScouterStatus(`Verified · Registered${premium}${policy}${remaining}`, result.data?.policy_update_required ? "#e0a25e" : "#7fe18d");
                    if (status) status.textContent = "FFScouter connection verified and key saved.";
                } catch (error) {
                    setFFScouterStatus(`Verification failed · ${error.message}`, "#e05959");
                    showFFScouterDialog({
                        title: "FFScouter Verification Failed",
                        summary: error.message,
                        color: "#e05959",
                        rows: [["Status", "Invalid, inactive, or unavailable"]]
                    });
                } finally {
                    verifyFFScouterButton.disabled = false;
                }
            };
        }

        if (clearFFScouterButton && !clearFFScouterButton.dataset.bound) {
            clearFFScouterButton.dataset.bound = "true";
            clearFFScouterButton.onclick = () => {
                setStoredFFScouterKey("");
                if (ffscouterKeyInput) ffscouterKeyInput.value = "";
                setFFScouterStatus("Not configured");
                if (status) status.textContent = "FFScouter key cleared.";
            };
        }

        if (fullRefreshButton && !fullRefreshButton.dataset.bound) {
            fullRefreshButton.dataset.bound = "true";
            fullRefreshButton.onclick = async () => {
                debugLog("Full section refresh button clicked");
                if (status) status.innerText = "Refreshing all sections...";
                // Explicit manual "refresh everything" action — unlike automatic/periodic
                // refresh (which only ever touches overview/personal/faction), this button
                // deliberately opts into company/inventory too since the user asked for
                // genuinely everything. Activity tab has been removed entirely.
                await refreshAllSections({ includeCompany: true, includeInventory: true });
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

        const resetWindowButton = document.getElementById("reset-window-size-btn");
        if (resetWindowButton && !resetWindowButton.dataset.bound) {
            resetWindowButton.dataset.bound = "true";
            resetWindowButton.onclick = () => {
                // Clears every saved per-tab size, so normalizeWidgetSize() falls back to
                // its defaults again (mobile: full width + height below the icon row;
                // desktop: the standard ~480px floating panel) — same mechanism as a
                // genuine first run, just re-triggerable on demand instead of only once.
                state.windowSizes = {};
                setStoredDashboardState({ windowSizes: state.windowSizes });
                const defaultPosition = isMobileEnvironment()
                    ? { edge: "right", x: null, y: MOBILE_TOP_OFFSET_PX }
                    : { edge: "right", x: null, y: 20 };
                setStoredPosition(defaultPosition);
                applyCurrentWidgetSize();
                applyWidgetPosition();
                debugLog("Window size & position reset to defaults", { isMobileEnvironment: isMobileEnvironment(), defaultPosition });
                renderTabContent();
            };
        }

        subTabButtons.forEach((button) => {
            if (button.dataset.bound === "true") return;
            button.dataset.bound = "true";
            button.onclick = () => {
                const tabKey = button.getAttribute("data-settings-subtab");
                if (tabKey) {
                    captureCurrentWidgetSize(false);
                    state.settingsSubTab = tabKey;
                    setStoredDashboardState({ settingsSubTab: tabKey, windowSizes: state.windowSizes });
                    applyCurrentWidgetSize();
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
                captureCurrentWidgetSize(false);
                state.personalSubTab = subTab;
                setStoredDashboardState({ personalSubTab: subTab, windowSizes: state.windowSizes });
                applyCurrentWidgetSize();
                renderTabContent();
            };
        });
    }

    async function refreshWarTargets(includeStats = false) {
        if (state.warTargetsRefreshInFlight) return false;
        const faction = state.caches.faction || {};
        const war = faction.war || null;
        const apiKey = getStoredKey();
        if (!apiKey || !war || !getStoredFFScouterKey()) return false;
        const existing = faction.warTargets || {};
        state.warTargetsRefreshInFlight = true;
        try {
            const refreshed = await fetchWarTargetData(apiKey, war, [], {
                includeStats: includeStats || !Array.isArray(existing.ffResults) || existing.ffResults.length === 0,
                existingStats: existing.ffResults || [],
                statsFetchedAt: existing.statsFetchedAt || 0
            });
            const currentFaction = state.caches.faction || {};
            if (Number(currentFaction.war?.warId || 0) !== Number(war.warId || 0)) return false;
            state.caches.faction = { ...currentFaction, warTargets: { ...refreshed, war: { ...war } } };
            void gmSetValue(APP_STORAGE.sections.faction, {
                data: state.caches.faction,
                lastRefresh: state.lastRefreshBySection.faction,
                status: state.sectionStatus.faction
            });
            if (state.currentTab === "faction" && state.factionSubTab === "ffscouter") renderTabContent();
            return true;
        } catch (error) {
            const currentFaction = state.caches.faction || {};
            if (Number(currentFaction.war?.warId || 0) === Number(war.warId || 0)) {
                state.caches.faction = {
                    ...currentFaction,
                    warTargets: { ...existing, war: { ...war }, error: error.message, liveFetchedAt: Date.now() }
                };
            }
            if (state.currentTab === "faction" && state.factionSubTab === "ffscouter") renderTabContent();
            return false;
        } finally {
            state.warTargetsRefreshInFlight = false;
        }
    }

    function bindFactionControls() {
        const contentEl = document.getElementById("torn-companion-content");
        if (!contentEl || state.currentTab !== "faction") return;
        contentEl.querySelectorAll("[data-war-target-filter]").forEach((input) => {
            input.onchange = () => {
                const key = input.getAttribute("data-war-target-filter");
                if (!(key in WAR_TARGET_FILTER_DEFAULTS)) return;
                state.warTargetFilters = { ...state.warTargetFilters, [key]: input.checked };
                setStoredDashboardState({ warTargetFilters: state.warTargetFilters });
                renderTabContent();
            };
        });
        const minFFInput = document.getElementById("war-ff-min-input");
        const maxFFInput = document.getElementById("war-ff-max-input");
        const clearFFRangeButton = document.getElementById("clear-war-ff-range-btn");
        const saveFFRange = () => {
            const normalizeFFBound = (value) => {
                const text = String(value || "").trim();
                if (!text) return "";
                const number = Number(text);
                return Number.isFinite(number) ? String(Math.max(0, number)) : "";
            };
            let min = normalizeFFBound(minFFInput?.value);
            let max = normalizeFFBound(maxFFInput?.value);
            if (min !== "" && max !== "" && Number(min) > Number(max)) [min, max] = [max, min];
            state.warTargetFFRange = { min, max };
            setStoredDashboardState({ warTargetFFRange: state.warTargetFFRange });
            renderTabContent();
        };
        if (minFFInput) minFFInput.onchange = saveFFRange;
        if (maxFFInput) maxFFInput.onchange = saveFFRange;
        [minFFInput, maxFFInput].filter(Boolean).forEach((input) => {
            input.onwheel = (event) => {
                event.preventDefault();
                const step = Number(input.step) || 0.01;
                const current = input.value === "" ? 0 : Number(input.value);
                const next = Math.max(0, (Number.isFinite(current) ? current : 0) + (event.deltaY < 0 ? step : -step));
                input.value = next.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
                saveFFRange();
            };
        });
        if (clearFFRangeButton) clearFFRangeButton.onclick = () => {
            state.warTargetFFRange = { min: "", max: "" };
            setStoredDashboardState({ warTargetFFRange: state.warTargetFFRange });
            renderTabContent();
        };
        contentEl.querySelectorAll("[data-war-target-sort]").forEach((header) => {
            header.onclick = (event) => {
                if (event.target.closest("[data-war-column-resize], [data-war-column-drag]")) return;
                const key = header.getAttribute("data-war-target-sort");
                if (!key) return;
                const current = state.warTargetSort || {};
                const defaultDirection = ["stats", "ff"].includes(key) ? "desc" : "asc";
                state.warTargetSort = {
                    key,
                    direction: key === "status"
                        ? "asc"
                        : current.key === key ? (current.direction === "asc" ? "desc" : "asc") : defaultDirection
                };
                setStoredDashboardState({ warTargetSort: state.warTargetSort });
                renderTabContent();
            };
        });
        let draggedColumn = null;
        contentEl.querySelectorAll("[data-war-column-drag]").forEach((handle) => {
            handle.ondragstart = (event) => {
                draggedColumn = handle.getAttribute("data-war-column-drag");
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", draggedColumn);
                handle.style.cursor = "grabbing";
            };
            handle.ondragend = () => {
                draggedColumn = null;
                handle.style.cursor = "grab";
            };
        });
        contentEl.querySelectorAll("[data-war-column-key]").forEach((header) => {
            header.ondragover = (event) => {
                if (!draggedColumn) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                header.style.boxShadow = "inset 3px 0 #9dd8ff";
            };
            header.ondragleave = () => {
                header.style.boxShadow = "";
            };
            header.ondrop = (event) => {
                event.preventDefault();
                header.style.boxShadow = "";
                const source = draggedColumn || event.dataTransfer.getData("text/plain");
                const target = header.getAttribute("data-war-column-key");
                if (!source || !target || source === target) return;
                const order = state.warTargetColumnOrder.filter((key) => key !== source);
                const targetIndex = order.indexOf(target);
                order.splice(Math.max(0, targetIndex), 0, source);
                state.warTargetColumnOrder = order;
                setStoredDashboardState({ warTargetColumnOrder: order });
                renderTabContent();
            };
        });
        contentEl.querySelectorAll("[data-war-column-resize]").forEach((handle) => {
            handle.onmousedown = (event) => {
                event.preventDefault();
                event.stopPropagation();
                const key = handle.getAttribute("data-war-column-resize");
                const column = contentEl.querySelector(`[data-war-column="${key}"]`);
                const definition = WAR_TARGET_COLUMNS[key];
                if (!column || !definition) return;
                const startX = event.clientX;
                const startWidth = column.getBoundingClientRect().width;
                handle.style.borderRightColor = "#9dd8ff";
                document.body.style.userSelect = "none";
                const onMove = (moveEvent) => {
                    const width = Math.min(600, Math.max(definition.minWidth, startWidth + moveEvent.clientX - startX));
                    column.style.width = `${width}px`;
                    state.warTargetColumnWidths = { ...state.warTargetColumnWidths, [key]: Math.round(width) };
                };
                const onUp = () => {
                    document.removeEventListener("mousemove", onMove);
                    document.removeEventListener("mouseup", onUp);
                    document.body.style.userSelect = "";
                    handle.style.borderRightColor = "#46505d";
                    setStoredDashboardState({ warTargetColumnWidths: state.warTargetColumnWidths });
                };
                document.addEventListener("mousemove", onMove);
                document.addEventListener("mouseup", onUp);
            };
        });
        contentEl.querySelectorAll("[data-faction-subtab]").forEach((button) => {
            button.onclick = () => {
                const subTab = button.getAttribute("data-faction-subtab");
                if (!subTab || subTab === state.factionSubTab) return;
                captureCurrentWidgetSize(false);
                state.factionSubTab = subTab;
                setStoredDashboardState({ factionSubTab: subTab, windowSizes: state.windowSizes });
                applyCurrentWidgetSize();
                renderTabContent();
                if (subTab === "ffscouter") void refreshWarTargets(false);
            };
        });
        const liveButton = document.getElementById("refresh-war-live-btn");
        const allButton = document.getElementById("refresh-war-all-btn");
        if (liveButton) liveButton.onclick = async () => {
            liveButton.disabled = true;
            liveButton.textContent = "Refreshing...";
            await refreshWarTargets(false);
        };
        if (allButton) allButton.onclick = async () => {
            allButton.disabled = true;
            allButton.textContent = "Refreshing...";
            await refreshWarTargets(true);
        };
    }

    function stopWarTargetsRefreshTimer() {
        if (state.warTargetsRefreshTimer) {
            clearInterval(state.warTargetsRefreshTimer);
            state.warTargetsRefreshTimer = null;
        }
    }

    function startWarTargetsRefreshTimer() {
        stopWarTargetsRefreshTimer();
        if (state.currentTab !== "faction" || state.factionSubTab !== "ffscouter") return;
        state.warTargetsRefreshTimer = setInterval(() => {
            if (state.currentTab !== "faction" || state.factionSubTab !== "ffscouter") {
                stopWarTargetsRefreshTimer();
                return;
            }
            void refreshWarTargets(false);
        }, 30 * 1000);
    }

    function bindOverviewControls() {
        const contentEl = document.getElementById("torn-companion-content");
        if (!contentEl || state.currentTab !== "overview") return;
        contentEl.querySelectorAll("[data-overview-subtab]").forEach((button) => {
            button.onclick = () => {
                const subTab = button.getAttribute("data-overview-subtab");
                if (!subTab || subTab === state.overviewSubTab) return;
                captureCurrentWidgetSize(false);
                state.overviewSubTab = subTab;
                setStoredDashboardState({ overviewSubTab: subTab, windowSizes: state.windowSizes });
                applyCurrentWidgetSize();
                renderTabContent();
            };
        });
    }

    // Only overview/personal/faction/company/inventory get this bar (settings has
    // its own dedicated "Refresh all sections" control already). Auto-refreshable
    // tabs (overview/personal-on-Info/faction) get a subtler note since they update
    // themselves; the manual-only ones (company/inventory) get a slightly more
    // prominent call to action since the button is their only path to fresh data.
    // Activity tab has been removed entirely (redundant with Torn's own built-in
    // notifications).
    const AUTO_REFRESH_TAB_SECTIONS = new Set(["overview", "personal", "faction"]);
    function renderSectionRefreshHeader(sectionKey, label) {
        const lastRefreshMs = state.lastRefreshBySection[sectionKey] || 0;
        const updatedText = lastRefreshMs ? formatRelativeTime(Math.floor(lastRefreshMs / 1000)) : "never";
        // Personal only actually auto-refreshes while the Info sub-tab is active —
        // Skills/Education, Perks, and Awards don't trigger the periodic cycle, so
        // the note needs to reflect that instead of always claiming "auto-refreshes".
        const isPersonalOnInfo = sectionKey === "personal" && state.personalSubTab === "info";
        const isAuto = sectionKey === "personal" ? isPersonalOnInfo : AUTO_REFRESH_TAB_SECTIONS.has(sectionKey);
        const noteText = sectionKey === "personal"
            ? (isPersonalOnInfo ? "auto-refreshes on Info" : "auto-refreshes only on Info sub-tab")
            : sectionKey === "faction"
                ? "live-updates (5s) while viewing"
                : (isAuto ? "auto-refreshes" : "manual refresh only");
        return `
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:5px 10px;background:rgba(255,255,255,0.03);border-bottom:1px solid #333;font-size:10px;color:#999;flex-shrink:0;">
                <span>UPDATED: <span data-section-updated="${sectionKey}" style="color:#ccc;">${escapeHtml(updatedText)}</span> <span style="color:#666;">(${label} ${noteText})</span></span>
                <button data-section-refresh="${sectionKey}" style="background:${isAuto ? "#2f5b8a" : "#8f5a1f"};color:#fff;border:none;border-radius:4px;padding:4px 10px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;flex-shrink:0;">🔄 Refresh</button>
            </div>
        `;
    }

    function bindSectionRefreshButtons() {
        const dashboard = state.dashboard;
        if (!dashboard) return;
        dashboard.querySelectorAll("[data-section-refresh]").forEach((button) => {
            if (button.dataset.bound === "true") return;
            button.dataset.bound = "true";
            button.onclick = async () => {
                const sectionKey = button.getAttribute("data-section-refresh");
                debugLog("Per-tab refresh button clicked", { sectionKey });
                button.disabled = true;
                button.textContent = "Refreshing...";
                await refreshSectionByKey(sectionKey, null);
                renderTabContent();
            };
        });
    }

    const SECTION_TAB_LABELS = {
        overview: "Overview",
        personal: "Personal",
        faction: "Faction",
        company: "Company",
        inventory: "Inventory"
    };

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
            case "settings":
                innerHtml = renderSettingsPanel();
                break;
            case "overview":
            default:
                innerHtml = renderOverviewPanel();
                break;
        }

        const refreshHeaderLabel = SECTION_TAB_LABELS[state.currentTab];
        if (refreshHeaderLabel) {
            innerHtml = renderSectionRefreshHeader(state.currentTab, refreshHeaderLabel) + innerHtml;
        }

        debugLog("Tab render", { previousTab, activeTab: state.currentTab, sectionStatus: state.sectionStatus });
        contentEl.classList.toggle("ntc-ffscouter-active", state.currentTab === "faction" && state.factionSubTab === "ffscouter");
        contentEl.classList.toggle("ntc-inventory-active", state.currentTab === "inventory");
        contentEl.innerHTML = innerHtml;
        bindInventoryTableControls();
        bindSettingsControls();
        bindPersonalControls();
        bindFactionControls();
        bindOverviewControls();
        bindSectionRefreshButtons();

        if (state.currentTab === "faction") {
            startChainCountdownTimer();
            startFactionLiveRefreshTimer();
        } else {
            stopChainCountdownTimer();
            stopFactionLiveRefreshTimer();
        }
        if (state.currentTab === "faction" && state.factionSubTab === "ffscouter") startWarTargetsRefreshTimer();
        else stopWarTargetsRefreshTimer();
        startCooldownCountdownTimer();
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
            const elements = document.querySelectorAll("[data-chain-seconds]");
            if (!elements.length || state.currentTab !== "faction") {
                stopChainCountdownTimer();
                return;
            }
            elements.forEach((el) => {
                const seconds = Number(el.dataset.chainSeconds || 0);
                const fetchedAt = Number(el.dataset.fetchedAt || Date.now());
                const remaining = getCountdownRemaining(seconds, fetchedAt, 0);
                el.textContent = remaining > 0 ? formatDuration(Math.ceil(remaining)) : (el.dataset.expiredText || "0s");
                el.style.color = remaining > 0 ? (el.dataset.activeColor || "#ccc") : (el.dataset.expiredColor || "#e05959");
            });
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
            updateBarTimers();
            const elements = document.querySelectorAll("[id^='cooldown-'][data-seconds]");
            elements.forEach((el) => {
                const seconds = Number(el.dataset.seconds || 0);
                const fetchedAt = Number(el.dataset.fetchedAt || Date.now());
                const untilMs = Number(el.dataset.untilMs || 0);
                const remaining = getCountdownRemaining(seconds, fetchedAt, untilMs);
                el.textContent = remaining > 0 ? formatDuration(Math.ceil(remaining)) : "Ready";
                el.style.color = remaining > 0 ? (el.dataset.activeColor || "#fff") : "#7fe18d";
            });
            document.querySelectorAll("[data-countdown-type]").forEach((el) => {
                const type = el.dataset.countdownType;
                const seconds = Number(el.dataset.seconds || 0);
                const fetchedAt = Number(el.dataset.fetchedAt || Date.now());
                const untilMs = Number(el.dataset.untilMs || 0);
                const remaining = getCountdownRemaining(seconds, fetchedAt, untilMs);
                if (type === "travel") {
                    el.textContent = remaining > 0 ? `Arriving in ${formatDuration(Math.ceil(remaining))}` : "Arriving soon";
                } else if (type === "status") {
                    el.textContent = remaining > 0 ? `${formatDuration(Math.ceil(remaining))} remaining` : "Expired";
                    el.style.color = remaining > 0 ? "#7fe18d" : "#e05959";
                } else if (type === "education") {
                    el.textContent = remaining > 0 ? `${formatDuration(Math.ceil(remaining))} left` : "Complete";
                } else if (type === "war-hospital") {
                    el.textContent = remaining > 0 ? `Out in ${formatDuration(Math.ceil(remaining))}` : "Attackable now";
                    el.style.color = remaining > 0 ? "#e05959" : "#7fe18d";
                } else if (type === "war-target-status") {
                    const suffix = el.dataset.statusSuffix || "";
                    el.textContent = remaining > 0
                        ? `${formatDuration(Math.ceil(remaining))}${suffix}`
                        : (el.dataset.statusFallback || "Okay");
                } else if (type === "trade") {
                    el.textContent = formatTimeUntil(untilMs / 1000);
                } else {
                    el.textContent = formatDuration(Math.ceil(remaining));
                }
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
        // Auto-refreshable core is ONLY overview/personal/faction now — company and
        // inventory are manual-refresh-only tabs and default to false here. The two
        // callers that want a genuinely complete refresh (the "Refresh all sections"
        // button and the one-time fresh-install bootstrap) explicitly pass both
        // flags true; every automatic/periodic caller uses the defaults and only
        // ever touches the core three. Activity tab has been removed entirely.
        const { includeCompany = false, includeInventory = false, silent = false } = options;
        const apiKey = getStoredKey();
        debugLog("Full refresh initiated", { includeCompany, includeInventory, silent, apiKeyPresent: !!apiKey });
        if (!apiKey) {
            const status = document.getElementById("fetch-status-bar");
            if (status && !silent) status.innerText = "⚠️ Enter a Torn API key before refreshing.";
            return false;
        }

        const status = document.getElementById("fetch-status-bar");
        try {
            state.lastRefresh = Date.now();
            const [overview, personal, faction] = await Promise.all([
                fetchOverviewData(apiKey),
                fetchPersonalData(apiKey),
                fetchFactionData(apiKey)
            ]);

            setSectionCache("overview", overview || state.caches.overview);
            setSectionCache("personal", personal || state.caches.personal);
            setSectionCache("faction", faction || state.caches.faction);

            if (includeCompany) {
                const company = await fetchCompanyData(apiKey);
                setSectionCache("company", company || state.caches.company);
            }

            // Inventory is intentionally excluded from every automatic/bulk refresh
            // path (periodic auto-refresh, startup staleness check, and this
            // "refresh all" action by default) unless explicitly opted into. It's a
            // manual-refresh-only tab — see its dedicated "Refresh" button
            // (refreshSectionByKey(...)), which is unaffected by this and always
            // works on demand.
            if (includeInventory) {
                const inventoryData = await fetchInventoryData(apiKey, status);
                setSectionCache("inventory", inventoryData || state.caches.inventory);
            }
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

    // Company updates automatically exactly once per day, at 18:10 UTC — checked by
    // performAutoRefreshCycle's 60-second tick. Manual refresh (the per-tab button,
    // or Settings > Controls) always works too regardless of this daily trigger.
    function isCompanyUpdateDue(now = Date.now()) {
        const date = new Date(now);
        const isTargetTime = date.getUTCHours() === 18 && date.getUTCMinutes() === 10;
        if (!isTargetTime) return false;

        const lastUpdate = state.lastRefreshBySection.company || 0;
        const lastDate = new Date(lastUpdate);
        return !(lastUpdate && lastDate.getUTCFullYear() === date.getUTCFullYear() && lastDate.getUTCMonth() === date.getUTCMonth() && lastDate.getUTCDate() === date.getUTCDate());
    }

    // Auto-refreshable tabs: Overview, Personal (only while the Info sub-tab is
    // active — Skills/Education, Perks, and Awards don't force a refresh cycle),
    // and Faction (which also gets its own much faster dedicated timer — see
    // startFactionLiveRefreshTimer — while actively being viewed, since Chain/War
    // progress needs to feel closer to real-time than the general 5-min cadence).
    // Company updates once daily at a fixed UTC time (see isCompanyUpdateDue).
    // Inventory is fully manual-only. Activity has been removed entirely.
    function performAutoRefreshCycle() {
        const apiKey = getStoredKey();
        if (!apiKey) {
            debugLog("Auto refresh skipped: no API key");
            state.autoRefreshTimer = setTimeout(performAutoRefreshCycle, 60 * 1000);
            return;
        }

        const now = Date.now();
        const sectionsToCheck = ["overview", "faction"];
        if (state.currentTab === "personal" && state.personalSubTab === "info") {
            sectionsToCheck.push("personal");
        }
        const quickRefreshDue = sectionsToCheck.some((section) => {
            const last = state.lastRefreshBySection[section] || 0;
            return now - last >= QUICK_REFRESH_MS;
        });
        const fullRefreshDue = now - (state.lastRefreshBySection.all || 0) >= AUTO_REFRESH_MS;
        const companyRefreshDue = isCompanyUpdateDue(now);

        debugLog("Auto refresh cycle", {
            quickRefreshDue,
            fullRefreshDue,
            companyRefreshDue,
            currentTab: state.currentTab,
            personalSubTab: state.personalSubTab,
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

        if (fullRefreshDue || quickRefreshDue) {
            tasks.push(refreshAllSections({ silent: true }));
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

    // Near-real-time Faction data refresh while the Faction tab is actually being
    // viewed — separate from and much faster than the general auto-refresh cadence
    // above, so Chain/War progress bars stay close to as fresh as the client-side
    // countdown timers (startChainCountdownTimer) that tick every 250ms. 5s at a
    // single fetch/tick = 12 requests/minute while actively watching the tab —
    // comfortably inside Torn's 100 req/min per-key budget alongside everything
    // else the widget fetches, but this is the fastest sane floor; going faster
    // than the API can realistically return fresh data within would just waste
    // calls without any visible benefit.
    const FACTION_LIVE_REFRESH_MS = 5 * 1000;

    function stopFactionLiveRefreshTimer() {
        if (state.factionLiveRefreshTimer) {
            clearInterval(state.factionLiveRefreshTimer);
            state.factionLiveRefreshTimer = null;
        }
    }

    function startFactionLiveRefreshTimer() {
        stopFactionLiveRefreshTimer();
        state.factionLiveRefreshTimer = setInterval(() => {
            if (state.currentTab !== "faction") {
                stopFactionLiveRefreshTimer();
                return;
            }
            if (!getStoredKey()) return;
            void refreshSectionByKey("faction", null);
        }, FACTION_LIVE_REFRESH_MS);
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

    const getWidgetSizeLimits = () => {
        const maxWidth = Math.max(120, window.innerWidth - 40);
        const maxHeight = Math.max(120, window.innerHeight - 20);
        return {
            minWidth: Math.min(340, maxWidth),
            minHeight: Math.min(280, maxHeight),
            maxWidth,
            maxHeight
        };
    };

    function normalizeWidgetSize(size = {}) {
        const limits = getWidgetSizeLimits();
        const width = Number(size.width);
        const height = Number(size.height);
        const hasStoredWidth = Number.isFinite(width);
        const hasStoredHeight = Number.isFinite(height);
        // Desktop default: a modest 480px-ish floating panel, ~80% of viewport height.
        // Mobile/PDA default (only when nothing has been saved yet for this tab — a real
        // stored size, including one the user manually shrank, is always respected):
        // fill the available width and the height remaining below Torn's own top icon
        // row, since a small floating panel doesn't leave room for tables like the
        // FFScouter war-target list to show all their columns.
        let defaultWidth = 480;
        let defaultHeight = Math.min(720, Math.round(window.innerHeight * 0.8));
        if (isMobileEnvironment() && (!hasStoredWidth || !hasStoredHeight)) {
            defaultWidth = limits.maxWidth;
            defaultHeight = Math.max(limits.minHeight, window.innerHeight - MOBILE_TOP_OFFSET_PX - 12);
        }
        return {
            width: Math.min(limits.maxWidth, Math.max(limits.minWidth, hasStoredWidth ? width : defaultWidth)),
            height: Math.min(limits.maxHeight, Math.max(limits.minHeight, hasStoredHeight ? height : defaultHeight))
        };
    }

    function getWidgetLayoutKey() {
        if (state.currentTab === "overview") return `overview:${state.overviewSubTab}`;
        if (state.currentTab === "personal") return `personal:${state.personalSubTab}`;
        if (state.currentTab === "faction") return `faction:${state.factionSubTab}`;
        if (state.currentTab === "settings") return `settings:${state.settingsSubTab}`;
        return state.currentTab;
    }

    function getCurrentWidgetSize() {
        return normalizeWidgetSize(state.windowSizes[getWidgetLayoutKey()]);
    }

    function storeCurrentWidgetSize(width, height, persist = true) {
        if (state.isMinimized) return;
        const size = normalizeWidgetSize({ width, height });
        state.windowSizes = { ...state.windowSizes, [getWidgetLayoutKey()]: size };
        if (persist) setStoredDashboardState({ windowSizes: state.windowSizes });
    }

    function captureCurrentWidgetSize(persist = true) {
        if (!state.dashboard || state.isMinimized) return;
        const rect = state.dashboard.getBoundingClientRect();
        storeCurrentWidgetSize(rect.width, rect.height, persist);
    }

    function getWidgetEdge() {
        const edge = getStoredPosition()?.edge;
        return ["left", "right", "top", "bottom"].includes(edge) ? edge : "right";
    }

    function applyWidgetPosition(position = getStoredPosition()) {
        const dashboard = state.dashboard;
        if (!dashboard) return;
        const rect = dashboard.getBoundingClientRect();
        const edge = ["left", "right", "top", "bottom"].includes(position?.edge) ? position.edge : "right";
        const requestedX = Number(position?.x ?? rect.left);
        const requestedY = Number(position?.y ?? position?.top ?? rect.top);
        const maxLeft = Math.max(0, window.innerWidth - rect.width);
        const maxTop = Math.max(0, window.innerHeight - rect.height);
        const left = Math.min(Math.max(requestedX, 0), maxLeft);
        const top = Math.min(Math.max(requestedY, 0), maxTop);
        dashboard.style.left = "auto";
        dashboard.style.right = "auto";
        dashboard.style.top = "auto";
        dashboard.style.bottom = "auto";
        if (edge === "left") {
            dashboard.style.left = "0";
            dashboard.style.top = `${top}px`;
        } else if (edge === "right") {
            dashboard.style.right = "0";
            dashboard.style.top = `${top}px`;
        } else if (edge === "top") {
            dashboard.style.top = "0";
            dashboard.style.left = `${left}px`;
        } else {
            dashboard.style.bottom = "0";
            dashboard.style.left = `${left}px`;
        }
    }

    function getNearestWidgetEdge(rect) {
        const distances = {
            left: Math.max(0, rect.left),
            right: Math.max(0, window.innerWidth - rect.right),
            top: Math.max(0, rect.top),
            bottom: Math.max(0, window.innerHeight - rect.bottom)
        };
        return Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];
    }

    function clampWidgetTop() {
        applyWidgetPosition();
    }

    function applyCurrentWidgetSize() {
        const dashboard = state.dashboard;
        if (!dashboard || state.isMinimized) return;
        const limits = getWidgetSizeLimits();
        const size = getCurrentWidgetSize();
        dashboard.style.minWidth = `${limits.minWidth}px`;
        dashboard.style.minHeight = `${limits.minHeight}px`;
        dashboard.style.maxWidth = `${limits.maxWidth}px`;
        dashboard.style.maxHeight = `${limits.maxHeight}px`;
        dashboard.style.width = `${size.width}px`;
        dashboard.style.height = `${size.height}px`;
        applyWidgetPosition();
    }

    function applyWidgetView() {
        const dashboard = state.dashboard;
        if (!dashboard) return;
        const widgetBody = dashboard.querySelector("#widget-main-body");
        const dragHandle = dashboard.querySelector("#widget-drag-handle");
        const title = dashboard.querySelector("#widget-title");
        const toggleBtn = dashboard.querySelector("#widget-toggle-view-btn");
        const resizeHandles = dashboard.querySelectorAll(".widget-resize-handle");
        if (!widgetBody || !dragHandle || !title || !toggleBtn || !resizeHandles.length) return;

        if (state.isMinimized) {
            widgetBody.style.display = "none";
            dashboard.style.width = "48px";
            dashboard.style.height = "36px";
            dashboard.style.minWidth = "48px";
            dashboard.style.minHeight = "36px";
            dashboard.style.maxWidth = "48px";
            dashboard.style.maxHeight = "36px";
            resizeHandles.forEach((handle) => { handle.style.display = "none"; });
            dragHandle.style.padding = "0";
            dragHandle.style.height = "36px";
            dragHandle.style.justifyContent = "center";
            dragHandle.style.cursor = "move";
            title.textContent = `NTC v${SCRIPT_VERSION}`;
            title.style.fontSize = "11px";
            title.style.letterSpacing = "0.06em";
            toggleBtn.style.display = "none";
            dashboard.title = "Naughty Torn Companion — click to restore";
            applyWidgetPosition();
        } else {
            widgetBody.style.display = "flex";
            widgetBody.style.flexDirection = "column";
            widgetBody.style.flex = "1 1 auto";
            widgetBody.style.minHeight = "0";
            widgetBody.style.maxHeight = "none";
            widgetBody.style.overflowY = "auto";
            resizeHandles.forEach((handle) => { handle.style.display = "block"; });
            dragHandle.style.padding = "8px 10px";
            dragHandle.style.height = "auto";
            dragHandle.style.justifyContent = "space-between";
            title.textContent = `🧭 Naughty Torn Companion v${SCRIPT_VERSION}`;
            title.style.fontSize = "12px";
            title.style.letterSpacing = "normal";
            toggleBtn.style.display = "block";
            toggleBtn.innerText = "_";
            dashboard.title = "";
            applyCurrentWidgetSize();
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
        dashboard.style.height = `${Math.min(720, Math.round(window.innerHeight * 0.8))}px`;
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
                #torn-v2-inventory-wrapper[data-theme="light"] .ntc-perk-section,
                #torn-v2-inventory-wrapper[data-theme="light"] .ntc-perk-item {
                    background: #ffffff !important;
                    border-color: #cbd5e1 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] .ntc-perk-item span:last-child {
                    color: #334155 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] .ntc-war-target-filter-panel,
                #torn-v2-inventory-wrapper[data-theme="light"] .ntc-war-target-filter-option {
                    background: #f8fafc !important;
                    border-color: #cbd5e1 !important;
                    color: #334155 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] .ntc-war-ff-range button {
                    background: #e2e8f0 !important;
                    border-color: #94a3b8 !important;
                    color: #334155 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] .ntc-war-filter-heading {
                    color: #172033 !important;
                }
                #torn-v2-inventory-wrapper[data-theme="light"] .ntc-war-filter-group-label {
                    color: #475569 !important;
                }
                #torn-v2-inventory-wrapper #torn-companion-content {
                    container-type: inline-size;
                    min-width: 0;
                    font-size: clamp(10px, 2.4cqi, 12px) !important;
                }
                #torn-v2-inventory-wrapper #torn-companion-content.ntc-ffscouter-active {
                    flex: 1 1 auto;
                    min-height: 0;
                    grid-template-rows: auto auto minmax(0, 1fr);
                }
                #torn-v2-inventory-wrapper #torn-companion-content.ntc-ffscouter-active .ntc-ffscouter-layout {
                    min-height: 0;
                    height: 100%;
                }
                #torn-v2-inventory-wrapper #torn-companion-content.ntc-inventory-active {
                    flex: 1 1 auto;
                    min-height: 0;
                    grid-template-rows: auto minmax(0, 1fr);
                }
                #torn-v2-inventory-wrapper #torn-companion-content.ntc-inventory-active .ntc-inventory-layout {
                    min-height: 0;
                    height: 100%;
                }
                #torn-v2-inventory-wrapper #torn-companion-content.ntc-inventory-active .ntc-inventory-table-wrap {
                    min-height: 160px;
                    height: 100%;
                }
                #torn-v2-inventory-wrapper #torn-companion-content *,
                #torn-v2-inventory-wrapper #widget-main-body > * {
                    box-sizing: border-box;
                    min-width: 0;
                    max-width: 100%;
                    overflow-wrap: anywhere;
                }
                #torn-v2-inventory-wrapper #torn-companion-content [style*="grid-template-columns: repeat("] {
                    grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)) !important;
                }
                #torn-v2-inventory-wrapper #torn-companion-content .ntc-personal-stats-pair {
                    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
                }
                #torn-v2-inventory-wrapper #torn-companion-content .ntc-battle-stats-grid {
                    grid-template-columns: minmax(48px, .75fr) minmax(64px, 1fr) minmax(38px, .55fr) minmax(64px, 1fr) !important;
                    gap: 4px !important;
                }
                #torn-v2-inventory-wrapper #torn-companion-content .ntc-battle-stats-card span {
                    font-size: clamp(9px, 1.7cqi, 12px) !important;
                }
                #torn-v2-inventory-wrapper #torn-companion-content table {
                    max-width: 100%;
                }
                #torn-v2-inventory-wrapper #torn-companion-content .ntc-war-target-table-wrap {
                    width: 100% !important;
                    min-width: 0 !important;
                    max-width: 100% !important;
                }
                #torn-v2-inventory-wrapper #torn-companion-content .ntc-war-target-table {
                    width: 100% !important;
                    table-layout: fixed !important;
                }
                #torn-v2-inventory-wrapper #torn-companion-content .ntc-attack-button {
                    min-width: max-content !important;
                    max-width: none !important;
                    white-space: nowrap !important;
                    overflow-wrap: normal !important;
                    word-break: keep-all !important;
                }
                @container (max-width: 520px) {
                    #torn-v2-inventory-wrapper #torn-companion-content .ntc-personal-stats-pair {
                        grid-template-columns: minmax(0, 1fr) !important;
                    }
                }
                @container (max-width: 430px) {
                    #torn-v2-inventory-wrapper #torn-companion-content [style*="grid-template-columns"] {
                        grid-template-columns: minmax(0, 1fr) !important;
                    }
                }
                .widget-resize-handle::after {
                    content: "";
                    position: absolute;
                    width: 9px;
                    height: 9px;
                }
                .widget-resize-handle[data-corner="bottom-left"]::after {
                    left: 4px;
                    bottom: 4px;
                    border-left: 2px solid #777;
                    border-bottom: 2px solid #777;
                }
                .widget-resize-handle[data-corner="bottom-right"]::after {
                    right: 4px;
                    bottom: 4px;
                    border-right: 2px solid #777;
                    border-bottom: 2px solid #777;
                }
                .widget-resize-handle[data-corner="top-left"]::after {
                    left: 4px;
                    top: 4px;
                    border-left: 2px solid #777;
                    border-top: 2px solid #777;
                }
            </style>
            <div id="widget-drag-handle" style="background-color: #2c2c2c; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; cursor: move; border-bottom: 1px solid #444; user-select: none;">
                <span id="widget-title" style="color: #fff; font-size: 12px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">🧭 Naughty Torn Companion v${SCRIPT_VERSION}</span>
                <button id="widget-toggle-view-btn" type="button" title="Minimize Naughty Torn Companion" aria-label="Minimize Naughty Torn Companion" style="width: 32px; height: 28px; flex: 0 0 32px; display: grid; place-items: center; background-color: #444; color: #fff; border: 1px solid #666; padding: 0; border-radius: 5px; cursor: pointer; font-size: 18px; font-weight: 700; line-height: 1;">−</button>
            </div>

            <div id="widget-main-body" style="padding: 10px; box-sizing: border-box; flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;">
                <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 10px;">${navHtml}</div>
                <div id="torn-companion-content" style="display: grid; gap: 8px; color: #fff; font-size: 11px;"></div>
            </div>
            <div class="widget-resize-handle" data-corner="top-left" title="Resize this tab" style="position:absolute;left:0;top:0;width:20px;height:20px;cursor:nwse-resize;z-index:4;touch-action:none;"></div>
            <div class="widget-resize-handle" data-corner="bottom-left" title="Resize this tab" style="position:absolute;left:0;bottom:0;width:20px;height:20px;cursor:nesw-resize;z-index:4;touch-action:none;"></div>
            <div class="widget-resize-handle" data-corner="bottom-right" title="Resize this tab" style="position:absolute;right:0;bottom:0;width:20px;height:20px;cursor:nwse-resize;z-index:4;touch-action:none;"></div>
        `;

        document.body.appendChild(dashboard);
        state.dashboard = dashboard;
        applyDashboardTheme();
        applyWidgetView();

        applyWidgetPosition();

        const toggleBtn = document.getElementById("widget-toggle-view-btn");
        toggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (!state.isMinimized) captureCurrentWidgetSize(false);
            state.isMinimized = !state.isMinimized;
            setStoredDashboardState({ isMinimized: state.isMinimized, windowSizes: state.windowSizes });
            applyWidgetView();
        });

        const dragHandle = document.getElementById("widget-drag-handle");
        let isDragging = false;
        let didDrag = false;
        let offsetX;
        let offsetY;

        dragHandle.addEventListener("mousedown", (e) => {
            if (e.target.closest("#widget-toggle-view-btn")) return;
            isDragging = true;
            didDrag = false;
            const rect = dashboard.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            dashboard.style.bottom = "auto";
            dashboard.style.right = "auto";
            dashboard.style.left = `${rect.left}px`;
            dashboard.style.top = `${rect.top}px`;
        });

        document.addEventListener("mousemove", (e) => {
            if (!isDragging) return;
            didDrag = true;
            const maxLeft = Math.max(0, window.innerWidth - dashboard.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - dashboard.offsetHeight);
            const left = Math.min(Math.max(e.clientX - offsetX, 0), maxLeft);
            const top = Math.min(Math.max(e.clientY - offsetY, 0), maxTop);
            dashboard.style.left = `${left}px`;
            dashboard.style.top = `${top}px`;
        });

        document.addEventListener("mouseup", () => {
            if (isDragging) {
                const rect = dashboard.getBoundingClientRect();
                const edge = getNearestWidgetEdge(rect);
                const position = { edge, x: rect.left, y: rect.top };
                setStoredPosition(position);
                applyWidgetPosition(position);
            }
            isDragging = false;
        });

        dragHandle.addEventListener("click", (e) => {
            if (e.target.closest("#widget-toggle-view-btn") || !state.isMinimized || didDrag) return;
            state.isMinimized = false;
            setStoredDashboardState({ isMinimized: false });
            applyWidgetView();
        });

        const resizeHandles = dashboard.querySelectorAll(".widget-resize-handle");
        let isResizing = false;
        let resizeStartX = 0;
        let resizeStartY = 0;
        let resizeStartWidth = 0;
        let resizeStartHeight = 0;
        let resizeCorner = "bottom-left";
        let resizeStartRect = null;

        resizeHandles.forEach((handle) => handle.addEventListener("mousedown", (e) => {
            if (state.isMinimized) return;
            e.preventDefault();
            e.stopPropagation();
            resizeStartRect = dashboard.getBoundingClientRect();
            isResizing = true;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;
            resizeStartWidth = resizeStartRect.width;
            resizeStartHeight = resizeStartRect.height;
            resizeCorner = handle.dataset.corner || "bottom-left";
            document.body.style.userSelect = "none";
        }));

        document.addEventListener("mousemove", (e) => {
            if (!isResizing) return;
            const limits = getWidgetSizeLimits();
            const resizeFromLeft = resizeCorner.endsWith("left");
            const resizeFromTop = resizeCorner.startsWith("top");
            const widthDelta = resizeFromLeft ? resizeStartX - e.clientX : e.clientX - resizeStartX;
            const heightDelta = resizeFromTop ? resizeStartY - e.clientY : e.clientY - resizeStartY;
            const maxWidth = Math.min(limits.maxWidth, resizeFromLeft ? resizeStartRect.right : window.innerWidth - resizeStartRect.left);
            const maxHeight = Math.min(limits.maxHeight, resizeFromTop ? resizeStartRect.bottom : window.innerHeight - resizeStartRect.top);
            const width = Math.min(maxWidth, Math.max(limits.minWidth, resizeStartWidth + widthDelta));
            const height = Math.min(maxHeight, Math.max(limits.minHeight, resizeStartHeight + heightDelta));
            dashboard.style.width = `${width}px`;
            dashboard.style.height = `${height}px`;
            dashboard.style.right = "auto";
            dashboard.style.bottom = "auto";
            dashboard.style.left = `${resizeFromLeft ? resizeStartRect.right - width : resizeStartRect.left}px`;
            dashboard.style.top = `${resizeFromTop ? resizeStartRect.bottom - height : resizeStartRect.top}px`;
        });

        document.addEventListener("mouseup", () => {
            if (!isResizing) return;
            isResizing = false;
            document.body.style.userSelect = "";
            const rect = dashboard.getBoundingClientRect();
            storeCurrentWidgetSize(rect.width, rect.height);
            const position = { edge: getNearestWidgetEdge(rect), x: rect.left, y: rect.top };
            setStoredPosition(position);
            applyWidgetPosition(position);
            // Re-render so width-dependent layouts (e.g. the FFScouter war-target table's
            // responsive column widths) recalculate against the widget's new size.
            renderTabContent();
        });

        let viewportResizeSaveTimer = null;
        window.addEventListener("resize", () => {
            if (state.isMinimized) {
                clampWidgetTop();
                return;
            }
            applyCurrentWidgetSize();
            clearTimeout(viewportResizeSaveTimer);
            viewportResizeSaveTimer = setTimeout(() => {
                const rect = dashboard.getBoundingClientRect();
                storeCurrentWidgetSize(rect.width, rect.height);
                const edge = getWidgetEdge();
                setStoredPosition({ edge, x: rect.left, y: rect.top });
                // Same reasoning as the corner-resize handler above — window resizes
                // (browser resize, mobile orientation change) also change how much
                // room width-dependent layouts have.
                renderTabContent();
            }, 150);
        });

        dashboard.querySelectorAll(".torn-companion-tab").forEach((button) => {
            button.addEventListener("click", () => {
                captureCurrentWidgetSize(false);
                state.currentTab = button.getAttribute("data-tab");
                setStoredDashboardState({ currentTab: state.currentTab, windowSizes: state.windowSizes });
                applyCurrentWidgetSize();
                renderTabContent();
                dashboard.querySelectorAll(".torn-companion-tab").forEach((tabButton) => {
                    const selected = tabButton.getAttribute("data-tab") === state.currentTab;
                    tabButton.style.background = selected ? '#3b5998' : '#2a2a2a';
                    tabButton.style.fontWeight = selected ? '700' : '400';
                });
            });
        });

        state.sectionStatus.settings = "Auto refresh: Overview (5 min), Personal-Info (5 min), Faction (live, 5s while viewing). Company updates once daily at 18:10 UTC. Inventory is manual-only. Activity tab removed.";
        renderTabContent();

        if (state.apiKey) {
            const hasAnyCache = Object.values(state.caches).some((cache) => cache !== null);
            if (!hasAnyCache) {
                // Fresh install / nothing restored from storage. Only fetches the
                // auto-refreshable core (overview/personal/faction) — company and
                // inventory are manual-refresh-only tabs (company also gets its own
                // once-daily 18:10 UTC auto-update, unrelated to this bootstrap call)
                // and stay empty until the user visits/refreshes them, even on a
                // brand new install, for consistency with "never auto-fetched" being
                // a strict rule for those two. Activity tab has been removed
                // entirely.
                void refreshAllSections({ silent: true });
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
