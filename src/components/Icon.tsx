import type { ReactElement } from "react";
const paths: Record<string, ReactElement> = {
  speaker: (
    <>
      <path d="M11 5 6 9H3v6h3l5 4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 6a9 9 0 0 1 0 12" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="M4 12.5l5 5L20 6.5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  minus: <path d="M5 12h14" />,
  maximize: <rect x="5" y="5" width="14" height="14" rx="1.5" />,
  flame: (
    <path d="M12 3c.8 2.8 4.8 4.9 4.8 8.9a4.8 4.8 0 1 1-9.6 0c0-1.9.9-3.3 1.9-4.8.4 1.4 1.4 2 1.4 2S11.2 5.7 12 3z" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h16M4 12h16M4 17h16" />
      <circle cx="14" cy="7" r="2" fill="var(--bg)" />
      <circle cx="8" cy="12" r="2" fill="var(--bg)" />
      <circle cx="17" cy="17" r="2" fill="var(--bg)" />
    </>
  ),
  chart: <path d="M5 20v-6M12 20V5M19 20v-9M3 20h18" />,
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  chevron: <path d="M6 9l6 6 6-6" />,
};

export type IconName = keyof typeof paths;

export function Icon({
  name,
  size = 17,
  className,
  strokeWidth = 1.6,
}: {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
}) {
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
      className={className}
      aria-hidden
    >
      {paths[name]}
    </svg>
  );
}
