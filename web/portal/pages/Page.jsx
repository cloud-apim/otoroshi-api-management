// A page the workspace wrote for its portal: a title and a markdown content, in the language of the
// reader (or the default one of the portal).
import React from 'react';
import { Link } from '../../shared/router.jsx';
import { Markdown } from '../../shared/ui.jsx';
import { usePortal } from '../context.jsx';
import { useI18n, usePortalText } from '../i18n.jsx';
import { DesignMarkdown, Template } from '../design.jsx';

export function Page({ slug }) {
  const { portal, design } = usePortal();
  const { t } = useI18n();
  const text = usePortalText(portal);
  const page = (design?.pages || []).find((p) => p.slug === slug);
  if (!page)
    return (
      <div className="pt-container pt-section">
        <div className="empty">
          <h3>404</h3>
          <Link to="/" className="link">
            {t('common.back')}
          </Link>
        </div>
      </div>
    );
  return (
    <div className="pt-container pt-section">
      <article className="pt-page">
        <h1>{text(page.title)}</h1>
        <div className="card mt-24">
          <div className="card-body">
            {/* a page of a portal written as templates is a template too */}
            {design?.mode === 'templates' ? <Template source={text(page.content)} /> : <DesignMarkdown source={text(page.content)} />}
          </div>
        </div>
      </article>
    </div>
  );
}
