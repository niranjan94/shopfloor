<tdd_and_testing_discipline>
The rules below govern every implementer subagent you dispatch and every commit you make. They apply on top of the plan, the issue, or your own reasoning.

**TDD iron rules.** Use this loop for every task that changes production behavior.

1. **RED.** Write one failing test that names the behavior you intend to add or fix.
2. **Verify the failure.** Run the test. Watching the failure is mandatory; a test that has never failed is not a regression guard.
3. **GREEN.** Write the minimum production code that makes the test pass. No extra fields, no extra branches, no anticipating the next test.
4. **Verify the pass.** Re-run the failing test, then re-run the broader suite at the layer the plan named for this task.
5. **REFACTOR** only when the refactor is justified by the change you just made. Tests stay green throughout.

Additional rules:

- Test names describe behavior (`returns_404_when_user_is_missing`), not implementation (`calls_lookup_then_returns`).
- One assertion per behavior. Different behaviors get different tests, not stacked assertions.
- Prefer real code over mocks. Reach for a mock only when the real dependency is non-deterministic, slow, or out of process.
- Bug-fix discipline: the first commit on a bug fix is the reproducing test. The fix is the second commit. The reproducing test must have been seen to fail before the fix lands.

**Exception clause.** Non-testable changes skip the RED/GREEN cycle entirely. These include: doc-only edits, formatting passes, dist-bundle rebuilds, prompt-only edits, and any change that has no executable behavior to assert against. When you skip the cycle, name the exception that applies in the commit body or the progress update so the reviewer can see the omission was intentional.
</tdd_and_testing_discipline>

<testing_anti_patterns>
Before writing any test, mock, or fixture, walk these gates. Each one catches a failure mode that produces green tests for broken code.

- **No mock-identity assertions.** Asserting that a mock returned a value you yourself injected returns no information about production behavior. If the only way to make a test pass is to read back the mock's setup, the test is testing the test, not the system. This includes asserting on `*-mock` test IDs, sentinel strings, or any value the test itself wired into the dependency.
- **No test-only methods on production classes.** A method that exists solely to make testing easier is a design smell. The behavior is hard to test because the seams are wrong; fix the seams instead of widening the production surface.
- **Map the full side-effect surface before mocking.** A mock that returns the right value but skips a side effect (writes a row, fires an event, advances a clock, mutates a singleton) produces a green test for code that is silently broken. Read the real implementation first, then stub.
- **Mirror the complete real shape in mock responses.** A `{ id: 1 }` stub for a real shape with thirty fields hides every null-deref the production code would otherwise crash on. Either return the full shape or wire a real fake.
  </testing_anti_patterns>

<minimize_overengineering>
Make only the changes the task directly requires. Resist the impulse to leave the code "better than you found it" if the improvement is outside the task's scope.

- **Scope:** Do not add features, refactor unrelated code, or make "improvements" beyond what the task asks for. A bug fix does not need surrounding cleanup; a one-shot operation does not need a helper.
- **Documentation:** Do not add docstrings, comments, or type annotations to code you did not change. Do not explain WHAT code does in comments; well-named identifiers already do that. Only comment when the WHY is non-obvious (a hidden constraint, a subtle invariant, a workaround for a specific bug).
- **Defensive coding:** Do not add error handling, fallbacks, or validation for scenarios that cannot happen. Trust internal callers and framework guarantees. Validate only at system boundaries (user input, external APIs).
- **Abstractions:** Do not create helpers, base classes, or wrappers for one-time operations. Do not design for hypothetical future requirements. Three similar lines beat a premature abstraction.
  </minimize_overengineering>

<pre_output_checklist>
Before emitting the structured output, walk this checklist in order. If any item fails, fix the underlying problem and re-walk the list; do NOT relax the rule to fit a partial result.

1. `git status` is clean. Every modification is committed.
2. Every commit message starts with a valid Conventional Commits type (`feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `build`, `ci`, `revert`), an optional scope in parens, then `: description`, and the description accurately reflects the diff.
3. Tests pass at every layer named in the testing strategy for the area you touched. If a layer was intentionally skipped under the exception clause, the commit body or the progress update names which exception applied.
4. No test-only methods, fixtures, or hooks were added to production source.
5. No assertion in any new test reads back a value the test itself wired into a mock.
6. No em dashes appear in commit messages, code, comments, or any other content the diff introduces.
7. No `Co-Authored-By` trailer appears in any commit you authored.
   </pre_output_checklist>
