// Word lists for the synthetic monorepo's names: packages, modules (adjective-noun), function suffixes, helper stems.
// Plain, neutral words, so no name hints at what a fixture tests.

export const PACKAGE_WORDS = [
  'amber', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'garnet', 'harbor', 'indigo', 'juniper', 'kelp', 'lagoon', 'marble',
  'nectar', 'onyx', 'pebble', 'quartz', 'raven', 'saffron', 'tundra', 'umber', 'velvet', 'willow', 'xenon', 'yarrow', 'zephyr',
  'acorn', 'birch', 'canyon', 'dune', 'estuary', 'fern', 'glacier', 'heather', 'iris', 'jasper', 'kestrel', 'lichen', 'meadow',
  'nimbus', 'orchid', 'prairie', 'quill', 'reef', 'sierra', 'thistle', 'upland', 'vale', 'wren', 'yucca', 'alder', 'bramble',
  'cobalt', 'dawn', 'egret', 'flint', 'grove', 'hazel', 'islet', 'jade', 'knoll', 'lotus', 'mesa', 'nettle', 'oak', 'pine',
  'quarry', 'ridge', 'sorrel', 'tide', 'vireo', 'wheat', 'aspen', 'beacon', 'coral', 'drift', 'elm', 'fallow', 'gorse',
  'heron', 'ivy', 'kiln', 'larch', 'moss', 'north', 'otter', 'plover', 'rush', 'sage', 'tern', 'vetch', 'wold', 'bay', 'crag',
] as const;

export const ADJECTIVES = [
  'swift', 'quiet', 'bright', 'steady', 'hollow', 'narrow', 'broad', 'gentle', 'rough', 'smooth', 'early', 'late', 'inner',
  'outer', 'upper', 'lower', 'plain', 'sharp', 'round', 'square', 'warm', 'cool', 'dense', 'sparse', 'light', 'heavy', 'level',
  'tilted', 'woven', 'folded', 'linked', 'loose', 'tight', 'fresh', 'stale', 'prime', 'minor', 'major', 'local', 'remote',
  'first', 'final', 'single', 'double', 'partial', 'total', 'static', 'mobile', 'common', 'rare',
] as const;

export const NOUNS = [
  'ledger', 'channel', 'bucket', 'cursor', 'window', 'parcel', 'socket', 'bridge', 'filter', 'marker', 'segment', 'record',
  'buffer', 'gauge', 'anchor', 'beacon', 'circuit', 'docket', 'engine', 'frame', 'grid', 'handle', 'index', 'joint', 'kernel',
  'lattice', 'matrix', 'notch', 'orbit', 'panel', 'quota', 'rail', 'shard', 'table', 'unit', 'vector', 'wedge', 'yard', 'zone',
  'arc', 'block', 'crate', 'drum', 'edge', 'fiber', 'gate', 'hinge', 'inlet', 'jet', 'keel',
] as const;

export const FUNCTION_SUFFIXES = ['Total', 'Span', 'Weight', 'Offset', 'Margin', 'Score'] as const;

/** Stems of the shared helpers' names: `fit<Stem>` (renamed in a sweep to `bound<Stem>`) and its same-signature sibling. */
export const HELPER_STEMS = ['Width', 'Height', 'Depth', 'Reach', 'Range', 'Extent', 'Breadth', 'Length'] as const;

export const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
export const camel = (parts: readonly string[]): string => parts.map((p, i) => (i === 0 ? p : cap(p))).join('');
