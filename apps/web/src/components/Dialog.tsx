import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

type DialogProps = {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  onDismiss: () => void;
};

/**
 * Minimal accessible modal: focus moves to the first action on open, Tab is trapped, Escape dismisses,
 * and focus returns to the previously focused element on close.
 */
export function Dialog({ title, children, actions, onDismiss }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = ref.current?.querySelector<HTMLElement>(
      "button, [href], input, [tabindex]:not([tabindex='-1'])",
    );
    first?.focus();
    return () => previous?.focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key !== "Tab" || !ref.current) return;
    const focusables = [
      ...ref.current.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input"),
    ];
    const first = focusables[0];
    const last = focusables.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onKeyDown={onKeyDown}
      >
        <h2 id={`${id}-title`} className="dialog__title">
          {title}
        </h2>
        <div className="dialog__body">{children}</div>
        <div className="dialog__actions">{actions}</div>
      </div>
    </div>
  );
}
