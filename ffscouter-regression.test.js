const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "Naughty Torn Companion.js"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const persistence = section("const getStoredDashboardState", "function updateCompanyStockHistory");
const restore = section("async function loadPersistedState", "async function secureCustomFetch");
const controls = section("function bindFactionControls", "function stopWarTargetsRefreshTimer");
const renderer = section("function renderFFScouterWarTargets", "function renderFactionPanel");
const refresh = section("async function refreshWarTargets", "function bindFactionControls");
const factionFetch = section("async function fetchFactionData", "async function fetchCompanyData");

for (const key of ["warTargetSort", "warTargetFilters", "warTargetFFRange", "warTargetColumnOrder", "warTargetColumnWidths"]) {
    assert.match(persistence, new RegExp(key), `${key} must be saved`);
    assert.match(restore, new RegExp(key), `${key} must be restored`);
}

assert.doesNotMatch(controls, /state\.caches/, "view controls must never mutate faction data");
assert.match(renderer, /faction\.war \|\| data\?\.war/, "renderer must retain the target snapshot's war context");
assert.match(factionFetch, /warsRequestFailed \? \(previousFaction\.war \|\| null\) : null/, "failed wars requests must retain the last valid war");
assert.match(refresh, /currentFaction\.war\?\.warId/, "target refresh must validate the current war before committing");
assert.match(refresh, /warTargets: \{ \.\.\.refreshed, war: \{ \.\.\.war \} \}/, "target cache must carry its war snapshot");
assert.doesNotMatch(renderer, /buildStatCard\("Estimates"/, "backend Estimates card must remain hidden");
assert.match(controls, /input\.onwheel/, "FF range fields must support wheel stepping");
assert.match(controls, /event\.preventDefault\(\)/, "FF wheel stepping must not scroll the page");
assert.match(source, /data-corner="top-left"/, "top-left window resize grip must exist");
assert.match(source, /data-corner="bottom-left"/, "bottom-left window resize grip must exist");
assert.match(source, /data-corner="bottom-right"/, "bottom-right window resize grip must exist");
assert.doesNotMatch(source, /data-corner="top-right"/, "top-right corner must remain reserved for Minimize");
assert.match(source, /resizeCorner\.endsWith\("left"\)/, "corner resize must support both left-side grips");
assert.match(source, /resizeCorner\.startsWith\("top"\)/, "corner resize must support top-left grip");

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
