// Any address ledgerly has no page for: say so and offer the way back.
import { escape } from '../html.js';
import { layout } from '../layout.js';

export function get({ path }) {
  return {
    status: 404,
    html: layout({
      title: 'Page not found', section: null, body: `    <h1>Page not found</h1>
    <p class="lead">There is no page at <code>${escape(path)}</code>. Check the address, or start again from the overview.</p>
    <p><a class="button button-primary" href="/">Go to the overview</a></p>`,
    }),
  };
}
