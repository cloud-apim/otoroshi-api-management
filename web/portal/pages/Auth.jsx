import React, { useState } from 'react';
import { Link, useQuery, useRouter } from '../../shared/router.jsx';
import { Callout, Field, Input, errorMessage } from '../../shared/ui.jsx';
import { api, usePortal } from '../context.jsx';
import { useT } from '../i18n.jsx';

function safeNext(next) {
  // only relative, in-portal destinations
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/apps';
}

function AuthCard({ title, subtitle, children, footer }) {
  return (
    <div className="pt-container pt-auth">
      <div className="card pt-auth-card">
        <div className="card-body col gap-16">
          <div>
            <h1>{title}</h1>
            {subtitle && <p className="muted mt-8">{subtitle}</p>}
          </div>
          {children}
        </div>
      </div>
      {footer && <p className="center muted small mt-16">{footer}</p>}
    </div>
  );
}

export function SignIn() {
  const t = useT();
  const { portal, reload } = usePortal();
  const { navigate } = useRouter();
  const [params] = useQuery();
  const next = params.get('next');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { email, password });
      await reload();
      navigate(safeNext(next));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard
      title={t('auth.signin.title')}
      subtitle={t('auth.signin.subtitle', { portal: portal?.title })}
      footer={
        portal?.selfSignup && (
          <>
            {t('auth.noaccount')}{' '}
            <Link to={`/signup${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="link">
              {t('nav.signup')}
            </Link>
          </>
        )
      }
    >
      {next && <Callout kind="info">{t('auth.required')}</Callout>}
      <form className="col gap-16" onSubmit={submit}>
        <Field label={t('auth.email')}>
          <Input type="email" value={email} onChange={setEmail} autoComplete="email" required autoFocus aria-label={t('auth.email')} />
        </Field>
        <Field label={t('auth.password')}>
          <Input type="password" value={password} onChange={setPassword} autoComplete="current-password" required aria-label={t('auth.password')} />
        </Field>
        {error && <Callout kind="negative">{errorMessage(error)}</Callout>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : t('auth.submit.signin')}
        </button>
      </form>
    </AuthCard>
  );
}

export function SignUp() {
  const t = useT();
  const { portal, reload } = usePortal();
  const { navigate } = useRouter();
  const [params] = useQuery();
  const next = params.get('next');
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (v) => setForm({ ...form, [k]: v });
  if (!portal?.selfSignup)
    return (
      <AuthCard title={t('auth.signup.title')}>
        <Callout kind="info">{t('auth.signupDisabled')}</Callout>
        <Link to="/signin" className="btn">
          {t('nav.signin')}
        </Link>
      </AuthCard>
    );
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/signup', form);
      await reload();
      navigate(safeNext(next));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard
      title={t('auth.signup.title')}
      subtitle={t('auth.signup.subtitle', { portal: portal?.title })}
      footer={
        <>
          {t('auth.hasaccount')}{' '}
          <Link to={`/signin${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="link">
            {t('nav.signin')}
          </Link>
        </>
      }
    >
      <form className="col gap-16" onSubmit={submit}>
        <Field label={t('auth.name')}>
          <Input value={form.name} onChange={set('name')} autoComplete="name" required autoFocus aria-label={t('auth.name')} />
        </Field>
        <Field label={t('auth.email')}>
          <Input type="email" value={form.email} onChange={set('email')} autoComplete="email" required aria-label={t('auth.email')} />
        </Field>
        <Field label={t('auth.password')} hint={t('auth.password.hint')}>
          <Input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" minLength={8} required aria-label={t('auth.password')} />
        </Field>
        {error && <Callout kind="negative">{errorMessage(error)}</Callout>}
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? <span className="spinner" /> : t('auth.submit.signup')}
        </button>
      </form>
    </AuthCard>
  );
}
