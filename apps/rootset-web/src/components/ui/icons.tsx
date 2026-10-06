"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowLeftDoubleIcon,
  ArrowRightDoubleIcon,
  FilterHorizontalIcon,
  PlusSignIcon,
  Settings01Icon,
  Table01Icon,
  TransactionHistoryIcon,
  ArrowDownToLineIcon,
  Delete02Icon,
  Refresh01Icon,
  Database01Icon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps } from "react";

type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon">;
function makeIcon(icon: typeof Database01Icon) {
  return function Icon(props: IconProps) {
    return (
      <HugeiconsIcon aria-hidden="true" size={16} {...props} icon={icon} />
    );
  };
}

export const Database = makeIcon(Database01Icon);
export const ChevronLeft = makeIcon(ArrowLeft01Icon);
export const ChevronRight = makeIcon(ArrowRight01Icon);
export const ChevronsLeft = makeIcon(ArrowLeftDoubleIcon);
export const ChevronsRight = makeIcon(ArrowRightDoubleIcon);
export const Filter = makeIcon(FilterHorizontalIcon);
export const Plus = makeIcon(PlusSignIcon);
export const Settings = makeIcon(Settings01Icon);
export const Columns3 = makeIcon(Table01Icon);
export const History = makeIcon(TransactionHistoryIcon);
export const ArrowDownToLine = makeIcon(ArrowDownToLineIcon);
export const Trash2 = makeIcon(Delete02Icon);
export const RefreshCw = makeIcon(Refresh01Icon);
