"use client";

import { Button } from "@avgeek-oss/design-system/buttons/button";
import { useMemo, useState } from "react";
import type { JsonValue } from "@rootset/contracts";
import styles from "./repair-intent-review.module.css";
import { ChevronLeft, ChevronRight } from "./ui/icons";

const charactersPerPage = 32768;
export function repairValuePage(text: string, page: number) {
  function boundary(offset: number) {
    const at = Math.min(text.length, offset);
    return at > 0 &&
      at < text.length &&
      /[\uD800-\uDBFF]/.test(text[at - 1]!) &&
      /[\uDC00-\uDFFF]/.test(text[at]!)
      ? at - 1
      : at;
  }
  const count = Math.max(1, Math.ceil(text.length / charactersPerPage));
  const selected = Math.max(0, Math.min(count - 1, page));
  const start = boundary(selected * charactersPerPage);
  const end = boundary((selected + 1) * charactersPerPage);
  return { text: text.slice(start, end), start, end, page: selected, count };
}

export default function RepairValueReview({
  value,
  field,
}: {
  value: JsonValue;
  field: string;
}) {
  const text = useMemo(
    () => (value === null ? "NULL" : JSON.stringify(value)),
    [value],
  );
  const [page, setPage] = useState(0);
  const current = repairValuePage(text, page);
  return (
    <div className={styles.value}>
      {current.count > 1 && (
        <div className={styles.pager}>
          <Button
            type="button"

            variant="secondary"
            isDisabled={current.page === 0}
            onPress={() => setPage(current.page - 1)}
          >
            <ChevronLeft />
            Previous value section
          </Button>
          <p role="status">
            Value section {current.page + 1} of {current.count}. Characters{" "}
            {current.start + 1}–{current.end} of {text.length}.
          </p>
          <Button
            type="button"

            variant="secondary"
            isDisabled={current.page === current.count - 1}
            onPress={() => setPage(current.page + 1)}
          >
            Next value section
            <ChevronRight />
          </Button>
        </div>
      )}
      <pre tabIndex={0} aria-label={`Requested JSON value for ${field}`}>
        {value === null ? (
          <span className="null-value">{current.text}</span>
        ) : (
          current.text
        )}
      </pre>
    </div>
  );
}
