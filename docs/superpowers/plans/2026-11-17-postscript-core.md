# PostScript Language Core Implementation Plan

Use superpowers:subagent-driven-development and test-driven-development.
Track progress and rulings in bd. The user's approval authorizes implementation
through verification and the repository's integration/sync workflow.

**Goal:** An extensible internal PostScript interpreter with correct language
semantics and bounded execution/allocation.

**Architecture:** Values and VM memory are independent of the interpreter.
A lazy scanner reads through that memory layer. The iterative interpreter
installs core and data operators, and exposes registration to later import work.

**Tech Stack:** TypeScript NodeNext ESM, Node built-ins, vitest, no runtime deps.

**Spec:** docs/superpowers/specs/2026-11-17-postscript-core-design.md.

## Global Constraints

All new interpreter modules are internal, with .js relative import specifiers.
Existing PDF calculator functions keep their established behavior.
LoadLimits defaults are maxPostScriptOperations 10000000 and
maxPostScriptVmBytes 134217728. Limits throw ResourceLimitError and cannot be
caught by PostScript stopped/error handlers. Every src catch starts with
rethrowLimit. No host filesystem, process, network or JavaScript execution.
Operand/dictionary/procedure/frame growth is checked before large allocation.
Only one implementation task writes files at a time. Run focused tests and
typecheck per task, then the full suite on the integrated result.

## Review Focus

Immediate names must see definitions executed before the scanner reaches them.
Array/string intervals share storage, while their access attributes are per
reference; dictionary access belongs to the shared body.
Restore must reject live references to newer local bodies before changing VM.
Empty loops, name-resolution cycles and repeated executable strings must consume
fuel without relying on JavaScript recursion.
Bulk copying, binding, scanning, searching and journaling must be metered, and
limits must escape every language-error recovery path.

## Task 1 — Values, memory and budgets

Create src/psvalue.ts, src/psbudget.ts, src/psmemory.ts, test/psvalue.test.ts,
test/psmemory.test.ts and test/psbudget.test.ts. Modify src/loadlimits.ts and
test/loadlimits.test.ts for the two new policy fields.

Produce a discriminated PsValue union. Use kinds integer, real, boolean, name,
string, array, dictionary, operator, mark, null and save, with an executable
flag. Scalar/name payloads use value/text. Composite references expose body,
offset/length where applicable, and access attributes. Arrays distinguish
packed storage. Backing bodies carry local/global allocation identity and
validity. Operators hold a name and a zero-argument execute callback, letting
the later VM register closures without importing the VM from this leaf.

Export PsFault(errorName: string, offset?: number) for internal language faults,
scalar constructors, withExecutable(value, executable), access queries and
PostScript equality/key normalization helpers. Preserve byte values in names
and strings and numeric key equivalence. Exact supporting type names may be
chosen by the implementer and must be documented for the next task.

Produce PsBudget(limits = LoadLimits.defaults), with work(count = 1, detail?),
allocate(bytes, detail?), depth(reached, detail?) and items(reached, detail?).
Counters are cumulative. A trusted bootstrap(callback) scope may initialize the
fixed built-in environment without charging source-controlled budgets. It must
restore accounting on exit and never be invoked while executing source.
Document the conservative allocation charge schedule in psbudget.ts.

Produce PsMemory(budget), with currentGlobal, array(length, executable?, packed?),
string(bytesOrLength), dictionary(capacity?), name(text, executable?),
get(composite, key), put(composite, key, value), lookup(dictionary, key),
entries(dictionary), interval(arrayOrString, start, length), copy(source, target),
restrictAccess(value, access), save() and restore(token, roots).
Array/string keys are integer indexes; dictionary keys are PsValue objects.
Use the same memory barrier for writes, journaling, access and global/local
checks. Provide any small typed helpers later operators require through this
layer. Numeric/equality/access rules follow Adobe's language reference.

Before implementation, write tests that fail on missing functionality, including
shared interval writes, overlap-safe copy, integer/real key equivalence, name
versus string keys, dictionary body access, per-reference array access, packed
write refusal, nested restore, string mutation persistence, global mutation
persistence, invalidrestore and cyclic composites. Test exact budget boundaries,
null/unlimited and allocation refusal before a large container is constructed.

Run `npm test -- test/psvalue.test.ts test/psmemory.test.ts test/psbudget.test.ts
test/loadlimits.test.ts`, observe RED, implement and observe GREEN. Run typecheck
and commit. The report must include the exported interface contract for Task 2/3.

## Task 2 — Lazy PostScript scanner

Create src/psscan.ts and test/psscan.test.ts, consuming Task 1's value/memory
interfaces. Produce PsScanner(source: Uint8Array, memory: PsMemory,
resolveImmediate?: (text: string) => PsValue), position, source and next():
PsValue | undefined. Undefined means EOF. Source positions must remain usable
by later inline-data operators and error reporting.

