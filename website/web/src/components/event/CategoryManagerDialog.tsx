/** 分类管理：新建、改名、改色、删除。删除后相关日程变为「未分类」而不是被删除。 */

import { useEffect, useState, type ReactElement } from 'react';
import { cn } from '@/lib/cn';
import { useCategories } from '@/api/use-calendar-data';
import {
  useCreateCategory,
  useDeleteCategory,
  useUpdateCategory,
} from '@/api/use-calendar-mutations';
import { PRESET_COLORS } from '@/lib/constants';
import {
  Button,
  ConfirmDialog,
  IconButton,
  InlineAlert,
  Input,
  Modal,
  Skeleton,
} from '@/components/ui';
import type { Category } from '@/types';

export interface CategoryManagerDialogProps {
  open: boolean;
  onClose: () => void;
}

function CategoryRow({
  category,
  onDelete,
}: {
  category: Category;
  onDelete: (category: Category) => void;
}): ReactElement {
  const updateCategory = useUpdateCategory();
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState(category.color);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setName(category.name);
    setColor(category.color);
  }, [category.name, category.color]);

  const dirty = name.trim() !== category.name || color !== category.color;

  return (
    <div className="category-editor">
      <div className="category-editor__row">
        <button
          type="button"
          className="category-editor__swatch"
          style={{ ['--category-color' as string]: color }}
          aria-label="切换色板"
          onClick={() => setExpanded((value) => !value)}
        />
        <Input
          value={name}
          maxLength={30}
          aria-label={`分类名称：${category.name}`}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          className="input--color-hex"
          value={color}
          aria-label="颜色值"
          onChange={(event) => setColor(event.target.value)}
        />
        <div className="row">
          <IconButton
            icon="check"
            label="保存修改"
            size="sm"
            disabled={!dirty || name.trim().length === 0}
            onClick={() =>
              updateCategory.mutate({ id: category.id, payload: { name: name.trim(), color } })
            }
          />
          <IconButton
            icon="trash"
            label={`删除分类 ${category.name}`}
            size="sm"
            onClick={() => onDelete(category)}
          />
        </div>
      </div>

      {expanded && (
        <div className="color-picker" style={{ paddingLeft: 34 }}>
          {PRESET_COLORS.map((preset) => (
            <button
              key={preset}
              type="button"
              className={cn('color-picker__swatch', color === preset && 'is-selected')}
              style={{ background: preset, ['--color-value' as string]: preset }}
              aria-label={`使用颜色 ${preset}`}
              onClick={() => setColor(preset)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function CategoryManagerDialog({ open, onClose }: CategoryManagerDialogProps): ReactElement {
  const { data: categories, isLoading } = useCategories();
  const createCategory = useCreateCategory();
  const deleteCategory = useDeleteCategory();

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<string>(PRESET_COLORS[0] ?? '#3b6fd4');
  const [pendingDelete, setPendingDelete] = useState<Category | null>(null);

  useEffect(() => {
    if (!open) {
      setNewName('');
      setPendingDelete(null);
    }
  }, [open]);

  const handleCreate = (): void => {
    const name = newName.trim();
    if (name.length === 0) return;
    createCategory.mutate({ name, color: newColor }, { onSuccess: () => setNewName('') });
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title="管理分类"
        description="分类用于给日程分组并决定默认配色。"
        size="md"
        footer={
          <Button variant="primary" onClick={onClose}>
            完成
          </Button>
        }
      >
        <div className="stack stack--lg">
          <div className="stack stack--sm">
            <span className="section-title">新建分类</span>
            <div className="category-editor__row">
              <button
                type="button"
                className="category-editor__swatch"
                style={{ ['--category-color' as string]: newColor }}
                aria-label="当前颜色"
                onClick={() => {
                  const index = PRESET_COLORS.indexOf(newColor);
                  setNewColor(PRESET_COLORS[(index + 1) % PRESET_COLORS.length] ?? newColor);
                }}
              />
              <Input
                value={newName}
                maxLength={30}
                placeholder="分类名称，例如：客户会议"
                aria-label="新分类名称"
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleCreate();
                  }
                }}
              />
              <Input
                className="input--color-hex"
                value={newColor}
                aria-label="新分类颜色"
                onChange={(event) => setNewColor(event.target.value)}
              />
              <Button
                variant="secondary"
                leadingIcon="plus"
                disabled={newName.trim().length === 0}
                loading={createCategory.isPending}
                onClick={handleCreate}
              >
                添加
              </Button>
            </div>
            <div className="color-picker" style={{ paddingLeft: 34 }}>
              {PRESET_COLORS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={cn('color-picker__swatch', newColor === preset && 'is-selected')}
                  style={{ background: preset, ['--color-value' as string]: preset }}
                  aria-label={`选择颜色 ${preset}`}
                  onClick={() => setNewColor(preset)}
                />
              ))}
            </div>
          </div>

          <div className="stack stack--sm">
            <span className="section-title">已有分类</span>
            {isLoading ? (
              <div className="stack stack--sm">
                <Skeleton height={36} radius="var(--radius-control)" />
                <Skeleton height={36} radius="var(--radius-control)" />
              </div>
            ) : (categories ?? []).length === 0 ? (
              <InlineAlert tone="info" title="还没有分类">
                先创建一个分类，之后新建日程就能按颜色区分了。
              </InlineAlert>
            ) : (
              (categories ?? []).map((category) => (
                <CategoryRow key={category.id} category={category} onDelete={setPendingDelete} />
              ))
            )}
          </div>

          <InlineAlert tone="info" title="删除分类会怎样">
            分类被删除后，原先属于它的日程会保留，并变为「未分类」，不会连带删除任何日程。
          </InlineAlert>
        </div>
      </Modal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除分类"
        tone="danger"
        confirmLabel="删除"
        busy={deleteCategory.isPending}
        message={
          <>
            确定删除分类 <strong>{pendingDelete?.name}</strong> 吗？该分类下的日程会变为「未分类」。
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          deleteCategory.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
        }}
      />
    </>
  );
}
