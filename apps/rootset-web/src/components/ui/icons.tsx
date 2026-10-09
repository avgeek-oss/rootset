"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowDown01Icon,
  ArrowUp01Icon,
  Tick02Icon,
  ArrowRight01Icon,
  ArrowLeftDoubleIcon,
  ArrowRightDoubleIcon,
  FilterIcon,
  PlusSignIcon,
  Settings01Icon,
  TableIcon,
  TransactionHistoryIcon,
  ArrowDownToLineIcon,
  Delete02Icon,
  Refresh01Icon,
  DatabaseIcon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps } from "react";

type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon">;
function makeIcon(icon: typeof DatabaseIcon) {
  return function Icon(props: IconProps) {
    return (
      <HugeiconsIcon aria-hidden="true" size={16} {...props} icon={icon} />
    );
  };
}

export const Database = makeIcon(DatabaseIcon);
export const ChevronLeft = makeIcon(ArrowLeft01Icon);
export const ChevronRight = makeIcon(ArrowRight01Icon);
export const ChevronsLeft = makeIcon(ArrowLeftDoubleIcon);
export const ChevronsRight = makeIcon(ArrowRightDoubleIcon);
export const Filter = makeIcon(FilterIcon);
export const Plus = makeIcon(PlusSignIcon);
export const Settings = makeIcon(Settings01Icon);
export const Columns3 = makeIcon(TableIcon);
export const History = makeIcon(TransactionHistoryIcon);
export const ArrowDownToLine = makeIcon(ArrowDownToLineIcon);
export const Trash2 = makeIcon(Delete02Icon);
export const RefreshCw = makeIcon(Refresh01Icon);

export const ChevronDown = makeIcon(ArrowDown01Icon);

export const ChevronUp = makeIcon(ArrowUp01Icon);
export const Check = makeIcon(Tick02Icon);
