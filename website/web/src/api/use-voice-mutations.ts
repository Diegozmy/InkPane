/** 语音助手设置的写入 hook。 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './query-keys';
import type { VoiceSettings } from '@/types';

/**
 * 保存语音设置。
 *
 * voice 计入设备屏幕的 ETag，因此成功后同时失效 `['display']`（含屏幕预览），
 * 让「屏幕预览」上的徽标/数据与最新设置保持一致。
 */
export function useUpdateVoiceSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: Partial<VoiceSettings>) => api.updateVoice(payload),
    onSuccess: (settings) => {
      client.setQueryData(queryKeys.voice, settings);
      void client.invalidateQueries({ queryKey: ['display'] });
    },
  });
}
