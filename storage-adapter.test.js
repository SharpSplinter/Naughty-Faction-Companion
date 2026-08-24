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
