const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "Naughty Faction Companion.user.js"), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const queueSource = section("function createPdaWriteQueue", "const PDA_WRITE_QUEUE");
const getSource = section("const gmGetValue = async", "const gmSetValue");
const setSource = section("const gmSetValue = async", "const getStoredKey");
const deleteSource = section("const deleteStoredValue = async", "const normalizeStoragePreference");
const nativeWriteSource = section("const writePdaValuesNow = async", "function createPdaWriteQueue");
const nativeLoadSource = section("const loadPdaStorage = async", "const legacyGetValue");
const storageRetrySource = section("function schedulePdaStorageRetryAfterBridgeReady", "const loadPdaStorage");
const pdaHandlerSource = section("function pdaHandler", "const NATIVE_TOAST_COLORS");
const backupValidationSource = section("function validateLocalBackupPayload", "function readLocalBackupFile");

const createPdaWriteQueue = new Function("PDA_WRITE_DEBOUNCE_MS", "warnLog", `${queueSource}\nreturn createPdaWriteQueue;`)(1, () => {});
const makeGet = (state, readLegacyValue, readPdaValue, writeLegacyValues, pdaSetValues) => new Function(
    "state", "readLegacyValue", "readPdaValue", "writeLegacyValues", "pdaSetValues",
    `${getSource}\nreturn gmGetValue;`
)(state, readLegacyValue, readPdaValue, writeLegacyValues, pdaSetValues);
const makeSet = (state, writeLegacyValues, pdaSetValues) => new Function(
    "state", "writeLegacyValues", "pdaSetValues", "warnLog",
    `${setSource}\nreturn gmSetValue;`
)(state, writeLegacyValues, pdaSetValues, () => {});
const makeDelete = (hasPdaStorage, PDA_storage, PDA_STORE, legacyDeleteValue, localStorage) => new Function(
    "hasPdaStorage", "PDA_storage", "PDA_STORE", "legacyDeleteValue", "localStorage", "PDA_WRITE_QUEUE", "warnLog", "safeErrorMessage",
    `${deleteSource}\nreturn deleteStoredValue;`
)(hasPdaStorage, PDA_storage, PDA_STORE, legacyDeleteValue, localStorage, { flush: async () => true }, () => {}, (error) => String(error));
const makeNativeWrite = (loadPdaStorage, hasPdaStorage, PDA_storage) => new Function(
    "loadPdaStorage", "hasPdaStorage", "PDA_storage", "warnLog", "safeErrorMessage",
    `${nativeWriteSource}\nreturn writePdaValuesNow;`
)(loadPdaStorage, hasPdaStorage, PDA_storage, () => {}, (error) => String(error));
const makeNativeLoad = ({ hasPdaStorage, PDA_storage, PDA_STORE, waitForPdaStorageBridgeReady, schedulePdaStorageRetryAfterBridgeReady = () => {}, isTornPDACandidate = () => true, pdaBridgeReadyEventSeen = true }) => new Function(
    "hasPdaStorage", "PDA_storage", "PDA_STORE", "waitForPdaStorageBridgeReady", "schedulePdaStorageRetryAfterBridgeReady", "isTornPDACandidate", "pdaBridgeReadyEventSeen", "debugLog", "warnLog", "safeErrorMessage", "window",
    `${nativeLoadSource}\nreturn loadPdaStorage;`
)(hasPdaStorage, PDA_storage, PDA_STORE, waitForPdaStorageBridgeReady, schedulePdaStorageRetryAfterBridgeReady, isTornPDACandidate, pdaBridgeReadyEventSeen, () => {}, () => {}, (error) => String(error), {
    addEventListener: () => {},
    removeEventListener: () => {}
});
const makeStorageRetry = (pdaBridgeReadyEventSeen, PDA_STORE, window, loadPdaStorage) => new Function(
    "pdaBridgeReadyEventSeen", "PDA_STORE", "window", "loadPdaStorage",
    `${storageRetrySource}\nreturn schedulePdaStorageRetryAfterBridgeReady;`
)(pdaBridgeReadyEventSeen, PDA_STORE, window, loadPdaStorage);
const makePdaHandler = (waitForTornPDABridgeReady) => new Function(
    "waitForTornPDABridgeReady", "PDA_BRIDGE_READY_TIMEOUT_MS", "debugLog", "warnLog", "safeErrorMessage",
    `${pdaHandlerSource}\nreturn pdaHandler;`
)(waitForTornPDABridgeReady, 1, () => {}, () => {}, (error) => String(error));
const makeBackupValidator = new Function(
    "isBackupRecord", "cloneBackupPayload", "BACKUP_SCHEMA", "BACKUP_SCHEMA_VERSION", "BACKUP_STORAGE_NAMESPACE", "getManagedStorageKeys", "getBackupSecretStorageKeys",
    `${backupValidationSource}\nreturn validateLocalBackupPayload;`
)(
    (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value),
    (value) => JSON.parse(JSON.stringify(value)),
    "naughty-faction-companion-backup",
    1,
    "NFC_V1",
    () => ["key", "ff", "position"],
    () => ["key", "ff"]
);

