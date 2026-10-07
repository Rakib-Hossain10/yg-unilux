"use client";

// The import page's three steps (T9, ADR 0058): 1 upload and preview,
// 2 check the preview, 3 save in batches. Holds which step is shown, the
// staged file and the preview; the save loop lives in useImportCommit.
// Focus moves to the step's heading when the step changes.

import { FolderTree } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  finishImportAction,
  previewImportAction,
} from "@/app/admin/import/actions";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

import { allMessages, callAction } from "../action-result";
import { ADMIN_SECTIONS } from "../admin-sections";
import type { CategoryOption } from "../product-new-form";
import { ImportCommitStep } from "./import-commit-step";
import { ImportPreviewStep, RefusedFile } from "./import-preview-step";
import { ImportUploadStep, type ImportSource } from "./import-upload-step";
import type { ImportPreviewView, PlanView } from "./import-view";
import { useImportCommit } from "./use-import-commit";

type Stage =
  | { step: "upload"; errors: string[] }
  | { step: "preview"; source: ImportSource; view: ImportPreviewView }
  | { step: "commit"; source: ImportSource; plan: PlanView };

const STEPS = [
  { key: "upload", label: "Upload" },
  { key: "preview", label: "Check" },
  { key: "commit", label: "Save" },
] as const;

const HEADINGS: Record<Stage["step"], string> = {
  upload: "Step 1: Upload the file",
  preview: "Step 2: Check what will change",
  commit: "Step 3: Save",
};

function StepList({ current }: { current: Stage["step"] }) {
  const at = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex flex-wrap gap-2 text-sm" aria-label="Import steps">
      {STEPS.map((step, index) => (
        <li
          key={step.key}
          aria-current={index === at ? "step" : undefined}
          className={cn(
            "rounded-full border px-3 py-1",
            index === at
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground",
          )}
        >
          {index + 1}. {step.label}
        </li>
      ))}
    </ol>
  );
}

export function ImportWizard({
  categories,
  restrictedColumns,
}: {
  categories: CategoryOption[];
  /** Spec column keys that are restricted now (marked in the diff). */
  restrictedColumns: string[];
}) {
  const [stage, setStage] = useState<Stage>({ step: "upload", errors: [] });
  // Bumped on every new upload step, so its form starts empty.
  const [uploadRound, setUploadRound] = useState(0);
  const [previewPending, startPreview] = useTransition();
  const commit = useImportCommit();
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus();
  }, [stage.step]);

  // Leaving while batches are being saved would stop the import half way.
  const running = commit.phase === "running";
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  const toUpload = (errors: string[] = []) => {
    commit.reset();
    setUploadRound((n) => n + 1);
    setStage({ step: "upload", errors });
  };

  /* Back to step 1. The staged file is deleted (best effort; 24 h sweep). */
  const startOver = () => {
    if (stage.step !== "upload" && commit.phase !== "done") {
      const { key } = stage.source;
      void callAction(() => finishImportAction({ key }));
    }
    toUpload();
  };

  /* Re-plans the same staged file (after "the file or products changed"). */
  const previewAgain = () => {
    if (stage.step === "upload") return;
    const { source } = stage;
    startPreview(async () => {
      const result = await callAction(() =>
        previewImportAction({
          key: source.key,
          defaultCategoryId: source.defaultCategoryId,
        }),
      );
      if (!result) return;
      if (!result.ok) {
        // The category or the staged file is gone: start again.
        toUpload(allMessages(result.errors));
        return;
      }
      commit.reset();
      setStage({ step: "preview", source, view: result.data });
    });
  };

  if (categories.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderTree aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Create a category first</EmptyTitle>
          <EmptyDescription>
            Imported products need a category. Add at least one, then come back.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href={ADMIN_SECTIONS.categories.href}>Go to categories</Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <StepList current={stage.step} />
      <h2
        ref={heading}
        tabIndex={-1}
        className="text-lg font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {HEADINGS[stage.step]}
      </h2>

      {previewPending ? (
        <p role="status" aria-live="polite" className="text-sm">
          Reading the file again…
        </p>
      ) : null}

      {stage.step === "upload" ? (
        <ImportUploadStep
          key={uploadRound}
          categories={categories}
          initialErrors={stage.errors}
          onPreviewed={(source, view) =>
            setStage({ step: "preview", source, view })
          }
        />
      ) : null}

      {stage.step === "preview" && stage.view.kind === "refused" ? (
        <RefusedFile warnings={stage.view.warnings} onStartOver={startOver} />
      ) : null}

      {stage.step === "preview" && stage.view.kind === "plan" ? (
        <ImportPreviewStep
          // A new preview starts with a fresh confirmation and filters.
          key={stage.view.planHash}
          fileName={stage.source.fileName}
          plan={stage.view}
          restrictedColumns={restrictedColumns}
          onStartOver={startOver}
          onSave={(acknowledgeRemovals) => {
            if (stage.view.kind !== "plan") return;
            const plan = stage.view;
            setStage({ step: "commit", source: stage.source, plan });
            commit.start(stage.source, plan, acknowledgeRemovals);
          }}
        />
      ) : null}

      {stage.step === "commit" ? (
        <ImportCommitStep
          commit={commit}
          onPreviewAgain={previewAgain}
          onStartOver={startOver}
        />
      ) : null}
    </div>
  );
}
