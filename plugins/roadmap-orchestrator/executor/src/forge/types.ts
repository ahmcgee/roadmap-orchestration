// The forge records (M4a; SCHEMAS.md "M4a"): the repo identity every `gh` call names (src/forge/{gh,push,pr}.ts).
import { type Read, object, str } from '../core/validate.ts';

/** Who the forge says a repo is: resolved once per publish (`gh repo view`, H13) and passed to every later call. */
export type RepoIdentity = Readonly<{ host: string; owner: string; name: string }>;
export const repoIdentity: Read<RepoIdentity> = object((f) => ({ host: f.get('host', str), owner: f.get('owner', str), name: f.get('name', str) }));
