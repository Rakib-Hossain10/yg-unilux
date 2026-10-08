"use client";

// The save loop of the import (T9, ADR 0058 + 0061): sends the batches that
// write something, one after another, each with the preview's ETag, plan hash
// and every entry hash; stops at the first failed batch so it can be retried
// (re-sending is safe: saved products plan as unchanged); calls finish after
// the last batch. Progress and per-product results are kept for the screen.

import { useEffect, useRef, useState, useTransition } from "react";

import {
  commitImportBatchAction,
  finishImportAction,
} from "@/app/admin/import/actions";
import type { CommittedProduct } from "@/lib/import";

import { allMessages, callAction } from "../action-result";
import type { ImportSource } from "./import-upload-step";
import {
  batchEntries,
  batchesToSend,
  type CommitNext,
  type PlanView,
} from "./import-view";

export interface CommitFailure {
  messages: string[];
  next: CommitNext;
  /** The batch may have been written (audit failed or the call threw). */
  saved: boolean | "unknown";
}

export type CommitPhase = "idle" | "running" | "failed" | "done";

export interface ImportCommitState {
  phase: CommitPhase;
  /** Batches that write something, and how many of them are done. */
  total: number;
  done: number;
  /** Per plan entry, the latest result (preview status for skipped ones). */
  results: CommittedProduct[];
  failure: CommitFailure | null;
  /** False when the staged file could not be deleted (the sweep will). */
  stagedDeleted: boolean | null;
  pending: boolean;
  start: (
    source: ImportSource,
    plan: PlanView,
    acknowledgeRemovals: boolean,
  ) => void;
  /** Re-sends the failed batch, then continues. */
  retry: () => void;
  reset: () => void;
}

/* The results of a plan before anything is sent: what the preview said. */
export function initialResults(plan: PlanView): CommittedProduct[] {
  return plan.entries.map((entry) => ({
    index: entry.index,
    sheet: entry.sheet,
    rows: entry.rows,
    productNo: entry.productNo,
    name: entry.name,
    // create/update are overwritten by their batch's answer.
    status:
      entry.status === "blocked"
        ? "blocked"
        : entry.status === "unchanged"
          ? "unchanged"
          : "failed",
    id: entry.existingId,
    slug: entry.slug,
    ...(entry.status === "create" || entry.status === "update"
      ? { error: "Not saved yet." }
      : {}),
  }));
}

interface Run {
  source: ImportSource;
  plan: PlanView;
  acknowledgeRemovals: boolean;
  batches: number[];
  /** Position in `batches` of the next batch to send. */
  position: number;
}

export function useImportCommit(): ImportCommitState {
  const [phase, setPhase] = useState<CommitPhase>("idle");
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState<CommittedProduct[]>([]);
  const [failure, setFailure] = useState<CommitFailure | null>(null);
  const [stagedDeleted, setStagedDeleted] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();
  const run = useRef<Run | null>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const loop = () => {
    const current = run.current;
    if (current === null || inFlight.current) return;
    inFlight.current = true;
    setPhase("running");
    setFailure(null);
    startTransition(async () => {
      try {
        const { source, plan } = current;
        const entryHashes = plan.entries.map((entry) => entry.hash);
        while (current.position < current.batches.length) {
          if (!alive.current) return;
          const batch = current.batches[current.position] as number;
          const result = await callAction(() =>
            commitImportBatchAction({
              key: source.key,
              defaultCategoryId: source.defaultCategoryId,
              etag: plan.etag,
              planHash: plan.planHash,
              entryHashes,
              batch,
              acknowledgeRemovals: current.acknowledgeRemovals,
            }),
          );
          if (!alive.current) return;
          if (result === undefined || !result.ok) {
            setFailure({
              messages:
                result === undefined
                  ? ["The batch could not be confirmed. Try it again."]
                  : allMessages(result.errors),
              next:
                result !== undefined && "next" in result
                  ? result.next
                  : "retry",
              saved: result === undefined ? "unknown" : result.saved,
            });
            setPhase("failed");
            return;
          }
          const answered = new Map(
            result.data.products.map((product) => [product.index, product]),
          );
          // Only this batch's entries; anything else in the answer is ignored.
          const own = new Set(
            batchEntries(plan.entries, batch).map((e) => e.index),
          );
          setResults((previous) =>
            previous.map((product) =>
              own.has(product.index)
                ? (answered.get(product.index) ?? product)
                : product,
            ),
          );
          current.position += 1;
          setDone(current.position);
        }
        const finished = await callAction(() =>
          finishImportAction({ key: source.key }),
        );
        if (!alive.current) return;
        setStagedDeleted(finished?.ok === true && finished.data.deleted);
        setPhase("done");
      } finally {
        inFlight.current = false;
      }
    });
  };

  const start = (
    source: ImportSource,
    plan: PlanView,
    acknowledgeRemovals: boolean,
  ) => {
    if (inFlight.current) return;
    const batches = batchesToSend(plan.entries);
    run.current = { source, plan, acknowledgeRemovals, batches, position: 0 };
    setTotal(batches.length);
    setDone(0);
    setResults(initialResults(plan));
    setStagedDeleted(null);
    loop();
  };

  const reset = () => {
    run.current = null;
    setPhase("idle");
    setTotal(0);
    setDone(0);
    setResults([]);
    setFailure(null);
    setStagedDeleted(null);
  };

  return {
    phase,
    total,
    done,
    results,
    failure,
    stagedDeleted,
    pending,
    start,
    retry: loop,
    reset,
  };
}
