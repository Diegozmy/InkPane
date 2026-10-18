/** 删除日程时的范围选择：只有重复日程才需要用户做决定。 */

import { useEffect, useState, type ReactElement } from 'react';
import { formatDayLabel, parseOccurrenceStart } from '@/lib/date';
import { Icon } from '@/components/ui/icon';
import { Button, Modal, SegmentedControl } from '@/components/ui';
import type { Occurrence } from '@/types';

export type DeleteScope = 'single' | 'future' | 'series';

export interface EventDeleteDialogProps {
  open: boolean;
  occurrence: Occurrence;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (choice: { scope: DeleteScope; occurrenceKey: string }) => void;
}

export function EventDeleteDialog({
  open,
  occurrence,
  busy,
  onCancel,
  onConfirm,
}: EventDeleteDialogProps): ReactElement {
  const [scope, setScope] = useState<DeleteScope>('single');

  // 每次打开都回到最保守的默认值，避免沿用上一次的选择
  useEffect(() => {
    if (open) setScope('single');
  }, [open, occurrence.occurrenceKey]);

  const start = parseOccurrenceStart(occurrence);
  const isRecurring = occurrence.isRecurring;
  const effectiveScope: DeleteScope = isRecurring ? scope : 'series';

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={isRecurring ? '删除重复日程' : '删除日程'}
      size="sm"
      dismissOnBackdrop={false}
      footer={
        <>
          <Button onClick={onCancel} disabled={busy}>
            取消
          </Button>
          <Button
            variant="danger"
            leadingIcon="trash"
            loading={busy}
            onClick={() => onConfirm({ scope: effectiveScope, occurrenceKey: occurrence.occurrenceKey })}
          >
            确认删除
          </Button>
        </>
      }
    >
      <div className="stack">
        <p className="confirm-message">
          即将删除 <strong>{occurrence.title}</strong>
          {!occurrence.allDay && `（${formatDayLabel(start, true)} 起）`}。
        </p>

        {isRecurring ? (
          <div className="stack stack--sm">
            <span className="field__label">删除范围</span>
            <SegmentedControl<DeleteScope>
              value={scope}
              onChange={setScope}
              ariaLabel="删除范围"
              options={[
                { value: 'single', label: '仅此一次' },
                { value: 'future', label: '此后所有' },
                { value: 'series', label: '整条序列' },
              ]}
            />
            <p className="field__hint">
              {scope === 'single'
                ? '只删除当前这一次，其余重复时间保持原样。'
                : scope === 'future'
                  ? '删除本次及之后的所有重复实例，之前的记录保留。'
                  : '删除整条重复序列及其所有实例调整记录。'}
            </p>
          </div>
        ) : (
          <p className="field__hint">
            <Icon name="warning" size={13} /> 该操作不可撤销。
          </p>
        )}
      </div>
    </Modal>
  );
}
