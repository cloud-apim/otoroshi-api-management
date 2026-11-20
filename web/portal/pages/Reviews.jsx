import React, { useEffect, useState } from 'react';
import { Link } from '../../shared/router.jsx';
import { Callout, Empty, Loader, errorMessage, useLoad, useToast } from '../../shared/ui.jsx';
import { Stars, StarsInput } from '../../shared/stars.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../shared/lists.jsx';
import { api, usePortal } from '../context.jsx';
import { useI18n } from '../i18n.jsx';

// the reviews of an api, across its versions: a rating and a comment from each consumer whose
// applications subscribed to it — the second axis of discovery, beside the editorial one
export function Reviews({ a }) {
  const { t, lang } = useI18n();
  const { user } = usePortal();
  const toast = useToast();
  const state = useLoad(() => api.get(`/apis/${a.slug}/reviews`), [a.slug, user?.id]);
  const mine = state.data?.reviews.find((r) => r.mine);
  const page = useLocalPaging(state.data?.reviews, { prefix: 'rv', size: 10, text: (x) => `${x.author || ''} ${x.comment || ''}` });
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    setRating(mine?.rating || 0);
    setComment(mine?.comment || '');
  }, [mine?.id, mine?.updated_at]);

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put(`/apis/${a.slug}/reviews/mine`, { rating, comment });
      toast(t('reviews.saved'));
      state.reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };
  const withdraw = async () => {
    try {
      await api.del(`/apis/${a.slug}/reviews/mine`);
      toast(t('reviews.deleted'));
      state.reload();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <Loader state={state}>
      {(r) => (
        <div className="col gap-16" style={{ maxWidth: 760 }}>
          <div className="row gap-8">
            {r.rating ? (
              <>
                <Stars value={r.rating.average} label={t('reviews.rating', { n: r.rating.average })} />
                <span className="bold">{t('reviews.rating', { n: r.rating.average })}</span>
                <span className="muted small">{r.rating.count === 1 ? t('reviews.one') : t('reviews.count', { n: r.rating.count })}</span>
              </>
            ) : (
              <span className="muted">{t('reviews.none')}</span>
            )}
          </div>
          <p className="muted small">{t('reviews.who')}</p>
          {r.can_review ? (
            <form className="card" onSubmit={save}>
              <div className="card-body col gap-12">
                <h3>{t('reviews.yours')}</h3>
                <StarsInput value={rating} onChange={setRating} label={t('reviews.rate')} labelOf={(n) => t('reviews.rating', { n })} />
                <div className="field">
                  <label htmlFor="review-comment">{t('reviews.comment')}</label>
                  <textarea id="review-comment" className="textarea" rows={4} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
                </div>
                <div className="row gap-8">
                  <button className="btn primary" type="submit" disabled={!rating || saving}>
                    {mine ? t('reviews.update') : t('reviews.save')}
                  </button>
                  {mine && (
                    <button className="btn ghost" type="button" onClick={withdraw}>
                      {t('reviews.delete')}
                    </button>
                  )}
                </div>
              </div>
            </form>
          ) : (
            <Callout kind="info">
              {user ? (
                <Link to={`/apis/${a.id}/plans`} className="link">
                  {t('reviews.subscribe')}
                </Link>
              ) : (
                <Link to="/signin" className="link">
                  {t('reviews.signin')}
                </Link>
              )}
            </Callout>
          )}
          {r.reviews.length ? (
            <div>
              <ListToolbar paging={page} placeholder={t('reviews.search')} onReload={state.reload} loading={state.loading} />
              {page.items.length ? (
                <ul className="col gap-8 pt-reviews">
                  {page.items.map((x) => (
                    <li key={x.id} className="card">
                      <div className="card-body col gap-4">
                        <div className="row gap-8">
                          <Stars value={x.rating} label={t('reviews.rating', { n: x.rating })} />
                          <span className="bold small">{x.author}</span>
                          <span className="faint tiny">{new Date(x.updated_at).toLocaleDateString(lang)}</span>
                        </div>
                        {x.comment && <p className="small pre-wrap">{x.comment}</p>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="card">
                  <Empty title={t('reviews.nomatch')} icon="search" />
                </div>
              )}
              {page.total > 0 && (
                <div className="mt-16">
                  <Pager paging={page} total={page.total} />
                </div>
              )}
            </div>
          ) : (
            !r.can_review && <Empty title={t('reviews.none')} />
          )}
        </div>
      )}
    </Loader>
  );
}
