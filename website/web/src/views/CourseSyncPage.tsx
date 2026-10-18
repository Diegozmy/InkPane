/** 课程同步页：对接学校课程管理系统，导入并自动同步课程表。 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import {
  useCourseSettings,
  useCourseSyncStatus,
  useDeleteCourseCredentials,
  useImportCourses,
  usePreviewCourses,
  useSaveCourseCredentials,
  useSyncCoursesNow,
  useTestCourseLogin,
  useUpdateCourseSettings,
} from '@/api/use-courses';
import { formatTime, relativeDayLabel } from '@/lib/date';
import { useShellTopBar } from '@/hooks/use-shell';
import { AppShell } from '@/components/layout/AppShell';
import {
  Badge,
  Button,
  Field,
  IconButton,
  InlineAlert,
  Input,
  Modal,
  Select,
  Skeleton,
  Switch,
} from '@/components/ui';
import type { CoursePreview, CourseSyncSettings, PeriodTime, PreviewSlot } from '@/types';

/* ------------------------------------------------------------------ *
 * 节次时间编辑器
 * ------------------------------------------------------------------ */

function PeriodEditor({
  title,
  description,
  periods,
  onChange,
  accent,
}: {
  title: string;
  description?: string;
  periods: PeriodTime[];
  onChange: (periods: PeriodTime[]) => void;
  accent?: boolean;
}): ReactElement {
  const sorted = useMemo(() => [...periods].sort((a, b) => a.index - b.index), [periods]);

  const update = (index: number, patch: Partial<PeriodTime>): void => {
    onChange(periods.map((item) => (item.index === index ? { ...item, ...patch } : item)));
  };

  const append = (): void => {
    const maxIndex = periods.reduce((acc, item) => Math.max(acc, item.index), 0);
    const last = sorted[sorted.length - 1];
    const start = last ? addMinutes(last.end, 10) : '08:00';
    onChange([...periods, { index: maxIndex + 1, start, end: addMinutes(start, 40) }]);
  };

  const remove = (index: number): void => {
    if (periods.length <= 1) return;
    onChange(periods.filter((item) => item.index !== index));
  };

  return (
    <div className={accent ? 'period-editor is-accent' : 'period-editor'}>
      <div className="period-editor__head">
        <div>
          <h3 className="period-editor__title">{title}</h3>
          {description && <p className="field__hint">{description}</p>}
        </div>
        <Button size="sm" variant="secondary" leadingIcon="plus" onClick={append}>
          添加一节
        </Button>
      </div>

      <div className="period-editor__list">
        {sorted.map((period) => (
          <div className="period-row" key={period.index}>
            <span className="period-row__label">第 {period.index} 节</span>
            <Input
              type="time"
              value={period.start}
              aria-label={`第 ${period.index} 节开始时间`}
              onChange={(event) => update(period.index, { start: event.target.value })}
            />
            <span className="period-row__sep" aria-hidden="true">
              —
            </span>
            <Input
              type="time"
              value={period.end}
              aria-label={`第 ${period.index} 节结束时间`}
              onChange={(event) => update(period.index, { end: event.target.value })}
            />
            <IconButton
              icon="trash"
              label={`删除第 ${period.index} 节`}
              size="sm"
              disabled={periods.length <= 1}
              onClick={() => remove(period.index)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function addMinutes(time: string, minutes: number): string {
  const [hour, minute] = time.split(':').map(Number);
  const total = ((hour ?? 0) * 60 + (minute ?? 0) + minutes) % 1440;
  return `${`${Math.floor(total / 60)}`.padStart(2, '0')}:${`${total % 60}`.padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ *
 * 课表预览
 * ------------------------------------------------------------------ */

function PreviewTable({ preview }: { preview: CoursePreview }): ReactElement {
  const grouped = useMemo(() => {
    const map = new Map<number, PreviewSlot[]>();
    for (const slot of preview.slots) {
      const bucket = map.get(slot.weekday);
      if (bucket) bucket.push(slot);
      else map.set(slot.weekday, [slot]);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [preview.slots]);

  return (
    <div className="preview-groups">
      {grouped.map(([weekday, slots]) => (
        <div className="preview-group" key={weekday}>
          <span className="preview-group__title">{slots[0]?.weekdayLabel ?? `星期${weekday}`}</span>
          <ul className="preview-group__list">
            {slots.map((slot) => (
              <li className="preview-item" key={slot.externalKey}>
                <span className="preview-item__time numeric">
                  第 {slot.period} 节 · {formatTime(new Date(slot.firstStartAt))}-
                  {formatTime(new Date(slot.firstEndAt))}
                </span>
                <span className="preview-item__name">{slot.courseName}</span>
                <span className="preview-item__meta">
                  {slot.teacher && <span>{slot.teacher}</span>}
                  {slot.room && <span>{slot.room}</span>}
                </span>
                <span className="preview-item__flags">
                  {slot.willUpdate && <Badge tone="accent">将更新</Badge>}
                  {slot.timeFallback && <Badge tone="warning">时间估算</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

export function CourseSyncPage(): ReactElement {
  const topbar = useShellTopBar({ showFilters: false });
  const status = useCourseSyncStatus();
  const settingsQuery = useCourseSettings();
  const updateSettings = useUpdateCourseSettings();
  const saveCredentials = useSaveCourseCredentials();
  const deleteCredentials = useDeleteCourseCredentials();
  const testLogin = useTestCourseLogin();
  const previewMutation = usePreviewCourses();
  const importMutation = useImportCourses();
  const syncNow = useSyncCoursesNow();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(true);

  const [draft, setDraft] = useState<CourseSyncSettings | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<CoursePreview | null>(null);

  const credentials = status.data?.credentials;
  const lastRun = status.data?.lastRun;

  // 首次拿到服务端设置时填进本地草稿；之后由用户显式保存
  useEffect(() => {
    if (settingsQuery.data && draft === null) setDraft(settingsQuery.data);
  }, [settingsQuery.data, draft]);

  useEffect(() => {
    if (credentials?.username && username.length === 0) setUsername(credentials.username);
  }, [credentials?.username, username.length]);

  const inlineCredentials = useMemo(() => {
    const trimmed = username.trim();
    if (trimmed.length === 0 || password.length === 0) return {};
    return { username: trimmed, password };
  }, [username, password]);

  const dirty = useMemo(() => {
    if (!draft || !settingsQuery.data) return false;
    return JSON.stringify(draft) !== JSON.stringify(settingsQuery.data);
  }, [draft, settingsQuery.data]);

  const sidebar = (
    <>
      <div className="sidebar-card">
        <span className="sidebar-card__title">这是什么</span>
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          从学校课程管理系统（ws8.yucai.sh.cn）读取你的课表，按「每节课的起止时间」换算成日程，
          并写入「课程」分类。重复同步只会更新，不会产生重复条目；课表里消失的课会被自动删除。
        </p>
      </div>
      <div className="sidebar-card">
        <span className="sidebar-card__title">同步状态</span>
        <div className="stack stack--sm">
          <div className="row row--between">
            <span className="muted">已链接课程</span>
            <span className="numeric">{status.data?.linkedCount ?? 0} 条</span>
          </div>
          <div className="row row--between">
            <span className="muted">自动同步</span>
            <span>{settingsQuery.data?.autoSync ? `每 ${settingsQuery.data.syncIntervalHours} 小时` : '已关闭'}</span>
          </div>
          <div className="row row--between">
            <span className="muted">上次同步</span>
            <span>
              {lastRun?.finishedAt ? relativeDayLabel(new Date(lastRun.finishedAt)) : '尚未同步'}
            </span>
          </div>
        </div>
      </div>
      <div className="sidebar-card">
        <span className="sidebar-card__title">安全提示</span>
        <p className="muted" style={{ fontSize: 'var(--text-sm)' }}>
          学校系统本身是 HTTP 明文站点，账号密码在到达学校服务器时不受传输加密保护，这是校方系统的限制。
          InkPane 能保证的是：密码在本机以 AES-256-GCM 密文保存，接口永不回传密码。
        </p>
      </div>
    </>
  );

  if (status.isLoading && !settingsQuery.data) {
    return (
      <AppShell topbar={topbar} sidebar={sidebar}>
        <div className="page">
          <Skeleton height={40} width={220} />
          <Skeleton height={220} radius="var(--radius-surface)" />
          <Skeleton height={220} radius="var(--radius-surface)" />
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell topbar={topbar} sidebar={sidebar}>
      <div className="page">
        <header className="page__header">
          <div className="page__heading">
            <p className="page__eyebrow">Courses · 课表同步</p>
            <h1 className="page__title">课程同步</h1>
            <p className="page__subtitle">
              从学校课程管理系统导入课表，并按你设置的每节课时间生成日程；开启自动同步后无需手动刷新。
            </p>
          </div>
        </header>

        {/* ---------------- 账号 ---------------- */}
        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">学校系统账号</h2>
              <p className="card__description">
                用于登录 ws8.yucai.sh.cn。勾选「保存密码」后以密文写入本机数据库，
                下次可直接点「立即导入」。
              </p>
            </div>
            <Badge tone={credentials?.hasPassword ? 'success' : 'neutral'}>
              {credentials?.hasPassword ? '已保存' : '未保存'}
            </Badge>
          </div>

          <div className="form-grid">
            <Field label="账号（学号）">
              <Input
                value={username}
                autoComplete="username"
                placeholder="例如：20240101"
                onChange={(event) => setUsername(event.target.value)}
              />
            </Field>

            <Field
              label="密码"
              hint={
                credentials?.hasPassword && password.length === 0
                  ? `已保存的密码：${credentials.passwordMask ?? '••••'}（留空表示继续使用）`
                  : '密码只会在加密后保存在本机'
              }
            >
              <div className="row" style={{ gap: 'var(--space-2)' }}>
                <Input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  autoComplete="current-password"
                  placeholder={credentials?.hasPassword ? '留空则使用已保存的密码' : '请输入密码'}
                  onChange={(event) => setPassword(event.target.value)}
                />
                <IconButton
                  icon={showPassword ? 'eye-off' : 'eye'}
                  label={showPassword ? '隐藏密码' : '显示密码'}
                  onClick={() => setShowPassword((value) => !value)}
                />
              </div>
            </Field>
          </div>

          <Switch
            checked={remember}
            onChange={setRemember}
            label="保存密码到本机"
            description="关闭后仅本次会话临时使用，不会写入数据库。"
          />

          <div className="row row--wrap">
            <Button
              variant="secondary"
              leadingIcon="online"
              disabled={username.trim().length === 0 || password.length === 0}
              loading={testLogin.isPending}
              onClick={() => testLogin.mutate({ username: username.trim(), password })}
            >
              测试连接
            </Button>
            <Button
              variant="primary"
              leadingIcon="check"
              disabled={username.trim().length === 0 || password.length === 0}
              loading={saveCredentials.isPending}
              onClick={() =>
                saveCredentials.mutate(
                  { username: username.trim(), password, remember },
                  { onSuccess: () => setPassword('') },
                )
              }
            >
              保存账号
            </Button>
            {credentials?.hasPassword && (
              <Button
                variant="ghost"
                leadingIcon="trash"
                loading={deleteCredentials.isPending}
                style={{ color: 'var(--danger)' }}
                onClick={() => deleteCredentials.mutate()}
              >
                清除已保存账号
              </Button>
            )}
          </div>
        </section>

        {/* ---------------- 导入与自动同步 ---------------- */}
        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">导入与自动同步</h2>
              <p className="card__description">
                开启自动同步后，服务端会按下面的间隔定时重新抓取课表并更新日程。
              </p>
            </div>
          </div>

          <div className="row row--wrap">
            <Button
              variant="secondary"
              leadingIcon="eye"
              loading={previewMutation.isPending}
              onClick={() =>
                previewMutation.mutate(inlineCredentials, {
                  onSuccess: (data) => {
                    setPreview(data);
                    setPreviewOpen(true);
                  },
                })
              }
            >
              预览课表
            </Button>
            <Button
              variant="primary"
              leadingIcon="calendar-plus"
              loading={importMutation.isPending}
              onClick={() => importMutation.mutate(inlineCredentials)}
            >
              立即导入
            </Button>
            <Button
              variant="secondary"
              leadingIcon="refresh-all"
              loading={syncNow.isPending}
              onClick={() => syncNow.mutate()}
            >
              按已保存配置同步
            </Button>
          </div>

          <div className="form-grid">
            <div className="stack">
              <Switch
                checked={settingsQuery.data?.autoSync ?? false}
                disabled={!settingsQuery.data}
                onChange={(checked) => updateSettings.mutate({ autoSync: checked })}
                label="自动同步"
                description="服务端定时重新抓取课表，无需打开页面。"
              />
            </div>

            <Field label="同步间隔" hint="建议 6–24 小时；课表变动不频繁。">
              <Select
                value={String(settingsQuery.data?.syncIntervalHours ?? 6)}
                disabled={!settingsQuery.data}
                onChange={(event) => updateSettings.mutate({ syncIntervalHours: Number(event.target.value) })}
              >
                {[1, 3, 6, 12, 24, 72, 168].map((hours) => (
                  <option key={hours} value={hours}>
                    {hours < 24 ? `每 ${hours} 小时` : `每 ${hours / 24} 天`}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {lastRun && (
            <InlineAlert
              tone={lastRun.status === 'success' ? 'success' : lastRun.status === 'failed' ? 'danger' : 'info'}
              title={
                lastRun.status === 'success'
                  ? '上次同步成功'
                  : lastRun.status === 'failed'
                    ? '上次同步失败'
                    : '正在同步'
              }
            >
              {lastRun.message || '—'}
              {lastRun.finishedAt && (
                <span className="faint"> （{new Date(lastRun.finishedAt).toLocaleString('zh-CN')}）</span>
              )}
            </InlineAlert>
          )}
        </section>

        {/* ---------------- 上课时间 ---------------- */}
        <section className="card">
          <div className="card__header">
            <div>
              <h2 className="card__title">上课时间</h2>
              <p className="card__description">
                学校系统只提供「第几节」，不提供具体时间，因此需要在这里配置。
                勾选「周五单独时间」后，周五会使用下面那一整套独立时间表。
              </p>
            </div>
          </div>

          {!draft ? (
            <Skeleton height={200} radius="var(--radius-surface)" />
          ) : (
            <>
              <div className="form-grid">
                <Field
                  label="本学期第一周周一"
                  hint="用于定位每节课落在哪一天；学校系统只给当周日期，无法得知学程第一周。"
                >
                  <Input
                    type="date"
                    value={draft.termStartDate ?? ''}
                    onChange={(event) =>
                      setDraft({ ...draft, termStartDate: event.target.value === '' ? null : event.target.value })
                    }
                  />
                </Field>
                <Field label="总周数" hint="决定重复日程在哪一周结束。">
                  <Input
                    type="number"
                    min={1}
                    max={30}
                    value={draft.totalWeeks}
                    onChange={(event) => setDraft({ ...draft, totalWeeks: Number(event.target.value) })}
                  />
                </Field>
              </div>

              <div className="form-grid">
                <Switch
                  checked={draft.includeTeacher}
                  onChange={(checked) => setDraft({ ...draft, includeTeacher: checked })}
                  label="写入教师姓名"
                  description="同步到日程备注里。"
                />
                <Switch
                  checked={draft.includeRoom}
                  onChange={(checked) => setDraft({ ...draft, includeRoom: checked })}
                  label="写入教室"
                  description="同步到日程地点里。"
                />
              </div>

              <Switch
                checked={draft.fridaySeparate}
                onChange={(checked) => setDraft({ ...draft, fridaySeparate: checked })}
                label="周五使用单独时间"
                description="例如周五提前放学或作息不同时勾选。"
              />

              <PeriodEditor
                title="周一至周四、周六、周日"
                description="这些天共用的每节课起止时间。"
                periods={draft.periods}
                onChange={(periods) => setDraft({ ...draft, periods })}
              />

              {draft.fridaySeparate && (
                <PeriodEditor
                  accent
                  title="周五"
                  description="周五专用的每节课起止时间，与上面互不影响。"
                  periods={draft.fridayPeriods}
                  onChange={(periods) => setDraft({ ...draft, fridayPeriods: periods })}
                />
              )}

              <div className="row row--between">
                <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>
                  {dirty ? '有未保存的修改' : '所有修改已保存'}
                </span>
                <div className="row">
                  <Button
                    variant="ghost"
                    disabled={!dirty}
                    onClick={() => setDraft(settingsQuery.data ?? draft)}
                  >
                    撤销
                  </Button>
                  <Button
                    variant="primary"
                    leadingIcon="check"
                    disabled={!dirty}
                    loading={updateSettings.isPending}
                    onClick={() => updateSettings.mutate(draft)}
                  >
                    保存时间设置
                  </Button>
                </div>
              </div>
            </>
          )}
        </section>

        <p className="faint" style={{ fontSize: 'var(--text-xs)' }}>
          导入的课程会出现在「课程」分类下。想调整某次课的时间，可以直接在日历里拖动，
          那属于「仅此一次」的改动，下次同步不会覆盖。
          前往 <Link to="/calendar/week">周视图</Link> 查看课表。
        </p>
      </div>

      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="课表预览"
        description={preview?.termName ? `${preview.termName} · 共 ${preview.slots.length} 个条目` : undefined}
        size="lg"
        footer={
          <>
            <Button onClick={() => setPreviewOpen(false)}>关闭</Button>
            <Button
              variant="primary"
              leadingIcon="calendar-plus"
              loading={importMutation.isPending}
              onClick={() =>
                importMutation.mutate(inlineCredentials, { onSuccess: () => setPreviewOpen(false) })
              }
            >
              按此导入
            </Button>
          </>
        }
      >
        {preview && (
          <div className="stack stack--lg">
            {preview.warnings.map((warning) => (
              <InlineAlert key={warning} tone="warning" title="需要注意">
                {warning}
              </InlineAlert>
            ))}

            <div className="row row--wrap">
              <Badge tone="neutral" icon="calendar-check">
                学期起始 {preview.termStartDate}
              </Badge>
              <Badge tone="neutral" icon="rows">
                共 {preview.totalWeeks} 周
              </Badge>
              <Badge tone="neutral" icon="clock">
                节次 {preview.periodNumbers.join('、')}
              </Badge>
              <Badge tone="accent" icon="plus">
                新建 {preview.slots.filter((slot) => !slot.willUpdate).length}
              </Badge>
              <Badge tone="info" icon="refresh">
                更新 {preview.slots.filter((slot) => slot.willUpdate).length}
              </Badge>
            </div>

            <PreviewTable preview={preview} />

            <InlineAlert tone="info" title="导入后会怎样">
              每个条目会生成一条每周重复的日程，从学期第一周对应那天开始，到第 {preview.totalWeeks} 周结束。
              课程内容写入标题，教室写入地点，教师写入备注。
            </InlineAlert>
          </div>
        )}
      </Modal>
    </AppShell>
  );
}
