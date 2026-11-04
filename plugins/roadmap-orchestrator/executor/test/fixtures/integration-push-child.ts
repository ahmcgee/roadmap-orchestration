import { BRANCH, openPush, publish, type PushScene } from './integration-push-common.ts';
const [json, mode] = process.argv.slice(2);
const r = openPush(JSON.parse(json!) as PushScene);
try {
  if (mode === 'publish') await publish(r);
  else r.pushes.recover(BRANCH);
  await r.pushes.drain();
} finally {
  await r.pushes.close();
  r.journal.close();
}
