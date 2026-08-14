# Logging Standard

This document defines the logging standard used in Allusion for console logging and lifecycle observability.

## 1. Goals

- Track the application's key lifecycle events.
- Make the current state visible without flooding the logs.
- Keep logs useful for troubleshooting and incident analysis.
- Use the current logger interception (console -> unified logger).

## 2. Logging Levels

### info

Use for milestones, state transitions, and aggregated counters.

Examples:

- Watcher started/ready/closed.
- Location sync started/completed.
- New files detected (count).
- Conflict resolution summary (matches, duplicates, merges).
- Backend persistence summaries (items created/saved/removed).

### debug

Use for detailed data, sampled payloads, and diagnostic traces.

Examples:

- Sample of file entities involved in conflict resolution.
- Sample ids or payload entries for bulk operations.
- path samples for watcher events.

### warn

Use for recoverable anomalies.

Examples:

- Missing location on disk.
- Missing or invalid snapshot file.
- Watch init fallback path.

### error

Use for failures requiring attention.

Examples:

- Watcher subscription errors.
- Event handling exceptions.
- Storage write failures.

## 3. Message Structure

All logs should be structured and machine-search friendly.

- Prefix with module scope in square brackets.
  - Example scopes: [LocationStore], [Location], [FolderWatcherWorker]
- Use event names with phase format.
  - event:start, event:completed, watcher:ready, sync:diff-result
- Prefer object payloads over free text.
  - Include ids, paths, counts, durations, and flags.

Pattern:

```ts
console.info('[Module] event:phase', {
  locationId,
  path,
  count,
  status,
  ClientObject,
});
```

## 4. Anti-Spam Rules

- Do not emit info logs per file for high-frequency streams.
- Aggregate watcher events in a short time window and log counters.
  - add/update/remove/error totals every N ms.
- Keep high-cardinality payloads in debug and cap sample size.
  - Suggested sample cap: 10 to 50 entries depending on operation.
- Keep info payloads short and stable.
- For expensive debug payloads (slicing/mapping large arrays, serializing objects), pass a
  argumentless function (`() => payload`) instead of the computed value.
  - The logger interceptor (`logger-renderer.ts`, `logger-worker.ts`) only invokes it when
    logging is enabled, so the computation is skipped entirely when disabled.
  - Example: `console.debug('[Module] event:phase', () => files.slice(0, 50))`.
  - Only worth it when building the payload has a real cost; skip it for cheap values
    (counts, single ids) where the wrapper adds no benefit.

## 5. Privacy and Sensitive Data

- The logging feature comes disabled by default in production builds.
- The user can enable logging in the Advanced settings, which will write logs to a file in the user data directory. no data will be sent to any server or service.
- Optionally, the user can enable a privacy mode that will redact sensitive data from the logs, such as file paths, tags and location names.

