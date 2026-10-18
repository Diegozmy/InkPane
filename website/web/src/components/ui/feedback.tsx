/** 反馈类组件：骨架屏、空状态、错误状态、行内提示与轻提示宿主。 */

import { useEffect, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useUiStore, type ToastItem } from '@/store/ui-store';
import { Icon, type IconName } from './icon';
import { Button } from './primitives';

/* ------------------------------ 骨架屏 ------------------------------ */

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string;
  className?: string;
}

export function Skeleton({ width, height = 14, radius, className }: SkeletonProps): ReactElement {
  const style: CSSProperties = {};
  if (width !== undefined) style.width = typeof width === 'number' ? `${width}px` : width;
  if (height !== undefined) style.height = typeof height === 'number' ? `${height}px` : height;
  if (radius !== undefined) style.borderRadius = radius;
  return <span className={cn('skeleton', className)} style={style} aria-hidden="true" />;
}

/** 日历网格骨架：形状与真实网格一致，避免加载时布局跳动。 */
export function CalendarGridSkeleton({ cells = 35 }: { cells?: number }): ReactElement {
  return (
    <div className="skeleton-grid" aria-hidden="true">
      {Array.from({ length: cells }, (_, index) => (
        <div className="skeleton-grid__cell" key={index}>
          <Skeleton width={22} height={14} />
          <Skeleton width="82%" height={16} radius="var(--radius-control)" />
          <Skeleton width="64%" height={16} radius="var(--radius-control)" />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------ 状态占位 ------------------------------ */

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: string;
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ icon = 'calendar-blank', title, description, action, compact }: EmptyStateProps): ReactElement {
  return (
    <div className={cn('state-block', compact && 'state-block--compact')}>
      <span className="state-block__icon" aria-hidden="true">
        <Icon name={icon} size={compact ? 22 : 28} />
      </span>
      <h3 className="state-block__title">{title}</h3>
      {description && <p className="state-block__description">{description}</p>}
      {action && <div className="state-block__action">{action}</div>}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  description?: string;
  detail?: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function ErrorState({
  title = '数据加载失败',
  description = '请检查后端服务是否已启动，然后重试。',
  detail,
  onRetry,
  compact,
}: ErrorStateProps): ReactElement {
  return (
    <div className={cn('state-block', 'state-block--error', compact && 'state-block--compact')} role="alert">
      <span className="state-block__icon" aria-hidden="true">
        <Icon name="warning-circle" size={compact ? 22 : 28} />
      </span>
      <h3 className="state-block__title">{title}</h3>
      <p className="state-block__description">{description}</p>
      {detail && <code className="state-block__detail">{detail}</code>}
      {onRetry && (
        <div className="state-block__action">
          <Button onClick={onRetry} leadingIcon="refresh">
            重试
          </Button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 行内提示 ------------------------------ */

export interface InlineAlertProps {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title?: string;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}

const ALERT_ICON: Record<'info' | 'success' | 'warning' | 'danger', IconName> = {
  info: 'info',
  success: 'check-circle',
  warning: 'warning',
  danger: 'warning-circle',
};

export function InlineAlert({ tone = 'info', title, children, action, className }: InlineAlertProps): ReactElement {
  return (
    <div className={cn('alert', `alert--${tone}`, className)} role={tone === 'danger' ? 'alert' : undefined}>
      <span className="alert__icon" aria-hidden="true">
        <Icon name={ALERT_ICON[tone]} size={16} />
      </span>
      <div className="alert__body">
        {title && <p className="alert__title">{title}</p>}
        <div className="alert__content">{children}</div>
      </div>
      {action && <div className="alert__action">{action}</div>}
    </div>
  );
}

/* ------------------------------ 轻提示 ------------------------------ */

function ToastCard({ toast }: { toast: ToastItem }): ReactElement {
  const dismiss = useUiStore((state) => state.dismissToast);
  const { id, durationMs } = toast;

  useEffect(() => {
    if (durationMs <= 0) return undefined;
    const timer = window.setTimeout(() => dismiss(id), durationMs);
    return () => window.clearTimeout(timer);
  }, [dismiss, durationMs, id]);

  const iconName: IconName =
    toast.tone === 'success' ? 'check-circle' : toast.tone === 'error' ? 'warning-circle' : 'info';

  return (
    <div className={cn('toast', `toast--${toast.tone}`)} role="status" aria-live="polite">
      <span className="toast__icon" aria-hidden="true">
        <Icon name={iconName} size={17} />
      </span>
      <div className="toast__body">
        <p className="toast__message">{toast.message}</p>
        {toast.description && <p className="toast__description">{toast.description}</p>}
        {toast.action && (
          <button
            type="button"
            className="toast__action"
            onClick={() => {
              toast.action?.onClick();
              dismiss(id);
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button type="button" className="toast__close" aria-label="关闭提示" onClick={() => dismiss(id)}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function ToastHost(): ReactElement {
  const toasts = useUiStore((state) => state.toasts);
  return (
    <div className="toast-host" role="region" aria-label="通知">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
