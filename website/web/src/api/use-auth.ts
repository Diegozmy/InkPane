/** 账户相关 hooks：初始化状态、当前用户、登录/退出/改密。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { queryKeys } from './query-keys';
import type { AuthSession } from '@/types';

export function useSetupStatus() {
  return useQuery({
    queryKey: queryKeys.setupStatus,
    queryFn: ({ signal }) => api.setupStatus(signal),
    staleTime: 10_000,
    retry: 0,
  });
}

export function useMe(enabled = true) {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => api.me(signal),
    enabled,
    staleTime: 30_000,
    retry: 0,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { username: string; password: string }) => api.login(payload),
    onSuccess: (session: AuthSession) => {
      queryClient.setQueryData(queryKeys.me, session);
      queryClient.setQueryData(queryKeys.setupStatus, { required: false });
    },
  });
}

export function useSetup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      username: string;
      password: string;
      displayName?: string;
      timezone?: string;
      code?: string;
    }) => api.setup(payload),
    onSuccess: (session: AuthSession) => {
      queryClient.setQueryData(queryKeys.me, session);
      queryClient.setQueryData(queryKeys.setupStatus, { required: false });
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(queryKeys.setupStatus, { required: false });
    },
  });
}

export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (displayName: string) => api.updateProfile({ displayName }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (payload: { currentPassword: string; newPassword: string }) =>
      api.changePassword(payload),
  });
}
