/** 设备：多设备列表、令牌、遥测、800×480 预览与用户级窗格布局。 */

import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { useDisplayConfig, useScreenPreview } from '@/api/use-workspace';
import { copyText, useUpdateDisplay } from '@/api/use-workspace-mutations';
import {
  useCreateDevice,
  useDeleteDevice,
  useDevices,
  useRenameDevice,
  useRotateDeviceToken,
} from '@/api/use-devices';
import { MODULE_LABEL, ScreenPreview } from '@/components/device/ScreenPreview';
import { AppShell } from '@/components/layout/AppShell';
import { useShellTopBar } from '@/hooks/use-shell';
import { cn } from '@/lib/cn';
import { deviceEndpoint } from '@/lib/device-endpoint';
import { describeUpdatedAt } from '@/lib/labels';
import {
  MODULE_ORDER,
  PRESETS,
  normalizeModules,
  presetModules,
  presetOf,
  type LayoutPreset,
} from '@/lib/layout-presets';
import {
  Badge,
  Button,
  ConfirmDialog,
  ErrorState,
  Field,
  InlineAlert,
  Input,
  Select,
  Skeleton,
} from '@/components/ui';
import { Icon } from '@/components/ui/icon';
import type { CreatedDevice, DisplayLayout, DisplayModuleId } from '@/types';

const REFRESH_OPTIONS = [5, 10, 15, 30, 60, 120, 240, 360, 720] as const;

const MAX_DEVICE_NAME_LENGTH = 40;

