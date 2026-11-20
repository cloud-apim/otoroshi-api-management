import React from 'react';
import { Badge, Code, Empty, Loader, Markdown, useLoad } from '../../shared/ui.jsx';
import { api } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { channelsOf } from '../../shared/asyncapi.js';

function Message({ m }) {
  const { t } = useI18n();
  const example = m.examples?.[0]?.payload ?? m.examples?.[0];
  return (
    <div className="panel col gap-6">
      <div className="row wrap gap-6">
        <span className="bold small">{m.title || m.name || m.messageId || t('asyncapi.message')}</span>
        {m.contentType && <span className="tag mono">{m.contentType}</span>}
      </div>
      {(m.summary || m.description) && <p className="muted small">{m.summary || m.description}</p>}
      {m.payload && (
        <details>
          <summary className="small">{t('asyncapi.payload')}</summary>
          <Code lang="json">{JSON.stringify(m.payload, null, 2)}</Code>
        </details>
      )}
      {example !== undefined && (
        <details>
          <summary className="small">{t('asyncapi.example')}</summary>
          <Code lang="json">{JSON.stringify(example, null, 2)}</Code>
        </details>
      )}
    </div>
  );
}

// the events of an event-driven api, rendered from its AsyncAPI specification
export function Events({ a }) {
  const { t } = useI18n();
  const state = useLoad(() => api.get(`/apis/${a.id}/asyncapi`), [a.id]);
  if (state.error?.status === 404)
    return (
      <div className="card">
        <Empty title={t('asyncapi.none')} icon="doc" />
      </div>
    );
  return (
    <Loader state={state}>
      {(spec) => {
        const channels = channelsOf(spec);
        return (
          <div className="col gap-16" style={{ maxWidth: 900 }}>
            <div>
              <h2>{spec.info?.title}</h2>
              <div className="muted small">{t('asyncapi.version', { asyncapi: spec.asyncapi, version: spec.info?.version || '—' })}</div>
            </div>
            {spec.info?.description && <Markdown source={spec.info.description} />}
            <div className="card">
              <div className="card-head">
                <h3>{t('asyncapi.servers')}</h3>
              </div>
              <div className="card-body col gap-6">
                {Object.entries(spec.servers || {}).map(([name, s]) => (
                  <div key={name} className="row wrap gap-6 small">
                    <span className="tag mono">{s.protocol}</span>
                    <code>{s.url || `${s.host}${s.pathname || ''}`}</code>
                    {s.description && <span className="muted">{s.description}</span>}
                  </div>
                ))}
                <p className="muted small">{t('asyncapi.serversHint')}</p>
              </div>
            </div>
            <h3>{t('asyncapi.channels', { n: channels.length })}</h3>
            {!channels.length && <Empty title={t('asyncapi.noChannel')} />}
            {channels.map((c) => (
              <div key={c.name} className="card">
                <div className="card-head">
                  <h3 className="grow mono">{c.address}</h3>
                </div>
                <div className="card-body col gap-12">
                  {c.description && <Markdown source={c.description} />}
                  {!c.operations.length && <p className="muted small">{t('asyncapi.noOperation')}</p>}
                  {c.operations.map((o, i) => (
                    <div key={o.id || i} className="col gap-8">
                      <div className="row wrap gap-6">
                        <Badge kind={o.side === 'receive' ? 'info' : 'accent'}>{t(`asyncapi.side.${o.side}`)}</Badge>
                        {o.summary && <span className="small">{o.summary}</span>}
                      </div>
                      {o.messages.map((m, j) => (
                        <Message key={j} m={m || {}} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        );
      }}
    </Loader>
  );
}
