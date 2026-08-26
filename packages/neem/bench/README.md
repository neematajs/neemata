# Neem lifecycle benchmarks

Neem cold-start and watcher-reload benchmarks are intentionally deferred. Both
paths spawn worker threads and subprocesses, compile fixture applications, and
depend on filesystem watcher scheduling, so short local samples mostly measure
host load and OS timing rather than framework work. A useful benchmark needs a
dedicated fixture and process-level runner that records the lifecycle phases
separately; adding that machinery is outside this package-local benchmark slice.
