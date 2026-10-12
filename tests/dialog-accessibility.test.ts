import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import EntryDialog, { type DialogSpec } from '../src/components/EntryDialog';
import PrivatePasswordDialog, { type PasswordMode } from '../src/components/PrivatePasswordDialog';

const noop = () => undefined;
const attr = (html: string, tag: string, name: string) => new RegExp(`<${tag}[^>]*?\\s${name}="([^"]*)"`).exec(html)?.[1];

function expectNamed(html: string, title: string, described: boolean) {
  const labelledby = attr(html, 'dialog', 'aria-labelledby');
  expect(labelledby).toBeTruthy();
  const heading = new RegExp(`<h2 id="${labelledby!.replace(/[:]/g, '\\$&')}">([^<]*)</h2>`).exec(html);
  expect(heading?.[1]).toBe(title);
  const describedby = attr(html, 'dialog', 'aria-describedby');
  if (!described) { expect(describedby).toBeUndefined(); return; }
  expect(describedby).toBeTruthy();
  expect(describedby).not.toBe(labelledby);
  expect(html.split(`id="${describedby}"`).length - 1).toBe(1);
}

describe('accessible dialog names', () => {
  const entry = (spec: DialogSpec) => renderToStaticMarkup(createElement(EntryDialog, { spec, busy: false, error: '', onCancel: noop, onSubmit: noop }));

  it('names every EntryDialog by its title', () => {
    expectNamed(entry({ kind: 'note', title: 'Nueva nota', path: '' }), 'Nueva nota', false);
    expectNamed(entry({ kind: 'rename', title: 'Renombrar', path: 'a.md', initialValue: 'a' }), 'Renombrar', false);
    expectNamed(entry({ kind: 'trash', title: 'Eliminar', path: 'a.md', permanent: true }), 'Eliminar', true);
    expectNamed(entry({ kind: 'missing', title: 'Nota inexistente', path: 'x/y.md' }), 'Nota inexistente', true);
  });

  it('names PrivatePasswordDialog by its title', () => {
    const titles: Record<PasswordMode, string> = { setup: 'Crear contraseña', unlock: 'Desbloquear bóveda', change: 'Cambiar contraseña' };
    for (const mode of Object.keys(titles) as PasswordMode[]) {
      const html = renderToStaticMarkup(createElement(PrivatePasswordDialog, { mode, busy: false, error: '', onCancel: noop, onSubmit: async () => undefined }));
      expectNamed(html, titles[mode], mode === 'setup');
    }
  });

  it('uses distinct ids for dialogs rendered together', () => {
    const html = renderToStaticMarkup(createElement('div', null,
      createElement(EntryDialog, { spec: { kind: 'note', title: 'A', path: '' }, busy: false, error: '', onCancel: noop, onSubmit: noop }),
      createElement(EntryDialog, { spec: { kind: 'note', title: 'B', path: '' }, busy: false, error: '', onCancel: noop, onSubmit: noop })));
    const ids = [...html.matchAll(/aria-labelledby="([^"]*)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(2);
  });
});
