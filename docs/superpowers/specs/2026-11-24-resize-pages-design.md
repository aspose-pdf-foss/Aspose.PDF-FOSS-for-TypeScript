# Coordinated page resize

`doc.ResizePages(pages, box)` fits each selected page's effective CropBox to a single target rectangle in PDF default user space. Page numbers are one-based. A repeated number selects the same page once. The page keeps its rotation. MediaBox and CropBox become the target box. Content and interactive geometry follow the same scale and translation. Existing single-page Resize and Scale calls keep their contracts.

## Approaches

A page-level option could align annotations on one page. Incoming links and shared destinations require a document-wide operation, and a loop over pages could partially apply a batch. The approved document-level API validates the entire selection and prepares every edit before writing any object.

Plan annotation geometry from the page that owns it and destination coordinates from the page they target. Cover rectangles, quadpoints, vertices, line endpoints, free-text callouts and ink strokes. Keep appearance streams in their own local coordinates. Preserve the zoom and null operands of an explicit destination. Update each distinct local destination array once, including one shared by a link, bookmark and named destination.

Use the existing geometry tests to guard Page.Resize defaults. Exercise different crops, rotation, incoming links and invalid geometry through Document.ResizePages, including save and reopen.
