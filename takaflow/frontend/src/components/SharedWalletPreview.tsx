/**
 * Multi-signature shared wallet — DESIGN PREVIEW.
 *
 * This is the one thing on this page that is not real. Every other scenario in the judge console
 * calls the live API and reports what came back; this one runs entirely on local state and calls
 * nothing. It is here because the design is worth showing and the honest thing is to show it as a
 * design rather than to quietly leave it out — or worse, to dress a mock up as evidence.
 *
 * What IS designed is described alongside the mockup: the schema, the consensus rule, and the
 * concurrency hazard that decides how the execution step has to be written.
 */
import { useState } from 'react';
import { Avatar, Badge, Card } from './ui';

interface Member {
  id: string;
  name: string;
}

const MEMBERS: Member[] = [
  { id: 'rahim', name: 'Rahim Uddin' },
  { id: 'karim', name: 'Karim Hossain' },
  { id: 'salma', name: 'Salma Akter' },
  { id: 'nabil', name: 'Nabil Chowdhury' },
  { id: 'tania', name: 'Tania Rahman' },
];

const WALLET = { name: 'Ashuganj trip fund', balance: '48,500.00' };
const PROPOSAL = { amount: '12,000.00', payee: 'Sundarban Resort', note: 'Two nights, deposit' };

export function SharedWalletPreview() {
  // The proposer implicitly approves their own proposal — proposing IS approving.
  const [approvals, setApprovals] = useState<string[]>(['rahim']);

  const executed = approvals.length === MEMBERS.length;
  const progress = (approvals.length / MEMBERS.length) * 100;

  const approve = (id: string) => {
    setApprovals((current) => (current.includes(id) ? current : [...current, id]));
  };

  return (
    <Card className="preview">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div className="grow" style={{ minWidth: 240 }}>
          <div className="row" style={{ gap: 8 }}>
            <h2 style={{ fontSize: '1rem' }}>Multi-signature shared wallet</h2>
            <Badge status="warn">design preview · not built</Badge>
          </div>
          <div className="hint" style={{ marginTop: 4 }}>
            A group wallet where a payment executes only with approval from every member. This card
            is a mockup running on local state — it calls no API, and nothing below is evidence.
          </div>
        </div>

        <button className="ghost" onClick={() => setApprovals(['rahim'])}>
          Reset
        </button>
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <div>
          <div className="stat" style={{ marginBottom: 14 }}>
            <span className="label">{WALLET.name}</span>
            <span className="value">৳{WALLET.balance}</span>
            <span className="hint">{MEMBERS.length} members · every payment needs all of them</span>
          </div>

          <div className={`banner ${executed ? 'success' : 'info'}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <strong>৳{PROPOSAL.amount} to {PROPOSAL.payee}</strong>
                <div className="hint" style={{ color: 'inherit', opacity: 0.85 }}>
                  {PROPOSAL.note} · proposed by Rahim
                </div>
              </div>
              <Badge status={executed ? 'ok' : 'warn'}>{executed ? 'EXECUTED' : 'PENDING'}</Badge>
            </div>

            <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
              <span className="hint" style={{ color: 'inherit' }}>
                {approvals.length}/{MEMBERS.length} approved
              </span>
              {executed && <span className="mono">TF260829K4XQ8ZP2</span>}
            </div>
            <div className="progress">
              <div
                className="progress-bar"
                style={{ width: `${progress}%`, background: executed ? 'var(--brand)' : 'var(--info)' }}
              />
            </div>
          </div>

          <div className="list">
            {MEMBERS.map((member) => {
              const approved = approvals.includes(member.id);
              return (
                <div className="item" key={member.id}>
                  <Avatar name={member.name} />
                  <div className="grow">
                    <div className="title">{member.name}</div>
                    <div className="sub">
                      {member.id === 'rahim' ? 'Proposer — approving by proposing' : approved ? 'Approved' : 'Waiting'}
                    </div>
                  </div>
                  {approved ? (
                    <Badge status="ok">approved</Badge>
                  ) : (
                    <button className="small secondary" onClick={() => approve(member.id)} disabled={executed}>
                      Approve as {member.name.split(' ')[0]}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {executed && (
            <div className="banner success" style={{ marginTop: 14 }}>
              The last approval is the one that pays. In the design, that same transaction debits
              the wallet account, credits the payee, writes the two ledger entries, and flips the
              proposal to EXECUTED — or none of it happens.
            </div>
          )}
        </div>

        <div>
          <h3 style={{ fontSize: '0.9rem', marginBottom: 8 }}>What the design says</h3>
          <ul className="muted" style={{ paddingLeft: 18, margin: 0, display: 'grid', gap: 10 }}>
            <li>
              <strong>The wallet owns a real account.</strong> Not a `balance` column on a wallet
              row — an ordinary account in the same ledger, so funding it is a transfer and paying
              from it is a double entry. Every existing invariant keeps holding, unchanged.
            </li>
            <li>
              <strong>Approval is a row, not a counter.</strong>{' '}
              <span className="mono">shared_wallet_approvals(txn_id, user_id)</span> with a
              composite primary key, so approving twice is impossible rather than merely discouraged.
            </li>
            <li>
              <strong>The last approval executes.</strong> The approve endpoint locks the proposal
              row <span className="mono">FOR UPDATE</span>, inserts the approval, counts, and — if
              the count now equals the membership — posts the payment and flips the status with a
              guarded <span className="mono">UPDATE … WHERE status = 'PENDING'</span>.
            </li>
            <li>
              <strong>Why the lock matters.</strong> Without it, two members approving in the same
              millisecond both read "one short of unanimous", both then see unanimity, and the
              wallet pays twice. It is the same read-then-write race the velocity limiter has, and
              it gets the same answer: let the database serialise it.
            </li>
          </ul>

          <h3 style={{ fontSize: '0.9rem', margin: '18px 0 8px' }}>Schema</h3>
          <pre className="mono schema">
{`shared_wallets          (id, name, account_id → accounts)
shared_wallet_members   (wallet_id, user_id)      PK both
shared_wallet_txns      (id, wallet_id, amount_minor,
                         destination_account_id, status)
shared_wallet_approvals (txn_id, user_id)         PK both`}
          </pre>

          <p className="hint" style={{ marginTop: 12 }}>
            Not built because the deadline arrived first, and shipping a half-working way to move
            group money would have been the wrong thing to spend the last hour on.
          </p>
        </div>
      </div>
    </Card>
  );
}
