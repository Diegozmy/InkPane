/** 设备：多设备列表、令牌、遥测、800×480 预览与用户级窗格布局。 */

import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { useDisplayConfig, useScreenPreview } from '@/api/use-workspace';
import { copyText, useUpdateDisplay } from '@/api/use-workspace-mutations';
import { useCreateDevice, useDeleteDevice, useDevices, useRenameDevice, useRotateDeviceToken } from '@/api/use-devices';
import { MODULE_LABEL, ScreenPreview } from '@/components/device/ScreenPreview';
import { AppShell } from '@/components/layout/AppShell';
import { useShellTopBar } from '@/hooks/use-shell';
import { describeUpdatedAt } from '@/lib/labels';
import { Badge, Button, ErrorState, Field, InlineAlert, Input, Select, Skeleton } from '@/components/ui';
import { Icon } from '@/components/ui/icon';
import type { CreatedDevice, DisplayLayout, DisplayModuleId } from '@/types';

const MODULE_ORDER: readonly DisplayModuleId[] = [
  'clock',
  'calendar',
  'weather',
  'schedule',
  'courses',
  'todos',
];

const REFRESH_OPTIONS = [5, 10, 15, 30, 60, 120, 240, 360, 720] as const;

const DOCS_URL = 'https://github.com/Diegozmy/InkPane/blob/main/website/docs/DEVICE-API.md';

