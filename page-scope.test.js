const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "Naughty Faction Companion.user.js"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const routeSource = section("function isFactionPageLocation", "const state =");
const currentScopeSource = section("function isCurrentPageScope", "const sleep =");
const scopeSource = section("function applyFactionPageScope", "function patchFactionPageHistory");
const historySource = section("function patchFactionPageHistory", "function registerFactionPageScopeHandlers");
const refreshSource = section("function isAutomaticRefreshAllowed", "function pauseAutomaticRefresh");
const renderSource = section("function renderTabContent", "function stopChainCountdownTimer");
const registrationSource = section("function registerFactionPageScopeHandlers", "function performAutoRefreshCycle");
const sectionRefreshSource = section("async function refreshSectionByKey", "function getAutoRefreshSetting");
const warRefreshSource = section("async function refreshWarTargets", "function bindFactionControls");
const fullRefreshSource = section("async function refreshAllSections", "function isCompanyUpdateDue");

const makeRouteMatcher = (window) => new Function("window", "URL", `${routeSource}\nreturn isFactionPageLocation;`)(window, URL);

test("page matcher accepts only the Faction page on the current Torn origin", () => {
    const window = { location: { href: "https://www.torn.com/factions.php", origin: "https://www.torn.com" } };
    const isFactionPageLocation = makeRouteMatcher(window);
    assert.equal(isFactionPageLocation("https://www.torn.com/factions.php"), true);
    assert.equal(isFactionPageLocation("https://www.torn.com/factions.php?step=your#/tab=info"), true);
    assert.equal(isFactionPageLocation("https://www.torn.com/factions.php/"), false);
    assert.equal(isFactionPageLocation("https://www.torn.com/factions.php/extra"), false);
    assert.equal(isFactionPageLocation("https://www.torn.com/page.php?sid=awards"), false);
    assert.equal(isFactionPageLocation("https://example.com/factions.php"), false);
});

test("route transitions hide, suspend, restore, and reattach the same dashboard", () => {
    const calls = { pause: 0, chain: 0, cooldown: 0, init: 0, widget: 0, render: 0, activity: 0, append: 0 };
    const attributes = {};
    const dashboard = {
        hidden: false,
        inert: false,
        isConnected: true,
        style: { setProperty: (name, value) => { dashboard.display = name === "display" ? value : dashboard.display; } },
        setAttribute: (name, value) => { attributes[name] = value; }
    };
    const window = { location: { href: "https://www.torn.com/factions.php", origin: "https://www.torn.com", pathname: "/factions.php" } };
    const document = {
        body: { appendChild: (node) => { calls.append += 1; node.isConnected = true; } },
        getElementById: () => dashboard
    };
    const state = { pageScopeActive: true, pageScopeEpoch: 0, dashboard };
    const isFactionPageLocation = makeRouteMatcher(window);
    const applyFactionPageScope = new Function(
        "window", "document", "state", "isFactionPageLocation", "pauseAutomaticRefresh", "stopChainCountdownTimer", "stopCooldownCountdownTimer", "debugLog", "initializeDOMDashboard", "applyWidgetView", "renderTabContent", "applyRuntimeActivityState",
        `${scopeSource}\nreturn applyFactionPageScope;`
    )(
        window,
        document,
        state,
        isFactionPageLocation,
        () => { calls.pause += 1; },
        () => { calls.chain += 1; },
        () => { calls.cooldown += 1; },
        () => {},
        () => { calls.init += 1; },
        () => { calls.widget += 1; },
        () => { calls.render += 1; },
        () => { calls.activity += 1; }
    );

    window.location.href = "https://www.torn.com/page.php?sid=awards";
    window.location.pathname = "/page.php";
    assert.equal(applyFactionPageScope("test-leave"), false);
    assert.equal(state.pageScopeActive, false);
    assert.equal(state.pageScopeEpoch, 1);
    assert.equal(dashboard.hidden, true);
    assert.equal(dashboard.inert, true);
    assert.equal(dashboard.display, "none");
    assert.equal(attributes["aria-hidden"], "true");
    assert.deepEqual({ pause: calls.pause, chain: calls.chain, cooldown: calls.cooldown }, { pause: 1, chain: 1, cooldown: 1 });
    assert.equal(calls.render, 0);

    dashboard.isConnected = false;
    window.location.href = "https://www.torn.com/factions.php?step=your";
    window.location.pathname = "/factions.php";
    assert.equal(applyFactionPageScope("test-return"), true);
    assert.equal(state.pageScopeActive, true);
    assert.equal(state.pageScopeEpoch, 2);
    assert.equal(dashboard.hidden, false);
    assert.equal(dashboard.inert, false);
    assert.equal(dashboard.display, "flex");
    assert.equal(attributes["aria-hidden"], "false");
    assert.equal(calls.append, 1);
    assert.equal(calls.init, 0);
    assert.equal(calls.widget, 1);
    assert.equal(calls.render, 1);
    assert.equal(calls.activity, 1);
});

