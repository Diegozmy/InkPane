/** 设置页：外观、提醒、分类、快捷键与连接信息。 */

import { useState, type ReactElement } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useCategories, useHealth } from '@/api/use-calendar-data';
import { useReminderScheduler } from '@/hooks/use-reminders';
import { requestNotificationPermission, showReminderNotification } from '@/lib/notify';
import { useUiStore, type ThemeMode } from '@/store/ui-store';
import { CategoryManagerDialog } from '@/components/event/CategoryManagerDialog';
import { AppShell } from '@/components/layout/AppShell';
import { useShellTopBar } from '@/hooks/use-shell';
import { FilterDialog } from '@/components/filters/FilterDialog';
import {
  Badge,
  Button,
  InlineAlert,
  SegmentedControl,
  Switch,
} from '@/components/ui';
import { Icon, type IconName } from '@/components/ui/icon';
import type { PermissionState } from '@/lib/notify';

const SHORTCUTS: readonly { keys: string[]; label: string }[] = [
  { keys: ['T'], label: '回到今天' },
  { keys: ['M'], label: '切换到月视图' },
  { keys: ['W'], label: '切换到周视图' },
  { keys: ['D'], label: '切换到日视图' },
  { keys: ['A'], label: '打开列表视图' },
  { keys: ['←', '→'], label: '前后翻页' },
  { keys: ['N'], label: '新建日程' },
  { keys: ['/'], label: '聚焦搜索框' },
  { keys: ['Esc'], label: '关闭当前面板' },
];

const PERMISSION_TEXT: Record<PermissionState, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  granted: { label: '已授权', tone: 'success' },
  default: { label: '未授权', tone: 'warning' },
  denied: { label: '已拒绝', tone: 'danger' },
  unsupported: { label: '浏览器不支持', tone: 'neutral' },
};

function InfoRow({ icon, label, value }: { icon: IconName; label: string; value: string }): ReactElement {
  return (
    <div className="row row--between">
      <span className="row" style={{ gap: 'var(--space-2)' }}>
        <Icon name={icon} size={15} />
        <span className="muted">{label}</span>
      </span>
      <span className="numeric" style={{ color: 'var(--text-strong)' }}>
        {value}
      </span>
    </div>
  );
}

