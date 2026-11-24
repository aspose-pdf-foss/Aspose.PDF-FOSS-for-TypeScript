# AutoTag inference implementation plan

1. In autotagheading.ts and an AutoTag heading regression suite, implement the existing font-size strategy, bookmark-title and destination matching, and ordered explicit thresholds. Validate options before document mutation.
2. In autotaglist.ts and a list regression suite, use the document-model marker classifier to build L and LI trees with correct label/body content, nested and continuation lines, and link owners. Exercise shared and split text operators.
3. In autotagfurniture.ts and a furniture regression suite, classify recurring marginal text and explicit watermark matches before marking content. Verify conservative matching, isolated operator ownership and preserved rendering.
4. Integrate the helpers in autotag.ts, exercise combined reading order with tables, links and prose, document options and reports, then run typecheck and the full suite.
