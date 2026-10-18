import { useEffect, useState } from 'react';
import { useUiStore, type ThemeMode } from '@/store/ui-store';

const STORAGE_KEY = 'inkpane.theme';

/** 主题：system 跟随系统，显式选择则落盘，供 index.html 的首屏脚本读取。 */
export function useTheme(): { theme: ThemeMode; setTheme: (mode: ThemeMode) => void; resolved: 'light' | 'dark' } {
  const theme = useUiStore((state) => state.theme);
  const setTheme = useUiStore((state) => state.setTheme);
  const setResolvedTheme = useUiStore((state) => state.setResolvedTheme);
  const [resolved, setResolved] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light',
  );

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = (): void => {
      const next: 'light' | 'dark' = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset['theme'] = next;
      document.documentElement.style.colorScheme = next;
      setResolved(next);
      setResolvedTheme(next);
      try {
        if (theme === 'system') window.localStorage.removeItem(STORAGE_KEY);
        else window.localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // localStorage 不可用时忽略
      }
    };

    apply();

    if (theme !== 'system') return undefined;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme, setResolvedTheme]);

  return { theme, setTheme, resolved };
}

/** 响应式断点查询。 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(query);
    const handler = (event: MediaQueryListEvent): void => setMatches(event.matches);
    setMatches(media.matches);
    media.addEventListener('change', handler);
    return () => media.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

export function useIsCompact(): boolean {
  return useMediaQuery('(max-width: 900px)');
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery('(prefers-reduced-motion: reduce)');
}
