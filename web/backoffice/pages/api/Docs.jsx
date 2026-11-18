import React, { useEffect, useState } from 'react';
import YAML from 'yaml';
import { Callout, Empty, Field, FileButton, Icon, Input, Loader, Markdown, Select, Seg, TagsInput, errorMessage, useConfirm, useLoad, useToast } from '../../../shared/ui.jsx';
import { useWs } from '../../context.jsx';
import { CodeEditor, codeLanguage } from '../../../shared/code-editor.jsx';
import { tr, Tr } from '../../../shared/i18n.jsx';

// documentation stays in the product, never in the gateway, and is multilingual from the
// start: the languages belong to the customer
export function DocsTab({ api, draft, setDraft, readOnly, reload, dirty }) {
  const { wapi } = useWs();
  const toast = useToast();
  const confirm = useConfirm();
  const pages = useLoad(() => wapi.get(`/apis/${api.id}/pages`), [api.id]);
  const [selected, setSelected] = useState(null);
  const langs = draft.documentation.languages;
  useEffect(() => {
    if (!selected && pages.data?.length) setSelected(pages.data[0].id);
  }, [pages.data]);
  const add = async () => {
    try {
      const p = await wapi.post(`/apis/${api.id}/pages`, { title: Object.fromEntries(langs.map((l) => [l, tr('New page')])), content: {}, slug: `page-${Date.now().toString(36)}` });
      await pages.reload();
      setSelected(p.id);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <div className="col gap-16">
      <div className="card">
        <div className="card-body row wrap gap-16">
          <Field label={tr('Languages')} hint={tr('any language the customer wants; the first is the default')}>
            <TagsInput
              value={langs}
              onChange={(v) => v.length && setDraft((d) => ({ ...d, documentation: { ...d.documentation, languages: v, defaultLanguage: v.includes(d.documentation.defaultLanguage) ? d.documentation.defaultLanguage : v[0] } }))}
              placeholder={tr('en, fr, de…')}
            />
          </Field>
          <Field label={tr('Default language')}>
            <Select value={draft.documentation.defaultLanguage} onChange={(v) => setDraft((d) => ({ ...d, documentation: { ...d.documentation, defaultLanguage: v } }))} options={langs} />
          </Field>
          <p className="muted small grow">{tr('Pages are saved as you go, in the draft: the portal shows them once a snapshot is published and deployed.')}</p>
        </div>
      </div>
      <Loader state={pages}>
        {(list) => (
          <div className="split">
            <div className="card" style={{ padding: 8 }}>
              <div className="pagelist col gap-4">
                {list.map((p) => (
                  <button key={p.id} className={selected === p.id ? 'on' : ''} onClick={() => setSelected(p.id)}>
                    <Icon name="doc" />
                    <span className="grow ellipsis">{p.title?.[draft.documentation.defaultLanguage] || Object.values(p.title || {})[0] || p.slug}</span>
                    <span className="faint tiny">{Object.keys(p.title || {}).length}</span>
                  </button>
                ))}
                {!readOnly && (
                  <button onClick={add}>
                    <Icon name="plus" /> {tr('New page')}
                  </button>
                )}
              </div>
            </div>
            <div>
              {selected ? (
                <PageEditor
                  key={selected}
                  api={api}
                  pageId={selected}
                  langs={langs}
                  readOnly={readOnly}
                  onSaved={() => {
                    pages.reload();
                    if (!dirty) reload();
                  }}
                  onDelete={async (p) => {
                    if (!(await confirm({ title: tr('Delete page {0}?', [p.slug]), danger: true, confirmLabel: tr('Delete') }))) return;
                    await wapi.del(`/apis/${api.id}/pages/${p.id}`);
                    setSelected(null);
                    pages.reload();
                  }}
                />
              ) : (
                <div className="card">
                  <Empty title={tr('No page')} icon="doc" action={!readOnly && <button className="btn primary" onClick={add}>{tr('Write the first page')}</button>} />
                </div>
              )}
            </div>
          </div>
        )}
      </Loader>
    </div>
  );
}

function PageEditor({ api, pageId, langs, readOnly, onSaved, onDelete }) {
  const { wapi } = useWs();
  const toast = useToast();
  const state = useLoad(() => wapi.get(`/apis/${api.id}/pages/${pageId}`), [pageId]);
  const [lang, setLang] = useState(langs[0]);
  const [page, setPage] = useState(null);
  const [mode, setMode] = useState('write');
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    if (state.data) setPage(state.data);
  }, [state.data]);
  if (!page) return <Loader state={state}>{() => null}</Loader>;
  const setLangValue = (key, v) => {
    setPage((p) => ({ ...p, [key]: { ...p[key], [lang]: v } }));
    setChanged(true);
  };
  const save = async () => {
    try {
      await wapi.put(`/apis/${api.id}/pages/${page.id}`, { slug: page.slug, title: page.title, content: page.content, position: page.position });
      setChanged(false);
      toast(tr('Page saved in the draft'));
      onSaved();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  const missing = langs.filter((l) => !page.content?.[l]?.trim());
  return (
    <div className="card">
      <div className="card-head">
        <Seg value={lang} onChange={setLang} options={langs.map((l) => ({ value: l, label: l.toUpperCase() + (page.content?.[l]?.trim() ? '' : ' ·') }))} />
        <span className="spacer" />
        <Seg value={mode} onChange={setMode} options={[{ value: 'write', label: tr('Write') }, { value: 'preview', label: tr('Preview') }]} />
      </div>
      <div className="card-body col">
        {missing.length > 0 && <Callout kind="info"><Tr text={'Not translated yet: {0}. The portal falls back on the default language.'} args={[missing.join(', ')]} /></Callout>}
        <div className="grid-2">
          <Field label={tr('Title ({0})', [lang])}>
            <Input value={page.title?.[lang] || ''} onChange={(v) => setLangValue('title', v)} disabled={readOnly} />
          </Field>
          <Field label={tr('Slug')} hint={tr('url of the page on the portal')}>
            <Input
              value={page.slug}
              onChange={(v) => {
                setPage((p) => ({ ...p, slug: v }));
                setChanged(true);
              }}
              mono
              disabled={readOnly}
            />
          </Field>
        </div>
        {mode === 'write' ? (
          <CodeEditor
            key={lang}
            value={page.content?.[lang] || ''}
            onChange={(v) => setLangValue('content', v)}
            language="markdown"
            wordWrap="on"
            readOnly={readOnly}
            minHeight={420}
            maxHeight={760}
            ariaLabel={tr('page content ({0})', [lang])}
            placeholder={tr('# Markdown')}
          />
        ) : (
          <div className="panel" style={{ background: 'var(--surface)' }}>
            <Markdown source={page.content?.[lang] || ''} />
          </div>
        )}
        {!readOnly && (
          <div className="row">
            <button className="btn primary" disabled={!changed} onClick={save}>
              {tr('Save page')}
            </button>
            <span className="spacer" />
            <button className="btn danger ghost" onClick={() => onDelete(page)}>
              <Icon name="trash" /> {tr('Delete page')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function OpenApiTab({ draft, setDraft, readOnly }) {
  const [url, setUrl] = useState('');
  const toast = useToast();
  const content = draft.openapi.content || '';
  let parsed = null;
  let error = null;
  if (content.trim()) {
    try {
      parsed = content.trim().startsWith('{') ? JSON.parse(content) : YAML.parse(content);
      if (!parsed?.openapi && !parsed?.swagger) error = tr('not an OpenAPI document: no "openapi" field');
    } catch (e) {
      error = e.message;
    }
  }
  const paths = parsed?.paths ? Object.entries(parsed.paths) : [];
  const set = (v) => setDraft((d) => ({ ...d, openapi: { ...d.openapi, content: v } }));
  return (
    <div className="col gap-16">
      <p className="muted small">
        {tr("The specification is rendered on the portal with Scalar, its servers pointing at the gateway, and its test requests go through the portal proxy with the consumer's own credentials.")}
      </p>
      {!readOnly && (
        <div className="row">
          <input className="input" style={{ maxWidth: 480 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={tr('https://…/openapi.json — import from a url')} aria-label={tr('openapi url')} />
          <button
            className="btn"
            disabled={!url}
            onClick={async () => {
              try {
                const res = await fetch(url);
                set(await res.text());
                toast(tr('Specification imported into the draft'));
              } catch (e) {
                toast(tr('cannot fetch {0}: {1}', [url, e.message]), 'error');
              }
            }}
          >
            <Icon name="download" /> {tr('Import')}
          </button>
          <span className="faint small">{tr('or')}</span>
          <FileButton
            accept=".json,.yaml,.yml,application/json,application/yaml,text/yaml"
            onFile={(text, file) => {
              set(text);
              toast(tr('{0} imported into the draft', [file.name]));
            }}
          >
            {tr('From a local file…')}
          </FileButton>
        </div>
      )}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        <div className="card">
          <div className="card-head">
            <h3 className="grow">{tr('Specification (YAML or JSON)')}</h3>
          </div>
          <div className="card-body">
            <CodeEditor
              value={content}
              onChange={set}
              language={codeLanguage(content)}
              readOnly={readOnly}
              minHeight={520}
              maxHeight={760}
              wordWrap="on"
              ariaLabel={tr('openapi specification')}
              placeholder={tr('openapi: 3.1.0\ninfo:\n  title: My API\n  version: 1.0.0\npaths: {}')}
            />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h3 className="grow">{tr('Outline')}</h3>
          </div>
          <div className="card-body col">
            {!content.trim() && <p className="muted small">{tr('No specification yet.')}</p>}
            {error && <Callout kind="negative">{error}</Callout>}
            {parsed && !error && (
              <>
                <div>
                  <div className="bold">{parsed.info?.title}</div>
                  <div className="muted small">
                    <Tr text={'{0} · version {1} · {2} paths'} args={[parsed.openapi || parsed.swagger, parsed.info?.version, paths.length]} />
                  </div>
                </div>
                {paths.map(([p, ops]) => (
                  <div key={p} className="mono small">
                    {Object.keys(ops)
                      .filter((m) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(m))
                      .map((m) => m.toUpperCase())
                      .join(' ')}{' '}
                    {p}
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
