/** 天气：当前实况、三天预报、室内传感器与位置设置。 */

import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import { useDeviceStatus, useWeather, useWeatherSearch, useWeatherSettings } from '@/api/use-workspace';
import { useRefreshWeather, useUpdateWeatherSettings } from '@/api/use-workspace-mutations';
import { AppShell } from '@/components/layout/AppShell';
import { useShellTopBar } from '@/hooks/use-shell';
import { describeUpdatedAt, weatherIconName } from '@/lib/labels';
import { Badge, Button, ErrorState, Field, InlineAlert, Input, Switch } from '@/components/ui';
import { Icon } from '@/components/ui/icon';

export function WeatherPage(): ReactElement {
  const topbar = useShellTopBar({ showFilters: false });
  const navigate = useNavigate();
  const weather = useWeather();
  const settings = useWeatherSettings();
  const device = useDeviceStatus();
  const updateSettings = useUpdateWeatherSettings();
  const refreshWeather = useRefreshWeather();

  const [cityQuery, setCityQuery] = useState('');
  const search = useWeatherSearch(cityQuery);

  const [city, setCity] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!settings.data) return;
    setCity(settings.data.city);
    setLatitude(String(settings.data.latitude));
    setLongitude(String(settings.data.longitude));
    setEnabled(settings.data.enabled);
  }, [settings.data]);

  const snapshot = weather.data;
  const indoor = device.data;

  const headline = useMemo(() => {
    if (!snapshot) return null;
    return snapshot.current;
  }, [snapshot]);

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const parsedLatitude = Number(latitude);
    const parsedLongitude = Number(longitude);
    if (!city.trim()) {
      setFormError('请填写城市名称');
      return;
    }
    if (!Number.isFinite(parsedLatitude) || parsedLatitude < -90 || parsedLatitude > 90) {
      setFormError('纬度需要在 -90 到 90 之间');
      return;
    }
    if (!Number.isFinite(parsedLongitude) || parsedLongitude < -180 || parsedLongitude > 180) {
      setFormError('经度需要在 -180 到 180 之间');
      return;
    }
    setFormError(null);
    updateSettings.mutate(
      {
        city: city.trim(),
        latitude: parsedLatitude,
        longitude: parsedLongitude,
        enabled,
      },
      {
        onSuccess: () => {
          setCityQuery('');
        },
      },
    );
  };

  const pickCity = (result: { name: string; latitude: number; longitude: number }): void => {
    setCity(result.name);
    setLatitude(String(result.latitude));
    setLongitude(String(result.longitude));
    setCityQuery('');
    setFormError(null);
  };

  if (weather.isError) {
    return (
      <AppShell topbar={topbar}>
        <div className="page">
          <ErrorState
            title="天气服务不可用"
            description="请确认后端已启动。天气数据由后端向 Open-Meteo 拉取并缓存，失败时会回退到最近一次缓存。"
            detail={weather.error instanceof Error ? weather.error.message : undefined}
            onRetry={() => void weather.refetch()}
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
            <p className="page__eyebrow">Weather · 阴晴气象</p>
            <h1 className="page__title">天气</h1>
            <p className="page__subtitle">
              天气数据由后端向 Open-Meteo 拉取并缓存 15 分钟。设备端只读取缓存结果，
              断网时回退到最近一次成功的数据，不会让屏幕空掉。
            </p>
          </div>
          <div className="page__actions">
            <Button
              variant="secondary"
              leadingIcon="refresh"
              loading={refreshWeather.isPending}
              onClick={() => refreshWeather.mutate()}
            >
              立即刷新
            </Button>
            <Button variant="ghost" leadingIcon="monitor" onClick={() => navigate('/device')}>
              屏幕预览
            </Button>
          </div>
        </header>

        <div className="weather-layout">
          <div className="stack stack--lg">
            <section className="card" aria-label="当前天气">
              <div className="section-head">
                <span className="section-head__title">
                  <Icon name="map-pin" size={15} /> {snapshot?.city ?? settings.data?.city ?? '上海'}
                </span>
                <span className="row" style={{ gap: 8 }}>
                  {snapshot && (
                    <Badge tone={snapshot.stale ? 'warning' : 'success'}>
                      {snapshot.stale ? '缓存数据' : '实时'}
                    </Badge>
                  )}
                  <span className="page-hint">
                    {snapshot ? `${describeUpdatedAt(snapshot.fetchedAt)}更新` : '加载中'}
                  </span>
                </span>
              </div>

              {snapshot?.source === 'fallback' && (
                <InlineAlert tone="warning" title="暂时没有可用的天气数据">
                  {snapshot.message ?? '后端无法连接天气服务，且本地还没有缓存。请检查网络后刷新一次。'}
                </InlineAlert>
              )}

              {snapshot && (
                <>
                  <div className="weather-current">
                    <div className="weather-current__temp">
                      {Math.round(snapshot.current.temperature)}
                      <sup>°</sup>
                    </div>
                    <div className="weather-current__side">
                      <span className="weather-current__icon">
                        <Icon name={weatherIconName(headline?.icon)} size={56} weight="light" />
                      </span>
                      <span className="weather-current__condition">{snapshot.current.condition}</span>
                      <span className="weather-current__place">
                        体感 {Math.round(snapshot.current.apparentTemperature)}° · 今日{' '}
                        {Math.round(snapshot.today.min)}° ~ {Math.round(snapshot.today.max)}°
                      </span>
                    </div>
                  </div>

                  <div className="weather-meta-grid">
                    <div className="metric-tile">
                      <span className="metric-tile__label">湿度</span>
                      <span className="metric-tile__value">
                        {snapshot.current.humidity}
                        <small>%</small>
                      </span>
                    </div>
                    <div className="metric-tile">
                      <span className="metric-tile__label">风速</span>
                      <span className="metric-tile__value">
                        {Math.round(snapshot.current.windSpeed)}
                        <small>km/h</small>
                      </span>
                    </div>
                    <div className="metric-tile">
                      <span className="metric-tile__label">今日降水概率</span>
                      <span className="metric-tile__value">
                        {snapshot.today.precipitationProbability}
                        <small>%</small>
                      </span>
                    </div>
                  </div>
                </>
              )}
            </section>

            <section className="card" aria-label="未来三天">
              <div className="section-head">
                <span className="section-head__title">未来三天</span>
                <span className="page-hint">与设备端天气窗格使用同一份数据</span>
              </div>

              <div className="forecast-grid">
                {(snapshot?.forecast ?? []).map((day, index) => (
                  <article className={index === 0 ? 'forecast-card is-today' : 'forecast-card'} key={day.date}>
                    <div className="forecast-card__head">
                      <span>{index === 0 ? '今天' : day.weekday}</span>
                      <span>{format(new Date(`${day.date}T00:00:00`), 'M/d')}</span>
                    </div>
                    <Icon name={weatherIconName(day.icon)} size={28} weight="light" />
                    <div className="forecast-card__range">
                      <span className="forecast-card__max">{Math.round(day.max)}°</span>
                      <span className="forecast-card__min">{Math.round(day.min)}°</span>
                    </div>
                    <span className="forecast-card__rain">
                      <Icon name="drop" size={12} /> {day.precipitationProbability}%
                    </span>
                  </article>
                ))}
              </div>
            </section>
          </div>

          <aside className="stack stack--lg" aria-label="天气设置">
            <section className="card card--quiet" aria-label="室内环境">
              <div className="section-head">
                <span className="section-head__title">室内环境</span>
                <Badge tone={indoor?.paired ? 'success' : 'neutral'}>
                  {indoor?.paired ? '设备在线' : '未配对'}
                </Badge>
              </div>
              <p className="page-hint">
                由设备上的 SHTC3 传感器上报，随遥测一起写入本地数据库。它和室外天气并排显示在屏幕上。
              </p>
              <div className="device-grid">
                <div className="status-tile">
                  <span className="status-tile__label">室内温度</span>
                  <span className="status-tile__value">
                    <Icon name="thermometer" size={15} />
                    {indoor?.indoorTemperature != null ? `${indoor.indoorTemperature.toFixed(1)}°C` : '—'}
                  </span>
                </div>
                <div className="status-tile">
                  <span className="status-tile__label">室内湿度</span>
                  <span className="status-tile__value">
                    <Icon name="drop" size={15} />
                    {indoor?.indoorHumidity != null ? `${Math.round(indoor.indoorHumidity)}%` : '—'}
                  </span>
                </div>
              </div>
              <p className="page-hint">
                {indoor?.lastSeenAt ? `最近上报 ${describeUpdatedAt(indoor.lastSeenAt)}` : '设备还没有上报过遥测。'}
              </p>
            </section>

            <section className="card" aria-label="位置设置">
              <div className="section-head">
                <span className="section-head__title">位置</span>
                <span className="page-hint">Open-Meteo</span>
              </div>

              <Field label="搜索城市" hint="输入中文或英文城市名，从结果里选一个会自动填入经纬度。">
                <Input
                  value={cityQuery}
                  onChange={(event) => setCityQuery(event.target.value)}
                  placeholder="例如：上海 / Hangzhou"
                  aria-label="搜索城市"
                />
              </Field>

              {cityQuery.trim().length > 0 && (
                <div className="search-results">
                  {search.isFetching && <span className="page-hint">正在搜索…</span>}
                  {!search.isFetching && (search.data?.results.length ?? 0) === 0 && (
                    <span className="page-hint">
                      {search.data?.warning ?? '没有找到匹配的城市，可以直接手动填写经纬度。'}
                    </span>
                  )}
                  {search.data?.results.map((result) => (
                    <button
                      type="button"
                      key={`${result.latitude},${result.longitude}`}
                      className="search-result"
                      onClick={() => pickCity(result)}
                    >
                      <span>
                        {result.name}
                        {result.admin1 ? ` · ${result.admin1}` : ''}
                        {result.country ? `, ${result.country}` : ''}
                      </span>
                      <span className="search-result__meta">
                        {result.latitude.toFixed(2)}, {result.longitude.toFixed(2)}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              <form className="stack" onSubmit={save}>
                <Field label="城市名称">
                  <Input value={city} onChange={(event) => setCity(event.target.value)} maxLength={40} />
                </Field>
                <div className="form-row">
                  <Field label="纬度">
                    <Input
                      value={latitude}
                      onChange={(event) => setLatitude(event.target.value)}
                      inputMode="decimal"
                    />
                  </Field>
                  <Field label="经度">
                    <Input
                      value={longitude}
                      onChange={(event) => setLongitude(event.target.value)}
                      inputMode="decimal"
                    />
                  </Field>
                </div>

                <Switch
                  checked={enabled}
                  onChange={setEnabled}
                  label="启用天气模块"
                  description="关闭后设备端天气窗格显示「暂无天气数据」，但不会影响其他模块。"
                />

                {formError && (
                  <InlineAlert tone="danger" title="设置未保存">
                    {formError}
                  </InlineAlert>
                )}

                <div className="row row--wrap">
                  <Button type="submit" variant="primary" loading={updateSettings.isPending}>
                    保存位置
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      if (!settings.data) return;
                      setCity(settings.data.city);
                      setLatitude(String(settings.data.latitude));
                      setLongitude(String(settings.data.longitude));
                      setEnabled(settings.data.enabled);
                      setFormError(null);
                    }}
                  >
                    撤销修改
                  </Button>
                </div>
              </form>

              <p className="page-hint">
                当前时区：{settings.data?.timezone ?? 'Asia/Shanghai'}。天气模块在关闭状态下仍会保留缓存，
                重新开启后可立即恢复显示。
              </p>
            </section>
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
