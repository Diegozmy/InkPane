/** 设备：墨水屏实时预览、窗格布局编辑器、设备令牌与遥测状态。 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useDeviceStatus, useDeviceToken, useDisplayConfig, useScreenPreview } from '@/api/use-workspace';
import {
  copyText,
  useRotateDeviceToken,
  useUpdateDeviceSettings,
  useUpdateDisplay,
} from '@/api/use-workspace-mutations';
import { MODULE_LABEL, ScreenPreview } from '@/components/device/ScreenPreview';
import { AppShell } from '@/components/layout/AppShell';
import { useShellTopBar } from '@/hooks/use-shell';
import { cn } from '@/lib/cn';
import { describeUpdatedAt } from '@/lib/labels';
import { Badge, Button, ErrorState, Field, Input, Skeleton } from '@/components/ui';
import { Icon } from '@/components/ui/icon';
import type { DisplayLayout, DisplayModule, DisplayModuleId } from '@/types';

const REFRESH_OPTIONS = [5, 10, 15, 30, 60, 120, 240, 360] as const;

const DOCS_URL = 'https://github.com/Diegozmy/InkPane/blob/main/website/docs/DEVICE-API.md';

interface LayoutPreset {
  key: string;
  name: string;
  description: string;
  modules: Record<DisplayModuleId, DisplayModule>;
}

function module(
  id: DisplayModuleId,
  x: number,
  y: number,
  w: number,
  h: number,
  enabled = true,
): DisplayModule {
  return { id, x, y, w, h, enabled };
}

const PRESETS: readonly LayoutPreset[] = [
  {
    key: 'balanced',
    name: '均衡',
    description: '左栏时钟 / 月历 / 待办，中间天气 / 课程，右栏整列日程。',
    modules: {
      clock: module('clock', 16, 16, 220, 100),
      calendar: module('calendar', 16, 128, 220, 180),
      todos: module('todos', 16, 320, 220, 144),
      weather: module('weather', 248, 16, 240, 288),
      courses: module('courses', 248, 316, 240, 148),
      schedule: module('schedule', 500, 16, 284, 448),
    },
  },
  {
    key: 'schedule',
    name: '日程优先',
    description: '日程独占中栏，时钟、月历、待办靠左，天气与课程收进右栏。',
    modules: {
      clock: module('clock', 16, 16, 200, 92),
      calendar: module('calendar', 16, 120, 200, 176),
      todos: module('todos', 16, 308, 200, 156),
      schedule: module('schedule', 228, 16, 360, 448),
      weather: module('weather', 600, 16, 184, 240),
      courses: module('courses', 600, 268, 184, 196),
    },
  },
  {
    key: 'weather',
    name: '天气优先',
    description: '左边一整块天气，右上月历与课程，日程仍占右栏。',
    modules: {
      clock: module('clock', 16, 16, 232, 100),
      weather: module('weather', 16, 128, 232, 336),
      calendar: module('calendar', 260, 16, 244, 200),
      courses: module('courses', 260, 228, 244, 120),
      todos: module('todos', 260, 360, 244, 104),
      schedule: module('schedule', 516, 16, 268, 448),
    },
  },
  {
    key: 'minimal',
    name: '极简',
    description: '只保留时钟、天气与日程，其余窗格关闭。适合「一窗墨色」的克制桌面。',
    modules: {
      clock: module('clock', 16, 16, 368, 160),
      weather: module('weather', 396, 16, 388, 220),
      schedule: module('schedule', 16, 188, 768, 276),
      calendar: module('calendar', 16, 16, 220, 180, false),
      courses: module('courses', 248, 316, 240, 148, false),
      todos: module('todos', 16, 320, 220, 144, false),
    },
  },
];

const MODULE_ORDER: readonly DisplayModuleId[] = ['clock', 'calendar', 'weather', 'schedule', 'courses', 'todos'];

function moduleName(id: DisplayModuleId, names: Partial<Record<DisplayModuleId, string>>): string {
  return names[id] ?? MODULE_LABEL[id];
}

export function DevicePage(): ReactElement {
  const topbar = useShellTopBar({ showFilters: false });
  const display = useDisplayConfig();
  const screen = useScreenPreview();
  const status = useDeviceStatus();
  const token = useDeviceToken();
  const updateDisplay = useUpdateDisplay();
  const updateDevice = useUpdateDeviceSettings();
  const rotateToken = useRotateDeviceToken();

  const [draft, setDraft] = useState<DisplayLayout | null>(null);
  const [refreshMinutes, setRefreshMinutes] = useState(30);
  const [deviceName, setDeviceName] = useState('');
  const [revealToken, setRevealToken] = useState(false);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    if (!display.data) return;
    setDraft(display.data.layout);
    setRefreshMinutes(display.data.refreshMinutes);
  }, [display.data]);

  useEffect(() => {
    if (status.data) setDeviceName(status.data.name);
  }, [status.data]);

  const moduleNames = useMemo(() => {
    const names: Partial<Record<DisplayModuleId, string>> = {};
    for (const meta of display.data?.modules ?? []) names[meta.id] = meta.name;
    return names;
  }, [display.data]);

  const presetKey = useMemo(() => {
    if (!draft) return null;
    const signature = (mods: DisplayModule[]): string =>
      MODULE_ORDER.map((id) => {
        const found = mods.find((item) => item.id === id);
        return found ? `${id}:${found.enabled ? 1 : 0}:${found.x},${found.y},${found.w},${found.h}` : id;
      }).join('|');
    const current = signature(draft.modules);
    return PRESETS.find((preset) => signature(Object.values(preset.modules)) === current)?.key ?? null;
  }, [draft]);

  const dirty = useMemo(() => {
    if (!draft || !display.data) return false;
    const serialize = (layout: DisplayLayout, minutes: number): string =>
      JSON.stringify({ modules: layout.modules, minutes });
    return serialize(draft, refreshMinutes) !== serialize(display.data.layout, display.data.refreshMinutes);
  }, [draft, display.data, refreshMinutes]);

  const applyPreset = (preset: LayoutPreset): void => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        modules: MODULE_ORDER.map((id) => ({ ...preset.modules[id] })),
      };
    });
  };

  const toggleModule = (id: DisplayModuleId): void => {
    setDraft((current) => {
      if (!current) return current;
      return {
        ...current,
        modules: current.modules.map((item) =>
          item.id === id ? { ...item, enabled: !item.enabled } : item,
        ),
      };
    });
  };

  const saveLayout = (): void => {
    if (!draft) return;
    updateDisplay.mutate({
      layout: {
        ...draft,
        modules: MODULE_ORDER.map((id) => {
          const found = draft.modules.find((item) => item.id === id);
          return found ?? { id, x: 16, y: 16, w: 220, h: 100, enabled: false };
        }),
      },
      refreshMinutes,
    });
  };

  const endpoint = useMemo(() => {
    const host = typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname;
    return { host: `http://${host}:4000`, path: '/api/device/screen' };
  }, []);

  const secret = token.data?.token ?? '';
  const masked = secret ? `${secret.slice(0, 6)}${'•'.repeat(18)}${secret.slice(-4)}` : '尚未生成';

  if (display.isError) {
    return (
      <AppShell topbar={topbar}>
        <div className="page">
          <ErrorState
            title="屏幕配置加载失败"
            description="请确认后端服务已启动。屏幕配置接口为 /api/display。"
            detail={display.error instanceof Error ? display.error.message : undefined}
            onRetry={() => void display.refetch()}
          />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell topbar={topbar}>
      <div className="page page--wide">
        <header className="page__header">
          <div className="page__heading">
            <p className="page__eyebrow">Display · 一方墨窗</p>
            <h1 className="page__title">屏幕与设备</h1>
            <p className="page__subtitle">
              800 × 480 的窗格由这里排布。布局与刷新间隔保存后，设备下次唤醒时会按 ETag 拉取新的屏幕数据。
            </p>
          </div>
          <div className="page__actions">
            <a className="btn btn--ghost btn--md" href={DOCS_URL} target="_blank" rel="noreferrer">
              <Icon name="external" size={16} />
              <span className="btn__label">硬件对接文档</span>
            </a>
            <Button
              variant="secondary"
              leadingIcon="refresh"
              onClick={() => void screen.refetch()}
              loading={screen.isFetching}
            >
              刷新预览
            </Button>
            <Button
              variant="primary"
              leadingIcon="check"
              disabled={!dirty}
              loading={updateDisplay.isPending}
              onClick={saveLayout}
            >
              {dirty ? '保存布局' : '布局已保存'}
            </Button>
          </div>
        </header>

        <div className="device-layout">
          <div className="stack stack--lg">
            <section className="card" aria-label="屏幕预览">
              <div className="section-head">
                <span className="section-head__title">实时预览</span>
                <span className="row" style={{ gap: 8 }}>
                  <Badge tone="neutral">800 × 480</Badge>
                  <Badge tone="neutral">1-bit</Badge>
                  {screen.data && (
                    <Badge tone="accent">{screen.data.etag.replaceAll('"', '').slice(0, 12)}</Badge>
                  )}
                </span>
              </div>

              <div className="preview-frame">
                <ScreenPreview
                  payload={screen.data}
                  layout={draft ?? undefined}
                  labels={dirty}
                />
              </div>

              <div className="preview-caption">
                <span>
                  预览为接近真机的排字效果；设备端 1-bit 渲染与字库建议见{' '}
                  <a href={DOCS_URL} target="_blank" rel="noreferrer">
                    硬件对接文档
                  </a>
                  。
                </span>
                <span>
                  {screen.data
                    ? `生成于 ${describeUpdatedAt(screen.data.generatedAt)}`
                    : '等待屏幕数据'}
                </span>
              </div>
            </section>

            <section className="card" aria-label="窗格布局">
              <div className="section-head">
                <span className="section-head__title">窗格排布</span>
                <span className="page-hint">
                  坐标以 800 × 480 画布为准，4 的倍数，16px 安全边距
                </span>
              </div>

              <div className="preset-row">
                {PRESETS.map((preset) => (
                  <button
                    type="button"
                    key={preset.key}
                    className={cn('preset-card', presetKey === preset.key && 'is-active')}
                    aria-pressed={presetKey === preset.key}
                    onClick={() => applyPreset(preset)}
                  >
                    <span className="preset-card__name">{preset.name}</span>
                    <span className="preset-card__desc">{preset.description}</span>
                  </button>
                ))}
              </div>

              <hr className="divider" />

              {display.isLoading || !draft ? (
                <div className="stack">
                  <Skeleton height={56} />
                  <Skeleton height={56} />
                  <Skeleton height={56} />
                </div>
              ) : (
                <div className="layout-modules">
                  {MODULE_ORDER.map((id) => {
                    const item = draft.modules.find((entry) => entry.id === id);
                    if (!item) return null;
                    return (
                      <div
                        className={cn('layout-module', !item.enabled && 'layout-module__disabled')}
                        key={id}
                      >
                        <button
                          type="button"
                          role="switch"
                          aria-checked={item.enabled}
                          aria-label={`${moduleName(id, moduleNames)} 窗格`}
                          className={cn('switch', item.enabled && 'is-on')}
                          onClick={() => toggleModule(id)}
                        >
                          <span className="switch__thumb" />
                        </button>
                        <div className="layout-module__body">
                          <span className="layout-module__name">{moduleName(id, moduleNames)}</span>
                          <span className="layout-module__meta">
                            {id} · {item.x},{item.y} · {item.w} × {item.h}
                          </span>
                        </div>
                        <Badge tone={item.enabled ? 'accent' : 'neutral'}>
                          {item.enabled ? '显示' : '隐藏'}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="row row--wrap">
                <label className="field" style={{ gap: 6 }}>
                  <span className="field__label">刷新间隔</span>
                  <select
                    className="input"
                    style={{ width: 140 }}
                    value={refreshMinutes}
                    onChange={(event) => setRefreshMinutes(Number(event.target.value))}
                    aria-label="刷新间隔"
                  >
                    {REFRESH_OPTIONS.map((minutes) => (
                      <option value={minutes} key={minutes}>
                        每 {minutes} 分钟
                      </option>
                    ))}
                  </select>
                </label>
                <span className="page-hint" style={{ maxWidth: 360 }}>
                  间隔越短越及时，但耗电越多。设备会在两次刷新之间深度休眠，
                  时钟由板载 RTC 走时，不需要为了分钟数重绘整屏。
                </span>
              </div>
            </section>

            <section className="card" aria-label="设备状态">
              <div className="section-head">
                <span className="section-head__title">设备状态</span>
                <Badge tone={status.data?.paired ? 'success' : 'neutral'}>
                  {status.data?.paired ? '已配对' : '等待配对'}
                </Badge>
              </div>

              <div className="device-grid">
                <div className="status-tile">
                  <span className="status-tile__label">最近上报</span>
                  <span className="status-tile__value">
                    <Icon name="paper-plane" size={15} />
                    {status.data?.lastSeenAt ? describeUpdatedAt(status.data.lastSeenAt) : '—'}
                  </span>
                </div>
                <div className="status-tile">
                  <span className="status-tile__label">电量</span>
                  <span className="status-tile__value">
                    <Icon
                      name={
                        status.data?.batteryPercent == null
                          ? 'battery-medium'
                          : status.data.batteryPercent > 60
                            ? 'battery-high'
                            : status.data.batteryPercent > 25
                              ? 'battery-medium'
                              : 'battery-low'
                      }
                      size={15}
                    />
                    {status.data?.batteryPercent != null ? `${status.data.batteryPercent}%` : '—'}
                  </span>
                </div>
                <div className="status-tile">
                  <span className="status-tile__label">信号</span>
                  <span className="status-tile__value">
                    <Icon name="signal" size={15} />
                    {status.data?.rssi != null ? `${status.data.rssi} dBm` : '—'}
                  </span>
                </div>
                <div className="status-tile">
                  <span className="status-tile__label">固件</span>
                  <span className="status-tile__value">{status.data?.firmware ?? '—'}</span>
                </div>
                <div className="status-tile">
                  <span className="status-tile__label">室内温度</span>
                  <span className="status-tile__value">
                    {status.data?.indoorTemperature != null
                      ? `${status.data.indoorTemperature.toFixed(1)}°C`
                      : '—'}
                  </span>
                </div>
                <div className="status-tile">
                  <span className="status-tile__label">室内湿度</span>
                  <span className="status-tile__value">
                    {status.data?.indoorHumidity != null
                      ? `${Math.round(status.data.indoorHumidity)}%`
                      : '—'}
                  </span>
                </div>
              </div>

              <form
                className="row row--wrap"
                onSubmit={(event) => {
                  event.preventDefault();
                  updateDevice.mutate({ name: deviceName.trim() || 'InkPane 墨窗' });
                }}
              >
                <Field label="设备名称">
                  <Input
                    value={deviceName}
                    onChange={(event) => setDeviceName(event.target.value)}
                    maxLength={40}
                    style={{ width: 240 }}
                  />
                </Field>
                <Button type="submit" variant="secondary" loading={updateDevice.isPending}>
                  保存名称
                </Button>
              </form>
            </section>
          </div>

          <aside className="stack stack--lg" aria-label="设备令牌与对接">
            <section className="card" aria-label="设备令牌">
              <div className="section-head">
                <span className="section-head__title">设备令牌</span>
                <Badge tone={secret ? 'success' : 'neutral'}>{secret ? '已生成' : '未生成'}</Badge>
              </div>
              <p className="page-hint">
                设备每次请求都带 <span className="code-inline">X-Device-Token</span> 请求头。
                令牌等同密码，只应写在设备 NVS 里，不要贴到公开的地方。
              </p>

              <div className="token-box">
                {revealToken ? secret || '尚未生成' : masked}
                <span className="token-box__actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={revealToken ? '隐藏令牌' : '显示令牌'}
                    onClick={() => setRevealToken((value) => !value)}
                  >
                    <Icon name={revealToken ? 'eye-off' : 'eye'} size={15} />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="复制令牌"
                    onClick={() => {
                      if (secret) void copyText(secret, '设备令牌已复制');
                    }}
                  >
                    <Icon name="copy" size={15} />
                  </Button>
                </span>
              </div>

              <div className="token-box__actions" style={{ position: 'static', justifyContent: 'flex-start' }}>
                {rotating ? (
                  <>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={rotateToken.isPending}
                      onClick={() => {
                        rotateToken.mutate(undefined, {
                          onSuccess: () => {
                            setRevealToken(true);
                            setRotating(false);
                          },
                        });
                      }}
                    >
                      确认轮换（旧令牌立即失效）
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRotating(false)}>
                      取消
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    leadingIcon="key"
                    onClick={() => setRotating(true)}
                  >
                    轮换令牌
                  </Button>
                )}
              </div>

              <div className="stack stack--sm">
                <span className="metric-tile__label">设备拉取地址</span>
                <div className="endpoint-line">
                  <span className="endpoint-line__text">
                    <span className="endpoint-line__host">{endpoint.host}</span>
                    <span className="endpoint-line__path">{endpoint.path}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="复制设备接口地址"
                    onClick={() => void copyText(`${endpoint.host}${endpoint.path}`, '接口地址已复制')}
                  >
                    <Icon name="copy" size={15} />
                  </Button>
                </div>
                <p className="page-hint">
                  设备需与运行本服务的电脑在同一局域网。默认服务只监听 127.0.0.1，
                  请在 <span className="code-inline">website/server/.env</span> 里设置{' '}
                  <span className="code-inline">HOST=0.0.0.0</span> 后重启。
                </p>
              </div>
            </section>

            <section className="card card--quiet" aria-label="对接步骤">
              <span className="section-head__title">接入一台新设备</span>
              <div className="step-list">
                <div className="step-list__item">
                  <span className="step-list__index">1</span>
                  <div className="step-list__body">
                    <span className="step-list__title">拷贝令牌与地址</span>
                    <span className="step-list__text">
                      把上面的令牌和拉取地址写进设备固件的 NVS / menuconfig。
                    </span>
                  </div>
                </div>
                <div className="step-list__item">
                  <span className="step-list__index">2</span>
                  <div className="step-list__body">
                    <span className="step-list__title">首次拉取屏幕</span>
                    <span className="step-list__text">
                      设备 GET 拉取地址并带上 <span className="code-inline">X-Device-Token</span>，
                      拿到 JSON 后按窗格布局渲染。
                    </span>
                  </div>
                </div>
                <div className="step-list__item">
                  <span className="step-list__index">3</span>
                  <div className="step-list__body">
                    <span className="step-list__title">上报遥测</span>
                    <span className="step-list__text">
                      POST /api/device/telemetry 上报温湿度与电量，这里的状态就会亮起来。
                    </span>
                  </div>
                </div>
              </div>
              <a className="btn btn--secondary btn--md" href={DOCS_URL} target="_blank" rel="noreferrer">
                <Icon name="book" size={16} />
                <span className="btn__label">查看完整对接文档</span>
                <Icon name="external" size={14} />
              </a>
            </section>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
