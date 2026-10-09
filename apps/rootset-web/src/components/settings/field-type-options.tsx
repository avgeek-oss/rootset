import { HugeiconsIcon } from "@hugeicons/react";
import {
  TextFontIcon,
  HashtagIcon,
  DecimalsArrowRightIcon,
  ToggleOnIcon,
  Calendar01Icon,
  Clock01Icon,
  CalendarClockIcon,
  SourceCodeIcon,
} from "@hugeicons/core-free-icons";
import { FIELD_TYPES, type TableField } from "./types";

const icons: Record<TableField["type"], typeof TextFontIcon> = {
  text: TextFontIcon,
  integer: HashtagIcon,
  float: DecimalsArrowRightIcon,
  boolean: ToggleOnIcon,
  date: Calendar01Icon,
  time: Clock01Icon,
  "date-time": CalendarClockIcon,
  json: SourceCodeIcon,
};

export const FIELD_TYPE_OPTIONS = FIELD_TYPES.map((type) => ({
  value: type,
  label: type,
  icon: (
    <HugeiconsIcon
      icon={icons[type]}
      size={16}
      aria-hidden="true"
      className="shrink-0"
    />
  ),
}));