test("native reads win over legacy values", async () => {
    let legacyReads = 0;
    const get = makeGet(
        { useLegacyGMStorage: false },
        async () => { legacyReads += 1; return { found: true, value: "legacy" }; },
        async () => ({ found: true, value: "native" }),
        async () => true,
        async () => true
    );
    assert.equal(await get("key", "fallback"), "native");
    assert.equal(legacyReads, 0);
});

test("legacy values migrate once into the native primary store", async () => {
    let nativeValue;
    let nativeWrites = 0;
    const get = makeGet(
        { useLegacyGMStorage: false },
        async () => ({ found: true, value: "legacy" }),
        async () => nativeValue === undefined ? { found: false } : { found: true, value: nativeValue },
        async () => true,
        async (values) => { nativeWrites += 1; nativeValue = values.key; return true; }
    );
    assert.equal(await get("key", "fallback"), "legacy");
    assert.equal(await get("key", "fallback"), "legacy");
    assert.equal(nativeWrites, 1);
});

test("legacy GM opt-in keeps GM as the primary storage route", async () => {
    let nativeReads = 0;
    let nativeWrites = 0;
    const state = { useLegacyGMStorage: true };
    const get = makeGet(
        state,
        async () => ({ found: true, value: "legacy" }),
        async () => { nativeReads += 1; return { found: true, value: "native" }; },
        async () => true,
        async () => { nativeWrites += 1; return true; }
    );
    const set = makeSet(state, async (values) => values.key === "saved", async () => { nativeWrites += 1; return true; });
    assert.equal(await get("key", "fallback"), "legacy");
    assert.equal(await set("key", "saved"), true);
    assert.equal(nativeReads, 0);
    assert.equal(nativeWrites, 0);
});

test("queued PDA writes coalesce into one setMany payload", async () => {
    const nativeCalls = [];
    const queue = createPdaWriteQueue(async (values) => { nativeCalls.push(values); return true; }, async () => false, 1);
    const results = await Promise.all([
        queue.enqueue({ first: 1, shared: "old" }),
        queue.enqueue({ second: 2, shared: "new" }),
        queue.enqueue({ third: 3 })
    ]);
    assert.deepEqual(results, [true, true, true]);
    assert.deepEqual(nativeCalls, [{ first: 1, shared: "new", second: 2, third: 3 }]);
});

test("PDA quota failure falls back to one legacy batch", async () => {
    const legacyCalls = [];
    const nativeWrite = makeNativeWrite(
        async () => ({}),
        () => true,
        { setMany: async () => { const error = new Error("quota"); error.code = "QuotaExceeded"; throw error; } }
    );
    const queue = createPdaWriteQueue(nativeWrite, async (values) => { legacyCalls.push(values); return true; }, 1);
    assert.equal(await queue.enqueue({ cache: "value" }), true);
    assert.deepEqual(legacyCalls, [{ cache: "value" }]);
});

