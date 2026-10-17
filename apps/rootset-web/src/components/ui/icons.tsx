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
  EraserIcon,
  Refresh01Icon,
  DatabaseIcon,
  Comment01Icon,
  ArrowUpRight01Icon,
  MoreHorizontalIcon,
  ViewIcon,
  ViewOffIcon,
  SortByUp01Icon,
  SortByDown01Icon,
  Upload01Icon,
  Link01Icon,
  FloppyDiskIcon,
  PencilEdit02Icon,
  Copy01Icon,
  DatabaseBackupIcon,
  DatabaseRestoreIcon,
  StopIcon,
  Shield01Icon,
  CommentAdd01Icon,
  SourceCodeIcon,
  Login03Icon,
  Logout03Icon,
} from "@hugeicons/core-free-icons";
import type { ComponentProps } from "react";

type IconProps = Omit<ComponentProps<typeof HugeiconsIcon>, "icon">;
function makeIcon(icon: typeof DatabaseIcon) {
  return function Icon(props: IconProps) {
    return (
      <HugeiconsIcon
        aria-hidden="true"
        size={16}
        className="shrink-0"
        {...props}
        icon={icon}
      />
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
export const Eraser = makeIcon(EraserIcon);
export const RefreshCw = makeIcon(Refresh01Icon);

export const ChevronDown = makeIcon(ArrowDown01Icon);

export const ChevronUp = makeIcon(ArrowUp01Icon);
export const Check = makeIcon(Tick02Icon);
export const MessageSquare = makeIcon(Comment01Icon);
export const ArrowUpRight = makeIcon(ArrowUpRight01Icon);
export const MoreHorizontal = makeIcon(MoreHorizontalIcon);
export const View = makeIcon(ViewIcon);
export const Hide = makeIcon(ViewOffIcon);
export const SortAscending = makeIcon(SortByUp01Icon);
export const SortDescending = makeIcon(SortByDown01Icon);
export const Upload = makeIcon(Upload01Icon);
export const Link = makeIcon(Link01Icon);
export const Save = makeIcon(FloppyDiskIcon);
export const Pencil = makeIcon(PencilEdit02Icon);
export const Copy = makeIcon(Copy01Icon);
export const Backup = makeIcon(DatabaseBackupIcon);
export const Restore = makeIcon(DatabaseRestoreIcon);
export const Stop = makeIcon(StopIcon);
export const ShieldCheck = makeIcon(Shield01Icon);
export const CommentPlus = makeIcon(CommentAdd01Icon);
export const Code = makeIcon(SourceCodeIcon);
export const LogIn = makeIcon(Login03Icon);
export const LogOut = makeIcon(Logout03Icon);
