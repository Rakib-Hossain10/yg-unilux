"use client";

// The desktop product menu (Phase 4b L6, KC Lighting reference): "Product" in
// the header becomes a disclosure button that opens a full-width panel with
// one row of main-category icons, the hovered or focused category's
// sub-categories below it, and an Applications column (the 7 areas).
//
// - Server HTML and no-JS: "Product" is a plain link to /products (the panel
//   stays hidden); the button replaces it once React runs.
// - Opens on click, Enter or Space (never on hover alone); focus moves to the
//   first category. Closes on Escape (focus back on the button), a press
//   outside, focus leaving the menu, any link inside it (the current page's
//   too), or a route change. A touch first tap that only reveals a
//   category's sub-categories keeps it open.
// - DOM order = Tab order: each category link is followed by its own
//   sub-category block, so Tab walks category, its sub-categories, next
//   category... Only the active category's block is shown.
// Hooks for the motion pass (L7): data-slot mega-menu / mega-menu-panel /
// mega-menu-strip / mega-menu-detail / mega-menu-scrim, data-state.

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  type CSSProperties,
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { useHydrated } from "../listing/use-hydrated";
import type { MenuCategory, SiteMenu } from "./menu-types";

/** Hover intent: a pointer must rest this long before the category switches. */
const HOVER_INTENT_MS = 90;

