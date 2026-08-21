import { Component, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  // Surface uncaught render errors to the browser console so the user (and
  // any attached devtool / log-shipper) sees the actual error stack instead
  // of just the "Something went wrong" fallback. This is additive — the
  // render path still shows the same UI.
  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    console.error('[ErrorBoundary]', error, info)
  }


  handleReload = () => {
    window.location.reload()
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 py-20">
          <p className="text-lg text-muted-foreground">Something went wrong</p>
          <Button onClick={this.handleReload}>Reload</Button>
        </div>
      )
    }
    return this.props.children
  }
}
