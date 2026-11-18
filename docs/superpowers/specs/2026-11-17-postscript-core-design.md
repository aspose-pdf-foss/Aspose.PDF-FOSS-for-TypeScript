# PostScript language core

Issue `aspose-pdf-foss-for-ts-lw8w.1`, a foundation for the graphics and text
children of the PostScript/EPS import epic. Approved by the user on 2026-11-17
with instructions to implement.

## Intent and scope

Interpret the language constructs that real PostScript page-description prologs
use. Supply operand, dictionary and execution stacks, executable procedures,
control flow, arithmetic, mutable strings and arrays, dictionaries, and virtual
memory save/restore. Every source-controlled execution and allocation path must
consume the caller's LoadLimits policy.

This issue supplies an internal interpreter and a registration point for the
graphics and font operators in lw8w.2 and lw8w.3. Those issues own page painting,
font handling and the eventual document-import entry point. EPS framing and
page sizing belong to lw8w.4. Rendered-page oracle fixtures belong to lw8w.5.
Language-core tests and small language-level oracle cases belong here.

## Existing code and approaches

`psfunc.ts` interprets PDF type-4 calculator functions. Its number/boolean/
procedure representation and permissive error contract serve shading and tint
transforms. The PDF lexer recognizes PDF name escapes and numeric syntax. A
PostScript interpreter needs distinct integer/real types, literal/executable
attributes, shared mutable composites and different lexical rules.

The proposed implementation choice is a dedicated interpreter with focused
modules. A shared expanded calculator VM would couple PDF-function fallback
semantics to document-program errors and would require adapting every existing
calculator caller. A Ghostscript runtime dependency conflicts with the
repository's zero-runtime-dependency requirement. Ghostscript remains useful
as a development oracle.

The .NET reference at commit 10a36383 provides the parity inventory through
PsInterpreter, PsScanner, PsValue, PsOperators.Core/Data and PsVirtualMemory.
Use Adobe language semantics to resolve differences, especially immediate-name
lookup, integer typing, error handling and budget exhaustion.

## Module boundaries and integration surface

- `psvalue.ts` owns the tagged value model, byte-string and array views,
  dictionary key semantics, and access/executable attributes.
- `psscan.ts` scans a byte source incrementally and builds procedure objects.
- `psbudget.ts` owns per-interpreter work and accounted-allocation totals.
- `psmemory.ts` owns allocation identity, local/global VM and save journals.
- `psvm.ts` owns dictionary lookup, the three stacks, execution frames, language
  error dispatch and the embedding boundary.
- `pscore.ts` installs stack, arithmetic, comparison and control operators.
- `psdata.ts` installs composite, dictionary, conversion, access and VM operators.

All are internal modules. `pscore.ts` and `psdata.ts` may import the VM type,
while the VM installs their operator tables without a value-import cycle.
Represent internal language errors in the value/runtime layer or a small leaf
if that avoids circular dependencies. Exact internal type names are left to
the implementer.

Provide a `PsInterpreter` constructed with an optional LoadLimits policy. It
executes supplied Uint8Array source and exposes its resulting operand stack,
dictionary lookup and operator registration to embedding code and tests.
Repeated execution on one interpreter continues its definitions and consumes
the same budgets. A fresh instance creates a fresh job. Registered host
operators use the same typed stack and scheduling helpers as built-ins.
Programs resolve only installed objects and supplied source bytes. The core
contains no host filesystem, network, process execution or JavaScript evaluator.

The source cursor must remain available to later inline-data operators. Future
currentfile/image/font readers can consume that same cursor without maintaining
a second scanner position. This issue implements string-source execution and
string tokenization; source-file data operators can be installed with the
graphics/text integration when their consumers exist.

## Values and composite identity

Distinguish integer, real, boolean, name, string, array/procedure, dictionary,
operator, mark, null and save objects. Use signed 32-bit integers and finite
JavaScript-number reals as the implementation's numeric model. Preserve real
typing even for an integral real value. Integer arithmetic that overflows
promotes to a real where the language specifies it. Integer-only operators
validate their operands and shift behavior explicitly.

