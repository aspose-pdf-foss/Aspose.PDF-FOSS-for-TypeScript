# Atomic output from Node file helpers

All 18 asynchronous Node helpers that write files accept an optional `overwrite` boolean. The default replaces a writable target atomically after flushing a sibling file, with the same link and permission behavior as `Document.WriteTo()`.

With `overwrite: false`, publish the completed sibling by creating a hard link under the requested destination name. This gives one winner among competing writers and returns `EEXIST` for an occupied name, including a dangling symbolic link. Filesystems without hard-link support propagate their error. Checking for existence then renaming would leave a race between the two operations. Opening the destination exclusively and writing directly would expose an incomplete file.

Multi-file helpers publish sequentially in their existing order. A failure stops publication, preserves earlier outputs, and leaves later entries alone. Retain current option positions, default paths, return values and cancellation behavior.
