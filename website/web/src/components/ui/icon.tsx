/**
 * 图标统一入口。
 *
 * 全站只用 Phosphor 一个图标族，并在这里集中固定线重（weight="regular"）与尺寸档位，
 * 避免出现同一界面里粗细不一致、或手写 SVG path 的情况。
 */

import {
  ArrowClockwise,
  ArrowsClockwise,
  Bell,
  BellRinging,
  BellSlash,
  BookOpen,
  Briefcase,
  CalendarBlank,
  CalendarCheck,
  CalendarDots,
  CalendarPlus,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  Check,
  CheckCircle,
  CircleNotch,
  Clock,
  Confetti,
  Desktop,
  DotsThree,
  Eye,
  EyeSlash,
  Flag,
  FunnelSimple,
  GearSix,
  Heartbeat,
  Info,
  Keyboard,
  ListBullets,
  ListChecks,
  MagnifyingGlass,
  MapPin,
  Moon,
  NotePencil,
  Palette,
  PencilSimple,
  Plus,
  Repeat,
  Rows,
  SidebarSimple,
  SquaresFour,
  Sun,
  Tag,
  Trash,
  User,
  UsersThree,
  Warning,
  WarningCircle,
  WifiHigh,
  WifiSlash,
  X,
  type IconWeight,
} from '@phosphor-icons/react';
import type { ReactElement } from 'react';

const ICONS = {
  'calendar-dots': CalendarDots,
  'calendar-blank': CalendarBlank,
  'calendar-check': CalendarCheck,
  'calendar-plus': CalendarPlus,
  plus: Plus,
  search: MagnifyingGlass,
  'caret-left': CaretLeft,
  'caret-right': CaretRight,
  'caret-down': CaretDown,
  'caret-up': CaretUp,
  close: X,
  check: Check,
  'check-circle': CheckCircle,
  trash: Trash,
  pencil: PencilSimple,
  'note-pencil': NotePencil,
  clock: Clock,
  'map-pin': MapPin,
  tag: Tag,
  repeat: Repeat,
  bell: Bell,
  'bell-ringing': BellRinging,
  'bell-off': BellSlash,
  sun: Sun,
  moon: Moon,
  desktop: Desktop,
  settings: GearSix,
  'list-bullets': ListBullets,
  rows: Rows,
  grid: SquaresFour,
  users: UsersThree,
  briefcase: Briefcase,
  book: BookOpen,
  heartbeat: Heartbeat,
  user: User,
  warning: Warning,
  'warning-circle': WarningCircle,
  info: Info,
  refresh: ArrowClockwise,
  'refresh-all': ArrowsClockwise,
  filter: FunnelSimple,
  palette: Palette,
  keyboard: Keyboard,
  spinner: CircleNotch,
  more: DotsThree,
  eye: Eye,
  'eye-off': EyeSlash,
  flag: Flag,
  list: ListChecks,
  confetti: Confetti,
  sidebar: SidebarSimple,
  online: WifiHigh,
  offline: WifiSlash,
} as const;

export type IconName = keyof typeof ICONS;

export interface IconProps {
  name: IconName;
  /** 建议使用 14 / 16 / 18 / 20 四档，保持视觉节奏一致 */
  size?: number;
  weight?: IconWeight;
  className?: string;
  /** 仅当图标本身承载信息（而非装饰）时才设置，用于无障碍朗读 */
  label?: string;
}

export function Icon({ name, size = 16, weight = 'regular', className, label }: IconProps): ReactElement {
  const Component = ICONS[name];
  return (
    <Component
      size={size}
      weight={weight}
      className={className}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? 'img' : undefined}
    />
  );
}
