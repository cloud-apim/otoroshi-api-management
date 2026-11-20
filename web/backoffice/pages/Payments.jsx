// The payments of a workspace: the Stripe account it sells its paid plans with (Stripe Connect —
// the product keeps its id only), and what Stripe said of them.
import React, { useEffect } from 'react';
import { useQuery } from '../../shared/router.jsx';
import { fmtDate, fmtRelative } from '../../shared/lib.js';
import { Badge, Callout, Code, Empty, Icon, Loader, Setting, StatusBadge, errorMessage, useConfirm, useLoad, useToast } from '../../shared/ui.jsx';
import { ListToolbar, Pager, usePaging } from '../../shared/lists.jsx';
import { useWs } from '../context.jsx';
import { tr, Tr } from '../../shared/i18n.jsx';

function Events() {
  const { wapi, slug } = useWs();
  const paging = usePaging({ prefix: 'events', size: 25 });
  const state = useLoad(() => wapi.get(`/payments/events?${paging.query}`), [slug, paging.key]);
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="audit" />
        <h3 className="grow">{tr('What Stripe said')}</h3>
        <span className="muted small">{tr('each event received once, signed, and handled by the projection queue')}</span>
      </div>
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <ListToolbar paging={paging} placeholder={tr('search types, outcomes, errors')} onReload={state.reload} loading={state.loading} />
      </div>
      <Loader state={state}>
        {({ items, total }) =>
          items.length ? (
            <>
              <div className="table-wrap">
                <table className="table small">
                  <tbody>
                    {items.map((e) => (
                      <tr key={e.id}>
                        <td className="mono">{e.type}</td>
                        <td className="muted">{fmtRelative(e.received_at)}</td>
                        <td>{e.error ? <span className="negative-text">{e.error}</span> : e.processed_at ? e.outcome : <StatusBadge status="pending" />}</td>
                        <td className="faint mono tiny">{e.id}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager paging={paging} total={total} />
            </>
          ) : (
            <Empty title={paging.q ? tr('No event matches') : tr('Nothing received yet')} icon="inbox" />
          )
        }
      </Loader>
    </div>
  );
}

export function PaymentsSettings() {
  const { wapi, slug, isAdmin } = useWs();
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useQuery();
  const state = useLoad(() => wapi.get('/payments'), [slug]);
  // back from Stripe
  useEffect(() => {
    const back = params.get('payments');
    if (!back) return;
    toast(back === 'connected' ? tr('Stripe account linked') : tr('The link of the Stripe account was declined'), back === 'connected' ? 'success' : 'error');
    setParams({ payments: null });
  }, []);
  const connect = async () => {
    try {
      window.location.href = (await wapi.post('/payments/connect')).url;
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const disconnect = async () => {
    if (!(await confirm({ title: tr('Unlink the Stripe account?'), message: tr('The paid plans of this workspace can no longer be subscribed to. Its paid subscriptions must be closed first.'), danger: true, confirmLabel: tr('Unlink') }))) return;
    try {
      await wapi.del('/payments');
      toast(tr('Stripe account unlinked'));
      state.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const reconcile = async () => {
    try {
      const r = await wapi.post('/payments/reconcile');
      toast(tr('{0} subscription(s) checked at Stripe, {1} changed', [r.checked, r.changed.length]));
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Loader state={state}>
      {(s) => (
        <div className="col gap-16">
          <Callout kind="info">
            {tr('The product decides the access; Stripe decides the money — the payment, the invoices, the cards and the taxes. A paid subscription becomes active once Stripe says it is paid, and follows what Stripe says of it.')}
          </Callout>
          {!s.available && <Callout kind="warning">{tr('Payments are not set up on this installation: its administrators set APIM_PAYMENTS_PROVIDER and the Stripe Connect keys.')}</Callout>}
          <div className="card">
            <div className="card-head">
              <Icon name="key" />
              <h3 className="grow">{tr('Stripe account')}</h3>
              {s.provider === 'fake' && <Badge kind="warning">{tr('fake Stripe of the development')}</Badge>}
            </div>
            <div className="card-body">
              <Setting label={tr('Linked account')} help={tr('the Stripe account this workspace sells its paid plans with, linked by Stripe Connect: the product keeps its id, never a key of it')}>
                {s.account ? (
                  <div className="col gap-4">
                    <div className="row gap-6">
                      <span className="bold">{s.account.name || s.account.id}</span>
                      <span className="mono small">{s.account.id}</span>
                      <Badge kind={s.account.livemode ? 'positive' : 'warning'}>{s.account.livemode ? tr('live') : tr('test mode')}</Badge>
                    </div>
                    <span className="faint tiny">
                      <Tr text={'linked by {0}, {1}'} args={[s.account.connected_by, fmtDate(s.account.connected_at)]} />
                    </span>
                  </div>
                ) : (
                  <span className="muted">{tr('none: the paid plans of this workspace cannot be subscribed to')}</span>
                )}
              </Setting>
              {isAdmin && s.available && (
                <div className="row gap-6" style={{ justifyContent: 'flex-end' }}>
                  {s.account && (
                    <button className="btn" onClick={reconcile}>
                      <Icon name="refresh" /> {tr('Reconcile now')}
                    </button>
                  )}
                  {s.account ? (
                    <button className="btn danger" onClick={disconnect}>
                      {tr('Unlink')}
                    </button>
                  ) : (
                    <button className="btn primary" onClick={connect}>
                      {tr('Link a Stripe account')}
                    </button>
                  )}
                </div>
              )}
              <Setting label={tr('Webhook')} help={tr('one endpoint for every linked account (Stripe Connect), set once for the installation, with the events checkout.session.completed, customer.subscription.updated, customer.subscription.deleted and account.application.deauthorized')}>
                <Code>{s.webhook}</Code>
              </Setting>
            </div>
          </div>
          {isAdmin && <Events />}
        </div>
      )}
    </Loader>
  );
}
