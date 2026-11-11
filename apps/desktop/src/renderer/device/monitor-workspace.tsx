import { useSyncExternalStore } from "react";
import type { Locale } from "../i18n/copy.js";
import type { RendererSession } from "../plugin-ui/bootstrap.js";

/** Compatibility destination for the saved Monitor tab; feature UI lives only
 * in the public plugin renderer. Catalog visits never start optional processes. */
export function MonitorWorkspace({
  plugins,
  onOpenTools,
  locale,
}: {
  plugins: Pick<RendererSession, "catalog" | "select">;
  onOpenTools(): void;
  locale: Locale;
}): React.JSX.Element {
  const zh = locale === "zh-TW";
  const catalog = useSyncExternalStore(plugins.catalog.subscribe, plugins.catalog.getSnapshot);
  return (
    <div className="monitor-workspace">
      {(
        [
          ["device-ev3", "EV3 device", "EV3 裝置"],
          ["sensor-lab", "Sensor Lab", "Sensor Lab"],
        ] as const
      ).map(([id, en, localized]) => {
        const entry = () =>
          plugins.catalog
            .getSnapshot()
            .entries.find(
              (item) =>
                item.kind === "panel" &&
                item.sourceKey === `builtin:kobrixa.${id}` &&
                item.pluginId === `kobrixa.${id}` &&
                item.id === `kobrixa.${id}.panel` &&
                item.availability === "available",
            );
        const available = catalog.phase === "ready" && !!entry();
        return (
          <section key={id} data-plugin-destination={id}>
            <p role="status">
              {catalog.phase === "loading"
                ? zh
                  ? "正在載入插件工具…"
                  : "Loading plugin tools…"
                : available
                  ? zh
                    ? `${localized} 已移至插件工具。`
                    : `${en} is available in Plugin tools.`
                  : zh
                    ? `${localized} 目前無法使用。請至插件工具查看狀態。`
                    : `${en} is unavailable. Check its status in Plugin tools.`}
            </p>
            <button
              onClick={() => {
                const current =
                  plugins.catalog.getSnapshot().phase === "ready" ? entry() : undefined;
                if (current) plugins.select(current);
                onOpenTools();
              }}
            >
              {zh ? `開啟 ${localized} 插件工具` : `Open ${en} plugin tools`}
            </button>
          </section>
        );
      })}
    </div>
  );
}
