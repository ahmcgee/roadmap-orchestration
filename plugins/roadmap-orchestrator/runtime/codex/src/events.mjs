export function createEventSink({ jsonl = false, stdout = process.stdout, onEvent = null } = {}) {
  const emit = (event) => {
    onEvent?.(event)
    if (jsonl) stdout.write(`${JSON.stringify(event)}\n`)
    else if (event.type === 'phase') stdout.write(`\n[${event.phase}]\n`)
    else if (event.type === 'call.started') stdout.write(`→ ${event.ordinal} ${event.label} · ${event.model}/${event.effort}\n`)
    else if (event.type === 'call.completed') stdout.write(`✓ ${event.ordinal} ${event.label}${event.replayed ? ' (replayed)' : ''}\n`)
    else if (event.type === 'call.failed') stdout.write(`! ${event.ordinal} ${event.label}: ${event.message}\n`)
    else if (event.type === 'log') stdout.write(`  ${event.message}\n`)
  }
  return { emit }
}