export function DevicePage(): ReactElement {
  const topbar = useShellTopBar({ showFilters: false });
  const display = useDisplayConfig();
  const screen = useScreenPreview();
  const devices = useDevices();
  const createDevice = useCreateDevice();
  const renameDevice = useRenameDevice();
  const rotateToken = useRotateDeviceToken();
  const deleteDevice = useDeleteDevice();
  const updateDisplay = useUpdateDisplay();

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draft, setDraft] = useState<DisplayLayout | null>(null);
  const [refreshMinutes, setRefreshMinutes] = useState(30);
  const [timezone, setTimezone] = useState('Asia/Shanghai');
  const [newDeviceName, setNewDeviceName] = useState('');
  const [editingName, setEditingName] = useState('');
  const [created, setCreated] = useState<CreatedDevice | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(
    () => devices.data?.find((device) => device.id === selectedId) ?? devices.data?.[0],
    [devices.data, selectedId],
  );

  useEffect(() => {
    if (!display.data) return;
    setDraft(display.data.layout);
    setRefreshMinutes(display.data.refreshMinutes);
    setTimezone(display.data.timezone);
  }, [display.data]);

  useEffect(() => {
    if (selectedId === null && devices.data?.[0]) setSelectedId(devices.data[0].id);
    if (selected && selected.id !== selectedId) setSelectedId(selected.id);
    if (selected) setEditingName(selected.name);
  }, [devices.data, selected, selectedId]);

  const dirty = useMemo(() => {
    if (!draft || !display.data) return false;
    return (
      JSON.stringify({ modules: draft.modules, refreshMinutes, timezone }) !==
      JSON.stringify({
        modules: display.data.layout.modules,
        refreshMinutes: display.data.refreshMinutes,
        timezone: display.data.timezone,
      })
    );
  }, [draft, display.data, refreshMinutes, timezone]);

  const toggleModule = (id: DisplayModuleId): void => {
    setDraft((current) =>
      current
        ? {
            ...current,
            modules: current.modules.map((module) =>
              module.id === id ? { ...module, enabled: !module.enabled } : module,
            ),
          }
        : current,
    );
  };

  const saveLayout = (): void => {
    if (!draft) return;
    updateDisplay.mutate({ layout: draft, refreshMinutes, timezone });
  };

  const endpoint = useMemo(() => {
    const host = typeof window === 'undefined' ? '127.0.0.1' : window.location.hostname;
    return { host: `http://${host}:4000`, path: '/api/device/screen' };
  }, []);

  const addDevice = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    const name = newDeviceName.trim();
    if (!name) return;
    createDevice.mutate(name, {
      onSuccess: (result) => {
        setCreated(result);
        setSelectedId(result.device.id);
        setNewDeviceName('');
      },
      onError: (cause) => setError(cause instanceof Error ? cause.message : '创建设备失败'),
    });
  };

  if (display.isError) {
    return (
      <AppShell topbar={topbar}>
        <div className="page">
          <ErrorState
            title="屏幕配置加载失败"
            description="请确认后端服务已启动，并且当前账号已登录。"
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
              布局、刷新间隔与时区对当前账号的所有设备生效；每台设备有独立令牌与遥测。
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
              保存布局
            </Button>
          </div>
        </header>

        {error && <InlineAlert tone="danger" title="操作失败">{error}</InlineAlert>}

        <div className="device-layout-grid">
          <section className="card" aria-label="屏幕预览">
            <div className="card__header">
              <div>
                <h2 className="card__title">屏幕预览</h2>
                <p className="card__description">
                  800 × 480，只使用黑 / 白 / 灰度。预览与设备拉取的数据同源。
                </p>
              </div>
              {screen.data && <Badge tone="neutral">ETag {screen.data.etag.slice(0, 10)}…</Badge>}
            </div>
            {screen.isLoading ? (
              <Skeleton height={360} radius="var(--radius-surface)" />
            ) : (
              <ScreenPreview payload={screen.data} layout={draft ?? undefined} />
            )}
          </section>

          <aside className="stack stack--lg" aria-label="设备管理">
            <section className="card">
              <div className="card__header">
                <div>
                  <h2 className="card__title">我的设备</h2>
                  <p className="card__description">一个账号可绑定多台设备，每台独立令牌。</p>
                </div>
                <Badge tone="neutral">{devices.data?.length ?? 0} 台</Badge>
              </div>

              {devices.isLoading ? (
                <Skeleton height={120} />
              ) : devices.data && devices.data.length > 0 ? (
                <div className="stack stack--sm">
                  <Field label="当前设备" htmlFor="device-select">
                    <Select
                      id="device-select"
                      value={selected?.id ?? ''}
                      onChange={(event) => setSelectedId(Number(event.target.value))}
                    >
                      {devices.data.map((device) => (
                        <option key={device.id} value={device.id}>
                          {device.name}
                          {device.online ? ' · 在线' : ' · 离线'}
                        </option>
                      ))}
                    </Select>
                  </Field>

                  {selected && (
                    <>
                      <div className="device-status-grid">
                        <div className="status-tile">
                          <span className="status-tile__label">状态</span>
                          <span className="status-tile__value">{selected.online ? '在线' : '离线'}</span>
                        </div>
                        <div className="status-tile">
                          <span className="status-tile__label">电量</span>
                          <span className="status-tile__value">
                            {selected.batteryPercent != null ? `${selected.batteryPercent}%` : '—'}
                          </span>
                        </div>
                        <div className="status-tile">
                          <span className="status-tile__label">室内温度</span>
                          <span className="status-tile__value">
                            {selected.indoorTemperature != null
                              ? `${selected.indoorTemperature.toFixed(1)} °C`
                              : '—'}
                          </span>
                        </div>
                        <div className="status-tile">
                          <span className="status-tile__label">最近上报</span>
                          <span className="status-tile__value faint">
                            {selected.lastSeenAt ? describeUpdatedAt(selected.lastSeenAt) : '—'}
                          </span>
                        </div>
                      </div>

                      <div className="row row--between">
                        <span className="faint">令牌前缀</span>
                        <span className="numeric">{selected.tokenPrefix}</span>
                      </div>

                      <form
                        className="row row--wrap"
                        onSubmit={(event) => {
                          event.preventDefault();
                          renameDevice.mutate({ id: selected.id, name: editingName.trim() });
                        }}
                      >
                        <Field label="设备名称" htmlFor="device-name">
                          <Input
                            id="device-name"
                            value={editingName}
                            maxLength={40}
                            onChange={(event) => setEditingName(event.target.value)}
                          />
                        </Field>
                        <Button type="submit" variant="secondary" loading={renameDevice.isPending}>
                          保存名称
                        </Button>
                      </form>

                      <div className="row row--wrap">
                        <Button
                          size="sm"
                          variant="secondary"
                          leadingIcon="key"
                          loading={rotateToken.isPending}
                          onClick={() => {
                            if (!window.confirm('轮换令牌后旧令牌立即失效，设备需要重新配置。继续？')) return;
                            rotateToken.mutate(selected.id, {
                              onSuccess: (result) => setCreated(result),
                            });
                          }}
                        >
                          轮换令牌
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          leadingIcon="trash"
                          loading={deleteDevice.isPending}
                          onClick={() => {
                            if (!window.confirm(`移除设备「${selected.name}」？旧令牌会立即失效。`)) return;
                            deleteDevice.mutate(selected.id, {
                              onSuccess: () => setSelectedId(null),
                            });
                          }}
                        >
                          移除设备
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              ) : (
                <p className="muted">还没有设备。先创建一台，把令牌写进固件。</p>
              )}

              <form className="row row--wrap" onSubmit={addDevice}>
                <Field label="新设备名称" htmlFor="new-device-name">
                  <Input
                    id="new-device-name"
                    value={newDeviceName}
                    maxLength={40}
                    placeholder="例如：书桌墨窗"
                    onChange={(event) => setNewDeviceName(event.target.value)}
                  />
                </Field>
                <Button type="submit" variant="primary" loading={createDevice.isPending}>
                  添加设备
                </Button>
              </form>
            </section>

            {created && (
              <section className="card card--quiet" aria-label="新设备令牌">
                <div className="section-head">
                  <span className="section-head__title">令牌只显示这一次</span>
                  <Badge tone="success">{created.device.name}</Badge>
                </div>
                <InlineAlert tone="warning" title="请立刻保存">
                  关闭后无法再次查看完整令牌；丢失只能轮换。
                </InlineAlert>
                <div className="token-box">
                  {created.token}
                  <span className="token-box__actions">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="复制令牌"
                      onClick={() => void copyText(created.token, '设备令牌已复制')}
                    >
                      <Icon name="copy" size={15} />
                    </Button>
                  </span>
                </div>
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
                <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                  我已保存，关闭
                </Button>
              </section>
            )}

            <section className="card" aria-label="布局与刷新">
              <div className="card__header">
                <div>
                  <h2 className="card__title">布局与刷新</h2>
                  <p className="card__description">对当前账号的所有设备生效。</p>
                </div>
              </div>
              <div className="stack stack--sm">
                {MODULE_ORDER.map((id) => {
                  const module = draft?.modules.find((item) => item.id === id);
                  const enabled = module?.enabled ?? true;
                  return (
                    <label key={id} className="row row--between">
                      <span>{MODULE_LABEL[id]}</span>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={() => toggleModule(id)}
                        aria-label={`${MODULE_LABEL[id]} 显示`}
                      />
                    </label>
                  );
                })}
                <Field label="刷新间隔" htmlFor="refresh-minutes">
                  <Select
                    id="refresh-minutes"
                    value={refreshMinutes}
                    onChange={(event) => setRefreshMinutes(Number(event.target.value))}
                  >
                    {REFRESH_OPTIONS.map((minutes) => (
                      <option key={minutes} value={minutes}>
                        {minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="显示时区" htmlFor="display-timezone">
                  <Input
                    id="display-timezone"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                  />
                </Field>
                <Button
                  variant="secondary"
                  leadingIcon="check"
                  disabled={!dirty}
                  loading={updateDisplay.isPending}
                  onClick={saveLayout}
                >
                  保存设置
                </Button>
              </div>
            </section>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
