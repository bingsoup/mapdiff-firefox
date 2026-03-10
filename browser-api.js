// Browser API compatibility layer for Chrome and Firefox
// Provides unified interface for browser-specific APIs
(function () {
  "use strict";

  // Detect browser and create unified API
  const browserAPI = (() => {
    // Check if we're in Firefox or Chrome
    const isFirefox = typeof browser !== "undefined";
    const isChrome = typeof chrome !== "undefined" && !isFirefox;

    if (isFirefox) {
      return {
        storage: {
          sync: {
            get: (keys) => browser.storage.local.get(keys),
            set: (obj) => browser.storage.local.set(obj),
            remove: (keys) => browser.storage.local.remove(keys),
          },
          onChanged: browser.storage.onChanged,
        },
      };
    } else if (isChrome) {
      return {
        storage: {
          sync: {
            get: (keys) => chrome.storage.sync.get(keys),
            set: (obj) => chrome.storage.sync.set(obj),
            remove: (keys) => chrome.storage.sync.remove(keys),
          },
          onChanged: chrome.storage.onChanged,
        },
      };
    } else {
      console.warn("Neither chrome nor browser API detected");
      return {
        storage: {
          sync: {
            get: () => Promise.resolve({}),
            set: () => Promise.resolve(),
            remove: () => Promise.resolve(),
          },
          onChanged: { addListener: () => {} },
        },
      };
    }
  })();

  // Expose as window.browserStorage for use in content scripts and popup
  window.browserStorage = browserAPI.storage;
})();
