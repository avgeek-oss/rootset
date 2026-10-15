import { Dropdown } from "@heroui/react";
import type { KeyboardEvent } from "react";
import type { ForeignKeyLink } from "../lib/foreign-key-navigation";
import { ArrowUpRight } from "./ui/icons";

function onKeyDown(event: KeyboardEvent) {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
}

export function ForeignKeyLinks({
  links,
  tabIndex,
}: {
  links: readonly ForeignKeyLink[];
  tabIndex: number;
}) {
  if (!links.length) return null;
  if (links.length === 1) {
    const link = links[0]!;
    return (
      <a
        className="foreign-key-link"
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        tabIndex={tabIndex}
        aria-label={`Open linked record in ${link.name} (new tab)`}
        title={`Open linked record in ${link.name} (new tab)`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <ArrowUpRight size={16} />
      </a>
    );
  }
  return (
    <span
      className="contents"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <Dropdown>
        <Dropdown.Trigger
          className="foreign-key-link"
          excludeFromTabOrder={tabIndex === -1}
          aria-label="Choose linked record to open"
        >
          <ArrowUpRight size={16} />
        </Dropdown.Trigger>
        <Dropdown.Popover>
          <Dropdown.Menu aria-label="Linked records">
            {links.map((link) => (
              <Dropdown.Item
                key={link.id}
                id={link.id}
                textValue={link.name}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {link.name}
                <ArrowUpRight size={16} />
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </span>
  );
}
