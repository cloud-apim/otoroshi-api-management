// The texts of the console, and of the components both faces share. The English text is the key:
// a text without a translation reads in English, never as a key. `scripts/i18n.js check` keeps the
// dictionaries complete.
//
//   tr('Deploy')                          a text
//   tr('Snapshot #{0} of {1}', [n, name]) a text with values
//   <Tr text="Served at {0}" args={[<span className="mono">{url}</span>]} />   a text around elements
import React, { Fragment } from 'react';

export const LANGUAGES = [
  ['en', 'English'],
  ['fr', 'Français'],
];
const KEY = 'apim.console.lang';

let lang = 'en';
let dict = {};

// the language chosen by the person, else the browser's, else English
export function preferredLanguage() {
  let chosen = null;
  try {
    chosen = localStorage.getItem(KEY);
  } catch (e) {}
  if (LANGUAGES.some(([l]) => l === chosen)) return chosen;
  const nav = (typeof navigator !== 'undefined' && navigator.language) || 'en';
  return nav.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function setLanguage(l, translations = {}) {
  lang = l;
  dict = l === 'en' ? {} : translations;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
}

// remembered for the next visits
export function chooseLanguage(l) {
  try {
    localStorage.setItem(KEY, l);
  } catch (e) {}
}

export const language = () => lang;

function fill(text, args) {
  if (!args) return text;
  return text.replace(/\{(\w+)\}/g, (whole, k) => (args[k] === undefined || args[k] === null ? whole : String(args[k])));
}

export function tr(text, args) {
  return fill(dict[text] ?? text, args);
}

export function Tr({ text, args = [] }) {
  const parts = (dict[text] ?? text).split(/\{(\d+)\}/);
  return parts.map((p, i) => (i % 2 ? <Fragment key={i}>{args[Number(p)]}</Fragment> : p));
}
