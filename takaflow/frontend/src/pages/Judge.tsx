/**
 * The judge console.
 *
 * One button per claim this system makes. Each runs the scenario against the live API with users
 * it creates on the spot, and prints what the server actually answered — status codes, balances,
 * references — so the demo is evidence rather than narration.
 */
import { useState } from 'react';
import { call, SCENARIOS, type Step } from '../lib/demo';
import { Badge, Card, ErrorBanner, Field, Spinner } from '../components/ui';

type RunState = 'idle' | 'running' | 'ok' | 'fail';

interface Result {
  state: RunState;
  steps: Step[];
  ms: number;
}

const TOKEN_KEY = 'takaflow.operator';

export function JudgePage() {
  const [token, setToken] = useState<string | null>(() => sessionStorage.getItem(TOKEN_KEY));
  const [username, setUsername] = useState('judge');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, Result>>({});
  const [runningAll, setRunningAll] = useState(false);

  const signIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await call<{ token: string }>('/admin/login', {
        method: 'POST',
        body: { username, password },
      });
      if (response.status !== 200) {
        throw new Error(
          (response.body as { error?: { message: string } })?.error?.message ?? 'Sign-in failed',
        );
      }
      // Session storage, not local: the operator token dies with the tab.
      sessionStorage.setItem(TOKEN_KEY, response.body.token);
      setToken(response.body.token);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const runOne = async (id: string): Promise<boolean> => {
    const scenario = SCENARIOS.find((item) => item.id === id)!;
    const steps: Step[] = [];
    const startedAt = Date.now();

    setResults((current) => ({ ...current, [id]: { state: 'running', steps: [], ms: 0 } }));

    const recorder = {
      step: (status: Step['status'], label: string, detail?: string) => {
        steps.push({ status, label, detail });
        setResults((current) => ({
          ...current,
          [id]: { state: 'running', steps: [...steps], ms: Date.now() - startedAt },
        }));
      },
    };

    try {
      await scenario.run(recorder, token ?? '');
    } catch (caught) {
      steps.push({
        status: 'fail',
        label: 'The scenario could not finish',
        detail: caught instanceof Error ? caught.message : String(caught),
      });
    }

    const failed = steps.some((step) => step.status === 'fail');
    setResults((current) => ({
      ...current,
      [id]: { state: failed ? 'fail' : 'ok', steps, ms: Date.now() - startedAt },
    }));
    return !failed;
  };

  const runAll = async () => {
    setRunningAll(true);
    // Sequentially: the scenarios share one database and several of them assert on totals.
    for (const scenario of SCENARIOS) await runOne(scenario.id);
    setRunningAll(false);
  };

  if (!token) {
    return (
      <div className="auth">
        <Card>
          <div style={{ textAlign: 'center', marginBottom: 18 }}>
            <div className="brand" style={{ justifyContent: 'center' }}>
              <span className="brand-mark">৳</span> Judge console
            </div>
            <p className="muted" style={{ margin: '6px 0 0' }}>
              Operator sign-in
            </p>
          </div>

          <ErrorBanner error={error} />

          <form onSubmit={signIn}>
            <Field label="Username">
              <input
                aria-label="Username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
              />
            </Field>
            <Field label="Password">
              <input
                aria-label="Password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <button type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? <Spinner /> : 'Sign in'}
            </button>
          </form>

          <p className="hint" style={{ marginTop: 14 }}>
            These credentials are exchanged for the operator token, which is what the guarded
            endpoints actually check. The token never leaves this tab.
          </p>
        </Card>
      </div>
    );
  }

  const passed = Object.values(results).filter((result) => result.state === 'ok').length;
  const failed = Object.values(results).filter((result) => result.state === 'fail').length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Judge console</h1>
          <p>
            Every button runs the real API with users created on the spot. Nothing here is mocked
            or pre-seeded.
          </p>
        </div>
        <div className="row">
          {(passed > 0 || failed > 0) && (
            <Badge status={failed === 0 ? 'ok' : 'bad'}>
              {passed} passed{failed > 0 ? ` · ${failed} failed` : ''}
            </Badge>
          )}
          <button onClick={runAll} disabled={runningAll}>
            {runningAll ? <Spinner /> : 'Run everything'}
          </button>
          <button
            className="ghost"
            onClick={() => {
              sessionStorage.removeItem(TOKEN_KEY);
              setToken(null);
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="grid" style={{ gap: 14 }}>
        {SCENARIOS.map((scenario) => {
          const result = results[scenario.id];
          return (
            <Card key={scenario.id}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div className="grow" style={{ minWidth: 240 }}>
                  <div className="row" style={{ gap: 8 }}>
                    <h2 style={{ fontSize: '1rem' }}>{scenario.title}</h2>
                    {result?.state === 'ok' && <Badge status="ok">passed · {result.ms}ms</Badge>}
                    {result?.state === 'fail' && <Badge status="bad">failed</Badge>}
                    {result?.state === 'running' && <Spinner />}
                  </div>
                  <div className="hint" style={{ marginTop: 4 }}>
                    {scenario.question}
                  </div>
                </div>

                <button
                  className="secondary"
                  disabled={result?.state === 'running' || runningAll}
                  onClick={() => void runOne(scenario.id)}
                >
                  {result ? 'Run again' : 'Run'}
                </button>
              </div>

              {result && result.steps.length > 0 && (
                <div className="list" style={{ marginTop: 12 }}>
                  {result.steps.map((step, index) => (
                    <div className="item" key={index} style={{ alignItems: 'flex-start' }}>
                      <span
                        className={`badge ${step.status === 'ok' ? 'ok' : step.status === 'fail' ? 'bad' : 'info'}`}
                        style={{ marginTop: 2 }}
                      >
                        {step.status === 'ok' ? 'PASS' : step.status === 'fail' ? 'FAIL' : 'INFO'}
                      </span>
                      <div className="grow">
                        <div className="title" style={{ whiteSpace: 'normal' }}>
                          {step.label}
                        </div>
                        {step.detail && <div className="sub mono">{step.detail}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}