Use an explicit builder stack for brace procedures. Resolve //names as they are
scanned, including inside procedures. Preserve /A#41 literally as a PostScript
name. Brackets/double-angle tokens produce executable names. Enforce token,
container, source, nesting and cumulative work/allocation bounds during reads.
ASCII85/hex decoding may reuse ascii.ts after delimiter validation and a
pre-allocation bound. Avoid allocating a large intermediate number[] first.

Write failing tests with literal expected objects for exponent/radix and real
typing, escapes/CRLF/octal bytes, odd hex nibbles, ASCII85, nested procedures,
comments, malformed source, delimiters, immediate lookup timing and offsets.
Exercise low custom limits and repeated scanning through one shared budget.
Run `npm test -- test/psscan.test.ts test/psvalue.test.ts test/psmemory.test.ts
test/psbudget.test.ts`, observe RED then GREEN, typecheck and commit.

## Task 3 — Interpreter and complete core operator inventory

Create src/psvm.ts, src/pscore.ts, src/psdata.ts, test/psvm.test.ts,
test/pscore.test.ts and test/psdata.test.ts. Consume the Task 1/2 interfaces.
Produce PsInterpreter({ limits?: LoadLimits } = {}), run(source: Uint8Array),
readonly stack: readonly PsValue[], memory, budget, systemdict/globaldict/userdict,
lookup(name): PsValue | undefined and registerOperator(name, (vm) => void).
Expose typed stack access and scheduling helpers for registered operators.

The dispatcher uses source/procedure/loop/stopped frames and one iterative pump.
Name resolution and procedure invocation must not recurse in JavaScript.
Scalar literals push directly; procedure literals push while indirect calls
execute. Executable strings scan through the same environment/budgets. Keep
the active cursor available. Repeated run calls retain definitions and budgets.
Protected base dictionaries and fixed bootstrap allocations are excluded from
user-requested dictionary nesting. All user-created growth is charged.

Install every operator in the approved spec's inventory, through installPsCore
and installPsData functions with type-only imports of PsInterpreter. Use
source-level error dispatch, standard errordict/$error, operand restoration
and offending-command push. Standard handlers stop; custom handlers execute
under the same frame and budget rules. Uncaught language faults become
PdfParseError with error name and source offset. stop/quit termination is
distinguished from faults. Resource limits and unsupported-feature errors
escape language recovery. Include bind over cyclic nested procedures.

VM helpers must let control operators schedule continuations instead of calling
the pump recursively. for/repeat/loop/forall tick on every iteration, including
empty procedures. Bulk data work is proportional and metered. Dictionary
lookup, equality and array/string access use Task 1 semantics. Do not make a
full operand-stack copy before every ordinary operator; validate operands and
perform writes only after checks, or retain a bounded undo log for pops.

Write tests before each operator group. Assert literal stacks for arithmetic,
32-bit overflow promotion, boolean/integer overloading, non-masked bitshifts,
conversions/types, marks/array/dictionary construction, shadowing, immediate
names, bind, mutable intervals, packed/access attributes, nested control exits,
custom errors/stopped, save/global/restore, repeated run and host registration.
Test malformed programs through the public embedding error types.

Run `npm test -- test/psvm.test.ts test/pscore.test.ts test/psdata.test.ts
test/psscan.test.ts test/psmemory.test.ts test/psfunc.test.ts`, observe each
missing feature RED then GREEN. Run typecheck and commit the complete inventory.

## Task 4 — Hostile inputs, oracle checks and documentation

Create test/pslimits.test.ts and any focused regressions required by integration.
Add small committed language-oracle data with PROVENANCE if Ghostscript is
available. Use Adobe literal examples when no development oracle is available
and state the verification boundary accurately.

Exercise empty infinite loops, recursive names and procedures, executable-string
recursion, source/token bounds, operand and dictionary growth, giant arrays,
allocation/discard loops, overlapping copies, cycle-safe bind, pathological
string search and large save journals. Each must fail through its configured
ResourceLimitError before a native stack/heap failure. Assert stopped and
custom handlers cannot catch exhaustion. Test exact boundaries and repeated
run accounting. Verify clean control-stack unwinding after terminal errors.

Review the full operator inventory against tests, and cover missing supported
branches with meaningful examples. Add CLAUDE module/invariant entries, README
limit fields and CHANGELOG's public LoadLimits additions. Update the LoadLimits
field inventory test to 19 fields and preserve existing policy semantics.

Run focused core/limit/calculator/import-cycle/catch/readme tests and typecheck,
then obtain a whole-branch review. Fix important findings with RED/GREEN
regressions. Run the full suite, integrate into main under repository workflow,
verify required gates on main, close lw8w.1, push main and sync Beads.
