/** 顶层错误边界：任何渲染期异常都给出可操作页面，而不是白屏。 */

import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留到控制台，便于排查；生产环境可替换为上报服务
    console.error('界面渲染失败', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="state-block" role="alert" style={{ minHeight: '100dvh' }}>
        <h1 className="state-block__title">界面出现异常</h1>
        <p className="state-block__description">
          这是前端渲染错误，日程数据本身没有受到影响。刷新页面通常可以恢复。
        </p>
        <code className="state-block__detail">{error.message}</code>
        <div className="state-block__action">
          <button type="button" className="btn btn--primary btn--md" onClick={() => window.location.reload()}>
            <span className="btn__label">刷新页面</span>
          </button>
        </div>
      </div>
    ) as ReactElement;
  }
}
