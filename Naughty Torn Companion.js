// ==UserScript==
// @name         TIM - Torn Inventory Manager
// @namespace    http://tampermonkey.net
// @version      4.2
// @description  Dynamically inserts an inventory table along with an interactive API Key config panel on the item page.
// @author       sharpsplinter [315311]
// @match        https://www.torn.com/item.php*
// @match        https://torn.com/item.php*
// @match        https://www.torn.com/page.php?sid=ItemMarket*
// @match        https://torn.com/page.php?sid=ItemMarket*
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

    // Only these categories can actually carry a faction-loaned item
    const LOANABLE_CATEGORIES = new Set([
        "temporary", "melee", "primary", "secondary", "tool", "defensive"
    ]);

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const formatMoney = (num) => num ? '$' + num.toLocaleString() : '$0';
    const getStoredKey = () => localStorage.getItem("TORN_V2_USER_KEY") || "";
    const setStoredKey = (key) => localStorage.setItem("TORN_V2_USER_KEY", key.trim());

    const INVENTORY_DATA_KEY = "TORN_V2_INVENTORY_DATA";
    const getStoredInventory = () => {
        try {
            const raw = localStorage.getItem(INVENTORY_DATA_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    };
    const setStoredInventory = (payload) => {
        localStorage.setItem(INVENTORY_DATA_KEY, JSON.stringify(payload));
    };

    let sortState = { key: "value", direction: "desc" };
    let expandedCategories = new Set();

    const WIDGET_POS_KEY = "TORN_V2_WIDGET_POS";
    const getStoredPosition = () => {
        try {
            const raw = localStorage.getItem(WIDGET_POS_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    };
    const setStoredPosition = (pos) => {
        localStorage.setItem(WIDGET_POS_KEY, JSON.stringify(pos));
    };

    function secureCustomFetch(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: url,
                headers: { "Accept": "application/json" },
                onload: function(response) {
                    if (response.status >= 200 && response.status < 300) {
                        try { resolve(JSON.parse(response.responseText)); }
                        catch(e) { reject(new Error("Failed to parse JSON")); }
                    } else { reject(new Error(`HTTP Status ${response.status}`)); }
                },
                onerror: (err) => reject(err)
            });
        });
    }

    async function fetchItemCatalog(apiKey, statusEl) {
        statusEl.innerText = "Fetching item price catalog...";
        const url = `${BASE_URL}torn/items?cat=All&key=${apiKey}`;
        const priceMap = {};

        try {
            const data = await secureCustomFetch(url);
            if (data.error) {
                console.warn(`[Torn v2 Debug] Catalog fetch error [${data.error.code}]: ${data.error.error}`);
                return priceMap;
            }

            const catalogItems = (data.items && Array.isArray(data.items))
                ? data.items
                : (Array.isArray(data) ? data : []);

            catalogItems.forEach(entry => {
                const id = entry.id;
                const value = parseInt(
                    (entry.value && entry.value.market_price) ||
                    entry.market_value ||
                    entry.value ||
                    0
                );
                if (id !== undefined) priceMap[id] = value;
            });

            console.log(`[Torn v2 Debug] Catalog loaded: ${Object.keys(priceMap).length} items`);
        } catch (error) {
            console.error("[Torn v2 Debug] Catalog fetch failed:", error);
        }

        return priceMap;
    }

    function renderTable(tableBodyEl, rows) {
        tableBodyEl.innerHTML = "";

        if (!rows || rows.length === 0) {
            tableBodyEl.innerHTML = `<tr><td colspan="5" style="padding: 20px; text-align: center; color: #555; font-size: 11px;">No local synced data.</td></tr>`;
            return;
        }

        // --- Group rows by category ---
        const groups = {};
        rows.forEach(row => {
            if (!groups[row.category]) {
                groups[row.category] = { category: row.category, items: [], quantity: 0, value: 0 };
            }
            const g = groups[row.category];
            g.items.push(row);
            g.quantity += row.quantity;
            g.value += row.total;
        });

        let categoryList = Object.values(groups);

        // --- Sort categories ---
        const { key, direction } = sortState;
        const sortKey = (key === "name") ? "category" : key; // "Item Name" header maps here too
        categoryList.sort((a, b) => {
            let av = a[sortKey], bv = b[sortKey];
            if (typeof av === "string") av = av.toLowerCase();
            if (typeof bv === "string") bv = bv.toLowerCase();
            if (av < bv) return direction === "asc" ? -1 : 1;
            if (av > bv) return direction === "asc" ? 1 : -1;
            return 0;
        });

        categoryList.forEach(group => {
            const isExpanded = expandedCategories.has(group.category);
            const isLoanable = LOANABLE_CATEGORIES.has(group.category);
            const loanedCount = isLoanable ? group.items.filter(i => i.factionOwned).length : 0;

            // --- Category summary row ---
            const catRow = document.createElement("tr");
            catRow.style.borderBottom = "1px solid #222";
            catRow.style.cursor = "pointer";
            catRow.style.backgroundColor = "#202020";
            catRow.innerHTML = `
                <td style="padding: 4px; color: #fff; font-weight: bold; text-transform: capitalize; font-size: 11px;">
                    <span style="display: inline-block; width: 12px;">${isExpanded ? "▼" : "▶"}</span>${group.category}
                </td>
                <td style="padding: 4px; color: #888; font-size: 10px; font-style: italic;">${group.items.length} item${group.items.length === 1 ? "" : "s"}</td>
                <td style="padding: 4px; text-align: center; color: #ccc; font-size: 11px; font-weight: bold;">${group.quantity.toLocaleString()}</td>
                <td style="padding: 4px; text-align: right; color: #85bb65; font-size: 11px; font-weight: bold;">${formatMoney(group.value)}</td>
                <td style="padding: 4px; text-align: center; color: #888; font-size: 10px;">${isLoanable ? (loanedCount > 0 ? `${loanedCount} 🔒` : "") : "—"}</td>
            `;
            catRow.addEventListener("click", () => {
                if (expandedCategories.has(group.category)) {
                    expandedCategories.delete(group.category);
                } else {
                    expandedCategories.add(group.category);
                }
                renderTable(tableBodyEl, rows);
            });
            tableBodyEl.appendChild(catRow);

            if (!isExpanded) return;

            // --- Expanded item rows (sorted by value, highest first) ---
            const items = [...group.items].sort((a, b) => b.total - a.total);
            items.forEach(item => {
                const itemRow = document.createElement("tr");
                itemRow.style.borderBottom = "1px solid #1a1a1a";
                itemRow.style.backgroundColor = "#161616";
                const loanedCell = isLoanable
                    ? `<input type="checkbox" disabled ${item.factionOwned ? "checked" : ""} style="accent-color: #4CAF50; cursor: default;" />`
                    : `<span style="color: #444; font-size: 11px;">—</span>`;
                itemRow.innerHTML = `
                    <td style="padding: 4px 4px 4px 22px; color: #666; font-size: 10px;">↳</td>
                    <td style="padding: 4px; color: #ddd; font-size: 11px; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${item.name}</td>
                    <td style="padding: 4px; text-align: center; color: #999; font-size: 11px;">${item.quantity.toLocaleString()}</td>
                    <td style="padding: 4px; text-align: right; color: #6fa356; font-size: 11px;">${formatMoney(item.price)}</td>
                    <td style="padding: 4px; text-align: center;">${loanedCell}</td>
                `;
                tableBodyEl.appendChild(itemRow);
            });
        });
    }

    function updateSortIndicators(theadEl) {
        theadEl.querySelectorAll("th[data-sort-key]").forEach(th => {
            const k = th.getAttribute("data-sort-key");
            const base = th.getAttribute("data-label");
            th.innerText = (k === sortState.key)
                ? `${base} ${sortState.direction === "asc" ? "▲" : "▼"}`
                : base;
        });
    }

    async function fetchAndRenderTable(statusEl, tableBodyEl, theadEl) {
        const apiKey = getStoredKey();
        if (!apiKey) {
            statusEl.innerText = "❌ Missing Key: Input and Save Key first.";
            return;
        }

        const REQUEST_DELAY_MS = 650;
        const collectedRows = [];

        const priceMap = await fetchItemCatalog(apiKey, statusEl);
        await sleep(REQUEST_DELAY_MS);

        let totalValueOverall = 0;
        let totalCountOverall = 0;

        for (let i = 0; i < INVENTORY_CATEGORIES.length; i++) {
            const category = INVENTORY_CATEGORIES[i];
            statusEl.innerText = `Fetching ${category} (${i + 1}/${INVENTORY_CATEGORIES.length})...`;

            const url = `${BASE_URL}user/inventory?cat=${category}&key=${apiKey}`;

            try {
                const data = await secureCustomFetch(url);
                if (data.error) {
                    statusEl.innerText = `❌ Error [${data.error.code}]: ${data.error.error}`;
                    return;
                }

                const itemsList = (data.inventory && Array.isArray(data.inventory.items))
                    ? data.inventory.items
                    : [];

                itemsList.forEach(item => {
                    const name = item.name || "Unknown Item";
                    const quantity = parseInt(item.amount || item.quantity || item.qty || item.count || 0);
                    const marketValue = parseInt(priceMap[item.id] || 0);
                    const total = quantity * marketValue;
                    const factionOwned = !!item.faction_owned;

                    totalCountOverall += quantity;
                    totalValueOverall += total;

                    collectedRows.push({ category, name, quantity, price: marketValue, total, factionOwned });
                });

            } catch (error) {
                console.error(error);
            }

            if (i < INVENTORY_CATEGORIES.length - 1) {
                await sleep(REQUEST_DELAY_MS);
            }
        }

        setStoredInventory({
            rows: collectedRows,
            totalCount: totalCountOverall,
            totalValue: totalValueOverall,
            syncedAt: Date.now()
        });

        updateSortIndicators(theadEl);
        renderTable(tableBodyEl, collectedRows);

        statusEl.innerHTML = `Done!<br>Items: <span style="font-weight: bold; text-decoration: underline;">${totalCountOverall.toLocaleString()}</span> | Value: <span style="font-weight: bold; text-decoration: underline;">${formatMoney(totalValueOverall)}</span>`;
    }

    function initializeDOMDashboard() {
        if (document.getElementById("torn-v2-inventory-wrapper")) return;

        const dashboard = document.createElement("div");
        dashboard.id = "torn-v2-inventory-wrapper";
        dashboard.style.position = "fixed";
        dashboard.style.bottom = "20px";
        dashboard.style.right = "20px";
        dashboard.style.width = "380px";
        dashboard.style.backgroundColor = "rgba(30, 30, 30, 0.95)";
        dashboard.style.border = "1px solid #444";
        dashboard.style.borderRadius = "6px";
        dashboard.style.zIndex = "999999";
        dashboard.style.boxShadow = "0 4px 15px rgba(0,0,0,0.6)";
        dashboard.style.fontFamily = "Arial, sans-serif";
        dashboard.style.overflow = "hidden";

        dashboard.innerHTML = `
            <div id="widget-drag-handle" style="background-color: #2c2c2c; padding: 8px 10px; display: flex; justify-content: space-between; align-items: center; cursor: move; border-bottom: 1px solid #444; user-select: none;">
                <span style="color: #fff; font-size: 12px; font-weight: bold; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">📦 TIM - Torn Inventory Manager</span>
                <button id="widget-toggle-view-btn" style="background-color: #444; color: #fff; border: none; padding: 2px 6px; border-radius: 3px; cursor: pointer; font-size: 11px;">_</button>
            </div>

            <div id="widget-main-body" style="padding: 10px;">
                <div style="display: flex; gap: 4px; margin-bottom: 8px;">
                    <input type="password" id="torn-api-key-input" placeholder="API Key" value="${getStoredKey()}"
                           style="background-color: #111; color: #fff; border: 1px solid #555; padding: 4px; border-radius: 3px; font-size: 11px; flex-grow: 1;" />
                    <button id="save-api-key-btn" style="background-color: #3b5998; color: #fff; border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: bold;">Save</button>
                    <button id="run-inventory-fetch" style="background-color: #4CAF50; color: #fff; border: none; padding: 4px 8px; border-radius: 3px; cursor: pointer; font-size: 11px; font-weight: bold;">Sync</button>
                </div>

                <div id="fetch-status-bar" style="color: #aaa; font-size: 11px; margin-bottom: 8px; font-style: italic; line-height: 1.4;">
                    ${getStoredKey() ? "Ready to sync records." : "⚠️ Enter key and click Save."}
                </div>

                <div style="max-height: 220px; overflow-y: auto; border: 1px solid #222; background-color: #151515; border-radius: 3px;">
                    <table style="width: 100%; border-collapse: collapse; text-align: left;">
                        <thead style="position: sticky; top: 0; background-color: #252525; z-index: 10; border-bottom: 1px solid #333;">
                            <tr style="color: #fff; font-size: 11px; font-weight: bold;">
                                <th data-sort-key="category" data-label="Category" style="padding: 4px; cursor: pointer; user-select: none;">Category</th>
                                <th style="padding: 4px;">Items</th>
                                <th data-sort-key="quantity" data-label="Qty" style="padding: 4px; text-align: center; cursor: pointer; user-select: none;">Qty</th>
                                <th data-sort-key="value" data-label="Value" style="padding: 4px; text-align: right; cursor: pointer; user-select: none;">Value</th>
                                <th style="padding: 4px; text-align: center;">Loaned</th>
                            </tr>
                        </thead>
                        <tbody id="inventory-table-body" style="color: #ccc;">
                            <tr>
                                <td colspan="5" style="padding: 20px; text-align: center; color: #555; font-size: 11px;">No local synced data.</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;

        document.body.appendChild(dashboard);

        // --- Restore Persisted Position ---
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

        // --- View Minimize Toggle ---
        const widgetBody = document.getElementById("widget-main-body");
        const toggleBtn = document.getElementById("widget-toggle-view-btn");
        toggleBtn.addEventListener("click", () => {
            if (widgetBody.style.display === "none") {
                widgetBody.style.display = "block";
                toggleBtn.innerText = "_";
                dashboard.style.width = "380px";
            } else {
                widgetBody.style.display = "none";
                toggleBtn.innerText = "▢";
                dashboard.style.width = "160px";
            }
        });

        // --- Drag Handler ---
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

        // --- Sort Header Clicks ---
        const theadEl = dashboard.querySelector("thead");
        const tableBodyEl = document.getElementById("inventory-table-body");
        theadEl.querySelectorAll("th[data-sort-key]").forEach(th => {
            th.addEventListener("click", () => {
                const key = th.getAttribute("data-sort-key");
                if (sortState.key === key) {
                    sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
                } else {
                    sortState.key = key;
                    sortState.direction = "asc";
                }
                updateSortIndicators(theadEl);
                const stored = getStoredInventory();
                renderTable(tableBodyEl, stored ? stored.rows : []);
            });
        });

        // --- Button Actions (scoped inside dashboard init, so elements exist) ---
        document.getElementById("save-api-key-btn").addEventListener("click", function() {
            const inputVal = document.getElementById("torn-api-key-input").value;
            if (!inputVal) return;
            setStoredKey(inputVal);
            document.getElementById("fetch-status-bar").innerText = "🔑 Key updated locally!";
        });

        document.getElementById("run-inventory-fetch").addEventListener("click", async function() {
            this.disabled = true;
            this.style.opacity = "0.5";
            await fetchAndRenderTable(
                document.getElementById("fetch-status-bar"),
                document.getElementById("inventory-table-body"),
                theadEl
            );
            this.disabled = false;
            this.style.opacity = "1";
        });

        // --- Restore Persisted Data On Load ---
        const persisted = getStoredInventory();
        updateSortIndicators(theadEl);
        if (persisted && Array.isArray(persisted.rows) && persisted.rows.length > 0) {
            renderTable(tableBodyEl, persisted.rows);
            const ageMins = Math.round((Date.now() - persisted.syncedAt) / 60000);
            document.getElementById("fetch-status-bar").innerHTML =
                `Loaded cached data (${ageMins}m old).<br>Items: <span style="font-weight: bold; text-decoration: underline;">${persisted.totalCount.toLocaleString()}</span> | Value: <span style="font-weight: bold; text-decoration: underline;">${formatMoney(persisted.totalValue)}</span>`;
        }
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        initializeDOMDashboard();
    } else {
        window.addEventListener("DOMContentLoaded", initializeDOMDashboard);
    }
})();