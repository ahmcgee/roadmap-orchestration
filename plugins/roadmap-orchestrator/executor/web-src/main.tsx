import { createRoot } from 'react-dom/client';
import { Component, type ReactNode } from 'react';
import { App } from './app/app.tsx';
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  override render() { return this.state.error ? <main><h1>Roadmap</h1><p role="alert">Console rendering failed: {this.state.error.message}</p></main> : this.props.children; }
}
createRoot(document.getElementById('root')!).render(<ErrorBoundary><App/></ErrorBoundary>);