test("history navigation dispatches an immediate page-scope event and patches once", () => {
    const events = [];
    const window = {
        history: {
            pushState: function(value) { return `push:${value}`; },
            replaceState: function(value) { return `replace:${value}`; }
        },
        dispatchEvent: (event) => { events.push(event.type); }
    };
    class FakeEvent { constructor(type) { this.type = type; } }
    const patchFactionPageHistory = new Function(
        "window", "Event", "PAGE_SCOPE_HISTORY_PATCH_KEY", "PAGE_SCOPE_LOCATION_EVENT",
        `${historySource}\nreturn patchFactionPageHistory;`
    )(window, FakeEvent, "__test_history_patch__", "test:location-change");

    patchFactionPageHistory();
    const wrappedPushState = window.history.pushState;
    assert.equal(window.history.pushState("away"), "push:away");
    assert.equal(window.history.replaceState("back"), "replace:back");
    assert.deepEqual(events, ["test:location-change", "test:location-change"]);
    patchFactionPageHistory();
    assert.equal(window.history.pushState, wrappedPushState);
});

test("automatic refresh and late renders stay disabled outside page scope", () => {
    const state = { pageScopeActive: false, isMinimized: false, runtimeTabState: { isActiveTab: true, isWebViewVisible: true } };
    const isAutomaticRefreshAllowed = new Function(
        "state", "document", "isTornPDAEnvironment",
        `${refreshSource}\nreturn isAutomaticRefreshAllowed;`
    )(state, { visibilityState: "visible" }, () => false);
    assert.equal(isAutomaticRefreshAllowed(), false);
    assert.match(renderSource, /if \(!state\.pageScopeActive\) return;/);
});

test("page-scope epochs reject work started before a route transition", () => {
    const state = { pageScopeActive: true, pageScopeEpoch: 4 };
    const isCurrentPageScope = new Function("state", `${currentScopeSource}\nreturn isCurrentPageScope;`)(state);
    assert.equal(isCurrentPageScope(4), true);
    state.pageScopeEpoch = 5;
    assert.equal(isCurrentPageScope(4), false);
    state.pageScopeActive = false;
    assert.equal(isCurrentPageScope(5), false);
    assert.match(sectionRefreshSource, /isCurrentPageScope\(pageScopeEpoch\)/);
    assert.match(warRefreshSource, /isCurrentPageScope\(pageScopeEpoch\)/);
    assert.match(fullRefreshSource, /isCurrentPageScope\(pageScopeEpoch\)/);
});

test("route lifecycle observes SPA, browser, and polling navigation", () => {
    assert.match(registrationSource, /addEventListener\("popstate"/);
    assert.match(registrationSource, /addEventListener\("hashchange"/);
    assert.match(registrationSource, /PAGE_SCOPE_LOCATION_EVENT/);
    assert.match(registrationSource, /state\.pageScopeActive \? 250 : 1000/);
    assert.match(registrationSource, /setTimeout\(\(\) => \{[\s\S]*sync\("url-poll"\)/);
    assert.match(registrationSource, /pagehide[\s\S]*clearTimeout\(state\.pageScopeMonitorTimer\)/);
    assert.match(registrationSource, /patchFactionPageHistory\(\)/);
});

test("URL polling detects isolated-world navigation when History cannot be patched", () => {
    const listeners = {};
    const timers = new Map();
    const cleared = [];
    const scopeCalls = [];
    let nextTimerId = 1;
    const state = { pageScopeActive: true, pageScopeHandlersRegistered: false, pageScopeMonitorTimer: null };
    const window = {
        location: { href: "https://www.torn.com/factions.php" },
        addEventListener: (name, listener) => { listeners[name] = listener; },
        setTimeout: (callback, delay) => {
            const id = nextTimerId++;
            timers.set(id, { callback, delay });
            return id;
        },
        clearTimeout: (id) => { cleared.push(id); timers.delete(id); }
    };
    const applyFactionPageScope = (reason) => {
        scopeCalls.push(reason);
        state.pageScopeActive = window.location.href.includes("/factions.php");
    };
    const registerFactionPageScopeHandlers = new Function(
        "window", "state", "PAGE_SCOPE_LOCATION_EVENT", "applyFactionPageScope", "patchFactionPageHistory", "pauseAutomaticRefresh", "stopChainCountdownTimer", "stopCooldownCountdownTimer",
        `${registrationSource}\nreturn registerFactionPageScopeHandlers;`
    )(window, state, "test:location-change", applyFactionPageScope, () => false, () => {}, () => {}, () => {});

    registerFactionPageScopeHandlers();
    assert.equal(state.pageScopeHandlersRegistered, true);
    assert.equal(scopeCalls.at(-1), "registration");
    const activePoll = timers.get(state.pageScopeMonitorTimer);
    assert.equal(activePoll.delay, 250);

    window.location.href = "https://www.torn.com/page.php?sid=awards";
    timers.delete(state.pageScopeMonitorTimer);
    activePoll.callback();
    assert.equal(scopeCalls.at(-1), "url-poll");
    assert.equal(state.pageScopeActive, false);
    assert.equal(timers.get(state.pageScopeMonitorTimer).delay, 1000);

    listeners.pagehide();
    assert.equal(state.pageScopeMonitorTimer, null);
    assert.equal(cleared.length > 0, true);
});
