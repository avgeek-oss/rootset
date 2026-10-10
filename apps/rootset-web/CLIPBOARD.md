# Spreadsheet clipboard

Rootset copies the selected rectangle in the current row window as UTF-8 TSV,
up to 200 rows, 200 columns and 8 MiB. Tabs, newlines and quotes inside a value
are quoted and escaped. Text containing only the empty string is copied as
`""`; a null cell is copied as an unquoted empty cell. A terminating newline
retains a final row whose cells are all null.

Paste preserves that distinction: a quoted empty cell means empty text, while
an unquoted empty cell means null. This also applies to TSV from other
applications. Required fields reject null rather than converting it into empty
text. Quoted empty text remains valid in a required text field; quoted empty
input in a numeric or temporal field is invalid. The review dialog states
these rules before a mutation can be committed.

Integer paste checks the original decimal or exponent spelling before accepting
its numeric value. Exact integral spellings such as `12.0` and `1.2e1` are accepted
within the safe integer range; fractional spellings that JavaScript would round
to an integer are refused. Field bounds still apply.

JSON fields contain JSON in TSV, including JSON encoding for scalar strings.
For example, the JSON string `abc` has the JSON representation `"abc"`, which
is then escaped as a quoted TSV cell. Booleans and numbers retain their canonical
representations. Dates, times and date-times use canonical API storage values;
times and date-times remain UTC.

Selections can extend beyond the columns currently loaded by horizontal
virtualization. Copy fetches a projected window only when selected fields are
unloaded, retaining the current window position and query order. At most 200 rows
and four sequential pages are read; byte-truncated pages continue through the
existing signed keyset cursor. The selected row IDs, revisions and schema version
must match the captured displayed selection, and every selected field must be
present. These temporary rows are not added to the viewport cache. Copy cancels when the selection, query,
schema or table changes and has a ten-second preparation deadline. A failed or
cancelled preparation leaves the existing clipboard intact and does not mutate
rows or cell history.

The browser permission call begins inside the copy gesture and receives its
content through a promise, preserving Safari's user-activation requirement when
selected columns need an asynchronous read. Clipboard denial is shown explicitly.
