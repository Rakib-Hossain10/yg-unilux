// Node preload for the e2e `next start` process ONLY (see e2e/test-server.ts,
// which adds it to that child's NODE_OPTIONS). When E2E_FAKE_PROVIDERS_PORT is
// set it sends the app's HTTPS calls to Cloudflare R2 and Cloudinary's API to
// the in-memory fake in server.ts on 127.0.0.1 instead. Nothing under src/ knows
// about this file, a production build never loads it, and without the variable
// it does nothing at all. Real hosts are matched by name, so a call to any
// other host (e.g. MongoDB, Resend) is never touched.

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
