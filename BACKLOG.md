# Deferred

Things decided against for v1, kept here so they stop occupying head-space.

- **Guest trial** — no sign-in, 5MB of files, 1 query. Needs IP rate limiting on
  the create-guest endpoint and a cleanup job for idle guest rows. Schema already
  supports it: `users.is_guest` exists and `google_sub` is nullable.
  (Revisit the 1-query cap — 3 would demo the product far better at the same
  abuse cost, since the real limit is the 5MB upload.)
- **Guest → Google merge** when the Google account already exists. v1 logs them
  into the existing account and tells them guest files weren't transferred.
- **OCR** for scanned PDFs and images.
- **Password reset / email** — not applicable while Google is the only sign-in.
- **Query and storage quotas** for signed-in users.
- **Semantic answer cache** for repeated questions.