export function SettingsPage(): ReactElement {
  const topbar = useShellTopBar({ showFilters: false });
  const navigate = useNavigate();
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const filtersPanelOpen = useUiStore((state) => state.filtersPanelOpen);
  const setFiltersPanelOpen = useUiStore((state) => state.setFiltersPanelOpen);

  const reminders = useReminderScheduler();
  const { data: categories } = useCategories();
  const health = useHealth();

  const [categoryManagerOpen, setCategoryManagerOpen] = useState(false);

  const sidebar = (
    <>
      <div className="sidebar-card">
        <span className="sidebar-card__title">关于</span>
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          InkPane 墨窗的桌面端控制台：日程、课程、待办与天气在这里整理，
          再由设备端拉取、铺到电子墨水屏上。数据只保存在本机的 SQLite 里。
        </p>
      </div>

      <div className="sidebar-card">
        <span className="sidebar-card__title">快捷键</span>
        <div className="shortcut-list">
          {SHORTCUTS.map((row) => (
            <div className="shortcut-row" key={row.label}>
              <span className="muted">{row.label}</span>
              <span className="shortcut-row__keys">
                {row.keys.map((key) => (
                  <kbd className="kbd" key={key}>
                    {key}
                  </kbd>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </>
  );

  return (
    <AppShell topbar={topbar} sidebar={sidebar}>
      <div className="page">
        <header className="page__header">
          <div className="page__heading">
            <p className="page__eyebrow">Settings · 偏好</p>
            <h1 className="page__title">设置</h1>
            <p className="page__subtitle">外观、提醒、模块入口与数据源状态。</p>
          </div>
        </header>

        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">外观</h2>
              <p className="card__description">
                主题偏好保存在本机浏览器中，首屏渲染前就会生效，不会出现白屏闪烁。
              </p>
            </div>
          </div>
          <SegmentedControl<ThemeMode>
            value={theme}
            onChange={setTheme}
            ariaLabel="主题模式"
            options={[
              { value: 'light', label: '浅色', icon: 'sun' },
              { value: 'dark', label: '深色', icon: 'moon' },
              { value: 'system', label: '跟随系统', icon: 'desktop' },
            ]}
          />
        </section>

        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">提醒</h2>
              <p className="card__description">
                前端每 30 秒向后端询问「有哪些提醒该触发了」，并在本机弹出系统通知。
                无需长连接或推送服务，也会自动去重，刷新页面不会重复提醒。
              </p>
            </div>
            <Badge tone={PERMISSION_TEXT[reminders.permission].tone}>
              {PERMISSION_TEXT[reminders.permission].label}
            </Badge>
          </div>

          <Switch
            checked={reminders.enabled}
            onChange={reminders.setEnabled}
            label="启用日程提醒"
            description="关闭后不再轮询提醒，已触发的提醒记录会保留。"
          />

          {reminders.permission === 'denied' && (
            <InlineAlert tone="warning" title="系统通知已被拒绝">
              请在浏览器地址栏左侧的站点设置里把「通知」改为允许，然后刷新页面。
            </InlineAlert>
          )}

          {reminders.permission === 'unsupported' && (
            <InlineAlert tone="info" title="当前浏览器不支持系统通知">
              提醒仍会以应用内轻提示的形式出现，不会丢失。
            </InlineAlert>
          )}

          <div className="row row--wrap">
            <Button
              variant="secondary"
              leadingIcon="bell"
              disabled={reminders.permission === 'unsupported'}
              onClick={() => void reminders.requestPermission()}
            >
              申请通知权限
            </Button>
            <Button
              variant="secondary"
              leadingIcon="bell-ringing"
              disabled={reminders.permission !== 'granted'}
              onClick={() => {
                const shown = showReminderNotification(
                  {
                    id: 'test',
                    eventId: 0,
                    occurrenceKey: 'test',
                    title: '这是一条测试提醒',
                    location: '来自 InkPane 设置页',
                    categoryId: null,
                    startAt: new Date(Date.now() + 300_000).toISOString(),
                    allDay: false,
                    fireAt: new Date().toISOString(),
                    minutesBefore: 0,
                  },
                  { fireAt: new Date().toISOString() },
                );
                if (!shown) void requestNotificationPermission();
              }}
            >
              发送测试通知
            </Button>
          </div>

          {reminders.lastCheckedAt && (
            <p className="faint" style={{ fontSize: 'var(--text-xs)' }}>
              最近一次检查：{reminders.lastCheckedAt.toLocaleTimeString('zh-CN')}，命中{' '}
              {reminders.lastCount} 条提醒窗口内的日程。
            </p>
          )}
        </section>

        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">桌面屏模块</h2>
              <p className="card__description">
                待办、天气与屏幕布局在各自的页面里维护。设备端通过 /api/device/screen
                拿到排布好的屏幕数据，这里改完布局，设备下次唤醒就会生效。
              </p>
            </div>
          </div>
          <div className="row row--wrap">
            <Button variant="secondary" leadingIcon="check-square" onClick={() => navigate('/todos')}>
              待办清单
            </Button>
            <Button variant="secondary" leadingIcon="cloud-sun" onClick={() => navigate('/weather')}>
              天气
            </Button>
            <Button variant="secondary" leadingIcon="device" onClick={() => navigate('/device')}>
              屏幕与设备
            </Button>
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">课程同步</h2>
              <p className="card__description">
                从学校课程管理系统（ws8.yucai.sh.cn）导入课表，并按你设置的每节课起止时间生成日程；
                可开启自动同步。
              </p>
            </div>
            <Button variant="secondary" leadingIcon="book" onClick={() => navigate('/courses')}>
              打开课程同步
            </Button>
          </div>
        </section>

        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">分类</h2>
              <p className="card__description">
                当前共有 {categories?.length ?? 0} 个分类。分类决定日程的默认颜色。
              </p>
            </div>
            <Button variant="secondary" leadingIcon="palette" onClick={() => setCategoryManagerOpen(true)}>
              管理分类
            </Button>
          </div>

          <InlineAlert tone="info" title="删除分类是安全的">
            删除分类不会删除任何日程，只会让它们变为「未分类」。
          </InlineAlert>
        </section>

        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">数据与连接</h2>
              <p className="card__description">
                数据存储在本机 SQLite 文件中；若需要重置，可在 server 目录执行{' '}
                <code>npm run db:reset</code>。
              </p>
            </div>
            <Badge tone={health.isError ? 'danger' : 'success'}>
              {health.isError ? '未连接' : '已连接'}
            </Badge>
          </div>

          <div className="stack stack--sm">
            <InfoRow
              icon="online"
              label="后端地址"
              value={import.meta.env.VITE_API_BASE ?? '/api（经 Vite 代理）'}
            />
            <InfoRow icon="grid" label="数据库结构版本" value={String(health.data?.schemaVersion ?? '—')} />
            <InfoRow icon="calendar-blank" label="日程总数" value={String(health.data?.eventCount ?? '—')} />
            <InfoRow icon="clock" label="服务运行时长" value={`${health.data?.uptimeSeconds ?? 0} 秒`} />
            <InfoRow icon="desktop" label="运行环境" value={health.data?.env ?? '—'} />
          </div>

          {health.isError && (
            <InlineAlert tone="danger" title="无法连接后端">
              请确认 API 服务已启动：在项目根目录执行 <code>npm run dev</code>，或单独执行{' '}
              <code>npm run dev:api</code>。
            </InlineAlert>
          )}
        </section>

        <p className="faint" style={{ fontSize: 'var(--text-xs)' }}>
          需要返回日历？前往 <Link to="/calendar/month">月视图</Link> 或{' '}
          <Link to="/agenda">列表视图</Link>。
        </p>
      </div>

      <CategoryManagerDialog open={categoryManagerOpen} onClose={() => setCategoryManagerOpen(false)} />
      <FilterDialog open={filtersPanelOpen} onClose={() => setFiltersPanelOpen(false)} />
    </AppShell>
  );
}