Names hold byte-preserving text. String-to-name conversion and dictionary
lookup use PostScript equality rules, including string keys interpreted as
names. Dictionaries accept the language's other legal key types as well.
Numeric key equivalence and composite identity are part of that contract.

Strings are bytes. Arrays contain tagged values. An interval shares its backing
body, and dup/copy operations preserve the distinction between copying a
reference and copying its contents. Literal/executable attributes belong to an
object reference. Access restrictions follow the language's composite-access
rules and cannot be relaxed by copying a reference or applying cvx/cvlit.
Self-referential containers are legal. Equality, bind, save journaling and
diagnostics must terminate on cyclic structures.

## Scanning and execution

Scan lazily so that definitions executed earlier in the source are visible to
later immediate names. Support whitespace/comments, decimal integers and reals
including exponent notation, radix numbers, executable names, literal /names,
immediate //names, literal strings with escapes/nesting, hexadecimal strings,
ASCII85 strings and curly-brace procedures. PDF #xx name decoding does not
apply to PostScript names. Reject malformed or unterminated source with an
offset-bearing language syntax error.

Name and number tokens consume exactly one following whitespace separator;
CRLF counts as one newline and consumes both bytes. Non-whitespace delimiters
remain unread. The separator is metered source work outside the word's token
span, while it still counts inside an enclosing procedure span. Comments end
at LF, CR or form-feed.

Curly braces build a procedure while scanning. Brackets and double-angle
tokens are executable names whose operators construct arrays and dictionaries
at execution time. This distinction also applies inside procedures. Immediate
names resolve at scan time and raise undefined if no binding exists.

Use explicit source, procedure, loop and stopped frames. Nested calls and
procedure scanning must not depend on the JavaScript call stack. A procedure
encountered directly is pushed as a value. A procedure reached through lookup,
exec or a control operator is invoked according to PostScript execution rules.
Executable strings re-enter the scanner with the same dictionaries and budgets.

Start with systemdict, globaldict and userdict, with protected base dictionary
stack entries. Bind replaces executable names that resolve to operators and
handles nested/cyclic procedures. Packing operators preserve packed-array
read/access semantics even if both array forms share an internal representation.

## Operator inventory

Implement the following language groups. The implementation plan should split
them into independently testable tasks and list their exact signatures.

- Stack and marks. pop, exch, dup, copy, index, roll, clear, count, mark,
  cleartomark, counttomark, countexecstack and execstack.
- Arithmetic and logic. add, sub, mul, div, idiv, mod, neg, abs, ceiling, floor,
  round, truncate, sqrt, exp, ln, log, sin, cos, atan, rand, srand, rrand,
  bitshift, and, or, xor, not, eq, ne, gt, ge, lt and le.
- Execution. exec, if, ifelse, for, repeat, loop, forall, exit, stop, stopped,
  quit and bind. Include true, false and null constants.
- Arrays and strings. array, packedarray, setpacking, currentpacking, [, ],
  string, length, get, put, getinterval, putinterval, aload, astore, search,
  anchorsearch and token. copy and forall dispatch by operand type.
- Dictionaries. dict, <<, >>, begin, end, def, store, load, known, where, undef,
  maxlength, currentdict, countdictstack, dictstack and cleardictstack.
- Types and access. type, cvlit, cvx, xcheck, cvi, cvr, cvn, cvs, cvrs, readonly,
  executeonly, noaccess, rcheck and wcheck.
- VM. save, restore, setglobal, currentglobal and gcheck.

This inventory defines the supported language core. Additional language/device
facilities get implementations through their owning import issues. Unsupported
facilities must produce a clear failure rather than a successful no-op.

## Virtual memory and errors

Track local/global identity on backing bodies. Enforce invalidaccess when a
global composite would retain a local composite. A save records an allocation
epoch, allocation mode and a journal boundary. First mutation after a save
journals a pre-existing local array/dictionary body, charged before copying.
Restore reverses those mutations, discards newer local allocations and nested
save levels, and restores allocation mode. Existing string contents are not
rolled back. Global mutations survive local restore. Check invalidrestore
before making changes when the live interpreter stacks retain discarded local
composites. Views use their backing body's allocation identity.

