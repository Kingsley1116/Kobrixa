const paths = {
  arrow: "M4 12h16m-6-6 6 6-6 6",
  "arrow-left": "M20 12H4m6-6-6 6 6 6",
  external: "M6 18 18 6M6 6h12v12",
  check: "m5 12 4 4L19 6",
  copy: "M9 9h11v11H9z M15 5V3H3v12h2",
  download: "M12 3v13m-5-5 5 5 5-5 M4 16v5h16v-5",
  upload: "M12 16V3m-5 5 5-5 5 5 M4 15v6h16v-6",
  image: "M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M14 8h.01",
  audio: "M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4",
  play: "m8 5 11 7-11 7Z",
  stop: "M6 6h12v12H6z",
  plus: "M5 12h14m-7-7v14",
  minus: "M5 12h14",
  grip: "M9 5v14m6-14v14",
  "chevron-left": "m14 6-6 6 6 6",
  "chevron-up": "m6 14 6-6 6 6",
  "chevron-right": "m10 6 6 6-6 6",
  windows: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  mac: "M4 3h16v13H4z M9 21h6m-3-5v5 M4 12h16",
  terminal: "M3 4h18v16H3z m4 4 4 4-4 4m7 0h3",
  code: "m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16",
  build: "m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5",
  device: "M6 2h12v20H6z M9 5h6v6H9z M10 16h4m-2-2v4",
  simulator: "M3 4h18v13H3z M8 21h8m-4-4v4m-3-13 6 4-6 3Z",
  users:
    "M15 21v-3a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v3m18 0v-3a4 4 0 0 0-3-4 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm4-4a4 4 0 0 1 0 8",
  book: "M12 5C9 3 5 3 2 4v15c3-1 7-1 10 1 3-2 7-2 10-1V4c-3-1-7-1-10 1Zm0 0v15",
  chart: "M4 3v17h17M7 14l4-5 4 3 5-7",
} as const;

export type IconName = keyof typeof paths;

/** Decorative icons inherit the surrounding text color and keep accessible labels on controls. */
export function Icon({ name, size = "1em" }: { name: IconName; size?: number | string }) {
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={paths[name]} />
    </svg>
  );
}
