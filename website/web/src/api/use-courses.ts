/** 课程同步的数据访问 hooks。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from '@/lib/api';
import { toast } from '@/store/ui-store';
import type { CourseSyncSettings } from '@/types';

const keys = {
  status: ['courses', 'status'] as const,
  settings: ['courses', 'settings'] as const,
};

function describe(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

export function useCourseSyncStatus() {
  return useQuery({
    queryKey: keys.status,
    queryFn: ({ signal }) => api.courseStatus(signal),
    refetchOnWindowFocus: true,
    staleTime: 10_000,
  });
}

export function useCourseSettings() {
  return useQuery({
    queryKey: keys.settings,
    queryFn: ({ signal }) => api.courseSettings(signal),
    staleTime: 30_000,
  });
}

/** 设置保存成功后就地更新缓存，界面不必等一次额外请求。 */
export function useUpdateCourseSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<CourseSyncSettings>) => api.updateCourseSettings(patch),
    onSuccess: (data) => {
      client.setQueryData(keys.settings, data);
      void client.invalidateQueries({ queryKey: keys.status });
    },
    onError: (error) => toast.error('保存设置失败', { description: describe(error) }),
  });
}

export function useSaveCourseCredentials() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: { username: string; password: string; remember: boolean }) =>
      api.saveCourseCredentials(payload),
    onSuccess: () => {
      toast.success('账号已保存', '密码以密文形式保存在本机，不会再回传');
      void client.invalidateQueries({ queryKey: keys.status });
    },
    onError: (error) => toast.error('保存账号失败', { description: describe(error) }),
  });
}

export function useDeleteCourseCredentials() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.deleteCourseCredentials(),
    onSuccess: () => {
      toast.info('已清除保存的账号密码');
      void client.invalidateQueries({ queryKey: keys.status });
    },
    onError: (error) => toast.error('清除失败', { description: describe(error) }),
  });
}

export function useTestCourseLogin() {
  return useMutation({
    mutationFn: (payload: { username: string; password: string }) => api.testCourseLogin(payload),
    onSuccess: () => toast.success('连接成功', '学校系统接受了这组账号密码'),
    onError: (error) => toast.error('连接失败', { description: describe(error) }),
  });
}

export function usePreviewCourses() {
  return useMutation({
    mutationFn: (payload: { username?: string; password?: string }) => api.previewCourses(payload),
    onError: (error) => toast.error('获取课表失败', { description: describe(error) }),
  });
}

export function useImportCourses() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: { username?: string; password?: string }) => api.importCourses(payload),
    onSuccess: (result) => {
      toast.success('课程导入完成', `新建 ${result.created}、更新 ${result.updated}、删除 ${result.removed}`);
      void client.invalidateQueries({ queryKey: ['occurrences'] });
      void client.invalidateQueries({ queryKey: ['summary'] });
      void client.invalidateQueries({ queryKey: ['events'] });
      void client.invalidateQueries({ queryKey: ['categories'] });
      void client.invalidateQueries({ queryKey: keys.status });
    },
    onError: (error) => toast.error('课程导入失败', { description: describe(error) }),
  });
}

export function useSyncCoursesNow() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.syncCoursesNow(),
    onSuccess: (result) => {
      toast.success('同步完成', `新建 ${result.created}、更新 ${result.updated}、删除 ${result.removed}`);
      void client.invalidateQueries({ queryKey: ['occurrences'] });
      void client.invalidateQueries({ queryKey: ['summary'] });
      void client.invalidateQueries({ queryKey: ['events'] });
      void client.invalidateQueries({ queryKey: keys.status });
    },
    onError: (error) => toast.error('同步失败', { description: describe(error) }),
  });
}
