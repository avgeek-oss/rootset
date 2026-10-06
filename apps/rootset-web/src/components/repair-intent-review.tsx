"use client";

import { Button } from "./ui/button";
import { lazy, Suspense, useId, useState } from "react";
import type { OperatorRepairIntent } from "@rootset/contracts";
import styles from "./repair-intent-review.module.css";

const RepairValueReview = lazy(() => import("./repair-value-review"));
const fieldsPerPage = 10;

type Update = OperatorRepairIntent["updates"][number];
function RequestedFields({ update }: { update: Update }) {
  const [page, setPage] = useState(0);
  const [opened, setOpened] = useState<string | null>(null);
  const id = useId();
  const keys = Object.keys(update.values);
  const count = Math.max(1, Math.ceil(keys.length / fieldsPerPage));
  const selected = Math.min(page, count - 1);
  function navigate(next: number) {
    setPage(next);
    setOpened(null);
  }
  return (
    <div>
      <p>
        Only the named fields will change. Values are shown as JSON, including
        quoted strings and explicit nulls.
      </p>
      <div className={styles.pager}>
        <Button
          type="button"

          variant="secondary"
          isDisabled={selected === 0}
          onPress={() => navigate(selected - 1)}
        >
          Previous fields
        </Button>
        <p role="status">
          Fields {keys.length ? selected * fieldsPerPage + 1 : 0}–
          {Math.min(keys.length, (selected + 1) * fieldsPerPage)} of{" "}
          {keys.length}
        </p>
        <Button
          type="button"

          variant="secondary"
          isDisabled={selected === count - 1}
          onPress={() => navigate(selected + 1)}
        >
          Next fields
        </Button>
      </div>
      <ul className={styles.fields}>
        {keys
          .slice(selected * fieldsPerPage, (selected + 1) * fieldsPerPage)
          .map((key, index) => {
            const expanded = opened === key,
              regionId = `${id}-value-${index}`;
            return (
              <li key={key}>
                <div className={styles.fieldHeading}>
                  <code>{key}</code>
                  <Button
                    type="button"

                    variant="secondary"
                    aria-expanded={expanded}
                    aria-controls={expanded ? regionId : undefined}
                    aria-label={`${expanded ? "Hide" : "View"} requested value for ${key}`}
                    onPress={() => setOpened(expanded ? null : key)}
                  >
                    {expanded ? "Hide value" : "View value"}
                  </Button>
                </div>
                {expanded && (
                  <div id={regionId}>
                    <Suspense
                      fallback={<p role="status">Opening requested value…</p>}
                    >
                      <RepairValueReview
                        value={update.values[key]!}
                        field={key}
                      />
                    </Suspense>
                  </div>
                )}
              </li>
            );
          })}
      </ul>
    </div>
  );
}

export function RepairIntentReview({
  intent,
}: {
  intent: OperatorRepairIntent;
}) {
  const [index, setIndex] = useState(0);
  const [rowNumber, setRowNumber] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const current = Math.min(index, intent.updates.length - 1),
    update = intent.updates[current]!;
  function navigate(next: number) {
    setIndex(next);
    setRowNumber(String(next + 1));
    setError(null);
  }
  function go() {
    const number = Number(rowNumber);
    if (
      !Number.isSafeInteger(number) ||
      number < 1 ||
      number > intent.updates.length
    ) {
      setError(`Choose a requested row from 1 to ${intent.updates.length}.`);
      return;
    }
    navigate(number - 1);
  }
  return (
    <section className={styles.review} aria-label="Requested operator repair">
      <h2>Review requested data repair</h2>
      <p>
        This immutable request updates {intent.updates.length} existing{" "}
        {intent.updates.length === 1 ? "row" : "rows"}. Browse every requested
        row and field before approving. Business data is displayed without
        masking field names or values.
      </p>
      <dl className={styles.target}>
        <div>
          <dt>Organisation ID</dt>
          <dd>
            <code>{intent.orgId}</code>
          </dd>
        </div>
        <div>
          <dt>Database ID</dt>
          <dd>
            <code>{intent.databaseId}</code>
          </dd>
        </div>
        <div>
          <dt>Table ID</dt>
          <dd>
            <code>{intent.tableId}</code>
          </dd>
        </div>
        <div>
          <dt>Expected schema version</dt>
          <dd>{intent.expectedSchemaVersion}</dd>
        </div>
        <div>
          <dt>Repair reason</dt>
          <dd className={styles.reason}>{intent.reason}</dd>
        </div>
      </dl>
      <div className={styles.pager}>
        <Button
          type="button"

          variant="secondary"
          isDisabled={current === 0}
          onPress={() => navigate(current - 1)}
        >
          Previous requested row
        </Button>
        <p role="status">
          Requested row {current + 1} of {intent.updates.length}
        </p>
        <Button
          type="button"

          variant="secondary"
          isDisabled={current === intent.updates.length - 1}
          onPress={() => navigate(current + 1)}
        >
          Next requested row
        </Button>
      </div>
      <div className={styles.jump}>
        <label htmlFor={labelId}>Requested row number</label>
        <input
          id={labelId}
          type="number"
          inputMode="numeric"
          min={1}
          max={intent.updates.length}
          value={rowNumber}
          onChange={(event) => setRowNumber(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              go();
            }
          }}
        />
        <Button type="button" variant="secondary" onPress={go}>
          Go to requested row
        </Button>
      </div>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <div className={styles.update}>
        <h3>Requested row update {current + 1}</h3>
        <dl className={styles.target}>
          <div>
            <dt>Row ID</dt>
            <dd>
              <code>{update.rowId}</code>
            </dd>
          </div>
          <div>
            <dt>Expected row version</dt>
            <dd>
              <code>{update.expectedVersion}</code>
            </dd>
          </div>
        </dl>
        <RequestedFields key={`${current}:${update.rowId}`} update={update} />
      </div>
    </section>
  );
}
