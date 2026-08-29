import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useApp } from './lib/app-state';
import { AuthPage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { SendPage } from './pages/Send';
import { RequestsPage } from './pages/Requests';
import { HistoryPage } from './pages/History';
import { SplitsPage } from './pages/Splits';
import { SchedulesPage } from './pages/Schedules';
import { EngineeringPage } from './pages/Engineering';
import { Spinner } from './components/ui';

const LINKS = [
  { to: '/', label: 'Overview', end: true },
  { to: '/send', label: 'Send' },
  { to: '/requests', label: 'Requests' },
  { to: '/splits', label: 'Split a bill' },
  { to: '/schedules', label: 'Scheduled' },
  { to: '/history', label: 'Transactions' },
  { to: '/engineering', label: 'Engineering' },
];

export default function App() {
  const { user, loading, signOut } = useApp();

  if (loading) {
    return (
      <div className="auth">
        <Spinner />
      </div>
    );
  }

  if (!user) return <AuthPage />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">৳</span> TakaFlow
        </div>

        <nav className="nav">
          {LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end}>
              {link.label}
            </NavLink>
          ))}
        </nav>

        <div className="spacer" />

        <div style={{ padding: '0 8px' }}>
          <div className="title">{user.name}</div>
          <div className="sub mono">{user.phone}</div>
          <button className="ghost small" style={{ marginTop: 10 }} onClick={signOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/send" element={<SendPage />} />
          <Route path="/requests" element={<RequestsPage />} />
          <Route path="/splits" element={<SplitsPage />} />
          <Route path="/schedules" element={<SchedulesPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/engineering" element={<EngineeringPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
