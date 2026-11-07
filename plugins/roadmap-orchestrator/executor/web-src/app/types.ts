import type { Envelope as Observation } from '../../src/observation/protocol.ts';
import type { consoleModel } from '../../src/console/model.ts';
export type Model = ReturnType<typeof consoleModel>;
export type Unit = Model['presentation']['units'][number];
export type Activity = Model['activities'][number];
export type Envelope = Omit<Observation, 'data'> & { data: Omit<Observation['data'], 'events'> & { console: Model } };
export type Signal = 'passed' | 'active' | 'held' | 'failed' | 'pending' | 'withdrawn';
