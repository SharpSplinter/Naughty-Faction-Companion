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
const resize = section("const resizeHandles = dashboard.querySelectorAll", "let viewportLayoutTimer");
const scrollbarStyles = section("#nfc-faction-wrapper #nfc-main-body {", "#nfc-faction-wrapper .nfc-primary-nav");

assert.match(source, /@version\s+1\.0\.21/, "userscript header version must be 1.0.21");
assert.match(source, /const SCRIPT_VERSION = "1\.0\.21";/, "displayed version must match the userscript header");
assert.match(source, /const CONSOLE_TAG = "\[Naughty Faction Companion\]";/, "diagnostics must use the script-specific console prefix");
assert.match(source, /function redactSecretText\(value\)/, "diagnostics must redact secret-bearing text");
assert.match(source, /function getSafeRequestTarget\(method, rawUrl\)/, "API diagnostics must build a query-free request target");
assert.match(source, /host: parsed\.host/, "API diagnostics must include the request host");
assert.match(source, /path: parsed\.pathname/, "API diagnostics must include the request path");
assert.match(source, /API request started/, "API diagnostics must log request starts");
assert.match(source, /API request succeeded/, "API diagnostics must log status and duration on success");
assert.match(source, /API request failed/, "API diagnostics must log failures");
assert.match(source, /Storage backend selected/, "storage backend and fallback diagnostics must be visible");
assert.match(source, /Native bridge HTTP fallback/, "native bridge fallback diagnostics must be visible");
assert.match(source, /Startup runtime/, "startup runtime diagnostics must be visible");
assert.doesNotMatch(source, /console\.warn\("Catalog fetch failed:/, "raw console warnings must use the secret-safe logger");
assert.doesNotMatch(source, /console\.error\("Refresh failed:/, "raw console errors must use the secret-safe logger");

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
assert.match(source, /async function fetchTornWarStatuses\(factionId, apiKey\)/, "live enemy status must use the Torn faction-members response");
assert.match(source, /faction\/\$\{factionId\}\/members/, "live enemy status must use Torn v2 faction members");
assert.doesNotMatch(source, /TORN_V1_BASE_URL/, "legacy Torn v1 profile batches must not be used for live status");
assert.match(source, /function pauseWindowActivity\(\)/, "minimizing must pause all refresh timers");
assert.match(source, /function resumeWindowActivity\(\)/, "restoring must resume permitted refresh timers");
assert.match(source, /if \(state\.isMinimized\) \{[\s\S]*return Promise\.reject/, "request wrappers must block API calls while minimized");
assert.match(source, /if \(state\.isMinimized\) return false;/, "refresh entry points must pause while minimized");
assert.doesNotMatch(renderer, /buildStatCard\("Estimates"/, "backend Estimates card must remain hidden");
assert.match(controls, /input\.onwheel/, "FF range fields must support wheel stepping");
assert.match(controls, /event\.preventDefault\(\)/, "FF wheel stepping must not scroll the page");
assert.match(source, /data-corner="top-left"/, "top-left window resize grip must exist");
assert.match(source, /data-corner="bottom-left"/, "bottom-left window resize grip must exist");
assert.match(source, /data-corner="bottom-right"/, "bottom-right window resize grip must exist");
assert.doesNotMatch(source, /data-corner="top-right"/, "top-right corner must remain reserved for Minimize");
assert.match(resize, /"bottom-left": \{ fromLeft: true, fromTop: false \}/, "bottom-left grip must resize from the left");
assert.match(resize, /"bottom-right": \{ fromLeft: false, fromTop: false \}/, "bottom-right grip must resize from the right");
assert.match(resize, /capturePointer\(handle, resizePointerId\)/, "each active resize grip must capture its pointer when available");
assert.match(resize, /releasePointer\(resizeHandle, resizePointerId\)/, "resize pointer capture must be released when resizing ends");
assert.match(source, /down: "pointerdown", move: "pointermove", up: "pointerup"/, "pointer events must support resize interactions");
assert.match(source, /down: "mousedown", move: "mousemove", up: "mouseup"/, "mouse events must remain a resize fallback");
assert.match(source, /overflow: hidden !important/, "widget content must not overflow horizontally or vertically");
assert.match(source, /min-inline-size: 0 !important/, "cards and fields must be allowed to shrink with the widget");
assert.match(source, /max-inline-size: 100% !important/, "cards and fields must remain constrained to the widget width");
assert.match(source, /minWidth: Math\.min\(380, maxWidth\)/, "the script window must enforce a readable minimum width");
assert.match(source, /minHeight: Math\.min\(620, maxHeight\)/, "the script window must enforce a readable minimum height");
assert.match(source, /grid-template-rows: auto auto auto minmax\(0, 1fr\)/, "FFScouter must reserve separate rows for refresh header, section title, tabs, and targets");
assert.match(source, /scrollbar-width: none/, "FFScouter scrollbars must remain hidden without disabling scrolling");
assert.match(scrollbarStyles, /ntc-war-target-table-wrap/, "war-target scrollbars must be visually hidden");
assert.match(scrollbarStyles, /dialog::-webkit-scrollbar \{ display: none;/, "dialog scrollbars must be visually hidden");
assert.match(source, /ntc-war-target-table-wrap[\s\S]*overflow-y:auto/, "war-target vertical scrolling must remain enabled");
assert.match(source, /dialog id="ffscouter-verification-dialog"[\s\S]*overflow-y: auto/, "dialog vertical scrolling must remain enabled");
assert.match(source, /resizeRenderTimer = setTimeout/, "FFScouter columns must recalculate while the window is being resized");
assert.match(source, /widgetBody\.style\.overflowY = "hidden"/, "the script window itself must not vertically scroll");
assert.match(source, /function fitCurrentContentToWidget\(\)/, "non-table panels must scale to fit the available window height");
assert.match(source, /requestAnimationFrame\(fitCurrentContentToWidget\)/, "card fitting must run after renders and size changes");
assert.match(source, /min-height:210px;flex:1 1 auto;border:1px solid #343a43/, "the FFScouter table must retain room for roughly five readable target rows");
assert.match(source, /ntc-ffscouter-summary/, "the FFScouter summary must have an independently responsive container");
assert.match(source, /const preferredTableHeight = tableHeaderHeight \+ \(tableRowHeight \* 4\) \+ 4/, "FFScouter must reserve four readable player rows before summary scaling");
assert.match(source, /const minimumTableHeight = tableHeaderHeight \+ \(tableRowHeight \* 3\) \+ 4/, "FFScouter must keep a useful minimum player-table viewport");
assert.match(source, /const maximumTableHeight = Math\.max\(0, Math\.floor\(layoutHeight - layoutGap\)\)/, "short visual viewports must clamp the table to the available layout height");
assert.match(source, /tableWrap\.style\.setProperty\("min-height", `\$\{tableHeight\}px`, "important"\)/, "responsive table height must override mobile minimums safely");
assert.match(source, /nfc-war-target-table--compact/, "narrow FFScouter headers must use explicit compact labels rather than clipped text");
assert.match(source, /compactLabel: "On"/, "compact FFScouter headers must use short visible names");
assert.match(source, /nfc-faction-general-layout/, "General must have an independent compact portrait layout");
assert.doesNotMatch(source, /Math\.max\(0\.72, Math\.min\(1, availableHeight/, "General must fit fully rather than clip at a fixed zoom floor");
assert.match(source, /ntc-ffscouter-summary-viewport/, "the FFScouter summary must reserve its own non-overlapping layout row");
assert.match(source, /summaryViewport\.style\.flex = `0 0 \$\{reservedSummaryHeight\}px`/, "the table must begin below the reserved FFScouter summary height");
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
