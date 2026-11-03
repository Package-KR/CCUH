// 브라우저 창의 한 번 읽기 관측
(async (browser, chromeTabId, runtimeHash) => {
  const browserExports = {};
  ((exports) => {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.observeBrowserTabWindow = observeBrowserTabWindow;
const UNSUPPORTED = Object.freeze([
    'os-window-id',
    'cua-native-window',
    'cua-tab-id-binding',
    'display-id',
    'spaces',
]);
const WINDOW_STATES = ['normal', 'minimized', 'maximized', 'fullscreen', 'locked-fullscreen'];
function validId(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function readFields(value, keys) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return;
    try {
        const fields = Object.create(null);
        for (const key of keys) {
            const field = Object.getOwnPropertyDescriptor(value, key);
            if (!field)
                continue;
            if (!Object.hasOwn(field, 'value'))
                return;
            fields[key] = field.value;
        }
        return fields;
    }
    catch {
        return;
    }
}
function readTab(value) {
    const fields = readFields(value, ['id', 'windowId']);
    if (!fields || !validId(fields.id) || !validId(fields.windowId))
        return;
    return { id: fields.id, windowId: fields.windowId };
}
function readWindow(value) {
    const coordinates = ['left', 'top', 'width', 'height'];
    const fields = readFields(value, ['id', 'state', ...coordinates]);
    if (!fields || !validId(fields.id) || typeof fields.state !== 'string' || !WINDOW_STATES.includes(fields.state))
        return;
    for (const key of coordinates) {
        if (!Object.hasOwn(fields, key) || fields[key] === null || fields[key] === undefined)
            continue;
        const value = fields[key];
        if (typeof value !== 'number' ||
            !Number.isSafeInteger(value) ||
            ((key === 'width' || key === 'height') && value <= 0))
            return;
    }
    const bounds = coordinates.every(key => typeof fields[key] === 'number')
        ? Object.freeze({
            left: fields.left,
            top: fields.top,
            width: fields.width,
            height: fields.height,
            unit: 'chrome-window-pixels',
        })
        : null;
    return { id: fields.id, state: fields.state, bounds };
}
function sameBrowser(browser, browserId) {
    try {
        return browser.browserId === browserId;
    }
    catch {
        return false;
    }
}
function unavailable(reason) {
    return Object.freeze({ status: 'unavailable', reason });
}
async function observeBrowserTabWindow(browser, chromeTabId) {
    let reason = 'invalid-input';
    try {
        if (!browser || typeof browser !== 'object' || !validId(chromeTabId))
            return unavailable(reason);
        const browserId = browser.browserId;
        if (typeof browserId !== 'string' ||
            browserId.trim().length === 0 ||
            browserId.length > 1024 ||
            /[\u0000-\u001f\u007f]/u.test(browserId))
            return unavailable(reason);
        reason = 'management-unavailable';
        const management = (await browser.capabilities.get('management'));
        if (!sameBrowser(browser, browserId))
            return unavailable('browser-identity-changed');
        if (!management ||
            typeof management !== 'object' ||
            Array.isArray(management) ||
            typeof management.tabs?.get !== 'function' ||
            typeof management.windows?.get !== 'function')
            return unavailable(reason);
        reason = 'tab-unavailable';
        const firstTab = readTab(await management.tabs.get(chromeTabId));
        if (!sameBrowser(browser, browserId))
            return unavailable('browser-identity-changed');
        if (!firstTab || firstTab.id !== chromeTabId)
            return unavailable('invalid-tab');
        reason = 'window-unavailable';
        const windowValue = await management.windows.get(firstTab.windowId, { populate: false });
        const capturedAtMs = Date.now();
        if (!sameBrowser(browser, browserId))
            return unavailable('browser-identity-changed');
        const window = readWindow(windowValue);
        if (!window || window.id !== firstTab.windowId || !validId(capturedAtMs))
            return unavailable('invalid-window');
        reason = 'tab-unavailable';
        const lastTab = readTab(await management.tabs.get(chromeTabId));
        if (!sameBrowser(browser, browserId))
            return unavailable('browser-identity-changed');
        if (!lastTab || lastTab.id !== chromeTabId)
            return unavailable('invalid-tab');
        if (lastTab.windowId !== firstTab.windowId)
            return unavailable('tab-window-changed');
        return Object.freeze({
            status: 'observed',
            browserId,
            identityScope: 'chrome-browser-session',
            chromeTabId,
            chromeWindowId: window.id,
            state: window.state,
            bounds: window.bounds,
            capturedAtMs,
            unsupported: UNSUPPORTED,
        });
    }
    catch {
        return unavailable(reason);
    }
}
  })(browserExports);
  const observation = await browserExports.observeBrowserTabWindow(browser, chromeTabId);
  nodeRepl.write({ ccuhBrowserWindow: 'result', runtimeHash, sourceHash: 'a4734044ff8971a6aabc5b5e87d0de74c0cb99ca8d99691c69d610dc61eba866', observation });
})
