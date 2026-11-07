// Safe DOM building. All text goes through textContent — task text is treated as untrusted.
// Never use innerHTML with data anywhere in the app.

const BOOL_ATTRS = new Set(['disabled', 'checked', 'hidden', 'required', 'open', 'selected', 'readonly', 'multiple', 'autofocus']);
const PROP_ATTRS = new Set(['value', 'checked']);

/**
 * h('button', { class: 'btn', onclick: fn, 'aria-label': 'x' }, 'text', child, [more])
 * Strings become text nodes. null/false children are skipped.
 */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (PROP_ATTRS.has(k)) { el[k] = v; if (k === 'value') el.setAttribute('value', String(v)); }
    else if (BOOL_ATTRS.has(k)) el.setAttribute(k, '');
    else if (k === 'text') el.textContent = String(v);
    else {
      if (/^(href|src|action|formaction)$/i.test(k) && /^\s*javascript:/i.test(String(v))) continue;
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clear = (el) => { el.replaceChildren(); return el; };

let uid = 0;
export const uniqueId = (p = 'f') => `${p}-${++uid}`;
