/** 筛选面板：关键词、分类、优先级、状态、标签与已取消显示开关。 */

import { useState, type ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { activeFilterCount, useUiStore } from '@/store/ui-store';
import { useCategories } from '@/api/use-calendar-data';
import { PRIORITY_META, PRIORITY_ORDER, STATUS_META } from '@/lib/constants';
import { Badge, Button, Chip, Field, Input, Modal, Switch } from '@/components/ui';
import type { EventStatus, Priority } from '@/types';

export interface FilterDialogProps {
  open: boolean;
  onClose: () => void;
}

export function FilterDialog({ open, onClose }: FilterDialogProps): ReactElement {
  const filters = useUiStore((state) => state.filters);
  const patchFilters = useUiStore((state) => state.patchFilters);
  const toggleFilterValue = useUiStore((state) => state.toggleFilterValue);
  const resetFilters = useUiStore((state) => state.resetFilters);
  const { data: categories } = useCategories();
  const [tagDraft, setTagDraft] = useState('');

  const count = activeFilterCount(filters);

  const addTag = (): void => {
    const value = tagDraft.trim();
    if (value.length === 0 || filters.tags.includes(value)) {
      setTagDraft('');
      return;
    }
    patchFilters({ tags: [...filters.tags, value] });
    setTagDraft('');
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="筛选日程"
      description="筛选条件会同时作用于日历视图、列表视图与侧栏统计。"
      size="md"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={resetFilters}
            disabled={count === 0}
            style={{ marginRight: 'auto' }}
          >
            清空全部
          </Button>
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        </>
      }
    >
      <div className="stack stack--lg">
        <Field label="关键词" hint="匹配标题、地点、备注与标签。">
          <Input
            type="search"
            value={filters.q}
            placeholder="输入关键词"
            onChange={(event) => patchFilters({ q: event.target.value })}
          />
        </Field>

        <div className="stack stack--sm">
          <span className="field__label">分类</span>
          <div className="row row--wrap">
            {(categories ?? []).map((category) => {
              const selected = filters.categoryIds.includes(category.id);
              return (
                <Chip
                  key={category.id}
                  color={category.color}
                  selected={selected}
                  onClick={() => toggleFilterValue('categoryIds', category.id)}
                >
                  {category.name}
                </Chip>
              );
            })}
            {(categories ?? []).length === 0 && (
              <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>
                还没有分类可供筛选。
              </span>
            )}
          </div>
        </div>

        <div className="stack stack--sm">
          <span className="field__label">优先级</span>
          <div className="row row--wrap">
            {PRIORITY_ORDER.map((priority: Priority) => {
              const selected = filters.priorities.includes(priority);
              return (
                <Chip
                  key={priority}
                  selected={selected}
                  onClick={() => toggleFilterValue('priorities', priority)}
                >
                  {PRIORITY_META[priority].label}
                </Chip>
              );
            })}
          </div>
        </div>

        <div className="stack stack--sm">
          <span className="field__label">状态</span>
          <div className="row row--wrap">
            {(['confirmed', 'tentative', 'cancelled'] as EventStatus[]).map((status) => (
              <Chip
                key={status}
                selected={filters.statuses.includes(status)}
                onClick={() => toggleFilterValue('statuses', status)}
              >
                {STATUS_META[status].label}
              </Chip>
            ))}
          </div>
        </div>

        <Field label="标签" hint="回车添加，多个标签之间是「或」的关系。">
          <div className="tag-input">
            <Input
              value={tagDraft}
              placeholder="例如：客户"
              maxLength={30}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addTag();
                }
              }}
            />
            <Button onClick={addTag} disabled={tagDraft.trim().length === 0}>
              添加
            </Button>
          </div>
          {filters.tags.length > 0 && (
            <div className="tag-list">
              {filters.tags.map((tag) => (
                <Chip
                  key={tag}
                  onRemove={() => patchFilters({ tags: filters.tags.filter((item) => item !== tag) })}
                >
                  {tag}
                </Chip>
              ))}
            </div>
          )}
        </Field>

        <Switch
          checked={filters.includeCancelled}
          onChange={(checked) => patchFilters({ includeCancelled: checked })}
          label="显示已取消的日程"
          description="默认隐藏状态为「已取消」的实例，避免干扰排期。"
        />

        <div className={cn('row', 'row--between')}>
          <span className="faint" style={{ fontSize: 'var(--text-sm)' }}>
            当前生效的筛选条件
          </span>
          <Badge tone={count > 0 ? 'accent' : 'neutral'}>{count} 项</Badge>
        </div>
      </div>
    </Modal>
  );
}