const DOCS_URL = 'https://github.com/Diegozmy/InkPane/blob/main/website/docs/DEVICE-API.md';

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

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
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'rotate' | 'delete' | null>(null);

  const endpoint = useMemo(() => deviceEndpoint(), []);

  const selected = useMemo(
    () => devices.data?.find((device) => device.id === selectedId) ?? devices.data?.[0],
    [devices.data, selectedId],
  );

  const moduleNames = useMemo(() => {
    const names: Partial<Record<DisplayModuleId, string>> = {};
    for (const meta of display.data?.modules ?? []) names[meta.id] = meta.name;
    return names;
  }, [display.data]);

  const activePreset = useMemo(() => presetOf(draft), [draft]);

  useEffect(() => {
    if (!display.data) return;
    setDraft(display.data.layout);
    setRefreshMinutes(display.data.refreshMinutes);
    setTimezone(display.data.timezone);
  }, [display.data]);

  useEffect(() => {
    if (selectedId === null && devices.data?.[0]) setSelectedId(devices.data[0].id);
  }, [devices.data, selectedId]);

  const selectedDeviceId = selected?.id;
  const selectedDeviceName = selected?.name;

  useEffect(() => {
    if (selectedDeviceId === undefined) return;
    setEditingName(selectedDeviceName ?? '');
  }, [selectedDeviceId, selectedDeviceName]);

  const dirty = useMemo(() => {
    if (!draft || !display.data) return false;
    const serialize = (modules: DisplayLayout['modules'], minutes: number, zone: string): string =>
      JSON.stringify({
        modules: normalizeModules(modules),
        refreshMinutes: minutes,
        timezone: zone,
      });
    return (
      serialize(draft.modules, refreshMinutes, timezone) !==
      serialize(display.data.layout.modules, display.data.refreshMinutes, display.data.timezone)
    );
  }, [draft, display.data, refreshMinutes, timezone]);

  const moduleName = (id: DisplayModuleId): string => moduleNames[id] ?? MODULE_LABEL[id];

  const applyPreset = (preset: LayoutPreset): void => {
    setDraft((current) => (current ? { ...current, modules: presetModules(preset) } : current));
  };

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
    setError(null);
    setNotice(null);
    updateDisplay.mutate(
      { layout: { ...draft, modules: normalizeModules(draft.modules) }, refreshMinutes, timezone: timezone.trim() },
      {
        onSuccess: () => setNotice('布局已保存，设备下次拉取时生效。'),
        onError: (cause) => setError(errorMessage(cause, '保存布局失败')),
      },
    );
  };

  const addDevice = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    const name = newDeviceName.trim();
    if (!name) {
      setError('请先填写设备名称');
      return;
    }
    if (name.length > MAX_DEVICE_NAME_LENGTH) {
      setError(`设备名称不能超过 ${MAX_DEVICE_NAME_LENGTH} 个字符`);
      return;
    }
    createDevice.mutate(name, {
      onSuccess: (result) => {
        setCreated(result);
        setSelectedId(result.device.id);
        setNewDeviceName('');
        setNotice(`已添加设备「${result.device.name}」`);
      },
      onError: (cause) => setError(errorMessage(cause, '创建设备失败')),
    });
  };

  const renameSelected = (event: FormEvent): void => {
    event.preventDefault();
    if (!selected) return;
    setError(null);
    setNotice(null);
    const name = editingName.trim();
    if (!name) {
      setError('设备名称不能为空');
      return;
    }
    if (name.length > MAX_DEVICE_NAME_LENGTH) {
      setError(`设备名称不能超过 ${MAX_DEVICE_NAME_LENGTH} 个字符`);
      return;
    }
    if (name === selected.name) {
      setNotice('设备名称没有变化');
      return;
    }
    renameDevice.mutate(
      { id: selected.id, name },
      {
        onSuccess: () => setNotice('设备名称已保存'),
        onError: (cause) => setError(errorMessage(cause, '保存设备名称失败')),
      },
    );
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
              {dirty ? '保存布局' : '布局已保存'}
            </Button>
          </div>
        </header>

        {error && (
          <InlineAlert tone="danger" title="操作失败">
            {error}
          </InlineAlert>
        )}
        {notice && (
          <InlineAlert tone="success" title="完成">
            {notice}
          </InlineAlert>
        )}

        <div className="device-layout-grid">
          <div className="stack stack--lg">
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
                <ScreenPreview payload={screen.data} layout={draft ?? undefined} labels={dirty} />
              )}
              <p className="preview-caption">
                <span>
                  预览为接近真机的排字效果；设备端 1-bit 渲染与字库建议见{' '}
                  <a href={DOCS_URL} target="_blank" rel="noreferrer">
                    硬件对接文档
                  </a>
                  。
                </span>
                <span>
                  {screen.data ? `生成于 ${describeUpdatedAt(screen.data.generatedAt)}` : '等待屏幕数据'}
                </span>
              </p>
            </section>

            <section className="card" aria-label="窗格布局">
              <div className="card__header">
                <div>
                  <h2 className="card__title">窗格排布</h2>
                  <p className="card__description">
                    坐标以 800 × 480 画布为准，4 的倍数，16px 安全边距。点击预设可整体替换草稿。
                  </p>
                </div>
              </div>

              <div className="preset-row">
                {PRESETS.map((preset) => {
                  const active = activePreset?.key === preset.key;
                  return (
                    <button
                      type="button"
                      key={preset.key}
                      className={cn('preset-card', active && 'is-active')}
                      aria-pressed={active}
                      onClick={() => applyPreset(preset)}
                    >
                      <span className="preset-card__name">{preset.name}</span>
                      <span className="preset-card__desc">{preset.description}</span>
                    </button>
                  );
                })}
              </div>

              <hr className="divider" />

              {!draft ? (
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
                          aria-label={`${moduleName(id)} 窗格`}
                          className={cn('switch', item.enabled && 'is-on')}
                          onClick={() => toggleModule(id)}
                        >
                          <span className="switch__thumb" />
                        </button>
                        <div className="layout-module__body">
                          <span className="layout-module__name">{moduleName(id)}</span>
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

              <hr className="divider" />

              <div className="row row--wrap">
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
                <Field label="显示时区" htmlFor="display-timezone" hint="IANA 名称，例如 Asia/Shanghai">
                  <Input
                    id="display-timezone"
                    value={timezone}
                    onChange={(event) => setTimezone(event.target.value)}
                  />
                </Field>
                <div className="row" style={{ alignItems: 'flex-end' }}>
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
              </div>
            </section>
          </div>

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
                          <span className="status-tile__value">
                            {selected.online ? '在线' : '离线'}
                          </span>
                        </div>
                        <div className="status-tile">
                          <span className="status-tile__label">电量</span>
                          <span className="status-tile__value">
                            {selected.batteryPercent != null ? `${selected.batteryPercent}%` : '—'}
                          </span>
                        </div>
                        <div className="status-tile">
                          <span className="status-tile__label">信号</span>
                          <span className="status-tile__value">
                            {selected.rssi != null ? `${selected.rssi} dBm` : '—'}
                          </span>
                        </div>
                        <div className="status-tile">
                          <span className="status-tile__label">固件</span>
                          <span className="status-tile__value">{selected.firmware ?? '—'}</span>
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
                          <span className="status-tile__label">室内湿度</span>
                          <span className="status-tile__value">
                            {selected.indoorHumidity != null
                              ? `${Math.round(selected.indoorHumidity)}%`
                              : '—'}
                          </span>
                        </div>
                      </div>

                      <div className="row row--between">
                        <span className="faint">最近上报</span>
                        <span className="numeric">
                          {selected.lastSeenAt ? describeUpdatedAt(selected.lastSeenAt) : '尚未上报'}
                        </span>
                      </div>

                      <div className="row row--between">
                        <span className="faint">令牌前缀</span>
                        <span className="numeric">{selected.tokenPrefix}</span>
                      </div>

                      <form className="row row--wrap" onSubmit={renameSelected}>
                        <Field label="设备名称" htmlFor="device-name" hint="最多 40 个字符">
                          <Input
                            id="device-name"
                            value={editingName}
                            maxLength={MAX_DEVICE_NAME_LENGTH}
                            onChange={(event) => setEditingName(event.target.value)}
                          />
                        </Field>
                        <div className="row" style={{ alignItems: 'flex-end' }}>
                          <Button
                            type="submit"
                            variant="secondary"
                            loading={renameDevice.isPending}
                            disabled={
                              renameDevice.isPending ||
                              deleteDevice.isPending ||
                              rotateToken.isPending
                            }
                          >
                            保存名称
                          </Button>
                        </div>
                      </form>

                      <div className="row row--wrap">
                        <Button
                          size="sm"
                          variant="secondary"
                          leadingIcon="key"
                          loading={rotateToken.isPending}
                          disabled={
                            rotateToken.isPending || deleteDevice.isPending || renameDevice.isPending
                          }
                          onClick={() => setPendingAction('rotate')}
                        >
                          轮换令牌
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          leadingIcon="trash"
                          loading={deleteDevice.isPending}
                          disabled={
                            deleteDevice.isPending || rotateToken.isPending || renameDevice.isPending
                          }
                          onClick={() => setPendingAction('delete')}
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
                <Field label="新设备名称" htmlFor="new-device-name" hint="最多 40 个字符">
                  <Input
                    id="new-device-name"
                    value={newDeviceName}
                    maxLength={MAX_DEVICE_NAME_LENGTH}
                    placeholder="例如：书桌墨窗"
                    onChange={(event) => setNewDeviceName(event.target.value)}
                  />
                </Field>
                <div className="row" style={{ alignItems: 'flex-end' }}>
                  <Button type="submit" variant="primary" loading={createDevice.isPending}>
                    添加设备
                  </Button>
                </div>
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
                    <span className="endpoint-line__host">{endpoint.origin}</span>
                    <span className="endpoint-line__path">{endpoint.path}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="复制设备接口地址"
                    onClick={() => void copyText(endpoint.url, '接口地址已复制')}
                  >
                    <Icon name="copy" size={15} />
                  </Button>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setCreated(null)}>
                  我已保存，关闭
                </Button>
              </section>
            )}

            <section className="card" aria-label="设备接口地址">
              <div className="card__header">
                <div>
                  <h2 className="card__title">设备拉取地址</h2>
                  <p className="card__description">
                    把这个地址与设备令牌一起写进固件的 NVS / menuconfig。
                  </p>
                </div>
              </div>

              <div className="endpoint-line">
                <span className="endpoint-line__text">
                  <span className="endpoint-line__host">{endpoint.origin}</span>
                  <span className="endpoint-line__path">{endpoint.path}</span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="复制设备接口地址"
                  onClick={() => void copyText(endpoint.url, '接口地址已复制')}
                >
                  <Icon name="copy" size={15} />
                </Button>
              </div>

              {endpoint.loopback ? (
                <InlineAlert tone="warning" title="当前是回环地址，设备访问不到">
                  设备需要请求运行后端服务的电脑。请把前端环境变量{' '}
                  <span className="code-inline">VITE_DEVICE_API_URL</span> 设为局域网地址（例如{' '}
                  <span className="code-inline">http://192.168.1.20:4000</span>），并确认服务端{' '}
                  <span className="code-inline">HOST=0.0.0.0</span>。
                </InlineAlert>
              ) : (
                <p className="page-hint">
                  设备需与运行本服务的电脑在同一局域网；地址已去掉了结尾斜杠，可直接复制。
                </p>
              )}
            </section>
          </aside>
        </div>
      </div>

      <ConfirmDialog
        open={pendingAction === 'rotate'}
        title="轮换设备令牌"
        message={`轮换后旧令牌立即失效，设备需要重新配置。确定要为「${selected?.name ?? ''}」轮换吗？`}
        confirmLabel="确认轮换"
        tone="danger"
        busy={rotateToken.isPending}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          if (!selected) return;
          rotateToken.mutate(selected.id, {
            onSuccess: (result) => {
              setCreated(result);
              setNotice('令牌已轮换，请在设备上更新配置。');
            },
            onError: (cause) => setError(errorMessage(cause, '轮换令牌失败')),
            onSettled: () => setPendingAction(null),
          });
        }}
      />

      <ConfirmDialog
        open={pendingAction === 'delete'}
        title="移除设备"
        message={`移除「${selected?.name ?? ''}」后旧令牌会立即失效，历史遥测保留。确定继续吗？`}
        confirmLabel="移除"
        tone="danger"
        busy={deleteDevice.isPending}
        onCancel={() => setPendingAction(null)}
        onConfirm={() => {
          if (!selected) return;
          deleteDevice.mutate(selected.id, {
            onSuccess: () => {
              setSelectedId(null);
              setCreated(null);
              setNotice('设备已移除');
            },
            onError: (cause) => setError(errorMessage(cause, '移除设备失败')),
            onSettled: () => setPendingAction(null),
          });
        }}
      />
    </AppShell>
  );
}
