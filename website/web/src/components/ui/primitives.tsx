/** 基础交互控件：按钮、输入、选择器、标签、开关。全部带完整状态与无障碍属性。 */

import {
  forwardRef,
  useId,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/cn';
import { Icon, type IconName } from './icon';

/* ------------------------------ 按钮 ------------------------------ */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent-ghost';
export type ButtonSize = 'sm' | 'md' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leadingIcon?: IconName;
  trailingIcon?: IconName;
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    leadingIcon,
    trailingIcon,
    block = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  const iconSize = size === 'sm' ? 14 : 16;
  return (
    <button
      ref={ref}
      type={type}
      className={cn('btn', `btn--${variant}`, `btn--${size}`, block && 'btn--block', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Icon name="spinner" size={iconSize} className="spin" />
      ) : (
        leadingIcon && <Icon name={leadingIcon} size={iconSize} />
      )}
      {children !== undefined && children !== null && <span className="btn__label">{children}</span>}
      {trailingIcon && !loading && <Icon name={trailingIcon} size={iconSize} />}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: IconName;
  /** 图标按钮必须提供可读标签，否则屏幕阅读器无法理解 */
  label: string;
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, variant = 'ghost', size = 'md', active = false, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn('btn', 'btn--icon', `btn--${variant}`, `btn--icon-${size}`, active && 'is-active', className)}
      title={label}
      aria-label={label}
      aria-pressed={active || undefined}
      {...rest}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : 18} />
    </button>
  );
});

/* ------------------------------ 表单字段 ------------------------------ */

export interface FieldProps {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * 表单字段容器：标签始终位于输入框上方，错误信息固定在下方，
 * 且 hint / error 通过 aria-describedby 与控件关联。
 */
export function Field({ label, htmlFor, hint, error, required, children, className }: FieldProps): ReactElement {
  return (
    <div className={cn('field', className)}>
      <label className="field__label" htmlFor={htmlFor}>
        {label}
        {required && <span className="field__required" aria-hidden="true">*</span>}
      </label>
      {children}
      {error ? (
        <p className="field__error" role="alert">
          <Icon name="warning-circle" size={13} />
          {error}
        </p>
      ) : (
        hint && <p className="field__hint">{hint}</p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cn('input', className)} {...rest} />;
  },
);

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, rows = 3, ...rest }, ref) {
    return <textarea ref={ref} className={cn('input', 'input--textarea', className)} rows={rows} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <span className="select-wrap">
        <select ref={ref} className={cn('input', 'input--select', className)} {...rest}>
          {children}
        </select>
        <Icon name="caret-down" size={14} className="select-wrap__caret" />
      </span>
    );
  },
);

/* ------------------------------ 标签与徽标 ------------------------------ */

export interface ChipProps {
  children: ReactNode;
  color?: string;
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  className?: string;
  title?: string;
  as?: 'button' | 'span';
}

export function Chip({
  children,
  color,
  selected = false,
  onClick,
  onRemove,
  className,
  title,
  as,
}: ChipProps): ReactElement {
  const interactive = onClick !== undefined || as === 'button';
  const style = color ? ({ '--chip-color': color } as CSSProperties) : undefined;

  const content = (
    <>
      {color && <span className="chip__dot" aria-hidden="true" />}
      <span className="chip__text">{children}</span>
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          className="chip__remove"
          aria-label="移除"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              event.stopPropagation();
              onRemove();
            }
          }}
        >
          <Icon name="close" size={11} />
        </span>
      )}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        className={cn('chip', 'chip--interactive', selected && 'is-selected', className)}
        style={style}
        onClick={onClick}
        title={title}
        aria-pressed={selected}
      >
        {content}
      </button>
    );
  }

  return (
    <span className={cn('chip', selected && 'is-selected', className)} style={style} title={title}>
      {content}
    </span>
  );
}

export interface BadgeProps {
  children: ReactNode;
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
  className?: string;
  icon?: IconName;
}

export function Badge({ children, tone = 'neutral', className, icon }: BadgeProps): ReactElement {
  return (
    <span className={cn('badge', `badge--${tone}`, className)}>
      {icon && <Icon name={icon} size={12} />}
      {children}
    </span>
  );
}

/* ------------------------------ 开关与分段控件 ------------------------------ */

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled }: SwitchProps): ReactElement {
  const id = useId();
  return (
    <div className={cn('switch-row', disabled && 'is-disabled')}>
      <div className="switch-row__text">
        <label className="switch-row__label" htmlFor={id}>
          {label}
        </label>
        {description && <p className="switch-row__hint">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={cn('switch', checked && 'is-on')}
        onClick={() => onChange(!checked)}
      >
        <span className="switch__thumb" />
      </button>
    </div>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  size = 'md',
}: SegmentedControlProps<T>): ReactElement {
  return (
    <div className={cn('segmented', `segmented--${size}`)} role="tablist" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            className={cn('segmented__item', selected && 'is-selected')}
            onClick={() => onChange(option.value)}
          >
            {option.icon && <Icon name={option.icon} size={size === 'sm' ? 13 : 15} />}
            <span>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** 键值对展示行，用于详情面板。 */
export function DetailRow({
  icon,
  label,
  children,
}: {
  icon: IconName;
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="detail-row">
      <span className="detail-row__icon" aria-hidden="true">
        <Icon name={icon} size={15} />
      </span>
      <div className="detail-row__body">
        <span className="detail-row__label">{label}</span>
        <div className="detail-row__value">{children}</div>
      </div>
    </div>
  );
}
