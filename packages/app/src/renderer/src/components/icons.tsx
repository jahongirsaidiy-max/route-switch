// Line icons from the design source, drawn with `currentColor` so the caller
// colours them through CSS. All are decorative (`aria-hidden`): the control
// that holds one carries the accessible name.

import type { ReactElement, ReactNode } from 'react';

interface IconProps {
  /** Rendered width and height in px. */
  readonly size?: number;
  readonly strokeWidth?: number;
  readonly className?: string | undefined;
}

function Svg({
  size = 16,
  strokeWidth = 1.8,
  className,
  children,
}: IconProps & { readonly children: ReactNode }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

/** The app mark: two opposite arrows (header of the menu bar window, "Qoidalar" sidebar item). */
export function RouteIcon(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 7h10l-3-3" />
      <path d="M20 17H10l3 3" />
    </Svg>
  );
}

export function EthernetIcon(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <rect x="5" y="4" width="14" height="11" rx="1.5" />
      <path d="M9 15v3h6v-3" />
      <path d="M12 18v3" />
      <path d="M9 8v3M12 8v3M15 8v3" />
    </Svg>
  );
}

export function WifiIcon(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M2 9a15 15 0 0 1 20 0" />
      <path d="M5.5 12.5a10 10 0 0 1 13 0" />
      <path d="M9 16a5 5 0 0 1 6 0" />
      <circle cx="12" cy="19.5" r="0.8" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps): ReactElement {
  return (
    <Svg strokeWidth={2} {...props}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function PlusIcon(props: IconProps): ReactElement {
  return (
    <Svg strokeWidth={2.2} {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function EditIcon(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps): ReactElement {
  return (
    <Svg {...props}>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps): ReactElement {
  return (
    <Svg strokeWidth={2} {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  );
}
