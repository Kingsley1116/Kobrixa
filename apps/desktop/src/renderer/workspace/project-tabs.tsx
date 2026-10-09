import { useEffect, useRef, type ReactNode } from "react";
import type { Locale } from "../i18n/copy.js";

export function ProjectTabs({
  projects,
  activeId,
  disabled,
  locale,
  settingsTab,
  onSelect,
  onClose,
}: {
  projects: Array<{
    id: string;
    name: string;
    location: string;
    dirty: boolean;
    phase?: string | undefined;
    closeDisabled: boolean;
  }>;
  activeId: string | undefined;
  disabled: boolean;
  locale: Locale;
  /** Rendered after the projects so settings sit at the project level. */
  settingsTab?: ReactNode;
  onSelect(id: string, focusEditor?: boolean): void;
  onClose(id: string): void;
}): React.JSX.Element | null {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);
  if (!projects.length && !settingsTab) return null;
  return (
    <div
      ref={root}
      className="project-tabs"
      role="tablist"
      aria-label={locale === "zh-TW" ? "開啟的專案" : "Open projects"}
    >
      {projects.map((project, index) => (
        <div className={`project-tab ${activeId === project.id ? "active" : ""}`} key={project.id}>
          <button
            type="button"
            role="tab"
            className="project-tab-select"
            aria-selected={activeId === project.id}
            aria-controls="project-workbench"
            title={project.location}
            disabled={disabled}
            tabIndex={activeId === project.id ? 0 : -1}
            onClick={() => onSelect(project.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % projects.length
                  : event.key === "ArrowLeft"
                    ? (index + projects.length - 1) % projects.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? projects.length - 1
                        : undefined;
              if (next === undefined) return;
              event.preventDefault();
              onSelect(projects[next]!.id, false);
              root.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
            }}
          >
            <span className="project-tab-name">{project.name}</span>
            {project.dirty && (
              <span className="dirty" aria-label={locale === "zh-TW" ? "未儲存" : "Unsaved"}>
                ●
              </span>
            )}
            {project.phase && <span className="project-phase">{project.phase}</span>}
          </button>
          <button
            type="button"
            className="project-tab-close"
            disabled={disabled || project.closeDisabled}
            aria-label={`${locale === "zh-TW" ? "關閉專案" : "Close project"}: ${project.name}`}
            onClick={() => onClose(project.id)}
          >
            ×
          </button>
        </div>
      ))}
      {settingsTab}
    </div>
  );
}
