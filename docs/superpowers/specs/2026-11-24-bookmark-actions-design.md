# Bookmark actions through outline editing

Add `Action?: PdfAction` to `OutlineItem`. Keep the existing `Dest` projection of a local GoTo, including the name of a named destination. Author a bookmark with either an action or a destination.

An outline read and written to the same document should retain the original /A object when its target is untouched. The typed projection cannot represent producer keys, action chains, all field specifications, or an unknown action. Reusing the original object also keeps its destinations shared with links and catalog actions during page resizing.

Detect intentional edits to either target projection, including edits inside a view. Validate and prepare the chosen target for each item before removing the existing tree. Preserve opaque actions through ordinary item edits and object spread. Raw PDF references belong to their document.
