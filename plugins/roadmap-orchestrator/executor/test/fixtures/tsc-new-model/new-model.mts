// parse.new-model-fails: the real PROMPTS table checked against a copy of its type whose model union has
// a fifth id. tsc must refuse it for the missing entry, which is what adding a model to ModelId does to
// src/prompts/index.ts. The .mts extension keeps this file out of the project's own test/**/*.ts check.
import type { PromptModules } from '../../../src/prompts/inputs.ts';
import { PROMPTS } from '../../../src/prompts/index.ts';
import type { ModelId, PromptSupport, Role } from '../../../src/routing/types.ts';

type WiderModelId = ModelId | 'gpt-9-test';
type WiderTable = { readonly [R in Role]: { readonly [M in WiderModelId]: PromptSupport<PromptModules[R]> } };

export const table: WiderTable = PROMPTS;
