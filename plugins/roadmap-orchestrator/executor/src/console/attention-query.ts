import { sha256Hex } from '../core/json.ts';
import type { Envelope } from '../observation/protocol.ts';
import { NEEDS_USER_REASONS } from '../core/records.ts';
import { attentionSummaries } from './tab-projections.ts';
import { CollectionPages, responseBound } from './collection-pages.ts';
import { allowParams, choice, invalid, known, list, pageLimit } from './query-params.ts';
import { versioned } from './views.ts';
import type { AttentionFilters, AttentionView } from './attention-protocol.ts';

export class ConsoleAttention {
  // Share the bounded collection store with the other plain tab queries in the worker.
  readonly pages: CollectionPages;
  constructor(pages = new CollectionPages()) {this.pages=pages;}
  read(e: Envelope, params: Record<string, string>, sourceVersion?: string): AttentionView {
    allowParams(params, ['blocking','subjectType','reason','q','sort','cursor','limit']);
    const q = params['q'] ?? ''; if (q.length > 200) invalid('Request search is limited to 200 characters');
    const filters: AttentionFilters = {blocking: choice(params,'blocking',['all','1','0'],'all'), subjectType: list(params,'subjectType'), reason: list(params,'reason'), q:q.toLowerCase(), sort:choice(params,'sort',['oldest','newest'],'oldest')};
    known(filters.subjectType,['unit','arc','host','findings'],'request subject type'); known(filters.reason,NEEDS_USER_REASONS,'request reason');
    const limit = pageLimit(params);
    const data = this.pages.page(e,'attention',filters,limit,params['cursor'],()=> {
      const summaries = attentionSummaries(e), records = new Map(e.data.requests.map(r=>[String(r.id),r]));
      const blocking = summaries.filter(r=>r.blocking).length;
      const rows = summaries.filter(r=>(filters.blocking==='all'||r.blocking===(filters.blocking==='1'))
        &&(!filters.subjectType.length||filters.subjectType.includes(r.subject.type))&&(!filters.reason.length||filters.reason.includes(r.reason))
        &&(!filters.q||[r.id,records.get(r.id)!.summary,records.get(r.id)!.recommendation,r.reason,r.subject.type,...(r.subject.type==='unit'?[r.subject.id,r.subject.title]:[])].join(' ').toLowerCase().includes(filters.q)));
      rows.sort((a,b)=>Number(b.blocking)-Number(a.blocking)||(filters.sort==='oldest'?1:-1)*(Date.parse(a.raisedAt)-Date.parse(b.raisedAt))||(a.id<b.id?-1:a.id>b.id?1:0));
      return {rows,context:{...versioned({filters,counts:{total:summaries.length,blocking,informational:summaries.length-blocking},reasons:[...new Set(summaries.map(r=>r.reason))].sort()},{basis:'current',from:null,to:null}),viewVersion:sourceVersion??sha256Hex(JSON.stringify(summaries))}};
    });
    return responseBound(e,data,limit===100?96*1024:48*1024);
  }
}
