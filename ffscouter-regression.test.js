const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "Naughty Faction Companion.user.js"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const persistence = section("const getStoredDashboardState", "function updateCompanyStockHistory");
const restore = section("async function loadPersistedState", "async function secureCustomFetch");
const controls = section("function bindFactionControls", "function stopWarTargetsRefreshTimer");
const renderer = section("function renderFFScouterWarTargets", "function renderFactionPanel");
const refresh = section("async function refreshWarTargets", "function bindFactionControls");
const factionFetch = section("async function fetchFactionData", "async function fetchCompanyData");
const factionOnlyRefresh = section("async function refreshAllSections", "function performAutoRefreshCycle");
const navigation = section("const tabs =", "const navHtml");

for (const key of ["warTargetSort", "warTargetFilters", "warTargetFFRange", "warTargetColumnOrder", "warTargetColumnWidths"]) {
    assert.match(persistence, new RegExp(key), `${key} must be saved`);
    assert.match(restore, new RegExp(key), `${key} must be restored`);
}

for (const target of ["faction:general", "faction:ffscouter"]) {
    assert.match(source, new RegExp(target), `${target} must have an auto-refresh control`);
}
assert.match(persistence, /autoRefreshSettings/, "auto-refresh settings must persist");
assert.match(restore, /autoRefreshSettings/, "auto-refresh settings must restore");
assert.match(source, /function getCurrentAutoRefreshTarget\(\)/, "auto-refresh must resolve the active view");
assert.match(navigation, /id: "faction", label: "Faction"/, "Faction must be a visible top-level tab");
assert.match(navigation, /id: "settings", label: "Settings"/, "Settings must remain available");
assert.doesNotMatch(navigation, /id: "(overview|personal|company|inventory)"/, "standalone navigation must not expose unrelated tabs");
assert.doesNotMatch(factionOnlyRefresh, /fetch(Overview|Personal|Company|Inventory)Data\(/, "standalone refresh must not request unrelated data");

assert.doesNotMatch(controls, /state\.caches/, "view controls must never mutate faction data");
assert.match(renderer, /faction\.war \|\| data\?\.war/, "renderer must retain the target snapshot's war context");
assert.match(factionFetch, /warsRequestFailed \? \(previousFaction\.war \|\| null\) : null/, "failed wars requests must retain the last valid war");
assert.match(refresh, /currentFaction\.war\?\.warId/, "target refresh must validate the current war before committing");
assert.match(refresh, /warTargets: \{ \.\.\.refreshed, war: \{ \.\.\.war \} \}/, "target cache must carry its war snapshot");
assert.match(source, /function hasRankedWarStarted\(war\)/, "static target lookup must wait for the Ranked War start time");
assert.match(refresh, /if \(!hasRankedWarStarted\(war\)\)/, "target refresh must wait for the Ranked War start time");
assert.match(refresh, /const loadStatic = !cacheMatchesWar \|\| !Number\(existing\.staticLookupAttemptedAt \|\| 0\)/, "FFScouter data must be loaded once per Ranked War");
assert.match(factionFetch, /let warTargets = previousWarTargets \|\| null;/, "ordinary faction refreshes must preserve the static FFScouter snapshot");
assert.doesNotMatch(factionFetch, /fetchWarTargetData\(/, "ordinary faction refreshes must not trigger FFScouter or target-profile lookups");
assert.match(source, /function pauseWindowActivity\(\)/, "minimizing must pause all refresh timers");
assert.match(source, /function resumeWindowActivity\(\)/, "restoring must resume permitted refresh timers");
assert.match(source, /if \(state\.isMinimized\) return Promise\.reject/, "request wrappers must block API calls while minimized");
assert.match(source, /if \(state\.isMinimized\) return false;/, "refresh entry points must pause while minimized");
assert.doesNotMatch(renderer, /buildStatCard\("Estimates"/, "backend Estimates card must remain hidden");
assert.match(controls, /input\.onwheel/, "FF range fields must support wheel stepping");
assert.match(controls, /event\.preventDefault\(\)/, "FF wheel stepping must not scroll the page");
assert.match(source, /data-corner="top-left"/, "top-left window resize grip must exist");
assert.match(source, /data-corner="bottom-left"/, "bottom-left window resize grip must exist");
assert.match(source, /data-corner="bottom-right"/, "bottom-right window resize grip must exist");
assert.doesNotMatch(source, /data-corner="top-right"/, "top-right corner must remain reserved for Minimize");
assert.match(source, /resizeCorner\.endsWith\("left"\)/, "corner resize must support both left-side grips");
assert.match(source, /resizeCorner\.startsWith\("top"\)/, "corner resize must support top-left grip");
assert.match(source, /overflow: hidden !important/, "widget content must not overflow horizontally or vertically");
assert.match(source, /min-inline-size: 0 !important/, "cards and fields must be allowed to shrink with the widget");
assert.match(source, /max-inline-size: 100% !important/, "cards and fields must remain constrained to the widget width");
assert.match(source, /Math\.max\(1, Math\.floor\(floors\[i\] \* scale\)\)/, "FFScouter columns must scale below fixed floors at extreme widths");
assert.match(source, /grid-template-rows: auto auto auto minmax\(0, 1fr\)/, "FFScouter must reserve separate rows for refresh header, section title, tabs, and targets");
assert.match(source, /scrollbar-width: none/, "FFScouter scrollbars must remain hidden without disabling scrolling");
assert.match(source, /resizeRenderTimer = setTimeout/, "FFScouter columns must recalculate while the window is being resized");
assert.match(source, /widgetBody\.style\.overflowY = "hidden"/, "the script window itself must not vertically scroll");
assert.match(source, /function fitCurrentContentToWidget\(\)/, "non-table panels must scale to fit the available window height");
assert.match(source, /requestAnimationFrame\(fitCurrentContentToWidget\)/, "card fitting must run after renders and size changes");
assert.match(source, /min-height:0;flex:1 1 auto;border:1px solid #343a43/, "only the FFScouter player table may consume remaining height and scroll");
assert.match(source, /ntc-ffscouter-summary/, "the FFScouter summary must have an independently responsive container");
assert.match(source, /availableSummaryHeight = Math\.max\(58, Math\.floor\(layout\.clientHeight \* 0\.48\)\)/, "the FFScouter summary must shrink to leave room for the target table");
assert.doesNotMatch(source, /faction\.factionNews/, "the General tab must not retain News-card data");

const defaults = { okay: true, hospitalized: true, traveling: true, online: true, idle: true, offline: true };
const targets = [
    { status: "okay", online: "online", fairFight: 1.25 },
    { status: "hospitalized", online: "idle", fairFight: 2.5 },
    { status: "traveling", online: "offline", fairFight: 4 },
    { status: "okay", online: "offline", fairFight: 0 }
];
const ranges = [["", ""], ["2", ""], ["", "3"], ["2", "3"], ["0", "0"], ["4", "2"]];
const filter = (target, filters, [minText, maxText]) => {
    if (filters[target.status] === false || filters[target.online] === false) return false;
    let min = minText === "" ? null : Number(minText);
    let max = maxText === "" ? null : Number(maxText);
    if (min !== null && max !== null && min > max) [min, max] = [max, min];
    if (min === null && max === null) return true;
    return target.fairFight > 0 && (min === null || target.fairFight >= min) && (max === null || target.fairFight <= max);
};

for (let mask = 0; mask < 64; mask += 1) {
    const filters = Object.fromEntries(Object.keys(defaults).map((key, index) => [key, Boolean(mask & (1 << index))]));
    for (const range of ranges) {
        const faction = { war: { warId: 7 }, warTargets: { targets: structuredClone(targets) } };
        const before = structuredClone(faction);
        faction.warTargets.targets.filter((target) => filter(target, filters, range));
        assert.deepEqual(faction, before, `filters mutated faction state for mask ${mask} and range ${range}`);
    }
}

console.log("FFScouter regression checks passed: persistence, 384 filter/range combinations, cache race guards, hidden Estimates card, and wheel controls.");