/** The strip never has fewer columns than this. */
const MIN_STRIP_COLUMNS = 6;

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 12 12"
      width={10}
      height={10}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      aria-hidden="true"
      focusable="false"
      className={`transition-transform duration-(--duration-quick) motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
    >
      <path d="m2.5 4.5 3.5 3.5 3.5-3.5" />
    </svg>
  );
}

const linkClass =
  "text-grey-700 transition-colors duration-(--duration-quick) hover:text-ink";

export function MegaMenu({
  menu,
  label,
  href,
  itemClassName,
}: {
  menu: SiteMenu;
  /** The nav item's text ("Product"). */
  label: string;
  /** Where the no-JS link goes (/products). */
  href: string;
  /** The nav item's classes (shared with the other header links). */
  itemClassName: string;
}) {
  const hydrated = useHydrated();
  const pathname = usePathname();
  // The menu belongs to the page it was opened on: a route change closes it
  // without an effect (derived, not synchronised).
  const [openOn, setOpenOn] = useState<string | null>(null);
  // A menu left open on another page (back/forward) is dropped, so it never
  // reopens when that page comes back (adjust-state-during-render pattern).
  if (openOn !== null && openOn !== pathname) setOpenOn(null);
  const open = openOn !== null && openOn === pathname;
  const firstId = menu.categories[0]?.id ?? "";
  const [activeId, setActiveId] = useState(firstId);
  const active = menu.categories.some((c) => c.id === activeId)
    ? activeId
    : firstId;

  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef(false);
  // Set by CategoryGrid when a touch tap only revealed a category's
  // sub-categories (no navigation), read and cleared by the panel's click.
  const revealTap = useRef(false);
  const hoverTimer = useRef<number | undefined>(undefined);
  const panelId = useId();

  // Opened by the user: focus moves into the panel (plan a11y rules).
  useEffect(() => {
    if (!open || !focusOnOpen.current) return;
    focusOnOpen.current = false;
    panelRef.current?.querySelector<HTMLElement>("a[href]")?.focus();
  }, [open]);

  // While open: a press outside the menu closes it (focus stays where the
  // press put it; the scrim closes itself, it lies inside the root), and
  // Escape closes it from anywhere, handing focus back to the button when
  // focus was in the menu or nowhere (body).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpenOn(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      const focused = document.activeElement;
      const returnFocus =
        focused === null ||
        focused === document.body ||
        Boolean(rootRef.current?.contains(focused));
      setOpenOn(null);
      if (returnFocus) buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => () => window.clearTimeout(hoverTimer.current), []);

  if (!hydrated || menu.categories.length === 0) {
    return (
      <Link href={href} className={itemClassName}>
        {label}
      </Link>
    );
  }

  const hoverTo = (id: string) => {
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(
      () => setActiveId(id),
      HOVER_INTENT_MS,
    );
  };
  const hasIcons = menu.categories.some((c) => c.iconSrc !== null);

  return (
    <div
      ref={rootRef}
      data-slot="mega-menu"
      data-state={open ? "open" : "closed"}
      onBlur={(event) => {
        // Tab past the last link (or Shift+Tab before the button) closes it.
        const next = event.relatedTarget as Node | null;
        if (open && next && !rootRef.current?.contains(next)) setOpenOn(null);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (open) {
            setOpenOn(null);
          } else {
            focusOnOpen.current = true;
            setOpenOn(pathname);
          }
        }}
        className={`${itemClassName} inline-flex cursor-pointer items-center gap-2 tracking-[inherit] uppercase aria-expanded:text-ink`}
      >
        {label}
        <ChevronIcon open={open} />
      </button>

      {/* Scrim: dims the page under the panel; a press on it closes. Placed
          with `absolute` (the header's backdrop blur makes it the containing
          block of fixed children). */}
      <div
        aria-hidden="true"
        data-slot="mega-menu-scrim"
        hidden={!open}
        onPointerDown={() => setOpenOn(null)}
        className="absolute inset-x-0 top-full h-dvh bg-ink/20"
      />

      <div
        ref={panelRef}
        id={panelId}
        hidden={!open}
        data-slot="mega-menu-panel"
        data-state={open ? "open" : "closed"}
        onClick={(event) => {
          // Any link inside closes the menu without stealing focus, a link
          // to the page already shown included (next/link prevents the
          // default of every client navigation, so defaultPrevented says
          // nothing here). Only a first tap that revealed a category stays.
          if (revealTap.current) {
            revealTap.current = false;
            return;
          }
          if ((event.target as Element).closest("a[href]")) setOpenOn(null);
        }}
        className="absolute inset-x-0 top-full border-b border-grey-200 bg-paper text-sm tracking-normal normal-case"
      >
        <div className="mx-auto grid max-w-(--container-site) grid-cols-[minmax(0,1fr)_13rem] gap-10 px-8 pt-8 pb-10 xl:grid-cols-[minmax(0,1fr)_16rem] xl:gap-16">
          <CategoryGrid
            categories={menu.categories}
            active={active}
            hasIcons={hasIcons}
            onFocusCategory={(id) => {
              window.clearTimeout(hoverTimer.current);
              setActiveId(id);
            }}
            onHoverCategory={hoverTo}
            onLeaveCategory={() => window.clearTimeout(hoverTimer.current)}
            onRevealTap={(id) => {
              revealTap.current = true;
              window.clearTimeout(hoverTimer.current);
              setActiveId(id);
            }}
          />
          <ApplicationsColumn menu={menu} allHref={href} />
        </div>
      </div>
    </div>
  );
}

function CategoryGrid({
  categories,
  active,
  hasIcons,
  onFocusCategory,
  onHoverCategory,
  onLeaveCategory,
  onRevealTap,
}: {
  categories: readonly MenuCategory[];
  active: string;
  hasIcons: boolean;
  onFocusCategory: (id: string) => void;
  onHoverCategory: (id: string) => void;
  onLeaveCategory: () => void;
  /** A touch tap that showed a category instead of following its link. */
  onRevealTap: (id: string) => void;
}) {
  const lastPointer = useRef<{ touch: boolean; wasActive: boolean } | null>(
    null,
  );
  const style = {
    // At least 6 columns, so a short list keeps item-sized slots
    // (left-aligned) instead of stretching across the panel.
    "--menu-cols": String(Math.max(categories.length, MIN_STRIP_COLUMNS)),
  } as CSSProperties;
  return (
    <div
      data-slot="mega-menu-strip"
      style={style}
      className="grid grid-cols-[repeat(var(--menu-cols),minmax(0,1fr))] gap-x-3"
    >
      {categories.map((category) => {
        const isActive = category.id === active;
        return (
          <Fragment key={category.id}>
            <Link
              href={category.href}
              data-menu-category={category.id}
              data-active={isActive ? "" : undefined}
              onFocus={() => onFocusCategory(category.id)}
              onPointerEnter={(event) => {
                // Hover intent for a mouse only; touch and pen use the tap.
                if (event.pointerType === "mouse") {
                  onHoverCategory(category.id);
                }
              }}
              onPointerLeave={onLeaveCategory}
              onPointerDown={(event) => {
                // Read before the tap's focus makes the category active.
                lastPointer.current = {
                  touch:
                    event.pointerType === "touch" ||
                    event.pointerType === "pen",
                  wasActive: isActive,
                };
              }}
              onClick={(event) => {
                // Touch/pen (a tablet at desktop width): the first tap on an
                // inactive category shows its sub-categories; the second
                // tap follows the link.
                const press = lastPointer.current;
                lastPointer.current = null;
                if (press?.touch && !press.wasActive) {
                  event.preventDefault();
                  onRevealTap(category.id);
                }
              }}
              className={`group row-start-1 flex min-h-11 flex-col gap-3 border-b pb-4 text-[0.8125rem] leading-snug transition-colors duration-(--duration-quick) ${
                // Icons: name centred under its icon (KC Lighting). Text
                // only: names start on the panel's left edge, like the
                // detail below them (ui-reviewer gate C, L-1).
                hasIcons
                  ? "items-center px-1 text-center"
                  : "items-start pr-2 text-left"
              } ${
                isActive
                  ? "border-ink text-ink"
                  : "border-transparent text-grey-600 hover:text-ink"
              }`}
            >
              {hasIcons ? (
                <span className="relative flex size-12 items-center justify-center">
                  {category.iconSrc ? (
                    // Served as delivered (96 x 96, explicit f_png raster,
                    // ADR 0067): no next/image hop for a tiny final file.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={category.iconSrc}
                      alt=""
                      width={48}
                      height={48}
                      loading="lazy"
                      decoding="async"
                      className={`size-12 object-contain transition-opacity duration-(--duration-quick) ${isActive ? "opacity-100" : "opacity-70 group-hover:opacity-100"}`}
                    />
                  ) : null}
                </span>
              ) : null}
              <span className="text-balance">{category.name}</span>
            </Link>
            <CategoryDetail category={category} hidden={!isActive} />
          </Fragment>
        );
      })}
    </div>
  );
}

function CategoryDetail({
  category,
  hidden,
}: {
  category: MenuCategory;
  hidden: boolean;
}) {
  return (
    <div
      hidden={hidden}
      data-slot="mega-menu-detail"
      className="col-span-full row-start-2 grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-10 border-t border-grey-200 pt-8"
    >
      <div>
        <p className="font-display text-3xl leading-tight font-light text-ink">
          {category.name}
        </p>
        {category.description ? (
          <p className="mt-3 line-clamp-3 max-w-sm leading-relaxed whitespace-pre-line text-grey-600">
            {category.description}
          </p>
        ) : null}
        <Link
          href={category.href}
          className="mt-4 inline-flex min-h-11 items-center text-ink underline decoration-grey-300 underline-offset-4 transition-colors duration-(--duration-quick) hover:decoration-ink"
        >
          View all {category.name}
        </Link>
      </div>
      {category.children.length > 0 ? (
        <ul
          aria-label={`${category.name} categories`}
          className="columns-2 gap-x-8 self-start"
        >
          {category.children.map((child) => (
            <li key={child.id} className="break-inside-avoid">
              <Link
                href={child.href}
                className={`flex min-h-11 w-fit items-center text-[0.9375rem] ${linkClass}`}
              >
                {child.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ApplicationsColumn({
  menu,
  allHref,
}: {
  menu: SiteMenu;
  allHref: string;
}) {
  const headingId = useId();
  return (
    <div className="border-l border-grey-200 pl-8 xl:pl-10">
      {menu.areas.length > 0 ? (
        <>
          <p id={headingId} className="text-grey-600">
            Applications
          </p>
          <ul aria-labelledby={headingId} className="mt-2">
            {menu.areas.map((area) => (
              <li key={area.id}>
                <Link
                  href={area.href}
                  className={`flex min-h-11 w-fit items-center text-[0.9375rem] ${linkClass}`}
                >
                  {area.name}
                </Link>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <Link
        href={allHref}
        className="mt-6 inline-flex min-h-11 items-center border-t border-grey-200 pt-2 text-ink underline decoration-grey-300 underline-offset-4 transition-colors duration-(--duration-quick) hover:decoration-ink"
      >
        All products
      </Link>
    </div>
  );
}
