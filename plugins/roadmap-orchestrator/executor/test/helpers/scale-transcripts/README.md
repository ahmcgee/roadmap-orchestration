Bounded stream-json excerpts from the retained m1-live and m1-dev55 invocations
(`140-1/stdout`, slug/page-id implementations). These are fixture data, never executed.
Host/session metadata and opaque thinking signatures were removed; tool results are
trimmed to 5,000 characters. Tool inputs, paired results and StructuredOutput retain
the real wire shapes. The scale generator adapts paths and verdicts to each unit and
adds explicitly synthetic Read/Edit/Write and long thinking events: these two m1 runs
used Bash for file operations and emitted redacted thinking, so they cannot supply
those examples verbatim. No dependency on the original scratch directory at runtime.
