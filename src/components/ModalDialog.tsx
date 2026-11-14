// src/components/ModalDialog.tsx
// A modal dialog on the platform's <dialog>, opened with showModal(): the browser then keeps focus inside it, makes the
// rest of the page inert, draws it in the top layer over everything (a dialog opened later over one opened earlier,
// wherever each sits in the page) and puts focus back where it was when it closes. Settings, the strategic context
// editor and the sync choice draw their panels in one, and so do the stand-ins that show while their chunks load.
//
// The element covers the viewport, transparent, and centres the panel it is given; the dim and the blur are its
// ::backdrop (Tailwind's backdrop: variant, which the caller passes), so a click outside the panel lands on the dialog
// element itself. It opens in a layout effect and closes in that effect's cleanup, while it is still in the document:
// React runs the layout cleanups of a removed subtree before it takes the subtree's nodes out, and a dialog removed
// while open would leave focus on body instead of returning it. Under StrictMode (main.jsx) a mount runs the effect,
// its cleanup and the effect again: the close puts focus back on the opener, so the second showModal() remembers the
// same one, and showModal() is only called on a closed dialog (it throws InvalidStateError on an open one in some
// engines).
//
// React alone closes it. The browser's `cancel` (a close request: Escape whose keydown nothing prevented, Android's
// back gesture) is always prevented. With onDismiss the user may leave: `cancel` calls it, and so does a press outside
// the panel (down, up and click all on the dialog element, so that a selection dragged out of a field never counts),
// and the parent unmounts the dialog in answer. Escape itself stays with each component's window listener, which
// prevents the keydown, so the browser raises no `cancel` for it. Without onDismiss only the parent closes it:
// `closedby="none"` asks the browser not to, and where it closes anyway (an engine without closedby, whose second
// Escape with no user activation in between makes `cancel` impossible to prevent) the dialog opens again once its
// `close` event arrives. A dismissable dialog that the browser closed calls onDismiss instead, so that React follows.
// The close listener is removed before the cleanup's own close(), so an intended unmount is never taken for either,
// and it ignores a dialog that is open again by the time the event arrives (StrictMode's second mount).
//
// Focus on open: initialFocus when given (the selected tab, the editor's text, the recommended choice), otherwise the
// dialog itself, which is how a stand-in holding a spinner or a failure card announces itself; tabIndex -1 lets every
// engine focus it, jsdom included, and keeps it out of the tab order.
import { useEffectEvent, useLayoutEffect, useRef } from 'react';
import type { MouseEvent, PointerEvent, ReactNode, RefObject } from 'react';

/** The dialog's accessible name: the id of the heading on it, or a name of its own where no heading names it. */
type DialogName = { labelledBy: string; label?: never } | { label: string; labelledBy?: never };

type ModalDialogProps = DialogName & {
  /** The id of the text that describes it. */
  describedBy?: string;
  /** Its content is still loading. */
  busy?: boolean;
  /** The element focused once it is open; the dialog itself without one, or while it cannot take focus. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** The user asked to leave (a press outside the panel, a close request). Without it nothing dismisses the dialog. */
  onDismiss?: () => void;
  /** The ::backdrop's look, in Tailwind's backdrop: variant. */
  backdropClassName: string;
  /** The panel, centred in the dialog. */
  children: ReactNode;
};

/** Opens `dialog` modally unless it is open already, then focuses `target`, or the dialog itself if that fails. */
function showAndFocus(dialog: HTMLDialogElement, target: HTMLElement | null | undefined): void {
  if (!dialog.open) dialog.showModal();
  target?.focus();
  if (!target || dialog.ownerDocument.activeElement !== target) dialog.focus();
}

export default function ModalDialog({
  labelledBy, label, describedBy, busy = false, initialFocus, onDismiss, backdropClassName, children,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  /** The current press began on the dialog element itself, outside the panel. */
  const pressedOutside = useRef(false);

  const show = useEffectEvent((dialog: HTMLDialogElement) => showAndFocus(dialog, initialFocus?.current));
  const requestedClose = useEffectEvent(() => onDismiss?.());
  const closedByBrowser = useEffectEvent((dialog: HTMLDialogElement) => {
    if (onDismiss) onDismiss();
    else showAndFocus(dialog, initialFocus?.current);
  });

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const onCancel = (event: Event) => {
      event.preventDefault();
      requestedClose();
    };
    const onClose = () => {
      if (!dialog.open && dialog.isConnected) closedByBrowser(dialog);
    };
    dialog.addEventListener('cancel', onCancel);
    dialog.addEventListener('close', onClose);
    show(dialog);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      dialog.removeEventListener('close', onClose);
      dialog.close();
    };
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDialogElement>) => {
    pressedOutside.current = event.target === event.currentTarget;
  };
  const onPointerUp = (event: PointerEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) pressedOutside.current = false;
  };
  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    const outside = pressedOutside.current && event.target === event.currentTarget;
    pressedOutside.current = false;
    if (outside) onDismiss?.();
  };

  return (
    <dialog
      ref={dialogRef}
      tabIndex={-1}
      aria-labelledby={labelledBy}
      aria-label={label}
      aria-describedby={describedBy}
      aria-busy={busy || undefined}
      closedby={onDismiss ? undefined : 'none'}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onClick={onClick}
      className={`fixed inset-0 h-full max-h-none w-full max-w-none items-center justify-center bg-transparent text-inherit outline-none open:flex ${backdropClassName}`}
    >
      {children}
    </dialog>
  );
}
