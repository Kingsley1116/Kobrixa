export function Icon({
  name,
}: {
  name:
    | "play"
    | "stop"
    | "sun"
    | "moon"
    | "plus"
    | "folder"
    | "device"
    | "code"
    | "arrow"
    | "settings"
    | "language";
}): React.JSX.Element {
  const paths = {
    settings:
      "M9 3h6v3l2 1 2.5-1.5 3 5L20 12v2l2.5 1.5-3 5L17 19l-2 1v3H9v-3l-2-1-2.5 1.5-3-5L4 14v-2L1.5 10.5l3-5L7 7l2-1Z M15 13a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
    language: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
    play: "m8 5 11 7-11 7Z",
    stop: "M6 6h12v12H6Z",
    sun: "M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
    moon: "M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z",
    plus: "M12 5v14M5 12h14",
    folder: "M3 7V5h6l2 2h10v13H3Z",
    device: "M6 3h12v18H6ZM9 6h6v5H9Zm1 10h4m-2-2v4",
    code: "m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16",
    arrow: "M4 12h16m-6-6 6 6-6 6",
  };
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
