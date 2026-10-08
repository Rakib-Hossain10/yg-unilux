// Next's server runtime installs AsyncLocalStorage on globalThis before any
// app code runs (node-environment). Import this FIRST in a test that loads
// the real next/cache, so its work stores can be created.

import { AsyncLocalStorage } from "node:async_hooks";

const g = globalThis as { AsyncLocalStorage?: unknown };
g.AsyncLocalStorage ??= AsyncLocalStorage;
