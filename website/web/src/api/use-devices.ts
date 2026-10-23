/** 设备管理 hooks。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './query-keys';

export function useDevices(enabled = true) {
  return useQuery({
    queryKey: queryKeys.devices,
    queryFn: ({ signal }) => api.listDevices(signal),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useCreateDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.createDevice({ name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices });
    },
  });
}

export function useRenameDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { id: number; name: string }) =>
      api.renameDevice(payload.id, { name: payload.name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices });
    },
  });
}

export function useRotateDeviceToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.rotateDeviceToken(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices });
    },
  });
}

export function useDeleteDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteDevice(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.devices });
    },
  });
}
