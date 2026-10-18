/** 浮层组件：模态框、确认框、下拉菜单。基于原生 dialog，天然具备焦点陷阱与 Esc 关闭。 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './icon';
import { Button, IconButton, type ButtonVariant } from './primitives';

/* ------------------------------ 模态框 ------------------------------ */

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: 'sm' | 'md' | 'lg';
  footer?: ReactNode;
  children: ReactNode;
  /** 需要用户明确选择时（例如表单有未保存内容）可关闭点击遮罩关闭 */
  dismissOnBackdrop?: boolean;
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  children,
  dismissOnBackdrop = true,
  className,
}: ModalProps): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const handleCancel = (event: Event): void => {
      event.preventDefault();
      onClose();
    };
    element.addEventListener('cancel', handleCancel);
    return () => element.removeEventListener('cancel', handleCancel);
  }, [onClose]);

  // 卸载时确保已关闭，否则 dialog 会残留并锁住滚动
  useEffect(
    () => () => {
      const element = ref.current;
      if (element?.open) element.close();
    },
    [],
  );

  return (
    <dialog
      ref={ref}
      className={cn('modal', `modal--${size}`, className)}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClick={(event) => {
        if (dismissOnBackdrop && event.target === ref.current) onClose();
      }}
    >
      <header className="modal__header">
        <div className="modal__heading">
          <h2 className="modal__title" id={titleId}>
            {title}
          </h2>
          {description && (
            <p className="modal__description" id={descriptionId}>
              {description}
            </p>
          )}
        </div>
        <IconButton icon="close" label="关闭" onClick={onClose} />
      </header>
      <div className="modal__body">{children}</div>
      {footer && <footer className="modal__footer">{footer}</footer>}
    </dialog>
  );
}

/* ------------------------------ 确认框 ------------------------------ */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps): ReactElement {
  const variant: ButtonVariant = tone === 'danger' ? 'danger' : 'primary';
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="confirm-message">{message}</div>
    </Modal>
  );
}

/* ------------------------------ 下拉菜单 ------------------------------ */

export interface MenuItemSpec {
  key: string;
  label: string;
  icon?: IconName;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  onSelect: () => void;
}

export interface MenuProps {
  items: readonly MenuItemSpec[];
  trigger: (props: { open: boolean; toggle: () => void; ref: (node: HTMLButtonElement | null) => void }) => ReactElement;
  align?: 'start' | 'end';
  label: string;
}

export function Menu({ items, trigger, align = 'end', label }: MenuProps): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (open) setActiveIndex(items.findIndex((item) => !item.disabled));
  }, [open, items]);

  const enabledIndexes = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.disabled)
    .map(({ index }) => index);

  const moveActive = (direction: 1 | -1): void => {
    if (enabledIndexes.length === 0) return;
    const position = enabledIndexes.indexOf(activeIndex);
    const nextPosition = (position + direction + enabledIndexes.length) % enabledIndexes.length;
    setActiveIndex(enabledIndexes[nextPosition] ?? 0);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(enabledIndexes[0] ?? 0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(enabledIndexes[enabledIndexes.length - 1] ?? 0);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      const item = items[activeIndex];
      if (!item || item.disabled) return;
      event.preventDefault();
      close(true);
      item.onSelect();
    }
  };

  return (
    <div className="menu" ref={rootRef}>
      {trigger({
        open,
        toggle: () => setOpen((value) => !value),
        ref: (node) => {
          triggerRef.current = node;
        },
      })}
      {open && (
        <div
          className={cn('menu__panel', `menu__panel--${align}`)}
          role="menu"
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          ref={(node) => node?.focus()}
        >
          {items.map((item, index) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              className={cn(
                'menu__item',
                item.tone === 'danger' && 'menu__item--danger',
                index === activeIndex && 'is-active',
              )}
              disabled={item.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                close(true);
                item.onSelect();
              }}
            >
              {item.icon && <Icon name={item.icon} size={15} />}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
