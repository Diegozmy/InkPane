import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { EventDetailPanel } from '@/components/event/EventDetailPanel';
import { EventDialog } from '@/components/event/EventDialog';
import { ToastHost } from '@/components/ui';
import { useReminderScheduler } from '@/hooks/use-reminders';
import { useTheme } from '@/hooks/use-theme';
import { AgendaPage } from '@/views/AgendaPage';
import { CalendarPage } from '@/views/CalendarPage';
import { CourseSyncPage } from '@/views/CourseSyncPage';
import { DashboardPage } from '@/views/DashboardPage';
import { DevicePage } from '@/views/DevicePage';
import { SettingsPage } from '@/views/SettingsPage';
import { TodosPage } from '@/views/TodosPage';
import { WeatherPage } from '@/views/WeatherPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
      // 本地服务响应很快，不需要额外重试延迟
      retryDelay: 400,
    },
    mutations: {
      retry: 0,
    },
  },
});

/** 应用内的全局副作用：主题应用、提醒轮询、弹窗与提示挂载。 */
function AppRuntime() {
  useTheme();
  useReminderScheduler();

  return (
    <>
      <Routes>
        <Route path="/" element={<Navigate to="/today" replace />} />
        <Route path="/today" element={<DashboardPage />} />
        <Route path="/calendar" element={<Navigate to="/calendar/month" replace />} />
        <Route path="/calendar/:view" element={<CalendarPage />} />
        <Route path="/agenda" element={<AgendaPage />} />
        <Route path="/todos" element={<TodosPage />} />
        <Route path="/weather" element={<WeatherPage />} />
        <Route path="/device" element={<DevicePage />} />
        <Route path="/courses" element={<CourseSyncPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/today" replace />} />
      </Routes>

      {/* 全局浮层：日程编辑、详情面板与轻提示 */}
      <EventDialog />
      <EventDetailPanel />
      <ToastHost />
    </>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppRuntime />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
