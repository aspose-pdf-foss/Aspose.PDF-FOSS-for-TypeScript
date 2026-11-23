# Signed-page appearance analysis

Beads issue `eent.2` extends signature verification with visual findings for the signed and current versions. Callers opt in with `VerifySignatures({ shadowAnalysis: true })`. Each valid signature with a readable signed revision gets its own result. A result contains findings in page order and the page numbers that could not be compared. Findings leave cryptographic integrity, certificate trust, and DocMDP verdicts independent.

Object changes alone cannot establish that presentation changed. A raster comparison alone can show changes, and can classify them more specifically when a second render confirms that the earlier appearance is still underneath the changed layer. Reuse the built-in raster renderer for the full and underlying appearance. Pair pages by reading order, include annotation appearances, and bound the sample size while retaining a common scale for both versions. A removed page is a hide finding. Additions in previously unpainted areas leave the signed appearance intact.

Report `hide` when signed marks disappear with no new marks, `replace` when signed marks change alongside new or altered marks, and `hide-and-replace` when an underlying render corroborates an overlay with new or altered marks. Report the overlay evidence on the finding. The comparison describes presentation in this renderer and covers the signed and current endpoints.

Adobe Acrobat exposes the same signed-to-current comparison as a defensive review action. [Compare signed document versions](https://helpx.adobe.com/acrobat/desktop/e-sign-documents/manage-digital-signatures/compare-versions.html)
