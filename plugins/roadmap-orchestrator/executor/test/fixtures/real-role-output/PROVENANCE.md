These 94 distinct structured-output values are copied from saved real CLI result events, not authored answers.
The index identifies the saved probe invocation or paid role-eval transcript and its event line (unwrapping a transcript event envelope when present), with the
SHA-256 of the original event. Probe transcripts were selected only when actual assistant messages had
message IDs; canned fake emissions were excluded. Duplicate values were removed.

Sources inspected: paid/ and paid2/ role-eval transcripts and probe logs; all four saved roadmap-probe
runs and the paid fixture git runtime directories; the walk/compare run directories named by both probe logs. Earlier failed API calls without a
structured-output value contribute no fixture. No private project data was collected.

Only string sanitization was applied: temporary job evidence roots are removed (citations retain their exact filename and prose), other absolute
temporary or workspace paths become /redacted/path, and model identifiers become backend. No fields,
shapes, array order, explanations, or decisions were corrected, added, removed, or truncated.

The expected repairs preserve two real evidence-file citation failures and thirteen verifier cross-field
failures. Three older outputs with invocation-style reraises are explicitly schema-rejected. Three interim build reports deliberately have final:false: the final-report parser refuses
them, while the runner normally waits for the later final:true report. They are explicitly marked as
expected repairs at the parser boundary, not as invalid interim backend events.

Eight values include long saved experiment logs. Their JSON is stored as deterministic gzip to keep
the fixtures small without editing a single value. The replay test decompresses them before both
sanitation checks and validation; the other 86 values remain plain JSON.
