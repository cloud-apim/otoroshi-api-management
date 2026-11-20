import React, { useState } from 'react';
import { Badge, Callout, Empty, Loader, Setting, Switch, errorMessage, useLoad, useToast } from '../../../shared/ui.jsx';
import { useWs } from '../../context.jsx';
import { ListToolbar, Pager, useLocalPaging } from '../../../shared/lists.jsx';
import { tr } from '../../../shared/i18n.jsx';
import { Stars as SharedStars } from '../../../shared/stars.jsx';

const localized = (v, lang, def) => (v && typeof v === 'object' ? v[lang] || v[def] || Object.values(v)[0] : v) || '';

function Stars({ value }) {
  return <SharedStars value={value} label={tr('{0} out of 5', [value])} />;
}

// where the api stands in the catalogue of the portal, across its versions, and what its consumers
// say of it. An editorial decision, not a description: it applies at once, without a snapshot.
export function CatalogueTab({ api, readOnly, onChanged }) {
  const { wapi } = useWs();
  const toast = useToast();
  const workspace = useLoad(() => wapi.get(''), []);
  const reviews = useLoad(() => wapi.get(`/apis/${api.id}/reviews`), [api.id]);
  const page = useLocalPaging(reviews.data?.reviews, { prefix: 'reviews', size: 10, text: (x) => `${x.author || ''} ${x.comment || ''} ${x.rating}/5 ${x.hidden ? tr('hidden by {0}', [x.hidden_by || '—']) : ''}` });
  const [placement, setPlacement] = useState({ categories: api.categories || [], featured: !!api.featured });

  const place = async (patch) => {
    const next = { ...placement, ...patch };
    try {
      setPlacement(await wapi.put(`/apis/${api.id}/placement`, next));
      onChanged?.();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const hide = async (r, hidden) => {
    try {
      await wapi.post(`/apis/${api.id}/reviews/${r.id}/hide`, { hidden });
      toast(hidden ? tr('Review hidden from the portal') : tr('Review shown again'));
      reviews.reload();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <div className="col gap-16">
      <div className="card">
        <div className="card-head">
          <h3>{tr('Placement')}</h3>
        </div>
        <Loader state={workspace}>
          {(w) => {
            const portal = w.portal || {};
            const def = portal.defaultLanguage || 'en';
            const categories = portal.categories || [];
            return (
              <fieldset disabled={readOnly} className="ro-fieldset card-body">
                <p className="muted small">{tr('Where this api stands in the catalogue of the portal, for all its versions. It applies at once: no snapshot, no deployment.')}</p>
                <Setting label={tr('Featured')} help={tr('shown first in the catalogue, and in its featured section')}>
                  <Switch checked={placement.featured} onChange={(v) => place({ featured: v })} label={tr('Feature this api')} />
                </Setting>
                <Setting label={tr('Categories')} help={tr('declared in the settings of the workspace, tab Portal')}>
                  {categories.length ? (
                    categories.map((c) => (
                      <Switch
                        key={c.slug}
                        checked={placement.categories.includes(c.slug)}
                        onChange={(v) => place({ categories: v ? [...placement.categories, c.slug] : placement.categories.filter((x) => x !== c.slug) })}
                        label={localized(c.name, def, def) || c.slug}
                      />
                    ))
                  ) : (
                    <span className="faint small">{tr('No category declared for this portal yet.')}</span>
                  )}
                </Setting>
              </fieldset>
            );
          }}
        </Loader>
      </div>
      <div className="card">
        <div className="card-head">
          <h3 className="grow">{tr('Reviews')}</h3>
          {reviews.data?.rating && (
            <span className="row small">
              <Stars value={reviews.data.rating.average} /> {tr('{0}/5 from {1} review(s)', [reviews.data.rating.average, reviews.data.rating.count])}
            </span>
          )}
        </div>
        <div className="card-body col gap-8">
          <p className="muted small">{tr('Only the consumers whose applications subscribed to this api review it. A hidden review leaves the portal and its rating, and stays here.')}</p>
          {workspace.data?.portal?.discovery?.reviews === false && <Callout kind="info">{tr('The reviews are off on this portal: the consumers neither see nor write them.')}</Callout>}
          <ListToolbar paging={page} placeholder={tr('search authors, comments')} onReload={reviews.reload} loading={reviews.loading} />
          <Loader state={reviews}>
            {() =>
              page.items.length ? (
                page.items.map((x) => (
                  <div key={x.id} className="panel col gap-4">
                    <div className="row">
                      <Stars value={x.rating} />
                      <span className="bold small">{x.author}</span>
                      <span className="faint tiny">{new Date(x.updated_at).toLocaleDateString()}</span>
                      {x.hidden && <Badge kind="warning">{tr('hidden by {0}', [x.hidden_by || '—'])}</Badge>}
                      <span className="spacer" />
                      {!readOnly && (
                        <button className="btn ghost sm" onClick={() => hide(x, !x.hidden)}>
                          {x.hidden ? tr('Show again') : tr('Hide')}
                        </button>
                      )}
                    </div>
                    {x.comment && <p className="small pre-wrap">{x.comment}</p>}
                  </div>
                ))
              ) : (
                <Empty title={page.q ? tr('No review matches') : tr('No review yet')} />
              )
            }
          </Loader>
        </div>
        {page.items.length > 0 && <Pager paging={page} total={page.total} />}
      </div>
    </div>
  );
}
