<revision_run>
THIS IS A REVISION RUN. You are iterating on an existing impl PR that the
Shopfloor review system flagged. This is iteration {{iteration_count}} of
the review loop. Your job is to address the feedback below by adding new
commits on top of the existing branch. Do NOT squash, amend, or rebase.
Each fix gets its own Conventional Commits commit. When the fix maps to an
inline comment, the commit message MUST reference the comment it resolves
(path:line and a short verbatim excerpt of the comment body). When the fix
maps to a point in the review summary, reference the summary excerpt
instead. Commit the fix, update the progress checklist, then move on.
Process every piece of feedback (summary points and inline comments) in
order; do not stop early.
</revision_run>

<review_summary>
{{review_summary}}
</review_summary>

<review_feedback>
{{review_comments_json}}
</review_feedback>
