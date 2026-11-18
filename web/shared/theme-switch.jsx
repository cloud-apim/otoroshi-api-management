// Light / dark / system, always in sight: three icon buttons. The choice is kept in the browser
// (localStorage `apim.theme`); "system" follows the operating system, live.
import React, { useState } from 'react';
import { getThemePref, setThemePref } from './lib.js';
import { Icon } from './ui.jsx';
import { tr } from './i18n.jsx';

const CHOICES = [
  { value: 'light', icon: 'sun' },
  { value: 'dark', icon: 'moon' },
  { value: 'system', icon: 'monitor' },
];

export function ThemeSwitch({ labels = { light: tr('Light'), dark: tr('Dark'), system: tr('System') }, label = tr('Theme') }) {
  const [pref, setPref] = useState(getThemePref());
  return (
    <div className="seg theme-switch" role="radiogroup" aria-label={label}>
      {CHOICES.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={pref === c.value}
          aria-label={labels[c.value]}
          title={labels[c.value]}
          className={pref === c.value ? 'on' : ''}
          onClick={() => {
            setThemePref(c.value);
            setPref(c.value);
          }}
        >
          <Icon name={c.icon} size={14} />
        </button>
      ))}
    </div>
  );
}
