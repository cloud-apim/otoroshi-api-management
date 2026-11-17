import React, { useState } from 'react';
import { Badge, Callout, Field, Icon, Input, Loader, Modal, errorMessage, useLoad, useToast } from '../../shared/ui.jsx';
import { api } from '../context.jsx';
import { useI18n } from '../i18n.jsx';
import { PageHeader, RequireUser } from '../common.jsx';

export function Teams() {
  return (
    <RequireUser>
      <TeamsView />
    </RequireUser>
  );
}

function Invite({ team, onDone }) {
  const { t } = useI18n();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/teams/${team.id}/members`, { email });
      setEmail('');
      toast(t('teams.invited'));
      onDone();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <form className="row gap-6" onSubmit={submit}>
      <label className="sr-only" htmlFor={`invite-${team.id}`}>
        {t('teams.invite')}
      </label>
      <input id={`invite-${team.id}`} className="input" type="email" placeholder={t('teams.invite')} value={email} onChange={(e) => setEmail(e.target.value)} required />
      <button className="btn sm" type="submit">
        {t('teams.invite.submit')}
      </button>
    </form>
  );
}

function TeamsView() {
  const { t } = useI18n();
  const state = useLoad(() => api.get('/teams'), []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const create = async (e) => {
    e.preventDefault();
    try {
      await api.post('/teams', { name });
      setCreating(false);
      setName('');
      state.reload();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="pt-container pt-section">
      <PageHeader
        title={t('teams.title')}
        subtitle={t('teams.subtitle')}
        actions={
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" />
            {t('teams.new')}
          </button>
        }
      />
      <Loader state={state}>
        {(teams) => (
          <div className="pt-grid">
            {teams.map((team) => (
              <div key={team.id} className="card">
                <div className="card-head">
                  <h3 className="grow ellipsis">{team.name}</h3>
                  {team.personal && <Badge kind="accent">{t('teams.personal')}</Badge>}
                </div>
                <div className="card-body col gap-16">
                  <div>
                    <div className="label mb-8">{t('teams.members')}</div>
                    <div className="col gap-6">
                      {(team.members || []).map((m) => (
                        <div key={m.id} className="row gap-6 small">
                          <span className="pt-avatar sm" aria-hidden="true">
                            {(m.name || m.email).slice(0, 2).toUpperCase()}
                          </span>
                          <span className="grow ellipsis">{m.name}</span>
                          <span className="faint ellipsis">{m.email}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  {team.personal ? <div className="faint tiny">{t('teams.personal.hint')}</div> : <Invite team={team} onDone={state.reload} />}
                </div>
              </div>
            ))}
          </div>
        )}
      </Loader>
      {creating && (
        <Modal
          title={t('teams.new')}
          onClose={() => setCreating(false)}
          footer={
            <>
              <button className="btn" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </button>
              <button className="btn primary" type="submit" form="new-team" disabled={!name.trim()}>
                {t('teams.create')}
              </button>
            </>
          }
        >
          <form id="new-team" className="col gap-16" onSubmit={create}>
            <Field label={t('teams.name')}>
              <Input value={name} onChange={setName} autoFocus aria-label={t('teams.name')} />
            </Field>
            {error && <Callout kind="negative">{errorMessage(error)}</Callout>}
          </form>
        </Modal>
      )}
    </div>
  );
}
