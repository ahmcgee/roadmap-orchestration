// Forms: labelled fields, their hints and errors, and the error summary at the top of a form that did not go through
// (design/DESIGN.md, "Forms"). What the person typed is always shown back.
import { escape } from './html.js';

/** The summary of a refused form: what to fix, each item linking to its field. `verb` finishes "before you ...". */
export function errorSummary(errors, verb) {
  if (errors.length === 0) return '';
  const items = errors.map((e) => (e.field === null ? `<li>${escape(e.message)}</li>` : `<li><a href="#${e.field}">${escape(e.message)}</a></li>`)).join('\n      ');
  const heading = errors.length === 1 ? `One thing to fix before you ${verb}` : `${errors.length} things to fix before you ${verb}`;
  return `<div class="error-summary" role="alert">
    <h2>${heading}</h2>
    <ul>
      ${items}
    </ul>
  </div>`;
}

const errorOf = (errors, name) => errors.find((e) => e.field === name) ?? null;

/** A labelled field. `control` is 'input', 'select' (with `options`) or 'textarea'. */
export function field({ name, label, hint = null, value = '', errors, control = 'input', type = 'text', options = [], attrs = '' }) {
  const error = errorOf(errors, name);
  const described = [hint === null ? null : `${name}-hint`, error === null ? null : `${name}-error`].filter((x) => x !== null).join(' ');
  const aria = `${described === '' ? '' : ` aria-describedby="${described}"`}${error === null ? '' : ' aria-invalid="true"'}`;
  let input;
  if (control === 'select') {
    const opts = options.map(([v, text]) => `<option value="${escape(v)}"${v === value ? ' selected' : ''}>${escape(text)}</option>`).join('');
    input = `<select id="${name}" name="${name}"${aria}>${opts}</select>`;
  } else if (control === 'textarea') {
    input = `<textarea id="${name}" name="${name}" rows="3"${aria}${attrs}>${escape(value)}</textarea>`;
  } else {
    input = `<input id="${name}" name="${name}" type="${type}" value="${escape(value)}"${aria}${attrs}>`;
  }
  return `<div class="field${error === null ? '' : ' field--error'}">
      <label for="${name}">${label}</label>
      ${hint === null ? '' : `<p class="hint" id="${name}-hint">${hint}</p>`}
      ${error === null ? '' : `<p class="field-error" id="${name}-error">${escape(error.message)}</p>`}
      ${input}
    </div>`;
}
