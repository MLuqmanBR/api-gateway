import { useEffect, useState, Suspense, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Menu, Moon, Sun, Loader2, Boxes, TerminalSquare, KeyRound, BarChart3 } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AuthGate } from '@/components/auth-gate'
import { ErrorBoundary } from '@/components/error-boundary'

const KeysPage = lazy(() => import('@/pages/KeysPage'))
const PlaygroundPage = lazy(() => import('@/pages/PlaygroundPage'))
const FallbackPage = lazy(() => import('@/pages/FallbackPage'))
const EmbeddingsPage = lazy(() => import('@/pages/EmbeddingsPage'))
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'))

const queryClient = new QueryClient()

const navItems = [
  { to: '/models', label: 'Models', icon: Boxes },
  { to: '/playground', label: 'Playground', icon: TerminalSquare },
  { to: '/keys', label: 'Keys', icon: KeyRound },
  { to: '/analytics', label: 'Analytics', icon: BarChart3 },
]

function getPreferredDarkMode() {
  if (typeof window === 'undefined') {
    return false
  }

  const stored = localStorage.getItem('theme')
  return stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

function useDarkMode() {
  const [dark, setDark] = useState(getPreferredDarkMode)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  function toggle() {
    setDark((current) => {
      const next = !current
      localStorage.setItem('theme', next ? 'dark' : 'light')
      return next
    })
  }

  return { dark, toggle }
}

// True when the dashboard runs inside the desktop shell (Electron preload
// sets this). The sidebar then doubles as the window title bar: draggable,
// padded for the macOS traffic lights, and the page background is glass.
// Set by the desktop app's preload script (desktop/src/preload.ts).
interface ApiGatewayWindow { __API_GATEWAY_DESKTOP__?: boolean }
const isDesktopApp = typeof window !== 'undefined'
  && (window as ApiGatewayWindow).__API_GATEWAY_DESKTOP__ === true

// The preload's own early classList.add can be lost (it may run before this
// document exists), so the client claims the class itself at module load —
// before the first React paint — keeping html.desktop CSS (transparent body,
// glass backdrop) reliable.
if (isDesktopApp) {
  document.documentElement.classList.add('desktop')
}

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  )
}

function Sidebar() {
  const { dark, toggle } = useDarkMode()

  return (
    <aside
      className={`hidden md:flex md:flex-col md:w-56 lg:w-60 border-r bg-card/50 shrink-0 ${isDesktopApp ? 'pt-0' : ''}`}
      style={isDesktopApp ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
    >
      <div className={`flex items-center gap-2.5 px-5 ${isDesktopApp ? 'h-13 pl-20' : 'h-14'}`}>
        <span className="inline-block size-2 rounded-full bg-primary" />
        <Link to="/" className="font-semibold tracking-tight text-sm transition-opacity hover:opacity-70">
          API-Gateway
        </Link>
      </div>

      <nav
        className="flex-1 flex flex-col gap-0.5 px-3 mt-2"
        style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
      >
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-colors ${
                isActive
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted'
              }`
            }
          >
            <item.icon className="size-4 shrink-0" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div
        className="px-3 pb-4"
        style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
      >
        <button
          onClick={toggle}
          className="flex items-center gap-3 w-full px-3 py-2 rounded-xl text-sm text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          {dark ? 'Light mode' : 'Dark mode'}
        </button>
      </div>
    </aside>
  )
}

function MobileHeader() {
  const { dark, toggle } = useDarkMode()
  const location = useLocation()
  const navigate = useNavigate()

  return (
    <header
      className={`sticky top-0 z-40 border-b backdrop-blur md:hidden ${isDesktopApp ? 'bg-background/45' : 'bg-background/80'}`}
      style={isDesktopApp ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
    >
      <div
        className={`flex items-center px-4 h-12 ${isDesktopApp ? 'pl-16' : ''}`}
        style={isDesktopApp ? { minHeight: 48 } : undefined}
      >
        <span className="inline-block size-2 rounded-full bg-primary" />
        <Link to="/" className="ml-2 font-semibold tracking-tight text-sm">
          API-Gateway
        </Link>

        <div className="ml-auto">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              aria-label="Open navigation menu"
            >
              <Menu />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuGroup>
                {navItems.map((item) => (
                  <DropdownMenuItem
                    key={item.to}
                    onClick={() => navigate(item.to)}
                    className={location.pathname.startsWith(item.to) ? 'bg-accent text-accent-foreground font-medium' : undefined}
                  >
                    <item.icon className="size-4 mr-2" />
                    {item.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={toggle} className="justify-between">
                  <span>{dark ? 'Light mode' : 'Dark mode'}</span>
                  {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthGate>
          <div className={`min-h-screen flex ${isDesktopApp ? 'desktop-backdrop' : 'bg-background'}`}>
            <Sidebar />
            <div className="flex-1 flex flex-col min-w-0">
              <MobileHeader />
              <main className="flex-1 px-5 py-6 sm:px-8 sm:py-8 max-w-5xl w-full">
                <Suspense fallback={<PageLoader />}>
                  <ErrorBoundary>
                    <Routes>
                      <Route path="/" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/models" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/models/chat" element={<FallbackPage />} />
                      <Route path="/models/embeddings" element={<EmbeddingsPage />} />
                      <Route path="/playground" element={<PlaygroundPage />} />
                      <Route path="/keys" element={<KeysPage />} />
                      <Route path="/fallback" element={<Navigate to="/models/chat" replace />} />
                      <Route path="/analytics" element={<AnalyticsPage />} />
                      <Route path="/test" element={<Navigate to="/playground" replace />} />
                      <Route path="/health" element={<Navigate to="/keys" replace />} />
                    </Routes>
                  </ErrorBoundary>
                </Suspense>
              </main>
            </div>
          </div>
        </AuthGate>
      </BrowserRouter>
    </QueryClientProvider>
  )
}

export default App
