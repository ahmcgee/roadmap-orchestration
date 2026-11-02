import { PROMPT as BASE } from './base.ts';
import { BUILD_DELEGATION } from '../delegation.ts';
export const PROMPT = {...BASE, system: `${BASE.system}\n${BUILD_DELEGATION}`};
