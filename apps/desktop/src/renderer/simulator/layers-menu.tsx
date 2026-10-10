import { Icon } from "../components/icon.js";
import { Picker } from "../components/picker.js";
import type { FieldLayers } from "./field-renderer.js";
import type { SimulatorCopy, SimulatorLocale } from "./simulator-copy.js";

export function LayersMenu({
  t,
  locale,
  layers,
  practice = false,
  onChange,
}: {
  t: SimulatorCopy;
  locale: SimulatorLocale;
  layers: FieldLayers;
  /** The practice field has no restricted zones, so that layer is not offered. */
  practice?: boolean;
  onChange(layers: FieldLayers): void;
}): React.JSX.Element {
  const options: { value: keyof FieldLayers; label: string }[] = [
    { value: "traces", label: t.trace },
    { value: "rays", label: t.rays },
    { value: "headings", label: t.headings },
    { value: "collisions", label: t.collisions },
    ...(practice ? [] : [{ value: "restrictedZones" as const, label: t.restrictedZones }]),
  ];
  return (
    <div className="sim-float sim-layers">
      <Picker
        multiple
        locale={locale}
        label={t.layers}
        options={options}
        value={options.filter(({ value }) => layers[value]).map(({ value }) => value)}
        onChange={(selected) => {
          const next = { ...layers };
          for (const { value } of options) next[value] = selected.includes(value);
          onChange(next);
        }}
        triggerContent={
          <>
            <Icon name="layers" />
            <span className="sim-label">{t.layers}</span>
          </>
        }
      />
    </div>
  );
}
