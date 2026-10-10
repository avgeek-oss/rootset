import { HugeiconsIcon } from "@hugeicons/react";
import {
  TextFontIcon,
  Link01Icon,
  Globe02Icon,
  Image01Icon,
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
  uri: Link01Icon,
  url: Globe02Icon,
  image: Image01Icon,
  integer: HashtagIcon,
  float: DecimalsArrowRightIcon,
  boolean: ToggleOnIcon,
  date: Calendar01Icon,
  time: Clock01Icon,
  "date-time": CalendarClockIcon,
  json: SourceCodeIcon,
};

export function FieldTypeIcon({
  type,
  size = 16,
}: {
  type: TableField["type"];
  size?: number;
}) {
  return (
    <HugeiconsIcon
      icon={icons[type]}
      size={size}
      aria-hidden="true"
      className="shrink-0"
    />
  );
}

export const FIELD_TYPE_OPTIONS = FIELD_TYPES.map((type) => ({
  value: type,
  label: type,
  icon: <FieldTypeIcon type={type} />,
}));
