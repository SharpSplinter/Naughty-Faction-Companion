const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "Naughty Faction Companion.user.js"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const baseNormalizerSource = section("function normalizeStaffApiBase", "const getStoredStaffApiBase");
const payloadNormalizerSource = section("function normalizeStaffStatusPayload", "const getStoredPosition");
const headerRefreshSource = section("function getHeaderRefreshTarget", "const SECTION_TAB_LABELS");
const freshnessSource = section("function getSectionFreshness", "function formatUtcTimestamp");
const fairFightFormatterSource = section("const formatFairFight", "const formatOptionalInteger");
const pdaTouchWidthSource = section("function getWarTargetColumnTouchWidthBonus", "function computeResponsiveColumnWidths");

const makeBaseNormalizer = new Function("STAFF_API_ORIGIN", "URL", `${baseNormalizerSource}\nreturn normalizeStaffApiBase;`);
const makePayloadNormalizer = new Function(`${payloadNormalizerSource}\nreturn normalizeStaffStatusPayload;`);
const makeFairFightFormatter = new Function(`${fairFightFormatterSource}\nreturn formatFairFight;`);
const makePdaTouchWidth = new Function("isTornPDAEnvironment", "isTornPDACandidate", `${pdaTouchWidthSource}\nreturn getWarTargetColumnTouchWidthBonus;`);

