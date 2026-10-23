/** 管理员用户管理 hooks。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './query-keys';
import type { UserRole } from '@/types';

export function useUsers(enabled = true) {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => api.listUsers(signal),
    enabled,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      username: string;
      password: string;
      displayName?: string;
      role?: UserRole;
      timezone?: string;
    }) => api.createUser(payload),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      id: number;
      displayName?: string;
      role?: UserRole;
      status?: 'active' | 'disabled';
    }) => {
      const { id, ...patch } = payload;
      return api.updateUser(id, patch);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users });
    },
  });
}

export function useResetUserPassword() {
  return useMutation({
    mutationFn: (payload: { id: number; password: string }) =>
      api.resetUserPassword(payload.id, payload.password),
  });
}
