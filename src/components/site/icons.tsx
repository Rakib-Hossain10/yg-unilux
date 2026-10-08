// Small inline SVG icons for the site chrome (search, account, menu, close)
// and the product gallery controls (arrows, zoom, enlarge).
// Inline so there is no icon font or extra request; decorative by default,
// so the surrounding link or button must carry the accessible name.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

/* Shared outline style: 24px grid, 1.5px stroke, inherits text colour. */
function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={20}
      height={20}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.4-4.4" />
    </Icon>
  );
}

export function AccountIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c1.2-3.5 3.8-5.5 7-5.5s5.8 2 7 5.5" />
    </Icon>
  );
}

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 8h16M4 16h16" />
    </Icon>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Icon>
  );
}

/* Gallery and lightbox controls (product page, plan P6). */

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5m6-6-6 6 6 6" />
    </Icon>
  );
}

export function ArrowRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14m-6-6 6 6-6 6" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M5 12h14" />
    </Icon>
  );
}

export function ExpandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" />
    </Icon>
  );
}
