# Atomic PDF output

`Document.WriteTo(path, options)` serializes the document, writes it to a new sibling of the resolved destination, flushes and closes the file, then renames it over the destination. An error before replacement leaves the old bytes available and removes the staged file. A failed first save leaves the destination absent.

Follow symbolic links, including relative links to a missing target. Replacing a hard-linked file changes only the named entry. Respect write access on an existing regular file and preserve its POSIX permission bits. New files use ordinary creation permissions subject to the process umask. Replacement requires write access in the target directory.

The API takes string paths. If resolving a parent or symbolic link encounters a filename that cannot be decoded as UTF-8, saving fails before staging. This prevents a write to a different filename containing a replacement character.

The synchronous API keeps its current signature and save options. Beads cqzf.4 covers asynchronous Node helpers and no-clobber behavior.