test("metadata and runtime fallback identify this release", () => {
    assert.match(source, /^\/\/ @version\s+1\.1\.87$/m);
    assert.match(source, /const VERSION = \(typeof GM_info !== "undefined"/);
    assert.match(source, /^\/\/ @run-at\s+document-start$/m);
    assert.match(source, /^\/\/ @license\s+MIT$/m);
    assert.match(source, /^\/\/ @connect\s+naughtybot\.unifiedbot\.net$/m);
});

test("TornPDA source adaptation remains parse-safe", () => {
    const adapted = source.replaceAll("###PDA-APIKEY###", "injected-demo-key").replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    assert.doesNotThrow(() => new vm.Script(adapted));
});

test("Staff Dashboard only accepts the declared API origin", () => {
    const normalize = makeBaseNormalizer("https://naughtybot.unifiedbot.net", URL);
    assert.equal(normalize("https://naughtybot.unifiedbot.net/"), "https://naughtybot.unifiedbot.net");
    assert.equal(normalize("https://naughtybot.unifiedbot.net"), "https://naughtybot.unifiedbot.net");
    assert.equal(normalize("http://naughtybot.unifiedbot.net"), "");
    assert.equal(normalize("https://example.com"), "");
    assert.equal(normalize("https://naughtybot.unifiedbot.net/api"), "");
    assert.equal(normalize("not a url"), "");
});

test("Staff payloads are normalized before rendering or caching", () => {
    const normalize = makePayloadNormalizer();
    const data = normalize({
        members: [{ id: 8317, name: "Member" }, null],
        loans: [{ weapon_name: "Rifle" }],
        bleeders: "invalid",
        revives: [{ id: 42 }],
        wars: [{ enemy_name: "Enemy" }],
        hospitalized_count: "3.8"
    });
    assert.equal(data.members.length, 1);
    assert.equal(data.loans.length, 1);
    assert.deepEqual(data.bleeders, []);
    assert.equal(data.hospitalized_count, 3);
    assert.throws(() => normalize(null), /invalid response/);
    assert.throws(() => normalize([]), /invalid response/);
});

test("Staff statuses and last actions use the companion presence colors", () => {
    const toneSource = section("function getStaffPresenceTone", "function renderStaffPresence");
    const getTone = new Function(`${toneSource}\nreturn getStaffPresenceTone;`)();
    assert.equal(getTone("Okay", "status"), "okay");
    assert.equal(getTone("Traveling from Torn to Switzerland", "status"), "travel");
    assert.equal(getTone("Hospital", "status"), "hospital");
    assert.equal(getTone("Online", "action"), "online");
    assert.equal(getTone("Idle", "action"), "idle");
    assert.equal(getTone("Offline", "action"), "offline");
    assert.match(source, /nfc-staff-presence--online[\s\S]*#7fe18d/);
    assert.match(source, /nfc-staff-presence--idle[\s\S]*#e0a25e/);
    assert.match(source, /nfc-staff-presence--offline[\s\S]*#9aa4b2/);
    assert.match(source, /renderStaffPresence\("Status", status, "status"\)/);
    assert.match(source, /renderStaffPresence\("Last action", lastAction, "action"\)/);
});

test("Staff credentials are persistent but secret-safe", () => {
    assert.match(source, /staffApiBase: "NFC_V1_STAFF_API_BASE"/);
    assert.match(source, /staffApiToken: "NFC_V1_STAFF_API_TOKEN"/);
    assert.match(source, /staff: "NFC_V1_CACHE_STAFF"/);
    assert.match(source, /APP_STORAGE\.staffApiBase,/);
    assert.match(source, /APP_STORAGE\.staffApiToken,/);
    assert.match(source, /getBackupSecretStorageKeys = \(\) => \[APP_STORAGE\.key, APP_STORAGE\.ffscouterKey, APP_STORAGE\.staffApiToken\]/);
    assert.match(source, /Authorization: `Bearer \$\{token\}`/);
    assert.match(source, /"X-Staff-Token": token/);
    assert.doesNotMatch(section("function fetchStaffStatus", "const STAFF_SUBTABS"), /\?token=/);
    assert.match(source, /id="staff-api-token-input" value=""/);
    assert.match(source, /id="ffscouter-api-key-input" value=""/);
    assert.match(source, /id="torn-api-key-input" value=""/);
});

test("Staff has a persistent cache and only refreshes while its view is active", () => {
    assert.match(source, /setSectionCache\("staff", staffData\)/);
    assert.match(source, /state\.staffData = state\.caches\.staff/);
    assert.match(source, /if \(due && target\.section === "staff"\) \{\s*if \(getStoredStaffApiBase\(\)\) void refreshSectionByKey/);
    assert.match(source, /if \(state\.currentTab === "staff"\) return "staff:overview"/);
});

test("FFScouter supports pre-war scouting and collapsible Sort & View controls", () => {
    const phaseSource = section("function getRankedWarPhase", "async function refreshWarTargets");
    const getPhase = new Function("formatDuration", `${phaseSource}\nreturn getRankedWarPhase;`)((seconds) => `${seconds}s`);
    assert.deepEqual(getPhase({ start: 120 }, 60_000), {
        isPreWar: true,
        label: "Pre-war scouting",
        detail: "Starts in 60s"
    });
    assert.deepEqual(getPhase({ start: 120 }, 120_000), {
        isPreWar: false,
        label: "Live Ranked War",
        detail: ""
    });
    const refreshSource = section("async function refreshWarTargets", "function bindFactionControls");
    assert.doesNotMatch(refreshSource, /targets load after the Ranked War begins/);
    assert.match(refreshSource, /scheduled or active Ranked War are required/);
    assert.match(refreshSource, /Fresh — Pre-war FFScouter target data updated\./);
    assert.match(refreshSource, /if \(hasRankedWarStarted\(war\)\) void syncWarHospitalAlertsFromFreshData/);
    assert.match(refreshSource, /else void clearScheduledWarHospitalAlerts\(\)/);
    assert.match(source, /warTargetControlsCollapsed: false/);
    assert.match(source, /data-action="toggle-war-target-controls"/);
    assert.match(source, /Show Sort & View/);
    assert.match(source, /Hide Sort & View/);
});

test("FFScouter preserves Fair Fight hundredths and widens its PDA sort target", () => {
    const formatFairFight = makeFairFightFormatter();
    const pdaTouchWidth = makePdaTouchWidth(() => true, () => false);
    assert.equal(formatFairFight(1), "1.00");
    assert.equal(formatFairFight(1.2), "1.20");
    assert.equal(formatFairFight(1.239), "1.24");
    assert.equal(formatFairFight(0), "—");
    assert.equal(pdaTouchWidth("ff"), 8);
    assert.equal(pdaTouchWidth("stats"), 0);
    assert.match(source, /const ff = formatFairFight\(target\.fairFight\);/);
    assert.match(source, /ff: \{ label: "FF", compactLabel: "FF", align: "center", minWidth: 50, hardFloor: 38 \}/);
    assert.match(section("function filterWarTargets", "function getWarTargetSortValue"), /Number\(rangeMetric === "bs" \? target\?\.battleStats : target\?\.fairFight\)/);
    assert.match(section("function getWarTargetSortValue", "function sortWarTargets"), /case "ff": return Number\(target\?\.fairFight \|\| 0\);/);
});

test("only the header owns section refresh while FFScouter keeps live status refresh", () => {
    const statusHeaderSource = section("function renderSectionRefreshHeader", "function getHeaderRefreshTarget");
    assert.doesNotMatch(statusHeaderSource, /data-section-refresh/);
    assert.doesNotMatch(source, /data-refresh-section/);
    assert.doesNotMatch(source, /function bindSectionRefreshButtons/);
    assert.doesNotMatch(source, /bindSectionRefreshButtons\(\);/);
    assert.match(source, /id="refresh-war-live-btn" class="nfc-primary-action">Refresh Live Status<\/button>/);
    assert.match(source, /class="nfc-secondary-action nfc-ffscouter-toggle"/);
    assert.match(source, /\.nfc-secondary-action \{[^}]*color:#edf4ff/);
    assert.match(source, /data-theme="light"\] \.nfc-secondary-action \{[^}]*color:#172033/);
});

test("every active parent and subtab uses the shared header/status vocabulary", () => {
    for (const label of ["Faction", "Staff", "Settings", "General", "FFScouter", "Statuses", "Loans", "Bleeders", "Revives", "Controls", "Auto Refresh", "Integrations", "Exports"]) {
        assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.match(source, /nfc-tab-status/);
    assert.match(source, /Fresh/);
    assert.match(source, /Partial/);
    assert.match(source, /Stale/);
    assert.match(source, /Not updated/);
    assert.match(source, /formatUtcTimestamp/);
    assert.match(source, /Refresh Staff data/);
    assert.match(source, /Refresh Faction data/);
});

test("responsive shell keeps headers compact and owns scrolling in the main body", () => {
    assert.match(source, /function getLayoutProfile\(\)/);
    assert.match(source, /dashboard\.dataset\.layoutProfile = layoutProfile/);
    assert.match(source, /ResizeObserver/);
    assert.match(source, /#nfc-faction-wrapper #nfc-main-body \{[\s\S]*overflow-y:auto !important;[\s\S]*touch-action:pan-y pinch-zoom;/);
    assert.match(source, /#nfc-faction-wrapper #nfc-content \{[\s\S]*overflow:visible !important;/);
    assert.match(source, /#nfc-faction-wrapper #nfc-drag-handle \{[\s\S]*flex:0 0 auto;/);
    assert.match(source, /#nfc-faction-wrapper #nfc-title \{[\s\S]*white-space:normal;/);
    assert.match(source, /nfc-faction-general-layout \{[\s\S]*display:flex !important;[\s\S]*flex-direction:column !important;/);
    assert.doesNotMatch(section("function fitCurrentContentToWidget", "function pauseWindowActivity"), /style\.zoom = String/);
    assert.doesNotMatch(section("function fitCurrentContentToWidget", "function pauseWindowActivity"), /availableHeight/);
});

test("refresh header updates cleanly for the active tab", () => {
    const state = { currentTab: "staff", factionSubTab: "general" };
    const getHeaderRefreshTarget = new Function("state", `${headerRefreshSource}\nreturn getHeaderRefreshTarget;`)(state);
    assert.deepEqual(getHeaderRefreshTarget(), { section: "staff", label: "Refresh Staff data" });
    state.currentTab = "faction";
    assert.deepEqual(getHeaderRefreshTarget(), { section: "faction", label: "Refresh Faction data" });
    state.factionSubTab = "ffscouter";
    assert.deepEqual(getHeaderRefreshTarget(), { section: "warTargets", label: "Refresh FFScouter data" });
    state.currentTab = "settings";
    assert.deepEqual(getHeaderRefreshTarget(), { section: null, label: "Settings saved locally" });
});

test("freshness reflects source-specific timestamps", () => {
    const state = { lastRefreshBySection: { staff: 0 }, sectionStatus: { staff: "Not updated" } };
    const getSectionFreshness = new Function("state", "QUICK_REFRESH_MS", "getSectionSourceLabel", `${freshnessSource}\nreturn getSectionFreshness;`)(state, 300000, () => "NaughtyBot Staff Dashboard");
    assert.equal(getSectionFreshness("staff").label, "Not updated");
    state.lastRefreshBySection.staff = Date.now();
    state.sectionStatus.staff = "Fresh — Staff Dashboard response received.";
    assert.equal(getSectionFreshness("staff").label, "Fresh");
    state.sectionStatus.staff = "Partial — request incomplete.";
    assert.equal(getSectionFreshness("staff").label, "Partial");
});
