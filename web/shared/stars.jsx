import React from 'react';

// a rating out of five, read: `label` says it in words for those who do not see the stars
export function Stars({ value, label }) {
  const full = Math.round(value || 0);
  return (
    <span className="stars" role="img" aria-label={label}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={i <= full ? 'on' : ''} aria-hidden="true">
          ★
        </span>
      ))}
    </span>
  );
}

// a rating out of five, given: a group of five radio buttons, `labelOf(n)` the name of each
export function StarsInput({ value, onChange, label, labelOf }) {
  return (
    <span className="stars-input" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={value === i}
          aria-label={labelOf(i)}
          className={i <= (value || 0) ? 'on' : ''}
          onClick={() => onChange(i)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight' || e.key === 'ArrowUp') (e.preventDefault(), onChange(Math.min(5, (value || 0) + 1)));
            if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') (e.preventDefault(), onChange(Math.max(1, (value || 1) - 1)));
          }}
          tabIndex={value ? (value === i ? 0 : -1) : i === 1 ? 0 : -1}
        >
          ★
        </button>
      ))}
    </span>
  );
}
