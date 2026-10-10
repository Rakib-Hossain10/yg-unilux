// Node preload for the e2e `next start` process ONLY (see e2e/test-server.ts,
// which adds it to that child's NODE_OPTIONS). When E2E_FAKE_PROVIDERS_PORT is
// set it sends the app's HTTPS calls to Cloudflare R2, Cloudinary's API and
// Resend's API to the in-memory fake in server.ts on 127.0.0.1 instead.
// Nothing under src/ knows about this file, a production build never loads it,
// and without the variable it does nothing at all. Real hosts are matched by
// name, so a call to any other host (e.g. MongoDB) is never touched.

import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

// This file is e2e-only and runs before the app (and src/lib/env.ts) exists.
// eslint-disable-next-line no-restricted-properties
const port = Number(process.env.E2E_FAKE_PROVIDERS_PORT ?? "");
const HOSTS = /(^|\.)r2\.cloudflarestorage\.com$|^api\.cloudinary\.com$/;

if (Number.isInteger(port) && port > 0) {
  const realRequest = https.request;

  const redirect = (options) => {
    const original = String(options.hostname ?? options.host ?? "").replace(
      /:\d+$/,
      "",
    );
    return {
      ...options,
      protocol: "http:",
      hostname: "127.0.0.1",
      host: "127.0.0.1",
      port,
      agent: undefined,
      headers: { ...options.headers, "x-e2e-host": original },
    };
  };

  /*
   * Resend: the SDK calls the global fetch() (resend dist/index.mjs:1310),
   * not https.request, so fetch is wrapped too, for api.resend.com only.
   * Next wraps globalThis.fetch later at server start; it wraps this one.
   */
  const realFetch = globalThis.fetch;
  globalThis.fetch = function fetch(input, init) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== "https:" || url.hostname !== "api.resend.com") {
      return realFetch(input, init);
    }
    const target = `http://127.0.0.1:${port}${url.pathname}${url.search}`;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("x-e2e-host", url.hostname);
    if (input instanceof Request) {
      return realFetch(new Request(target, input), { ...init, headers });
    }
    return realFetch(target, { ...init, headers });
  };

  https.request = function request(first, second, third) {
    // (options, callback) is what the AWS SDK and Cloudinary's SDK use.
    if (
      typeof first === "object" &&
      first !== null &&
      !(first instanceof URL)
    ) {
      const host = String(first.hostname ?? first.host ?? "").replace(
        /:\d+$/,
        "",
      );
      if (HOSTS.test(host)) return http.request(redirect(first), second);
    } else {
      const url = first instanceof URL ? first : new URL(String(first));
      if (HOSTS.test(url.hostname)) {
        const options = typeof second === "object" && second ? second : {};
        const callback = typeof second === "function" ? second : third;
        return http.request(
          redirect({
            ...options,
            hostname: url.hostname,
            path: `${url.pathname}${url.search}`,
          }),
          callback,
        );
      }
    }
    return realRequest.call(https, first, second, third);
  };
  syncBuiltinESMExports();
}
