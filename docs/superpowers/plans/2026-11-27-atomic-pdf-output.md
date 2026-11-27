# Implement atomic PDF output

1. Exercise `Document.WriteTo` with real destination files. Inject a partial write, a flush error and a rename error. Compare the original bytes and directory entries after each failure.
2. Add an internal synchronous writer that resolves the target, creates an exclusive sibling, preserves existing permissions, flushes and closes the staged file, then publishes it with one rename.
3. Verify creation, replacement, link behavior, write access and permissions. Document the filesystem contract and run the repository typecheck and test suite.