Graphics-state participation in save/restore is added by lw8w.2 alongside its
graphics stack. Keep the core VM boundary suitable for that integration.

Language faults use named PostScript errors. Restore an operator's operands and
push the offending object before dispatching the current errordict handler.
Provide standard handlers and $error entries required by stopped/error probes.
Default handlers record the error and execute stop. User-defined handlers run
under the same limits. exit targets the innermost permitted loop and respects
stopped boundaries. Ordinary stop/quit termination is distinct from an error.

Scanner syntax errors supply a literal string of the malformed token bytes
encountered so far as the offending object, retaining the token's original
offset. Diagnostic byte views, string copies and proportional work are charged
before allocation/copy; limits raised while constructing diagnostics escape
language recovery just like limits raised during ordinary execution.

At the embedding boundary, an uncaught language fault becomes PdfParseError
with its PostScript error name and source offset. Explicitly unsupported
facilities use UnsupportedFeatureError. ResourceLimitError propagates through
every language handler, stopped frame and embedding boundary. Every catch in
src follows the repository's rethrowLimit convention.

## Resource limits

Add two fields to LoadLimitValues, LIMIT_FIELDS, defaults and LoadLimits.

| Field | Proposed default | Scope |
|---|---|---|
| maxPostScriptOperations | 10,000,000 | Cumulative execution and proportional bulk/scanning work per interpreter |
| maxPostScriptVmBytes | 134,217,728 | Cumulative accounted allocation per interpreter, including save journals |

These defaults are initial implementation choices, with tuning informed by
language tests and later real-document oracle fixtures. Accounted bytes are a
deterministic conservative charge for bodies, slots, entries, names and frame
storage, rather than a claim to measure the JavaScript heap exactly. Document
and test the charge schedule in the implementation. Check charges before
allocation. Restoring or dropping objects does not refund the job's cumulative
allocation/work budget, which also bounds repeated allocation-and-discard work.

Use existing maxFileBytes for supplied source, maxObjectBytes for a token/string
span, maxContainerItems for each container and operand stack, and
maxNestingDepth for nested procedures, execution frames, dictionary depth and
open save levels. Check bounds during reads and growth, including empty-loop
iterations and bulk operators. Nested exec, token and host operators share the
interpreter budget. Bound name interning and procedure/frame construction too.
Avoid doing an unbounded native split, copy, search or allocation before the
corresponding charge can refuse it. null disables a field consistently with
LoadLimits.unlimited().

## Verification and delivery

Use focused tests over the scanner, object aliasing, VM and operator groups.
Include positive examples and named faults, immediate lookup timing, dictionary
shadowing, bracket/procedure execution differences, mutable intervals, packed
array access, integer/real distinctions, negative shifts, nested loops and exit,
custom error handlers, stopped, executable strings, cyclic bind, nested saves,
global/local references and invalidrestore. Use known literal expected stacks.

Adversarial cases include an empty infinite loop, unbounded recursion,
allocation fan-out, oversized tokens, stack growth, pathological searches and
repeated string exec. Each must fail through its named LoadLimits field before
host stack overflow or large allocation. Small exact-bound tests verify allowed,
reached and detail fields and that stopped cannot catch resource exhaustion.

Cross-check selected core semantics against Adobe examples and independently
generated Ghostscript stack/error outputs where the development tool is
available. Store oracle provenance and expected results; the normal suite needs
only committed data. Preserve the existing type-4 calculator test contracts.

Update README's public limit table and CLAUDE's source/invariant entries.
Document the new public limit fields in CHANGELOG. Run typecheck and the full
suite before delivery, retain the issue in progress through integration and
verification, then push code and sync Beads.

## References

The .NET source is a parity inventory. Adobe defines the language semantics,
and Ghostscript supplies an independent implementation for differential tests.

- [Adobe PostScript Language Reference, third edition](https://www.adobe.com/jp/print/postscript/pdfs/PLRM.pdf)
- [.NET PostScript converter at the epic's pinned commit](https://github.com/aspose-pdf-foss/Aspose.PDF-FOSS-for-.NET/tree/10a36383/src/Converters/PsToPdf)
- [Ghostscript language documentation](https://ghostscript.readthedocs.io/en/master/Language.html)
