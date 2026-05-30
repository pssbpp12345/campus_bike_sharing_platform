(function () {
  "use strict";

  const API_BASE_URL = "https://campus-bike-sharing-backend.onrender.com/api";
  const FRONTEND_BASE_URL = "https://campus-bike-sharing-frontend.onrender.com";

  function normaliseApiUrl(input) {
    if (typeof input !== "string") return input;
    if (input.startsWith("/api/") || input === "/api") {
      return API_BASE_URL + input.slice(4);
    }
    return input;
  }

  function normaliseFrontendPath(path) {
    const value = String(path || "").trim();
    if (!value) return "/";
    if (/^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.origin !== FRONTEND_BASE_URL) return "/";
        return normaliseFrontendPath(url.pathname + url.search + url.hash);
      } catch (_) {
        return "/";
      }
    }
    if (!value.startsWith("/") || value.startsWith("//")) return "/";
    return value.replace(/^\/frontend\/(Admin|User|Student|Staff)\//i, "/$1/");
  }

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch && !window.__cbsFetchPatched) {
    window.fetch = function (input, init) {
      if (input instanceof Request) {
        const nextUrl = normaliseApiUrl(input.url.replace(window.location.origin, ""));
        if (nextUrl !== input.url && nextUrl !== input.url.replace(window.location.origin, "")) {
          input = new Request(nextUrl, input);
        }
      } else {
        input = normaliseApiUrl(input);
      }
      return originalFetch(input, init);
    };
    window.__cbsFetchPatched = true;
  }

  window.API_BASE_URL = API_BASE_URL;
  window.CBS_FRONTEND_BASE_URL = FRONTEND_BASE_URL;
  window.cbsApiUrl = normaliseApiUrl;
  window.cbsFrontendPath = normaliseFrontendPath;
})();