test("native storage waits for bridge readiness before loading", async () => {
    let readyCalls = 0;
    let loadCalls = 0;
    const load = makeNativeLoad({
        hasPdaStorage: () => true,
        PDA_storage: { loadAll: () => { loadCalls += 1; return { saved: true }; } },
        PDA_STORE: { loaded: null, values: null, fallbackLogged: false, retryScheduled: false },
        waitForPdaStorageBridgeReady: async () => { readyCalls += 1; return { callHandler: () => {} }; }
    });
    assert.deepEqual(await load(), { saved: true });
    assert.equal(readyCalls, 1);
    assert.equal(loadCalls, 1);
});

test("synchronous native storage startup errors resolve to the GM fallback", async () => {
    const store = { loaded: null, values: null, fallbackLogged: false, retryScheduled: false };
    const load = makeNativeLoad({
        hasPdaStorage: () => true,
        PDA_storage: { loadAll: () => { throw new Error("bridge not ready"); } },
        PDA_STORE: store,
        waitForPdaStorageBridgeReady: async () => ({ callHandler: () => {} })
    });
    assert.equal(await load(), null);
    assert.equal(store.values, null);
    assert.equal(store.fallbackLogged, true);
});

test("late bridge readiness retries storage when it was unavailable at startup", async () => {
    const store = { loaded: Promise.resolve(null), values: null, fallbackLogged: true, retryScheduled: false };
    let readyListener;
    let retryCalls = 0;
    const retry = makeStorageRetry(false, store, {
        addEventListener: (name, callback) => { if (name === "flutterInAppWebViewPlatformReady") readyListener = callback; }
    }, () => { retryCalls += 1; return Promise.resolve({}); });
    retry();
    assert.equal(store.retryScheduled, true);
    assert.equal(typeof readyListener, "function");
    readyListener();
    assert.equal(store.retryScheduled, false);
    assert.equal(retryCalls, 1);
});

test("native handler turns a synchronous bridge failure into a rejected promise", async () => {
    const pdaHandler = makePdaHandler(async () => ({ callHandler: () => { throw new Error("bridge not ready"); } }));
    const result = pdaHandler("showToast", { text: "test" });
    assert.equal(typeof result.then, "function");
    await assert.rejects(result, /bridge not ready/);
});

test("delete uses native PDA_storage.delete and GM fallback semantics", async () => {
    const nativeDeleted = [];
    const legacyDeleted = [];
    const store = { values: { cache: "value" } };
    const deleteValue = makeDelete(
        () => true,
        { delete: async (key) => nativeDeleted.push(key) },
        store,
        async (key) => { legacyDeleted.push(key); return true; },
        { removeItem: () => { throw new Error("local fallback should not be needed"); } }
    );
    assert.equal(await deleteValue("cache"), true);
    assert.deepEqual(nativeDeleted, ["cache"]);
    assert.deepEqual(legacyDeleted, ["cache"]);
    assert.equal(Object.hasOwn(store.values, "cache"), false);
});

test("failed native delete falls back to GM deletion", async () => {
    const legacyDeleted = [];
    const deleteValue = makeDelete(
        () => true,
        { delete: async () => { throw new Error("native unavailable"); } },
        { values: { cache: "value" } },
        async (key) => { legacyDeleted.push(key); return true; },
        { removeItem: () => { throw new Error("local fallback should not be needed"); } }
    );
    assert.equal(await deleteValue("cache"), true);
    assert.deepEqual(legacyDeleted, ["cache"]);
});

test("backup validation accepts only Faction storage and keeps API-key inclusion explicit", () => {
    const backup = {
        schema: "naughty-faction-companion-backup",
        schemaVersion: 1,
        namespace: "NFC_V1",
        createdAt: "2026-08-24T18:00:00.000Z",
        scriptVersion: "1.0.27",
        includesApiKeys: false,
        values: { position: { x: 12, y: 24 } }
    };
    assert.deepEqual(makeBackupValidator(backup), backup);
    assert.throws(() => makeBackupValidator({ ...backup, namespace: "other" }), /different companion/);
    assert.throws(() => makeBackupValidator({ ...backup, values: { key: "secret" } }), /API keys without the API-key flag/);
    assert.throws(() => makeBackupValidator({ ...backup, values: { unknown: true } }), /unsupported storage keys/);
});
