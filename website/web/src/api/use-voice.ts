/** 语音助手设置的读取 hook（React Query）。 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './query-keys';
import type { VoiceSettings } from '@/types';

export function useVoiceSettings() {
  return useQuery<VoiceSettings>({
    queryKey: queryKeys.voice,
    queryFn: ({ signal }) => api.voiceSettings(signal),
    staleTime: 60_000,
  });
}
