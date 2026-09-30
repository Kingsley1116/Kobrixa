import { useId, type ComponentProps, type ReactNode } from "react";
import { Modal } from "./modal.js";

type DialogProps = ComponentProps<typeof Modal> & {
  title: ReactNode;
  titleId?: string;
  descriptionId?: string;
  role?: "dialog" | "alertdialog";
  className?: string;
  intro?: ReactNode;
  onSubmit?(): void;
};

/** Modal owns focus and dismissal; mark the initial control with data-modal-initial. */
export function Dialog({
  title,
  titleId,
  descriptionId,
  role = "dialog",
  className = "",
  intro,
  onSubmit,
  children,
  ...modal
}: DialogProps): React.JSX.Element {
  const generatedId = useId();
  const headingId = titleId ?? generatedId;
  const heading = <h2 id={headingId}>{title}</h2>;
  const content = (
    <>
      {intro ? (
        <header>
          {heading}
          {intro}
        </header>
      ) : (
        heading
      )}
      {children}
    </>
  );
  const card = {
    className: `modal-card ${className}`.trim(),
    role,
    "aria-modal": true as const,
    "aria-labelledby": headingId,
    "aria-describedby": descriptionId,
  };
  return (
    <Modal {...modal}>
      {onSubmit ? (
        <form
          {...card}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {content}
        </form>
      ) : (
        <section {...card}>{content}</section>
      )}
    </Modal>
  );
}

export function DialogActions({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return <div className={`modal-actions ${className}`.trim()}>{children}</div>;
}
